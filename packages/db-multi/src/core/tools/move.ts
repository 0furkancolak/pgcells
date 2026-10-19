/** Moves a tenant to another database; continues an interrupted move or rolls it back before the DB switch.
 *
 * Flow: planned → maintenance (placement `migrating`) → copying → validated → cutover (placement `maintenance` on the target) →
 * fenced (the source schema is renamed, so a writer holding a stale placement fails with 42P01) → completed (placement `active`). Every
 * step runs under the tenant lock, the node locks, and the ownership of placement.move_operation_id and moves.owner_id.
 *
 * Online flow (`online: true`, see online-move.ts): planned → prepared (empty structure on the target) → replicating (logical replication, initial copy done) →
 * paused (one source transaction: tables locked, subscriber caught up, sequences and counts checked, source schema renamed) → cutover → fenced → completed.
 * The tenant stays writable until the pause, so no `--writers-drained` is needed. */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { type Database, stopwatch } from "../database";
import type { Connection } from "../driver";
import { AppError, errorCode, parseDatabaseValue } from "../errors";
import type { Management } from "../management";
import { ownershipCheck, withNodeLocks, withTenantLock } from "../operations/locks";
import { movedSchemaName, type Placement, placementSchema, quoteIdentifier } from "../tenants/model";
import { schemaExists } from "../tenants/nodes";
import { assertCompatible, buildSchema, copySchema, fingerprint, readSchema, serverFacts, snapshotTransaction } from "./copy";
import {
  checkOnlinePrerequisites, compareCounts, createHeartbeat, dropHeartbeat, HEARTBEAT_TABLE, listTables, lockTables, ONLINE_DEFAULTS, type OnlineOptions, type OnlineSettings, replicationName,
  schemaBytes, startReplication, syncSequences, teardownReplication, waitCaughtUp,
  waitHeartbeat, waitInitialSync,
} from "./online-move";

const moveSchema = z.object({
  id: z.uuid(),
  tenantId: z.string(),
  targetDatabaseId: z.string(),
  source: placementSchema,
  ownerId: z.uuid().nullable(),
  status: z.enum(["running", "failed", "completed", "rolled-back"]),
  phase: z.string(),
  fingerprint: z.string().nullable(),
  error: z.string().nullable(),
  online: z.boolean(),
});
export type Move = z.infer<typeof moveSchema>;
type Check = () => Promise<void>;
type Checkpoint = (phase: string, hash?: string) => Promise<void>;
/** Ownership check, phase record and cancellation signal of the move being resumed. */
interface MoveRun {
  assertOwned: Check;
  checkpoint: Checkpoint;
  signal: AbortSignal;
}
type Queryable = Pick<Connection, "query">;

// Writes to `platform.moves`; the ownership (owner_id + running) condition affecting zero rows shows that ownership changed.
const TAKE_OWNERSHIP = "UPDATE platform.moves SET owner_id=$1,status='running',error=NULL,updated_at=now() WHERE id=$2";
const CHECK_OWNERSHIP = "SELECT id FROM platform.moves WHERE id=$1 AND owner_id=$2 AND status='running'";
const SAVE_CHECKPOINT = "UPDATE platform.moves SET phase=$1,fingerprint=$2,updated_at=now() WHERE id=$3 AND owner_id=$4 AND status='running' RETURNING 1";
const COMPLETE_MOVE = "UPDATE platform.moves SET status='completed',phase='completed',updated_at=now() WHERE id=$1 AND owner_id=$2 AND status='running' RETURNING 1";
const FAIL_MOVE = "UPDATE platform.moves SET status='failed',error=$1,updated_at=now() WHERE id=$2 AND owner_id=$3 AND status='running'";

const ownershipChanged = () => new AppError("PLACEMENT_CONFLICT", "Move ownership changed");
const recordChanged = (step: string) => new AppError("LOCK_LOST", `Move ${step} ownership changed`);

/** Declaration that you stopped the writers externally (`--writers-drained`); it does not stop requests itself. */
function requireMaintenance(writersDrained = false) {
  if (!writersDrained) throw new AppError("MAINTENANCE_REQUIRED", "Stop and drain all writers, then pass --writers-drained for this operation");
}

