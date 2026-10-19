/** Moves a tenant to another database; continues an interrupted move or rolls it back before the DB switch.
 *
 * Flow: planned → maintenance (placement `migrating`) → copying → validated → cutover (placement `maintenance` on the target) →
 * fenced (the source schema is renamed, so a writer holding a stale placement fails with 42P01) → completed (placement `active`). Every
 * step runs under the tenant lock, the node locks, and the ownership of placement.move_operation_id and moves.owner_id. */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { type Database, stopwatch } from "../database";
import type { Connection } from "../driver";
import { AppError, errorCode, parseDatabaseValue } from "../errors";
import type { Management } from "../management";
import { ownershipCheck, withNodeLocks, withTenantLock } from "../operations/locks";
import { movedSchemaName, type Placement, placementSchema, quoteIdentifier } from "../tenants/model";
import { schemaExists } from "../tenants/nodes";
import { copySchema, fingerprint } from "./copy";

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
    `SELECT id,tenant_id AS "tenantId",target_database_id AS "targetDatabaseId",source,owner_id AS "ownerId",status,phase,fingerprint,error FROM platform.moves WHERE id=$1`,
    [id],
  );
  if (!row) throw new AppError("MOVE_NOT_FOUND", "Move not found");
  const move = parseDatabaseValue(moveSchema, row);
  if (move.source.tenantId !== move.tenantId) throw new AppError("INVALID_DATABASE_STATE", "Invalid source recovery state");
  return move;
}

/** Runs `work` under the maintenance declaration, the tenant lock and two node locks; the move record is re-read inside the tenant lock. */
type MoveWork<T> = (op: Move, assertLocks: Check, signal: AbortSignal) => Promise<T>;
async function withMove<T>(m: Management, id: string, writersDrained: boolean | undefined, work: MoveWork<T>) {
  requireMaintenance(writersDrained);
  const { tenantId } = await getMove(m, id);
  return withTenantLock(m, tenantId, async (assertTenant, tenantSignal) => {
    const op = await getMove(m, id);
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

export async function startMove(m: Management, tenantId: string, targetDatabaseId: string, writersDrained?: boolean, onStarted?: (move: Move) => void) {
  requireMaintenance(writersDrained);
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
    await assertLock();
    const moveId = crypto.randomUUID();
    await m.pools.platform.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO platform.moves(id,tenant_id,target_database_id,source,status) VALUES ($1,$2,$3,$4::text::jsonb,'running')",
        [moveId, tenantId, targetDatabaseId, JSON.stringify(source)],
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
  return resumeMove(m, id, writersDrained);
}

export function resumeMove(m: Management, id: string, writersDrained?: boolean) {
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
      const placement = await copyAndCutover(m, op, run);
      await fence(m, op, run);
      await assertOwned();
      // The target schema is live now; release the reservation so a later move back is not blocked.
      await m.pools.node(op.targetDatabaseId).query("DELETE FROM platform.move_targets WHERE tenant_id=$1 AND operation_id=$2", [op.tenantId, id]);
      await activate(m, op, placement, (tx) => claim(tx, COMPLETE_MOVE, [id, ownerId], () => recordChanged("completion")));
      return await getMove(m, id);
    } catch (error) {
      await platform.query(FAIL_MOVE, [errorCode(error), id, ownerId]).catch(() => {});
      throw error;
    }
  });
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
  await claim(
    m.pools.platform,
    "UPDATE platform.placements SET database_id=$1,placement_version=placement_version+1,status='maintenance' WHERE tenant_id=$2 AND placement_version=$3 AND move_operation_id=$4 AND status='migrating' RETURNING 1",
    [targetDatabaseId, tenantId, from.placementVersion, op.id],
    ownershipChanged,
  );
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

export function rollbackMove(m: Management, id: string, writersDrained?: boolean): Promise<void> {
  return withMove(m, id, writersDrained, async (op, assertLocks) => {
    if (!["failed", "running"].includes(op.status)) throw new AppError("ROLLBACK_NOT_ALLOWED", "No failed pre-cutover move to roll back");
    const current = await m.platform.get(op.tenantId);
    if (current.databaseId !== op.source.databaseId || current.placementVersion !== op.source.placementVersion)
      throw new AppError("ROLLBACK_NOT_ALLOWED", "Cutover occurred; reverse data migration is required");
    if (!["active", "migrating"].includes(current.status)) throw ownershipChanged();
    await assertLocks();
    await dropTarget(m, op, current, assertLocks, true);
    await activate(m, op, current, (tx) =>
      claim(
        tx,
        "UPDATE platform.moves SET status='rolled-back',phase='rolled-back',updated_at=now() WHERE id=$1 AND status IN ('failed','running') RETURNING 1",
        [op.id],
        () => recordChanged("completion"),
      ),
    );
  });
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
