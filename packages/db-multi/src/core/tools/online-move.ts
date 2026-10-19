/** Building blocks of `move --online`: a tenant schema is copied to another database by PostgreSQL logical replication while it keeps taking writes, and the
 * write pause is limited to the final catch-up. The orchestration (phases, ownership, placement) is in `move.ts`.
 *
 * The order inside the pause matters and was found by experiment (bench/online-move-spike.ts):
 *  1. every table of the schema is locked `SHARE ROW EXCLUSIVE` in one transaction on the source: writes wait, reads continue;
 *  2. the subscriber is awaited until it has applied everything up to the source's current position, sequence values are copied and row counts compared;
 *  3. only then the schema is renamed (the fence) and the transaction commits.
 * "Applied everything" is proven by a heartbeat row, not by comparing WAL positions: the source server also writes WAL that is not replicated (on `db0` the directory
 * itself), so its current position can lie beyond anything the subscriber will ever apply. A row inserted into a replicated table after the locks are held commits
 * after every replicated change that came before it; when it shows up on the target, everything before it has been applied.
 * Renaming earlier breaks replication: the publisher sends the schema's *current* name, so changes committed before the rename but not yet applied fail on the
 * subscriber ("target relation ... does not exist"). A writer that was waiting on the locks re-resolves the table name after the commit and fails with
 * `undefined_table`; it can not write to the abandoned copy. */
import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "../database";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { qualified, quoteIdentifier } from "../tenants/model";

type Queryable = Pick<Connection, "query">;

/** Names of the publication, subscription and replication slot of one move (all the same, derived from the move id). */
export const replicationName = (operationId: string) => `pgcells_${operationId.replaceAll("-", "").slice(0, 16)}`;

export interface OnlineOptions {
  /** The source database as the **target server** can reach it (a direct connection, not a pooler): `postgres://user:password@host:port/db`. The password is stored
   * by PostgreSQL in the subscription and never by pgcells; it is only needed to create the subscription, not to resume later. */
  sourceUrlForTarget?: string;
  /** `"auto"` (default): compare row counts inside the pause when the schema is smaller than `verifyBelowBytes`, skip it otherwise; `"counts"`: always compare (the cost
   * grows with the size and is paid inside the write pause: about 10 s for 1 GB in the spike); `"none"`: never. */
  verify?: "auto" | "counts" | "none";
  /** The size under which `"auto"` compares row counts (default 256 MiB). */
  verifyBelowBytes?: number;
  /** Longest wait for the initial copy of every table (default one hour). */
  syncTimeoutMs?: number;
  /** The subscriber must answer a heartbeat within this many milliseconds before the pause starts (default 1000). */
  maxLagMs?: number;
  /** `lock_timeout` for taking the table locks and how many times a lock timeout is retried (defaults 2000 ms, 5 attempts). */
  lockTimeoutMs?: number;
  lockAttempts?: number;
}

/** The numeric settings with their defaults; `applyTimeoutMs` bounds the wait for the subscriber inside the pause. */
export interface OnlineSettings {
  verifyBelowBytes: number;
  syncTimeoutMs: number;
  maxLagMs: number;
  lockTimeoutMs: number;
  lockAttempts: number;
  applyTimeoutMs: number;
}
export const ONLINE_DEFAULTS: OnlineSettings = { verifyBelowBytes: 268_435_456, syncTimeoutMs: 3_600_000, maxLagMs: 1000, lockTimeoutMs: 2000, lockAttempts: 5, applyTimeoutMs: 60_000 };

const unsupported = (message: string) => new AppError("UNSUPPORTED_MOVE", message);