/** Single-row write protected by the ownership columns; zero rows means the record passed to someone else. */
async function claim(db: Queryable, sql: string, values: unknown[], error: () => AppError) {
  if ((await db.query(sql, values)).length !== 1) throw error();
}

export async function getMove(m: Management, id: string): Promise<Move> {
  z.uuid().parse(id);
  const [row] = await m.pools.platform.query(
    `SELECT id,tenant_id AS "tenantId",target_database_id AS "targetDatabaseId",source,owner_id AS "ownerId",status,phase,fingerprint,error,online FROM platform.moves WHERE id=$1`,
    [id],
  );
  if (!row) throw new AppError("MOVE_NOT_FOUND", "Move not found");
  const move = parseDatabaseValue(moveSchema, row);
  if (move.source.tenantId !== move.tenantId) throw new AppError("INVALID_DATABASE_STATE", "Invalid source recovery state");
  return move;
}

/** Runs `work` under the maintenance declaration, the tenant lock and two node locks; the move record is re-read inside the tenant lock. */
type MoveWork<T> = (op: Move, assertLocks: Check, signal: AbortSignal) => Promise<T>;
async function withMove<T>(m: Management, id: string, writersDrained: boolean | undefined, work: MoveWork<T>, online = false) {
  if (!online) requireMaintenance(writersDrained);
  const { tenantId } = await getMove(m, id);
  return withTenantLock(m, tenantId, async (assertTenant, tenantSignal) => {
    const op = await getMove(m, id);
    // An offline move needs the writers declared drained, whatever the caller thought it was resuming.
    if (!op.online) requireMaintenance(writersDrained);
    return withNodeLocks(m, tenantId, [op.source.databaseId, op.targetDatabaseId], (assertNodes, nodeSignal) => {
      const signal = AbortSignal.any([tenantSignal, nodeSignal]);
      return work(op, ownershipCheck(signal, assertTenant, assertNodes), signal);
    });
  });
}

const assertPlacementOwner = (m: Management, op: Move, p: Placement) =>
  claim(
    m.pools.platform,
    "SELECT tenant_id FROM platform.placements WHERE tenant_id=$1 AND database_id=$2 AND placement_version=$3 AND status=$4 AND move_operation_id=$5",
    [p.tenantId, p.databaseId, p.placementVersion, p.status, op.id],
    ownershipChanged,
  );

export interface MoveOptions {
  /** A move to a database in another region is refused without this (`CROSS_REGION_MOVE`). It never lets a tenant leave its residency zone. */
  allowCrossRegion?: boolean;
  /** Move while the tenant stays writable (logical replication; the write pause is the final catch-up). Needs PostgreSQL 15+, `wal_level=logical` on the source and the
   * source URL as the target server sees it. No `writersDrained` declaration is needed. */
  online?: OnlineOptions;
}
/** What `resumeMove` needs to know about an online move; the source URL is only used if the subscription does not exist yet. */
export type ResumeOptions = OnlineOptions & { online?: boolean };

/** Residency and region rules for moving `source` to `targetDatabaseId`, read with the node rows locked `FOR SHARE` so a concurrent `database set --zone` waits. */
async function assertMoveAllowed(tx: Connection, source: Placement, targetDatabaseId: string, options: MoveOptions) {
  const nodes = await tx.query<{ databaseId: string; region: string | null; zone: string | null }>(
    `SELECT database_id AS "databaseId",region,residency_zone AS zone FROM platform.nodes WHERE database_id IN ($1,$2) FOR SHARE`,
    [source.databaseId, targetDatabaseId],
  );
  const from = nodes.find((node) => node.databaseId === source.databaseId);
  const to = nodes.find((node) => node.databaseId === targetDatabaseId);
  if (!to) throw new AppError("DATABASE_NOT_FOUND", `Database ${targetDatabaseId} is not registered`);
  const zone = source.residencyZone ?? null;
  if (zone !== null && to.zone !== zone)
    throw new AppError("RESIDENCY_VIOLATION", `Tenant ${source.tenantId} is bound to residency zone ${zone}; ${targetDatabaseId} is ${to.zone === null ? "in no zone" : `in zone ${to.zone}`}`);
  if (from?.region && to.region && from.region !== to.region && !options.allowCrossRegion)
    throw new AppError("CROSS_REGION_MOVE", `${targetDatabaseId} is in region ${to.region}, the tenant lives in ${from.region}; pass --allow-cross-region to move it`);
}

