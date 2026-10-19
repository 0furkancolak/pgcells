/** `--from-replica` source: direct replica URLs from hidden input (`db0=url,…`). One replica is opened and verified for each node entered:
 * a direct connection (not a pooler), really a replica (`pg_is_in_recovery`), lag below the threshold. Data is read only from this
 * replica; placement and platform records are read from the primary (the caller's job). Messages contain no URL, host or user. */
import { setTimeout } from "node:timers/promises";
import { createConfig } from "../config";
import { connect, type Database } from "../database";
import { AppError, databaseUnavailable, errorCode } from "../errors";
import type { Management } from "../management";
import { usesTransactionPooler } from "../tenants/pooler";
import { probeReplica } from "../tenants/replicas";

const DIRECT_PROBE_DEADLINE_MS = 10_000;
/** The standby's conflict counters (per instance, not replicated): if they increased during a read, a conflict cut the connection. */
const CONFLICTS =
  "SELECT (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock)::pg_catalog.text AS n FROM pg_catalog.pg_stat_database_conflicts WHERE datname = pg_catalog.current_database()";
const PRIMARY_LSN = "SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn";
const REPLAYED_UP_TO = "SELECT pg_catalog.pg_last_wal_replay_lsn() >= $1::pg_catalog.pg_lsn AS ok, pg_catalog.pg_last_wal_replay_lsn()::pg_catalog.text AS lsn";
const CATCH_UP_POLL_MS = 100;
const REPLAY_LSN = "SELECT pg_catalog.pg_last_wal_replay_lsn()::text AS lsn";

export interface ReplicaSource {
  has(databaseId: string): boolean;
  node(databaseId: string): Database;
  /** WAL position the replica had replayed at open (written to the backup manifest: the start of the set). */
  replayLsn(databaseId: string): string;
  /** Waits until the replica replays the primary's current WAL position (at most `replicaMaxLagMs`, then `REPLICA_LAG_EXCEEDED`) and
   * returns the replica's position at that moment. Called before a tenant is read: proves that the placement and the schema reached the replica
   * and how fresh the data being read is. */
  catchUp(databaseId: string): Promise<string>;
  close(): Promise<void>;
}

/** A recovery conflict can cancel a long snapshot on the replica (`max_standby_streaming_delay`): SQLSTATE 40001 and "conflict with recovery". */
export function replicaConflict(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  if (errorCode(error) === "40001" && /conflict with recovery/i.test(message))
    return new AppError("REPLICA_CONFLICT", "The replica canceled the read because of a recovery conflict; retry or take the export from the primary");
  return error;
}

const conflictCount = async (db: Database) => Number((await db.query<{ n: string }>(CONFLICTS))[0]?.n ?? 0);
/** When the standby terminates an idle connection that holds a snapshot, drivers give only a generic connection error (codeless or
 * `CONNECTION_CLOSED`). Application errors, file system errors and SQL errors with a meaningful SQLSTATE do not count as conflicts. */
const maybeConflict = (error: unknown) => !(error instanceof AppError) && (databaseUnavailable(error) || errorCode(error) === "OPERATION_FAILED");

/** Replica connection: a SQLSTATE 40001 conflict becomes `REPLICA_CONFLICT` (on the query, exec and transaction paths). In a transaction, additionally,
 * if the standby conflict counter read at the start increased at the time of the error (even if the driver did not give the SQLSTATE), the cause is a conflict. */
function mapConflicts(db: Database): Database {
  const rethrow = (error: unknown): never => {
    throw replicaConflict(error);
  };
  return {
    ...db,
    query: ((text: string, params?: readonly unknown[], tenantId?: string) => db.query(text, params, tenantId).catch(rethrow)) as Database["query"],
    exec: (sql) => db.exec(sql).catch(rethrow),
    transaction: (async (work, options) => {
      const before = await conflictCount(db).catch(() => undefined);
      try {
        return await db.transaction(work, options);
      } catch (error) {
        const mapped = replicaConflict(error);
        if (mapped === error && before !== undefined && maybeConflict(error) && (await conflictCount(db).catch(() => before)) > before)
          throw replicaConflict(Object.assign(new Error("conflict with recovery"), { code: "40001" }));
        throw mapped;
      }
    }) as Database["transaction"],
  };
}

