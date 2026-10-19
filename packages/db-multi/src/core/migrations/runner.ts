/**
 * Global runner: a single runner across the cluster (platform lock + persistent marker), bounded worker sessions on the node DBs,
 * single-tenant and batch migration, rollback, baseline, status and explicit recovery.
 */
import { PLATFORM_DATABASE_ID } from "../config";
import { AppError, databaseUnavailable, errorCode } from "../errors";
import type { Management } from "../management";
import {
  afterGrace, cancelled, openManagementSession, openSession, ownershipCheck, RUNNER_KEY, type Session, tenantManagementKey, tenantOperationKey,
} from "../operations/locks";
import { type Placement, tenantSchema } from "../tenants/model";
import { schemaExists } from "../tenants/nodes";
import { type Batch, migrateBatch, migrationLimits, type MigrationReport, type MigrationRunOptions, type MigrationTarget, noReport } from "./batch";
import { tenantMigrations } from "./registry";
import { applyChain, markChain, pendingAt, rollbackChain, type RollbackTarget, rollbackTargets, type SessionConnection } from "./schema";

/** Error codes that may have left work behind remotely: the persistent marker is kept for recovery. */
const UNCERTAIN_CODES: readonly string[] = ["LOCK_LOST", "DATABASE_TIMEOUT"];
const isUncertain = (error: unknown) => databaseUnavailable(error) || UNCERTAIN_CODES.includes(errorCode(error));

const SELECT_MARKER_SQL = "SELECT run_id FROM platform.migration_runner WHERE singleton=true";
const INSERT_MARKER_SQL = "INSERT INTO platform.migration_runner(singleton,run_id) VALUES(true,$1)";
const DELETE_MARKER_SQL = "DELETE FROM platform.migration_runner WHERE singleton=true AND run_id=$1";

function checkDatabaseFilter(id: string, ids?: readonly string[]) {
  if (ids && !ids.includes(id)) throw new AppError("INVALID_CONFIG", "Tenant is outside the selected database filter");
}

export interface MigrationSessionOptions {
  concurrency: number;
  signal: AbortSignal;
  applicationName: string;
  report: MigrationReport;
}