export async function startMove(m: Management, tenantId: string, targetDatabaseId: string, writersDrained?: boolean, onStarted?: (move: Move) => void, options: MoveOptions = {}) {
  if (!options.online) requireMaintenance(writersDrained);
  m.pools.nodeConfig(targetDatabaseId);
  const id = await withTenantLock(m, tenantId, async (assertLock) => {
    const [unfinished] = await m.pools.platform.query<{ id: string }>(
      "SELECT id FROM platform.moves WHERE tenant_id=$1 AND status IN ('running','failed') ORDER BY created_at LIMIT 1",
      [tenantId],
    );
    if (unfinished) throw new AppError("MOVE_UNFINISHED", `Move ${unfinished.id} is unfinished; run resume-move or rollback-move for it first`);
    const source = await m.platform.get(tenantId);
    if (source.status !== "active") throw new AppError("TENANT_UNAVAILABLE", "Tenant must be active before move");
    if (source.databaseId === targetDatabaseId) throw new AppError("SAME_DATABASE", "Tenant is already on target");
    if (options.online) await checkOnlinePrerequisites(m.pools.node(source.databaseId), m.pools.node(targetDatabaseId));
    await assertLock();
    const moveId = crypto.randomUUID();
    await m.pools.platform.transaction(async (tx) => {
      await assertMoveAllowed(tx, source, targetDatabaseId, options);
      await tx.query(
        "INSERT INTO platform.moves(id,tenant_id,target_database_id,source,status,online) VALUES ($1,$2,$3,$4::text::jsonb,'running',$5)",
        [moveId, tenantId, targetDatabaseId, JSON.stringify(source), !!options.online],
      );
      await claim(
        tx,
        "UPDATE platform.placements SET move_operation_id=$1 WHERE tenant_id=$2 AND database_id=$3 AND placement_version=$4 AND status='active' RETURNING 1",
        [moveId, tenantId, source.databaseId, source.placementVersion],
        ownershipChanged,
      );
    });
    return moveId;
  });
  onStarted?.(await getMove(m, id));
  return resumeMove(m, id, writersDrained, options.online ? { ...options.online, online: true } : {});
}

export function resumeMove(m: Management, id: string, writersDrained?: boolean, options: ResumeOptions = {}) {
  return withMove(m, id, writersDrained, async (op, assertLocks, signal) => {
    if (op.status === "completed") return op;
    if (op.status === "rolled-back") throw new AppError("MOVE_TERMINAL", "Move is terminal");
    const ownerId = crypto.randomUUID();
    const platform = m.pools.platform;
    await assertLocks();
    await platform.query(TAKE_OWNERSHIP, [ownerId, id]);
    const assertOwned = async () => {
      await assertLocks();
      await claim(platform, CHECK_OWNERSHIP, [id, ownerId], () => recordChanged("record"));
    };
    let savedFingerprint = op.fingerprint;
    let phaseElapsed = stopwatch();
    const checkpoint: Checkpoint = async (phase, hash) => {
      m.emit({ name: `move.${phase}`, ms: phaseElapsed(), tenantId: op.tenantId });
      phaseElapsed = stopwatch();
      await assertOwned();
      savedFingerprint = hash ?? savedFingerprint;
      await claim(platform, SAVE_CHECKPOINT, [phase, savedFingerprint, id, ownerId], () => recordChanged("checkpoint"));
    };
    try {
      const run = { assertOwned, checkpoint, signal };
      const placement = op.online ? await copyAndCutoverOnline(m, op, run, options) : await copyAndCutover(m, op, run);
      await fence(m, op, run);
      await assertOwned();
      // Online: the replication objects are no longer needed. A failure to remove them is not a failed move; it is recorded so `move-status` and the log say what to drop.
      if (op.online) {
        const leftover = await teardownReplication(m.pools.node(op.source.databaseId), m.pools.node(op.targetDatabaseId), replicationName(op.id));
        const heartbeat = await dropHeartbeat(m.pools.node(op.targetDatabaseId), op.source.schemaName).then(
          () => undefined,
          () => `Drop the table ${HEARTBEAT_TABLE} from the moved schema on ${op.targetDatabaseId} by hand`,
        );
        const notes = [leftover, heartbeat].filter(Boolean).join("; ");
        if (notes) await platform.query("UPDATE platform.moves SET error=$1 WHERE id=$2 AND owner_id=$3", [notes, id, ownerId]);
      }
      // The target schema is live now; release the reservation so a later move back is not blocked.
      await m.pools.node(op.targetDatabaseId).query("DELETE FROM platform.move_targets WHERE tenant_id=$1 AND operation_id=$2", [op.tenantId, id]);
      await activate(m, op, placement, (tx) => claim(tx, COMPLETE_MOVE, [id, ownerId], () => recordChanged("completion")));
      return await getMove(m, id);
    } catch (error) {
      await platform.query(FAIL_MOVE, [errorCode(error), id, ownerId]).catch(() => {});
      throw error;
    }
  }, options.online === true);
}

