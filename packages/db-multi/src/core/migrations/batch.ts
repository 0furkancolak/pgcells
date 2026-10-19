/** Runs paged migration (and seed) targets with global and per-DB concurrency limits. */
import { boundedInteger, type ManagementSettings, MIGRATION_MAX } from "../config";
import { AppError, databaseUnavailable, errorCode } from "../errors";

export interface MigrationTarget {
  tenantId: string;
  databaseId: string;
  schemaName: string;
  status: string;
  schemaVersion?: number;
  kind?: string;
}
/** Progress events (plain objects that can be serialized to JSON); the CLI prints them. */
export type MigrationReport = (event: Record<string, unknown>) => void;
/** For when no report is wanted. */
export const noReport: MigrationReport = () => {};
export interface MigrationRunOptions {
  databaseIds?: readonly string[];
  concurrency?: number;
  perDatabaseConcurrency?: number;
  /** Default: no new work is admitted after the first error. */
  continueOnError?: boolean;
  /** Only reads the placement and ledger; no lock, session or write. */
  dryRun?: boolean;
  /** Abort stops admitting new work; running jobs are cancelled after `shutdownGraceMs`. */
  signal?: AbortSignal;
  report?: MigrationReport;
}

/** The effective DB list and validated limits of a run: CLI values override the factory options. */
export function migrationLimits(config: ManagementSettings, options: MigrationRunOptions) {
  const ids = options.databaseIds ?? config.nodes.map((node) => node.id);
  if (!ids.length || new Set(ids).size !== ids.length) throw new AppError("INVALID_CONFIG", "Database filter must be nonempty and unique");
  const perDatabaseConcurrency = options.perDatabaseConcurrency ?? config.perDatabaseConcurrency;
  const perDatabase = boundedInteger(perDatabaseConcurrency, "per-db-concurrency", MIGRATION_MAX.perDatabase);
  const databases = ids.map((id) => {
    if (!config.nodes.some((node) => node.id === id)) throw new AppError("INVALID_CONFIG", `Unknown migration database: ${id}`);
    return { id, concurrency: perDatabase };
  });
  return {
    concurrency: boundedInteger(options.concurrency ?? config.migrationConcurrency, "concurrency", MIGRATION_MAX.concurrency),
    databases,
    pageSize: config.pageSize,
    shutdownGraceMs: config.shutdownGraceMs,
  };
}

export interface Batch {
  databases: readonly { id: string; concurrency: number }[];
  /** A keyset page ordered by tenant ID (`platform.listPage`). */
  listPage(databaseId: string, after: string, limit: number): Promise<MigrationTarget[]>;
  run(target: MigrationTarget, signal: AbortSignal): Promise<void>;
}
type BatchOptions = Omit<ReturnType<typeof migrationLimits>, "databases"> & Pick<MigrationRunOptions, "continueOnError" | "signal">;

/** Shared concurrency slots. `wakeAll` wakes the waiters by rejecting them; every later acquisition is rejected too. */
function createSlots(concurrency: number) {
  let free = concurrency;
  let closed = false;
  const waiting: ((granted: boolean) => void)[] = [];
  return {
    acquire: () =>
      new Promise<boolean>((resolve) => {
        if (closed) resolve(false);
        else if (free === 0) waiting.push(resolve);
        else {
          free--;
          resolve(true);
        }
      }),
    release() {
      const next = waiting.shift();
      if (next) next(true);
      else free++;
    },
    wakeAll() {
      closed = true;
      for (const wake of waiting.splice(0)) wake(false);
    },
  };
}

/** One-shot stop: cuts off admission of work (`onStop`) and aborts the signal of running jobs after `graceMs`. */
function createStopSwitch(graceMs: number, onStop: () => void) {
  const workers = new AbortController();
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    signal: workers.signal,
    stopping: () => stopping,
    stop() {
      if (stopping) return;
      stopping = true;
      timer = setTimeout(() => workers.abort(), graceMs);
      onStop();
    },
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Each DB runs `concurrency` lanes over a single-buffered page; the lanes share `options.concurrency` slots and take a slot only
 * when there is a target in the queue, so a slow page does not hold a slot. A stop (signal, fail-fast error, source error) ends admission of work and
 * aborts running jobs after the grace period. A tenant never runs twice at the same time: the tenant lock rejects a second owner.
 */
export async function migrateBatch(batch: Batch, options: BatchOptions, report: MigrationReport = noReport) {
  const summary = { succeeded: 0, failed: 0, skipped: 0 };
  const slots = createSlots(options.concurrency);
  const shutdown = createStopSwitch(options.shutdownGraceMs, slots.wakeAll);
  const { stop, stopping } = shutdown;

  // Per DB: keyset cursor, buffered page, pending page read, exhausted/blocked flags.
  const databases = batch.databases.map((database) => ({
    ...database,
    after: "",
    queue: [] as MigrationTarget[],
    page: undefined as Promise<void> | undefined,
    done: false,
    blocked: false,
  }));
  type Database = (typeof databases)[number];

  async function fetchPage(db: Database) {
    try {
      const page = await batch.listPage(db.id, db.after, options.pageSize);
      db.after = page.at(-1)?.tenantId ?? db.after;
      db.done = page.length < options.pageSize;
      for (const target of page) {
        if (target.status === "active") db.queue.push(target);
        else {
          summary.skipped++;
          report({ ...target, status: "not-started", reason: "tenant-not-active" });
        }
      }
    } catch (error) {
      summary.failed++;
      db.blocked = true;
      report({ databaseId: db.id, error: errorCode(error), status: "target-source-failed" });
      // Placement acquisition uses the coordination DB; every source error stops admission of work.
      stop();
    }
  }

  /** True if the `db` queue has a target; false if it is exhausted, blocked or being stopped. */
  async function hasTarget(db: Database) {
    while (!db.queue.length && !db.done && !db.blocked && !stopping()) {
      db.page ??= fetchPage(db).finally(() => {
        db.page = undefined;
      });
      await db.page;
    }
    return db.queue.length > 0 && !db.blocked && !stopping();
  }

  async function migrate(db: Database, target: MigrationTarget) {
    const start = Date.now();
    try {
      await batch.run(target, shutdown.signal);
      summary.succeeded++;
      report({ ...target, status: "succeeded", durationMs: Date.now() - start });
    } catch (error) {
      summary.failed++;
      const code = errorCode(error);
      report({ ...target, status: "failed", error: code, durationMs: Date.now() - start });
      if (databaseUnavailable(error)) db.blocked = true;
      if (!options.continueOnError || code === "LOCK_LOST") stop();
    }
  }

  async function lane(db: Database) {
    while (await hasTarget(db)) {
      if (!(await slots.acquire())) return;
      // While this lane was waiting, another lane may have emptied the queue or the DB may have been blocked.
      const target = db.blocked || stopping() ? undefined : db.queue.shift();
      try {
        if (target) await migrate(db, target);
      } finally {
        slots.release();
      }
    }
  }

  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    await Promise.all(databases.flatMap((db) => Array.from({ length: db.concurrency }, () => lane(db))));
    for (const db of databases) for (const target of db.queue) report({ ...target, status: "not-started", reason: "admission-stopped" });
    // Tenants that are not active count as skipped; only a stop and blocked DBs leave work behind.
    return { ...summary, incomplete: stopping() || databases.some((db) => db.blocked) };
  } finally {
    shutdown.dispose();
    options.signal?.removeEventListener("abort", stop);
  }
}