/** At most `concurrency` node sessions; they belong to a single runner and are reused across a DB's tenants. */
export function createMigrationSessions(m: Management, { concurrency, signal, applicationName, report }: MigrationSessionOptions) {
  type Worker = { databaseId: string; session?: Session; busy: boolean };
  type ReadyWorker = Worker & { session: Session };
  const workers: Worker[] = [];
  const discard = (worker: Worker) => workers.splice(workers.indexOf(worker), 1);

  /** An idle healthy session on this DB; otherwise a new one within budget; otherwise an idle session is recycled. */
  async function borrow(databaseId: string): Promise<ReadyWorker> {
    const idle = workers.find((w) => !w.busy && w.databaseId === databaseId && !w.session?.signal.aborted);
    if (idle?.session) {
      idle.busy = true;
      return idle as ReadyWorker;
    }
    if (workers.length >= concurrency) {
      const other = workers.find((w) => !w.busy);
      if (!other) throw new AppError("MIGRATION_RUNNER_BUSY", "Worker concurrency exceeded");
      // The slot stays reserved while the backend is closing; idle backends on every DB would exceed the budget.
      other.busy = true;
      await other.session?.close();
      discard(other);
    }
    const worker: Worker = { databaseId, busy: true };
    workers.push(worker);
    try {
      worker.session = await openSession(m, databaseId, { applicationName, signal });
      return worker as ReadyWorker;
    } catch (error) {
      discard(worker);
      throw error;
    }
  }

  /** Runs `work` while holding the node `tenant-management` lock; a failed or aborted session is discarded. */
  async function run<T>(
    databaseId: string,
    tenantId: string,
    operationSignal: AbortSignal,
    work: (db: SessionConnection, assertAlive: () => void, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const worker = await borrow(databaseId);
    const { session } = worker;
    const cancel = () => session.cancel();
    operationSignal.addEventListener("abort", cancel, { once: true });
    if (operationSignal.aborted) cancel();
    let healthy = false;
    try {
      const ownership = await session.acquire(tenantManagementKey(tenantId));
      try {
        report({ tenantId, databaseId, status: "session-acquired", backendPid: ownership.pid, applicationName });
        const result = await work(session.db, ownership.assertAlive, AbortSignal.any([operationSignal, session.signal]));
        ownership.assertAlive();
        // A failed release marks the session as lost; it is discarded below anyway.
        healthy = true;
        return result;
      } finally {
        await ownership.release();
      }
    } finally {
      operationSignal.removeEventListener("abort", cancel);
      if (healthy && !session.signal.aborted) worker.busy = false;
      else {
        await session.close();
        discard(worker);
      }
    }
  }

  /** Closes every backend (even if one fails) before reporting the first error. */
  async function close() {
    const closing = workers.splice(0).map((w) => w.session?.close());
    for (const outcome of await Promise.allSettled(closing)) if (outcome.status === "rejected") throw outcome.reason;
  }
  return { run, close };
}

interface RunnerContext {
  signal: AbortSignal;
  assertOwned(): Promise<void>;
  markUncertain(): void;
  workers: ReturnType<typeof createMigrationSessions>;
  /** The platform `tenant-operation` lock, taken on the runner's own session. */
  acquireTenant(tenantId: string): ReturnType<Session["acquire"]>;
}

const openRunnerLock = (m: Management) => openManagementSession(m, PLATFORM_DATABASE_ID, RUNNER_KEY);
type RunnerLock = Awaited<ReturnType<typeof openRunnerLock>>;

/** Rejects if the previous runner did not close cleanly, otherwise writes this run's marker; on error the lock session is closed. */
async function claimRunnerMarker(lock: RunnerLock, runId: string) {
  try {
    const [prior] = await lock.db.query(SELECT_MARKER_SQL);
    if (prior) throw new AppError("MIGRATION_RECOVERY_REQUIRED", "Previous runner did not close cleanly; run migration-recover before retrying");
    await lock.db.query(INSERT_MARKER_SQL, [runId]);
  } catch (error) {
    await lock.close();
    throw error;
  }
}

/**
 * Monitors runner ownership: a heartbeat every second, loss of the lock session, and the grace period of the external signal. When the grace period ends or ownership
 * is lost, `signal` is aborted and the pools are closed; no query outlives the runner.
 */
function monitorOwnership(m: Management, lock: RunnerLock, externalSignal: AbortSignal | undefined) {
  const aborter = new AbortController();
  let owned = true;
  let uncertain = false;
  let checking = false;
  let poolShutdown: Promise<void> | undefined;
  const abort = () => {
    if (aborter.signal.aborted) return;
    aborter.abort();
    poolShutdown = m.pools.close().catch(() => {});
  };
  const lose = () => {
    owned = false;
    abort();
  };
  lock.signal.addEventListener("abort", lose, { once: true });
  const stopGrace = afterGrace(externalSignal, m.config.shutdownGraceMs, abort);
  const heartbeat = setInterval(() => {
    if (checking) return;
    checking = true;
    void lock.assertOwned().catch(lose).finally(() => (checking = false));
  }, 1000);

  async function assertOwned() {
    if (!owned) throw new AppError("LOCK_LOST", "Migration runner ownership lost; explicit recovery required");
    try {
      lock.assertAlive();
    } catch (error) {
      lose();
      throw error;
    }
    if (aborter.signal.aborted) throw cancelled();
  }

  return {
    signal: aborter.signal,
    assertOwned,
    markUncertain: () => {
      uncertain = true;
    },
    uncertain: () => uncertain,
    owned: () => owned,
    stopHeartbeat: () => clearInterval(heartbeat),
    /** Waits for the pools to close; there is no abort after this: the `releaseRunner` checks catch a lost lock. */
    async stop() {
      await poolShutdown;
      lock.signal.removeEventListener("abort", lose);
      stopGrace();
    },
  };
}
type OwnershipMonitor = ReturnType<typeof monitorOwnership>;

/**
 * The marker is deleted only on a clean, definite finish (an uncertain or aborted outcome leaves the marker for recovery), then the lock is
 * released and the session closes. If the deletion fails, the final state is uncertain: the returned `LOCK_LOST` replaces the result.
 */
async function releaseRunner(lock: RunnerLock, runId: string, monitor: OwnershipMonitor): Promise<AppError | undefined> {
  let owned = true;
  let finalError: AppError | undefined;
  if (!monitor.uncertain() && !monitor.signal.aborted)
    await lock
      .assertOwned()
      .then(() => lock.db.query(DELETE_MARKER_SQL, [runId]))
      .catch(() => {
        owned = false;
        finalError = new AppError("LOCK_LOST", "Runner final state is uncertain; explicit recovery required");
      });
  try {
    if (owned && monitor.owned() && !lock.signal.aborted) await lock.release();
  } finally {
    await lock.close();
  }
  return finalError;
}

/**
 * Admission of every non-dry-run execution. The signal starts the grace period; when it ends (or runner ownership is lost),
 * workers are cancelled and the pools close. The marker is deleted only after a clean, definite finish; otherwise
 * `recoverMigrations` must run first.
 */
async function withRunner<T>(m: Management, options: MigrationRunOptions, concurrency: number, work: (context: RunnerContext) => Promise<T>) {
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  const lock = await openRunnerLock(m);
  const runId = crypto.randomUUID();
  await claimRunnerMarker(lock, runId);
  // From here on the marker exists: it is removed only on a clean, definite finish.
  const monitor = monitorOwnership(m, lock, signal);
  const workers = createMigrationSessions(m, {
    concurrency,
    signal: monitor.signal,
    applicationName: `tenant-migration:${runId}`,
    report: options.report ?? noReport,
  });
  let outcome: { result: T } | { error: unknown };
  try {
    if (signal?.aborted) throw cancelled();
    const acquireTenant = (tenantId: string) => lock.acquire(tenantOperationKey(tenantId));
    const result = await work({ signal: monitor.signal, assertOwned: monitor.assertOwned, workers, markUncertain: monitor.markUncertain, acquireTenant });
    await monitor.assertOwned();
    outcome = { result };
  } catch (error) {
    if (isUncertain(error)) monitor.markUncertain();
    outcome = { error };
  }
  // Every error was caught above: cleanup runs in order. Even the idle node backends must have closed before the marker or the global ownership
  // is released.
  monitor.stopHeartbeat();
  await workers.close().catch((error: unknown) => {
    monitor.markUncertain();
    outcome = { error };
  });
  await monitor.stop();
  const finalError = await releaseRunner(lock, runId, monitor);
  if (finalError) throw finalError;
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

/** Clears the old runner marker only if no session of that run (or busy tenant DDL) remains anywhere. */
export async function recoverMigrations(m: Management): Promise<{ recovered: boolean }> {
  const lock = await openRunnerLock(m);
  try {
    const [prior] = await lock.db.query<{ run_id: string }>(SELECT_MARKER_SQL);
    if (!prior) return { recovered: false };
    // Every configured DB (db0 is the platform database); an unreachable DB makes recovery fail.
    for (const node of m.config.nodes) {
      const [sessions] = await m.pools.node(node.id).query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_catalog.pg_stat_activity WHERE pid<>pg_catalog.pg_backend_pid() AND (application_name=$1 OR (application_name='tenant-management' AND state IS DISTINCT FROM 'idle'))",
        [`tenant-migration:${prior.run_id}`],
      );
      if (sessions?.count !== 0)
        throw new AppError("MIGRATION_RECOVERY_REQUIRED", "Previous migration sessions remain; wait or stop them before recovery");
    }
    await lock.assertOwned();
    await lock.db.query(DELETE_MARKER_SQL, [prior.run_id]);
    return { recovered: true };
  } finally {
    await lock.close();
  }
}

/** Read-only: the tenant's placement and pending migrations. */
export async function migrationStatus(m: Management, tenantId: string) {
  const placement = await m.platform.get(tenantId);
  const pending = await pendingAt(m, placement);
  return { tenantId, databaseId: placement.databaseId, pending: pending.map(({ id, concurrentIndex }) => ({ id, transactional: !concurrentIndex })) };
}

type TargetSource = Pick<Batch, "listPage" | "run">;
/** schema_version advances only after the DDL and ledger: an up-to-date page row costs no query at all. */
const isCurrent = (target: MigrationTarget) => target.schemaVersion === tenantMigrations.length;

/** Dry run: only the page rows and the ledger are read; no lock, session or write. */
function dryRunTargets(m: Management, report: MigrationReport): TargetSource {
  return {
    listPage: async (id, after, limit) => m.platform.listPage(id, after, limit),
    async run(target, signal) {
      if (isCurrent(target)) return;
      if (signal.aborted) throw cancelled();
      report({ ...target, pending: (await pendingAt(m, target)).map((migration) => migration.id), dryRun: true });
    },
  };
}

/** Under the runner: ownership is checked before every page read, and each target is migrated with its own locks. */
function runnerTargets(m: Management, context: RunnerContext, report: MigrationReport): TargetSource {
  return {
    async listPage(id, after, limit) {
      await context.assertOwned();
      return m.platform.listPage(id, after, limit).catch((error) => {
        if (databaseUnavailable(error)) context.markUncertain();
        throw error;
      });
    },
    async run(target, signal) {
      if (isCurrent(target)) return;
      const both = AbortSignal.any([signal, context.signal]);
      await migrateTarget(m, context, target.tenantId, both, { expected: target }, apply(m, report));
    },
  };
}

/** Every active tenant that is not up to date, paged per DB. Inspect the `failed`/`incomplete` fields in the summary. */
export async function migrateAll(m: Management, options: MigrationRunOptions = {}) {
  const limits = migrationLimits(m.config, options);
  const report = options.report ?? noReport;
  report({ limits, dryRun: !!options.dryRun });
  const runBatch = (source: TargetSource, runnerSignal?: AbortSignal) =>
    migrateBatch(
      { databases: limits.databases, ...source },
      {
        ...limits,
        continueOnError: options.continueOnError,
        signal: AbortSignal.any([runnerSignal, options.signal].filter((s) => s !== undefined)),
      },
      report,
    );
  if (options.dryRun) return runBatch(dryRunTargets(m, report));
  return withRunner(m, options, limits.concurrency, (context) => runBatch(runnerTargets(m, context, report), context.signal));
}

/** Dry runs only read the placement and ledger; `migrations` are the pending IDs. */
async function dryRun(m: Management, tenantId: string, options: MigrationRunOptions) {
  if (options.signal?.aborted) throw cancelled();
  const placement = await m.platform.get(tenantId);
  checkDatabaseFilter(placement.databaseId, options.databaseIds);
  return (await pendingAt(m, placement)).map((migration) => migration.id);
}

type TargetWork = (placement: Placement, db: SessionConnection, verify: () => Promise<void>) => Promise<string[]>;
type TargetScope = { expected?: MigrationTarget; databaseIds?: readonly string[]; adopt?: string };
/** A single tenant under its own runner (single-tenant migrate, rollback, baseline). */
const runTarget = (m: Management, options: MigrationRunOptions, tenantId: string, scope: TargetScope, work: TargetWork) =>
  withRunner(m, options, 1, (context) => migrateTarget(m, context, tenantId, context.signal, scope, work));
const apply =
  (m: Management, report: MigrationReport): TargetWork =>
  async (placement, db, verify) =>
    (await applyChain(m, placement, db, verify, report)).applied;

/** Explicit single-tenant run: the ledger is always inspected. `migrations` are the applied (dry-run: pending) IDs. */
export async function migrateTenant(m: Management, tenantId: string, options: MigrationRunOptions = {}) {
  const limits = migrationLimits(m.config, options);
  const report = options.report ?? noReport;
  if (!options.dryRun) {
    const migrations = await runTarget(m, options, tenantId, { databaseIds: options.databaseIds }, apply(m, report));
    return { tenantId, dryRun: false, migrations };
  }
  const pending = await dryRun(m, tenantId, options);
  report({ tenantId, pending, limits, dryRun: true });
  return { tenantId, dryRun: true, migrations: pending };
}

export type RollbackOptions = Pick<MigrationRunOptions, "dryRun" | "signal" | "report"> & RollbackTarget;

/** Single-tenant rollback: the same runner, locks and CAS as migrate. `migrations` are the rolled-back (dry-run: to be rolled back) IDs, newest to oldest. */
export async function rollbackTenant(m: Management, tenantId: string, options: RollbackOptions = {}) {
  if (options.dryRun) {
    const applied = tenantMigrations.slice(0, tenantMigrations.length - (await dryRun(m, tenantId, options)).length);
    return { tenantId, dryRun: true, migrations: rollbackTargets(applied, options).map((migration) => migration.id) };
  }
  const migrations = await runTarget(m, options, tenantId, {}, async (placement, db, verify) => {
    const { rolledBack } = await rollbackChain(m, placement, db, verify, options.report ?? noReport, options);
    return rolledBack;
  });
  return { tenantId, dryRun: false, migrations };
}

/**
 * Baseline: counts the pending migrations up to `migrationId` as applied without running them; rejects if the live schema lacks the folded tables,
 * columns and enums. If there is no placement, it adopts the tenant schema on `databaseId` (default db0).
 * The tenant ends up `active`; the remaining migrations run with `migrateTenant`.
 */
export async function markMigrationApplied(
  m: Management,
  tenantId: string,
  migrationId: string,
  options: Pick<MigrationRunOptions, "signal" | "report"> & { databaseId?: string } = {},
) {
  const { databaseId } = options;
  const scope = { adopt: databaseId ?? PLATFORM_DATABASE_ID, databaseIds: databaseId ? [databaseId] : undefined };
  const migrations = await runTarget(m, options, tenantId, scope, async (found, db, verify) => {
    const { placement, marked } = await markChain(m, found, db, verify, migrationId);
    await verify();
    if (placement.status !== "active") await m.platform.setStatus(placement, "active");
    return marked;
  });
  return { tenantId, migrations };
}

/**
 * The live placement and target DB while the tenant lock is held. Only a baseline (`adopt`) may find no placement or accept a `provisioning`
 * placement; if the batch target (`expected`) has been moved, `PLACEMENT_CONFLICT`.
 */
async function resolveTargetPlacement(m: Management, tenantId: string, { expected, adopt, databaseIds }: TargetScope) {
  const found = await m.platform.get(tenantId).catch((error) => {
    if (!adopt || errorCode(error) !== "TENANT_NOT_FOUND") throw error;
  });
  const databaseId = found?.databaseId ?? (adopt as string);
  checkDatabaseFilter(databaseId, databaseIds);
  if (found && found.status !== "active" && !(adopt && found.status === "provisioning"))
    throw new AppError("TENANT_UNAVAILABLE", "Tenant not ready for migration");
  if (expected && (found?.databaseId !== expected.databaseId || found.schemaName !== expected.schemaName))
    throw new AppError("PLACEMENT_CONFLICT", "Tenant moved after target acquisition; rerun migration");
  return { found, databaseId };
}

/** Baseline without a placement: if the tenant schema exists on the node, a placement is written for it. */
async function adoptTenantSchema(m: Management, db: SessionConnection, tenantId: string, databaseId: string, verify: () => Promise<void>) {
  if (!(await schemaExists(db, tenantSchema(tenantId)))) throw new AppError("TENANT_NOT_FOUND", "No placement and no tenant schema to adopt");
  await verify();
  return m.platform.create(tenantId, databaseId);
}

/** Platform tenant lock → live placement checks → node worker lock → chain; every write re-verifies all three. */
async function migrateTarget(
  m: Management,
  context: RunnerContext,
  tenantId: string,
  signal: AbortSignal,
  scope: TargetScope,
  work: TargetWork,
): Promise<string[]> {
  await context.assertOwned();
  if (signal.aborted) throw cancelled();
  try {
    const tenant = await context.acquireTenant(tenantId);
    try {
      // The placement is live only while the tenant lock is held.
      const { found, databaseId } = await resolveTargetPlacement(m, tenantId, scope);
      return await context.workers.run(databaseId, tenantId, signal, async (db, assertNode, workerSignal) => {
        const verify = ownershipCheck(workerSignal, context.assertOwned, tenant.assertAlive, assertNode);
        const placement = found ?? (await adoptTenantSchema(m, db, tenantId, databaseId, verify));
        const result = await work(placement, db, verify);
        await verify();
        return result;
      });
    } finally {
      await tenant.release();
    }
  } catch (error) {
    if (signal.aborted || isUncertain(error)) context.markUncertain();
    throw error;
  }
}