/** Copies up to cutover and returns the target placement awaiting activation. Re-running is safe. */
async function copyAndCutover(m: Management, op: Move, run: MoveRun) {
  const { source: from, targetDatabaseId, tenantId } = op;
  const [source, target] = [m.pools.node(from.databaseId), m.pools.node(targetDatabaseId)];
  const placement = await m.platform.get(tenantId);
  // Cutover was already processed; only activation remains.
  if (placement.databaseId === targetDatabaseId && placement.placementVersion === from.placementVersion + 1) return placement;
  const onSource = placement.databaseId === from.databaseId && placement.placementVersion === from.placementVersion;
  if (!onSource || !["active", "migrating"].includes(placement.status)) throw ownershipChanged();
  await assertPlacementOwner(m, op, placement);
  await reserveTarget(target, op, from.schemaName);
  await enterMaintenance(m, op, run);
  await copyAndValidate(m, op, source, target, run);
  return cutover(m, op, run);
}

/** Drops `undefined` values so an unset option does not override a default. */
const definedOnly = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
const ONLINE_ORDER = ["planned", "prepared", "replicating", "paused", "cutover", "fenced", "completed"];
const phaseReached = (op: Move, phase: string) => ONLINE_ORDER.indexOf(op.phase) >= ONLINE_ORDER.indexOf(phase);

/** The online counterpart of `copyAndCutover`: prepares the target, replicates, pauses and fences, then switches the placement. Re-running is safe: each phase is skipped once
 * recorded, and the pause recognises that the source schema was already renamed. */
async function copyAndCutoverOnline(m: Management, op: Move, run: MoveRun, options: ResumeOptions) {
  const { source: from, targetDatabaseId, tenantId } = op;
  const [source, target] = [m.pools.node(from.databaseId), m.pools.node(targetDatabaseId)];
  const placement = await m.platform.get(tenantId);
  if (placement.databaseId === targetDatabaseId && placement.placementVersion === from.placementVersion + 1) return placement;
  const onSource = placement.databaseId === from.databaseId && placement.placementVersion === from.placementVersion;
  if (!onSource || !["active", "migrating"].includes(placement.status)) throw ownershipChanged();
  await assertPlacementOwner(m, op, placement);
  const schema = from.schemaName;
  const name = replicationName(op.id);
  const settings: OnlineSettings & OnlineOptions = { ...ONLINE_DEFAULTS, ...definedOnly(options) };
  const fenced = !(await schemaExists(source, schema)) && (await schemaExists(source, movedSchemaName(schema, op.id)));
  if (!fenced) {
    if (!phaseReached(op, "prepared")) {
      await checkOnlinePrerequisites(source, target);
      assertCompatible(...(await Promise.all([serverFacts(source), serverFacts(target)])));
      await reserveTarget(target, op, schema);
      await dropTarget(m, op, placement, run.assertOwned);
      await createHeartbeat(source, schema);
      await source.transaction(async (reader) => {
        const shape = await readSchema(reader, schema);
        await target.transaction((to) => buildSchema(to, schema, shape, async () => {}, run.signal), { statementTimeoutMs: settings.syncTimeoutMs, lockTimeoutMs: 1000 });
      }, snapshotTransaction(settings.syncTimeoutMs));
      await run.checkpoint("prepared");
    }
    const tables = await listTables(source, schema);
    if (!phaseReached(op, "replicating")) {
      await startReplication(source, target, schema, tables, name, options.sourceUrlForTarget);
      await waitInitialSync(target.pool, name, tables.length + 1, settings.syncTimeoutMs, run.signal); // the tables and the heartbeat table
      await run.checkpoint("replicating");
    }
    await waitCaughtUp(source.pool, target.pool, schema, name, settings.maxLagMs, settings.syncTimeoutMs, run.signal);
    // Counting rows inside the pause costs time proportional to the size; "auto" does it only for small schemas.
    const compare = settings.verify === "counts" || ((settings.verify ?? "auto") === "auto" && (await schemaBytes(source, schema)) <= settings.verifyBelowBytes);
    await pauseAndFence(m, op, run, settings, tables, compare);
    await run.checkpoint("paused");
  }
  return cutover(m, op, run);
}