export async function openReplicaSource(m: Management, entries: string): Promise<ReplicaSource> {
  // `createConfig` validates the format, the DB identities and duplicates (a primary URL is rejected as a replica).
  const parsed = createConfig(m.config.nodes.map((node) => node.url), entries);
  const { migrationStatementTimeoutMs, migrationLockTimeoutMs, replicaMaxLagMs } = m.config;
  const databases = new Map<string, Database>();
  const positions = new Map<string, string>();
  const close = async () => {
    await Promise.allSettled([...databases.values()].map((db) => db.close()));
    databases.clear();
  };
  try {
    for (const node of parsed.nodes) {
      const [url, extra] = node.replicas;
      if (extra) throw new AppError("INVALID_CONFIG", `--from-replica takes one direct replica URL per database (${node.id})`);
      if (!url) continue;
      if (await usesTransactionPooler(m.driver, url, { deadlineMs: DIRECT_PROBE_DEADLINE_MS }))
        throw new AppError("DIRECT_CONNECTION_REQUIRED", `The replica URL for ${node.id} must be a direct connection, not a transaction pooler`);
      const db = connect(m.driver(url, { max: 2, idleTimeoutSeconds: 60, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 }), {
        deadlineMs: migrationStatementTimeoutMs,
        timeouts: { statementTimeoutMs: migrationStatementTimeoutMs, lockTimeoutMs: migrationLockTimeoutMs },
        maxPending: 64,
        databaseId: node.id,
      });
      databases.set(node.id, db);
      const probe = await probeReplica(m.pools.node(node.id), db);
      if (!probe.inRecovery) throw new AppError("INVALID_CONFIG", `The replica URL for ${node.id} does not point at a replica`);
      if (probe.lagMs === null || probe.lagMs > replicaMaxLagMs)
        throw new AppError("REPLICA_LAG_EXCEEDED", `The replica for ${node.id} is behind by more than ${replicaMaxLagMs} ms`);
      const [identity] = await db.query<{ database_id: string }>("SELECT database_id FROM platform.node_identity");
      if (identity?.database_id !== node.id) throw new AppError("INVALID_CONFIG", `The replica URL for ${node.id} belongs to another database`);
      positions.set(node.id, (await db.query<{ lsn: string }>(REPLAY_LSN))[0]?.lsn ?? "");
    }
    if (!databases.size) throw new AppError("INVALID_CONFIG", "--from-replica needs at least one db0=postgres://… replica URL");
  } catch (error) {
    await close();
    throw error;
  }
  const mapped = new Map([...databases].map(([id, db]) => [id, mapConflicts(db)]));
  const missing = (id: string): never => {
    throw new AppError("INVALID_CONFIG", `--from-replica has no replica URL for ${id}`);
  };
  return {
    has: (id) => mapped.has(id),
    node: (id) => mapped.get(id) ?? missing(id),
    replayLsn: (id) => positions.get(id) ?? missing(id),
    async catchUp(id) {
      const standby = databases.get(id) ?? missing(id);
      const [position] = await m.pools.node(id).query<{ lsn: string }>(PRIMARY_LSN);
      const deadline = Date.now() + replicaMaxLagMs;
      for (;;) {
        const [row] = await standby.query<{ ok: boolean | null; lsn: string }>(REPLAYED_UP_TO, [position?.lsn]);
        if (row?.ok) return row.lsn;
        if (Date.now() >= deadline) throw new AppError("REPLICA_LAG_EXCEEDED", `The replica for ${id} did not catch up within ${replicaMaxLagMs} ms`);
        await setTimeout(CATCH_UP_POLL_MS);
      }
    },
    close,
  };
}