/** The server settings and privileges that logical replication needs, with the reason when one is missing. */
export async function checkOnlinePrerequisites(source: Queryable, target: Queryable) {
  const [from] = await source.query<{ level: string; version: number; slots: number; free: number; senders: number }>(
    `SELECT pg_catalog.current_setting('wal_level') AS level, pg_catalog.current_setting('server_version_num')::integer AS version,
       pg_catalog.current_setting('max_replication_slots')::integer AS slots,
       pg_catalog.current_setting('max_replication_slots')::integer - (SELECT count(*)::integer FROM pg_catalog.pg_replication_slots) AS free,
       pg_catalog.current_setting('max_wal_senders')::integer AS senders`,
  );
  const [to] = await target.query<{ version: number; workers: number; allowed: boolean }>(
    `SELECT pg_catalog.current_setting('server_version_num')::integer AS version, pg_catalog.current_setting('max_logical_replication_workers')::integer AS workers,
       (SELECT r.rolsuper OR pg_catalog.pg_has_role(r.oid, 'pg_create_subscription', 'member') FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS allowed`,
  ).catch(async () => {
    // PostgreSQL 15 has no pg_create_subscription role: only superusers may create subscriptions.
    return target.query<{ version: number; workers: number; allowed: boolean }>(
      `SELECT pg_catalog.current_setting('server_version_num')::integer AS version, pg_catalog.current_setting('max_logical_replication_workers')::integer AS workers,
         (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) AS allowed`,
    );
  });
  if (!from || !to) throw new AppError("COPY_FAILED", "Server settings unavailable");
  if (from.version < 150000 || to.version < 150000) throw unsupported("Online move needs PostgreSQL 15 or newer on both sides (publications for all tables in a schema)");
  if (from.level !== "logical") throw unsupported(`The source has wal_level=${from.level}; online move needs wal_level=logical (a restart; on managed services a parameter group or flag)`);
  if (from.free < 1 || from.senders < 1) throw unsupported("The source has no free replication slot or WAL sender (max_replication_slots / max_wal_senders)");
  if (to.workers < 2) throw unsupported("The target needs max_logical_replication_workers of at least 2");
  if (!to.allowed) throw unsupported("The management role of the target may not create subscriptions (superuser, or pg_create_subscription on PostgreSQL 16)");
}

/** The heartbeat table every online move adds to the tenant schema on both sides before replication starts, and removes from the target at the end. */
export const HEARTBEAT_TABLE = "_pgcells_hb";

/** The schema's table names (ordinary tables only; the schema was already validated as copyable), without the heartbeat table. */
export async function listTables(db: Queryable, schema: string): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    "SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r' AND c.relname<>$2 ORDER BY c.relname",
    [schema, HEARTBEAT_TABLE],
  );
  return rows.map((row) => row.name);
}

/** Adds the heartbeat table to the source schema (before the target structure is read, so the target gets it too). */
export const createHeartbeat = (source: Database, schema: string) => source.pool.exec(`CREATE TABLE IF NOT EXISTS ${qualified(schema, HEARTBEAT_TABLE)} (n bigint PRIMARY KEY)`);

/** Removes it again from the target; a failure is reported by the caller, not thrown here. */
export const dropHeartbeat = (target: Database, schema: string) => target.pool.exec(`DROP TABLE IF EXISTS ${qualified(schema, HEARTBEAT_TABLE)}`);

let beats = 0;
/** Inserts a heartbeat on the source (a separate autocommit statement, so it commits after everything replicated before it) and returns its number. */
async function beat(source: Queryable, schema: string): Promise<string> {
  const n = `${Date.now()}${String(++beats % 1000).padStart(3, "0")}`;
  await source.query(`INSERT INTO ${qualified(schema, HEARTBEAT_TABLE)} (n) VALUES ($1::bigint) ON CONFLICT DO NOTHING`, [n]);
  return n;
}