/** The write pause. In one source transaction: lock every table (`SHARE ROW EXCLUSIVE`: writes wait, reads continue), mark the placement `migrating` (processes with a
 * placement hook stop sending writes), wait for the subscriber to apply the current WAL position, copy the sequences, compare row counts, rename the schema and commit.
 * A lock timeout is retried (the tables were busy with a long transaction); any other failure rolls everything back, and the placement goes back to `active`. */
async function pauseAndFence(m: Management, op: Move, run: MoveRun, settings: OnlineSettings & OnlineOptions, tables: readonly string[], compare: boolean) {
  const { source: from, tenantId } = op;
  const schema = from.schemaName;
  const retained = movedSchemaName(schema, op.id);
  const name = replicationName(op.id);
  const source = m.pools.node(from.databaseId);
  const target = m.pools.node(op.targetDatabaseId);
  const setStatus = async (status: "migrating" | "active") => {
    await claim(
      m.pools.platform,
      "UPDATE platform.placements SET status=$1 WHERE tenant_id=$2 AND database_id=$3 AND placement_version=$4 AND move_operation_id=$5 AND status IN ('active','migrating') RETURNING 1",
      [status, tenantId, from.databaseId, from.placementVersion, op.id],
      ownershipChanged,
    );
    await m.platform.changed(tenantId);
  };
  for (let attempt = 1; ; attempt++) {
    await run.assertOwned();
    let paused = false;
    try {
      const pauseMs = await source.transaction(
        async (tx) => {
          await lockTables(tx, schema, tables);
          const started = performance.now();
          await setStatus("migrating");
          paused = true;
          // A heartbeat committed now follows every replicated write; when the target has it, the target has them all.
          await waitHeartbeat(source.pool, target.pool, schema, name, settings.applyTimeoutMs, run.signal);
          await syncSequences(tx, target, schema);
          if (compare) await compareCounts(tx, target, schema, tables);
          await tx.exec(`ALTER SCHEMA ${quoteIdentifier(schema)} RENAME TO ${quoteIdentifier(retained)}`);
          return performance.now() - started;
        },
        { statementTimeoutMs: Math.max(m.config.migrationStatementTimeoutMs, settings.applyTimeoutMs * 2), lockTimeoutMs: settings.lockTimeoutMs },
      );
      m.emit({ name: "move.pause", ms: pauseMs, tenantId, detail: compare ? "row counts compared" : "row counts not compared" });
      return;
    } catch (error) {
      // The transaction rolled back, so nothing is renamed: let requests through again.
      if (paused) await setStatus("active").catch(() => {});
      if (errorCode(error) === "55P03" && attempt < settings.lockAttempts) {
        await sleep(200 * attempt, undefined, { signal: run.signal });
        continue;
      }
      throw error;
    }
  }
}

