/** The `--from-replica` source: a single direct replica URL from hidden input. It is validated: a direct connection (not a pooler), really a
 * replica (`pg_is_in_recovery`), lag below the threshold. Data is read only from this replica. Messages contain no URL, host or user. */
import { setTimeout } from "node:timers/promises";
import { createConfig } from "../config";
import { connect, type Database } from "../database";
import { AppError, databaseUnavailable, driverError, errorCode } from "../errors";
import type { Management } from "../management";
import { usesTransactionPooler } from "../pooler";
import { probeReplica } from "../replicas";

const DIRECT_PROBE_DEADLINE_MS = 10_000;
/** The standby's conflict counters (per instance, not replicated): if they increased during a read, a conflict cut the connection. */
const CONFLICTS =
  "SELECT (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock)::pg_catalog.text AS n FROM pg_catalog.pg_stat_database_conflicts WHERE datname = pg_catalog.current_database()";
const PRIMARY_LSN = "SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn";
const REPLAYED_UP_TO = "SELECT pg_catalog.pg_last_wal_replay_lsn() >= $1::pg_catalog.pg_lsn AS ok, pg_catalog.pg_last_wal_replay_lsn()::pg_catalog.text AS lsn";
const CATCH_UP_POLL_MS = 100;

export interface ReplicaSource {
  /** The sole data source: a replica connection with conflict errors mapped to `REPLICA_CONFLICT`. */
  readonly db: Database;
  /** Waits until the replica replays the primary's current WAL position (at most `replicaMaxLagMs`, then `REPLICA_LAG_EXCEEDED`) and
   * returns the replica's position at that moment: proves that the schema being read reached the replica and the freshness of the data. */
  catchUp(): Promise<string>;
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
 * `CONNECTION_CLOSED`). Application errors, file-system errors and SQL errors with a meaningful SQLSTATE are not counted as conflicts. */
const maybeConflict = (error: unknown) => !(error instanceof AppError) && (databaseUnavailable(error) || errorCode(error) === "OPERATION_FAILED");

/** Replica connection: a SQLSTATE 40001 conflict becomes `REPLICA_CONFLICT` (on the query, exec and transaction paths). In a transaction, additionally,
 * if the standby conflict counter read at the start has increased at the time of the error (even if the driver gave no SQLSTATE), the cause is a conflict. */
function mapConflicts(db: Database): Database {
  const rethrow = (error: unknown): never => {
    throw replicaConflict(error);
  };
  return {
    ...db,
    query: ((text: string, params?: readonly unknown[]) => db.query(text, params).catch(rethrow)) as Database["query"],
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

/** `entry`: a single direct replica URL (a plain URL; the primary's URL and lists are rejected). */
export async function openReplicaSource(m: Management, entry: string): Promise<ReplicaSource> {
  // The primary's URL and a list are rejected with a message that describes the option, not the env name; `createConfig` validates the format.
  const wrong = () => new AppError("INVALID_CONFIG", "--from-replica takes exactly one direct replica URL, not the primary's");
  if (entry.split(",").some((part) => part.trim() === m.config.url)) throw wrong();
  const [url, extra] = createConfig(m.config.url, entry).replicas;
  if (!url || extra) throw wrong();
  const { migrationStatementTimeoutMs, migrationLockTimeoutMs, replicaMaxLagMs } = m.config;
  // The probe throws a raw driver error (the message may contain the host): it is surfaced by its code only.
  const pooled = await usesTransactionPooler(m.driver, url, { deadlineMs: DIRECT_PROBE_DEADLINE_MS }).catch((error: unknown) => {
    throw driverError(error);
  });
  if (pooled)
    throw new AppError("DIRECT_CONNECTION_REQUIRED", "The replica URL must be a direct connection, not a transaction pooler");
  const db = connect(m.driver(url, { max: 2, idleTimeoutSeconds: 60, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 }), {
    deadlineMs: migrationStatementTimeoutMs,
    timeouts: { statementTimeoutMs: migrationStatementTimeoutMs, lockTimeoutMs: migrationLockTimeoutMs },
    maxPending: 64,
  });
  try {
    const probe = await probeReplica(m.db, db);
    if (!probe.inRecovery) throw new AppError("INVALID_CONFIG", "The replica URL does not point at a replica");
    if (probe.lagMs === null || probe.lagMs > replicaMaxLagMs) throw new AppError("REPLICA_LAG_EXCEEDED", `The replica is behind by more than ${replicaMaxLagMs} ms`);
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  return {
    db: mapConflicts(db),
    async catchUp() {
      const [position] = await m.db.query<{ lsn: string }>(PRIMARY_LSN);
      const deadline = Date.now() + replicaMaxLagMs;
      for (;;) {
        const [row] = await db.query<{ ok: boolean | null; lsn: string }>(REPLAYED_UP_TO, [position?.lsn]);
        if (row?.ok) return row.lsn;
        if (Date.now() >= deadline) throw new AppError("REPLICA_LAG_EXCEEDED", `The replica did not catch up within ${replicaMaxLagMs} ms`);
        await setTimeout(CATCH_UP_POLL_MS);
      }
    },
    close: () => db.close(),
  };
}