/** Tables without a primary key need `REPLICA IDENTITY FULL` to replicate updates and deletes; this changes the source table's property (it is not reverted). */
async function ensureReplicaIdentity(source: Database, schema: string, tables: readonly string[]) {
  const rows = await source.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relkind='r' AND c.relreplident='d' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid AND i.indisprimary)`,
    [schema],
  );
  for (const { name } of rows) if (tables.includes(name)) await source.pool.exec(`ALTER TABLE ${qualified(schema, name)} REPLICA IDENTITY FULL`);
}

const exists = async (db: Queryable, sql: string, values: unknown[]) => (await db.query(sql, values)).length > 0;

/** Creates the publication on the source and the subscription on the target (copying existing rows); does nothing for what exists. The statements run on the raw pools: they
 * can not run in a transaction block. */
export async function startReplication(source: Database, target: Database, schema: string, tables: readonly string[], name: string, sourceUrlForTarget: string | undefined) {
  await ensureReplicaIdentity(source, schema, tables);
  if (!(await exists(source, "SELECT 1 FROM pg_catalog.pg_publication WHERE pubname=$1", [name])))
    await source.pool.exec(`CREATE PUBLICATION ${quoteIdentifier(name)} FOR TABLES IN SCHEMA ${quoteIdentifier(schema)}`);
  if (await exists(target, "SELECT 1 FROM pg_catalog.pg_subscription WHERE subname=$1", [name])) return;
  if (!sourceUrlForTarget) throw new AppError("ONLINE_SOURCE_URL_REQUIRED", "Creating the subscription needs the source URL as the target server sees it");
  const url = URL.parse(sourceUrlForTarget);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) throw new AppError("INVALID_CONFIG", "The source URL for the target must be postgres://…");
  const [{ literal } = { literal: "" }] = await target.query<{ literal: string }>("SELECT pg_catalog.quote_literal($1::text) AS literal", [url.href]);
  await target.pool.exec(`CREATE SUBSCRIPTION ${quoteIdentifier(name)} CONNECTION ${literal} PUBLICATION ${quoteIdentifier(name)} WITH (copy_data = true)`);
}

const SUBSCRIPTION_STATE = `SELECT count(*) FILTER (WHERE r.srsubstate <> 'r')::integer AS pending, count(*)::integer AS total
  FROM pg_catalog.pg_subscription_rel r JOIN pg_catalog.pg_subscription s ON s.oid=r.srsubid WHERE s.subname=$1`;
const SUBSCRIPTION_ERRORS = "SELECT COALESCE(sum(apply_error_count + sync_error_count),0)::integer AS errors FROM pg_catalog.pg_stat_subscription_stats WHERE subname=$1";

async function assertNoReplicationErrors(target: Queryable, name: string) {
  const [row] = await target.query<{ errors: number }>(SUBSCRIPTION_ERRORS, [name]);
  if ((row?.errors ?? 0) > 0)
    throw new AppError("ONLINE_REPLICATION_FAILED", `The subscription ${name} reported errors on the target; see the PostgreSQL log of the target (and roll back with rollback-move)`);
}

/** Polls `check` until it is true; fails with `ONLINE_TIMEOUT` after `timeoutMs`. Subscription errors abort the wait. */
async function until(what: string, check: () => Promise<boolean>, timeoutMs: number, signal: AbortSignal, target: Queryable, name: string, stepMs = 100) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    if (await check()) return;
    await assertNoReplicationErrors(target, name);
    if (performance.now() > deadline) throw new AppError("ONLINE_TIMEOUT", `Timed out waiting for ${what}`);
    await sleep(stepMs, undefined, { signal });
  }
}

/** Waits until every table of the subscription has finished its initial copy. */
export function waitInitialSync(target: Queryable, name: string, tableCount: number, timeoutMs: number, signal: AbortSignal) {
  return until(
    "the initial copy",
    async () => {
      const [state] = await target.query<{ pending: number; total: number }>(SUBSCRIPTION_STATE, [name]);
      return !!state && state.total === tableCount && state.pending === 0;
    },
    timeoutMs,
    signal,
    target,
    name,
    200,
  );
}

/** Waits until a heartbeat inserted on the source now has reached the target: everything replicated before it has been applied. */
export async function waitHeartbeat(source: Queryable, target: Queryable, schema: string, name: string, timeoutMs: number, signal: AbortSignal) {
  const n = await beat(source, schema);
  await until(
    "the subscriber to apply the heartbeat",
    async () => (await target.query(`SELECT 1 FROM ${qualified(schema, HEARTBEAT_TABLE)} WHERE n=$1::bigint`, [n])).length > 0,
    timeoutMs,
    signal,
    target,
    name,
    3,
  );
}

/** Waits until a heartbeat comes back within `maxLagMs`, so the pause that follows is short. */
export async function waitCaughtUp(source: Queryable, target: Queryable, schema: string, name: string, maxLagMs: number, timeoutMs: number, signal: AbortSignal) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const started = performance.now();
    await waitHeartbeat(source, target, schema, name, Math.max(maxLagMs, 1000), signal);
    if (performance.now() - started <= maxLagMs) return;
    if (performance.now() > deadline) throw new AppError("ONLINE_TIMEOUT", `The subscriber did not catch up to within ${maxLagMs} ms`);
  }
}

/** Locks every table `SHARE ROW EXCLUSIVE`: writes wait, reads continue. Runs inside the pause transaction; `lock_timeout` makes it fail fast instead of queueing every writer
 * behind a long transaction. */
export const lockTables = (tx: Pick<Connection, "exec">, schema: string, tables: readonly string[]) =>
  tx.exec(`LOCK TABLE ${tables.map((table) => qualified(schema, table)).join(", ")} IN SHARE ROW EXCLUSIVE MODE`);

/** Copies every sequence's state from the source (read inside the pause) to the target; logical replication does not carry sequences. */
export async function syncSequences(source: Queryable, target: Queryable, schema: string) {
  const sequences = await source.query<{ name: string }>(
    "SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S' ORDER BY c.relname",
    [schema],
  );
  for (const { name } of sequences) {
    const identifier = qualified(schema, name);
    const [state] = await source.query<{ last: string; called: boolean }>(`SELECT last_value::text AS last, is_called AS called FROM ${identifier}`);
    if (!state) throw new AppError("COPY_FAILED", "Sequence state unavailable");
    await target.query("SELECT pg_catalog.setval($1::pg_catalog.regclass, $2::pg_catalog.int8, $3::boolean)", [identifier, state.last, state.called]);
  }
}

/** Row counts of every table on both sides must be equal (`COPY_MISMATCH` otherwise). Cost grows with the size of the tenant. */
export async function compareCounts(source: Queryable, target: Queryable, schema: string, tables: readonly string[]) {
  for (const table of tables) {
    const sql = `SELECT count(*)::text AS n FROM ${qualified(schema, table)}`;
    const [from, to] = await Promise.all([source.query<{ n: string }>(sql), target.query<{ n: string }>(sql)]);
    if (from[0]?.n !== to[0]?.n) throw new AppError("COPY_MISMATCH", `Table ${table} has ${from[0]?.n} rows on the source and ${to[0]?.n} on the target`);
  }
}

/** Removes the subscription (and so its slot), then the publication; safe to repeat. The slot is dropped by hand if the subscription could not (source unreachable
 * while dropping). A failure is reported, not thrown: it leaves a replication slot behind that holds WAL, so the message names what to drop. */
export async function teardownReplication(source: Database, target: Database, name: string): Promise<string | undefined> {
  const problems: string[] = [];
  try {
    if (await exists(target, "SELECT 1 FROM pg_catalog.pg_subscription WHERE subname=$1", [name])) {
      const identifier = quoteIdentifier(name);
      await target.pool.exec(`ALTER SUBSCRIPTION ${identifier} DISABLE`);
      await target.pool.exec(`ALTER SUBSCRIPTION ${identifier} SET (slot_name = NONE)`);
      await target.pool.exec(`DROP SUBSCRIPTION ${identifier}`);
    }
  } catch (error) {
    problems.push(`drop subscription ${name} on the target (${(error as { code?: string }).code ?? "error"})`);
  }
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const [slot] = await source.query<{ active_pid: number | null }>("SELECT active_pid FROM pg_catalog.pg_replication_slots WHERE slot_name=$1", [name]);
      if (!slot) break;
      if (slot.active_pid) {
        await sleep(100);
        continue;
      }
      await source.query("SELECT pg_catalog.pg_drop_replication_slot($1)", [name]);
      break;
    }
    await source.pool.exec(`DROP PUBLICATION IF EXISTS ${quoteIdentifier(name)}`);
  } catch (error) {
    problems.push(`drop replication slot and publication ${name} on the source (${(error as { code?: string }).code ?? "error"})`);
  }
  return problems.length ? `Clean up by hand: ${problems.join("; ")}` : undefined;
}

/** Total size of the schema's tables with their indexes, in bytes. */
export async function schemaBytes(db: Queryable, schema: string): Promise<number> {
  const [row] = await db.query<{ bytes: string }>(
    "SELECT COALESCE(sum(pg_catalog.pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'",
    [schema],
  );
  return Number(row?.bytes ?? 0);
}