/** Reserves the target schema name for this move; a schema that was not reserved is never claimed (e.g. a source copy left over from a previous move). */
async function reserveTarget(target: Queryable, op: Move, schema: string) {
  const [reservation] = await target.query<{ operationId: string; schemaName: string }>(
    `SELECT operation_id AS "operationId",schema_name AS "schemaName" FROM platform.move_targets WHERE tenant_id=$1`,
    [op.tenantId],
  );
  if (reservation) {
    if (reservation.operationId !== op.id || reservation.schemaName !== schema) throw new AppError("TARGET_RESERVED", "Target belongs to another retained move");
    return;
  }
  if (await schemaExists(target, schema))
    throw new AppError(
      "TARGET_EXISTS",
      `Target schema exists; review the retained copy on ${op.targetDatabaseId}, then run DROP SCHEMA ${quoteIdentifier(schema)} CASCADE there and retry`,
    );
  await target.query("INSERT INTO platform.move_targets(tenant_id,operation_id,schema_name) VALUES ($1,$2,$3)", [op.tenantId, op.id, schema]);
}

/** Sets the source placement to `migrating` and waits for the cached `active` records to expire. */
async function enterMaintenance(m: Management, op: Move, { assertOwned, checkpoint, signal }: MoveRun) {
  const { source: from, tenantId } = op;
  await assertOwned();
  await claim(
    m.pools.platform,
    "UPDATE platform.placements SET status='migrating' WHERE tenant_id=$1 AND database_id=$2 AND placement_version=$3 AND move_operation_id=$4 AND status IN ('active','migrating') RETURNING 1",
    [tenantId, from.databaseId, from.placementVersion, op.id],
    ownershipChanged,
  );
  await m.platform.changed(tenantId);
  // Processes without onPlacementChange (e.g. a CLI move) drop the cached `active` placement before the data is copied.
  await sleep(m.config.placementCacheWaitMs, undefined, { signal });
  await checkpoint("maintenance");
}

/** Deletes the old copy on the target, copies the schema and compares the fingerprints on both sides. */
async function copyAndValidate(m: Management, op: Move, source: Database, target: Database, run: MoveRun) {
  const { assertOwned, checkpoint, signal } = run;
  const schema = op.source.schemaName;
  const expected = await fingerprint(source, schema);
  await assertOwned();
  await dropTarget(m, op, { ...op.source, status: "migrating" }, assertOwned);
  await checkpoint("copying");
  await copySchema(source, target, schema, undefined, signal);
  await assertOwned();
  if ((await fingerprint(target, schema)) !== expected) throw new AppError("COPY_MISMATCH", "Source and target validation differ");
  await checkpoint("validated", expected);
}

/** Moves the placement to the target DB in `maintenance` status (version +1) and returns the new placement. */
async function cutover(m: Management, op: Move, { assertOwned, checkpoint }: MoveRun) {
  const { source: from, targetDatabaseId, tenantId } = op;
  await assertOwned();
  // The target must still be in the tenant's residency zone when the placement switches (a zone change on the target in the meantime is refused here).
  const switched = await m.pools.platform.query(
    `UPDATE platform.placements p SET database_id=$1,placement_version=placement_version+1,status='maintenance'
     WHERE p.tenant_id=$2 AND p.placement_version=$3 AND p.move_operation_id=$4 AND p.status='migrating'
       AND (p.residency_zone IS NULL OR EXISTS (SELECT 1 FROM platform.nodes n WHERE n.database_id=$1 AND n.residency_zone=p.residency_zone)) RETURNING 1`,
    [targetDatabaseId, tenantId, from.placementVersion, op.id],
  );
  if (switched.length !== 1) {
    const [still] = await m.pools.platform.query(
      "SELECT 1 FROM platform.placements WHERE tenant_id=$1 AND placement_version=$2 AND move_operation_id=$3 AND status='migrating'",
      [tenantId, from.placementVersion, op.id],
    );
    throw still ? new AppError("RESIDENCY_VIOLATION", `${targetDatabaseId} is no longer in the tenant's residency zone`) : ownershipChanged();
  }
  await m.platform.changed(tenantId);
  await checkpoint("cutover");
  return m.platform.get(tenantId);
}

/** Renames the source schema to `movedSchemaName` once the placement points at the target. A process that still caches the old placement
 * then gets `undefined_table` instead of silently writing to a copy nobody reads; the data stays inspectable under the new name. Re-running is
 * safe: a missing source schema (already renamed or dropped) is skipped. */
async function fence(m: Management, op: Move, { assertOwned, checkpoint }: MoveRun) {
  const { schemaName: from, databaseId } = op.source;
  const retained = movedSchemaName(from, op.id);
  await assertOwned();
  await m.pools.node(databaseId).transaction(async (tx) => {
    if (!(await schemaExists(tx, from))) return;
    if (await schemaExists(tx, retained)) throw new AppError("INVALID_DATABASE_STATE", `Cannot fence ${databaseId}: ${retained} already exists`);
    await tx.exec(`ALTER SCHEMA ${quoteIdentifier(from)} RENAME TO ${quoteIdentifier(retained)}`);
  });
  await checkpoint("fenced");
}

export function rollbackMove(m: Management, id: string, writersDrained?: boolean, options: { online?: boolean } = {}): Promise<void> {
  return withMove(m, id, writersDrained, async (op, assertLocks) => {
    if (!["failed", "running"].includes(op.status)) throw new AppError("ROLLBACK_NOT_ALLOWED", "No failed pre-cutover move to roll back");
    const current = await m.platform.get(op.tenantId);
    if (current.databaseId !== op.source.databaseId || current.placementVersion !== op.source.placementVersion)
      throw new AppError("ROLLBACK_NOT_ALLOWED", "Cutover occurred; reverse data migration is required");
    if (!["active", "migrating"].includes(current.status)) throw ownershipChanged();
    await assertLocks();
    if (op.online) {
      // Stop the replication, and give the tenant its own schema name back if the pause had already renamed it (nothing can have written to it since).
      await teardownReplication(m.pools.node(op.source.databaseId), m.pools.node(op.targetDatabaseId), replicationName(op.id));
      await unfence(m, op);
    }
    await dropTarget(m, op, current, assertLocks, true);
    await activate(m, op, current, (tx) =>
      claim(
        tx,
        "UPDATE platform.moves SET status='rolled-back',phase='rolled-back',updated_at=now() WHERE id=$1 AND status IN ('failed','running') RETURNING 1",
        [op.id],
        () => recordChanged("completion"),
      ),
    );
  }, options.online === true);
}

/** Gives the source schema its own name back when a pause renamed it; a no-op otherwise. */
async function unfence(m: Management, op: Move) {
  const { schemaName: schema, databaseId } = op.source;
  const retained = movedSchemaName(schema, op.id);
  await m.pools.node(databaseId).transaction(async (tx) => {
    if ((await schemaExists(tx, retained)) && !(await schemaExists(tx, schema))) await tx.exec(`ALTER SCHEMA ${quoteIdentifier(retained)} RENAME TO ${quoteIdentifier(schema)}`);
  });
  // The heartbeat table was only needed for the move.
  await dropHeartbeat(m.pools.node(databaseId), schema).catch(() => {});
}

/** Deletes this operation's unpublished target copy, re-checking the durable ownership under the reservation row lock
 * (checkpoints do not authorize deletion); `release` also releases the reservation. */
async function dropTarget(m: Management, op: Move, source: Placement, assertOwned: Check, release = false) {
  const schema = op.source.schemaName;
  await m.pools.node(op.targetDatabaseId).transaction(async (tx) => {
    const owned = await tx.query(
      "SELECT tenant_id FROM platform.move_targets WHERE tenant_id=$1 AND operation_id=$2 AND schema_name=$3 FOR UPDATE",
      [op.tenantId, op.id, schema],
    );
    if (owned.length !== 1) {
      if (release) return;
      throw new AppError("TARGET_RESERVED", "Target reservation ownership changed");
    }
    await assertOwned();
    await assertPlacementOwner(m, op, source);
    await tx.exec(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    if (release) await tx.query("DELETE FROM platform.move_targets WHERE tenant_id=$1", [op.tenantId]);
  });
}

/** Activates the placement and clears move_operation_id in the same transaction as the move's final record. */
async function activate(m: Management, op: Move, p: Placement, finish: (tx: Connection) => Promise<void>) {
  await m.pools.platform.transaction(async (tx) => {
    await claim(
      tx,
      "UPDATE platform.placements SET status='active',move_operation_id=NULL WHERE tenant_id=$1 AND database_id=$2 AND placement_version=$3 AND status=$4 AND move_operation_id=$5 RETURNING 1",
      [p.tenantId, p.databaseId, p.placementVersion, p.status, op.id],
      ownershipChanged,
    );
    await finish(tx);
  });
  await m.platform.changed(p.tenantId);
}
