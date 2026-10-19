/** Replica health and selection. The status (health + lag) stays cached for `statusMs`; probing is lazy (no background timer,
 * which does not survive in Workers) and concurrent calls for the same replica share a single probe. The cache is module-level and holds only numbers:
 * in Workers the status survives even when the per-request pool closes. Lag: 0 if the replay LSN has reached the primary's LSN, otherwise the time since the last
 * replayed commit (it may briefly look high while WAL without commits flows; the error direction is safe). */
import type { Database, Pools } from "../database";
import type { Connection } from "../driver";
import { errorCode } from "../errors";

export type ReplicaStatus = { up: boolean; inRecovery: boolean; lagMs: number | null; at: number; error?: string };
export type StatusCache = Map<string, ReplicaStatus>;
export type ReplicaHandle = { db: Database; markDown(): void };
export type ReplicaReport = { databaseId: string; replica: number; up: boolean; inRecovery: boolean; lagMs: number | null; usable: boolean; error?: string };

const sharedCache: StatusCache = new Map();
/** The round-robin turn is also module-level (numbers only): in Workers, which builds a router per request, not every request starts from replica 1. */
const sharedRotation = new Map<string, number>();
const PRIMARY_LSN = "SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn";
const REPLICA_STATE = `SELECT pg_catalog.pg_is_in_recovery() AS in_recovery,
  pg_catalog.pg_last_wal_replay_lsn() >= $1::pg_catalog.pg_lsn AS caught_up,
  (pg_catalog.date_part('epoch', pg_catalog.now() - pg_catalog.pg_last_xact_replay_timestamp()) * 1000)::pg_catalog.float8 AS lag_ms`;

/** The primary's LSN is read once and compared on the replica; both run on the connections given. */
export async function probeReplica(primary: Connection, replica: Connection): Promise<{ inRecovery: boolean; lagMs: number | null }> {
  const [position] = await primary.query<{ lsn: string }>(PRIMARY_LSN);
  const [row] = await replica.query<{ in_recovery: boolean; caught_up: boolean | null; lag_ms: number | null }>(REPLICA_STATE, [position?.lsn]);
  if (!row) return { inRecovery: false, lagMs: null };
  const lagMs = row.caught_up ? 0 : row.lag_ms === null || row.lag_ms === undefined ? null : Math.max(0, Math.round(Number(row.lag_ms)));
  return { inRecovery: row.in_recovery === true, lagMs };
}

export interface ReplicaRouterOptions {
  pools: Pick<Pools, "node" | "replicas" | "nodeConfig">;
  maxLagMs: number;
  statusMs: number;
  cache?: StatusCache;
  rotation?: Map<string, number>;
  now?: () => number;
}

export function createReplicaRouter({ pools, maxLagMs, statusMs, cache = sharedCache, rotation = sharedRotation, now = () => performance.now() }: ReplicaRouterOptions) {
  const inflight = new Map<string, Promise<ReplicaStatus>>();
  const usable = (status: ReplicaStatus) => status.up && status.lagMs !== null && status.lagMs <= maxLagMs;
  const down = (error?: string): ReplicaStatus => ({ up: false, inRecovery: false, lagMs: null, at: now(), ...(error ? { error } : {}) });

  /** Runs the probe (the in-flight one, if any); the result is written to the cache. */
  function refresh(databaseId: string, index: number, url: string): Promise<ReplicaStatus> {
    let running = inflight.get(url);
    if (!running) {
      running = probeReplica(pools.node(databaseId), pools.replicas(databaseId)[index] as Database)
        .then(
          (probe): ReplicaStatus => ({ up: probe.inRecovery, inRecovery: probe.inRecovery, lagMs: probe.lagMs, at: now() }),
          (error: unknown) => down(errorCode(error)),
        )
        .then((status) => {
          cache.set(url, status);
          inflight.delete(url);
          return status;
        });
      inflight.set(url, running);
    }
    return running;
  }

  /** Returns synchronously if there is a fresh record (no Promise on the hot path). */
  function current(databaseId: string, index: number, url: string): ReplicaStatus | Promise<ReplicaStatus> {
    const cached = cache.get(url);
    return cached && now() - cached.at < statusMs ? cached : refresh(databaseId, index, url);
  }

  async function pick(databaseId: string): Promise<ReplicaHandle | undefined> {
    const urls = pools.nodeConfig(databaseId).replicas;
    if (!urls.length) return undefined;
    const states = urls.map((url, index) => current(databaseId, index, url));
    const statuses = states.some((state) => state instanceof Promise) ? await Promise.all(states) : (states as ReplicaStatus[]);
    const candidates = statuses.flatMap((status, index) => (usable(status) ? [index] : []));
    if (!candidates.length) return undefined;
    const turn = rotation.get(databaseId) ?? 0;
    rotation.set(databaseId, turn + 1);
    const index = candidates[turn % candidates.length] as number;
    return { db: pools.replicas(databaseId)[index] as Database, markDown: () => void cache.set(urls[index] as string, down()) };
  }

  /** Probes every replica without consulting the cache; there is no URL in the output (`replica`: a 1-based number in config order). */
  async function report(databaseIds: readonly string[]): Promise<ReplicaReport[]> {
    const rows = databaseIds.flatMap((databaseId) =>
      pools.nodeConfig(databaseId).replicas.map(async (url, index): Promise<ReplicaReport> => {
        const status = await refresh(databaseId, index, url);
        return {
          databaseId,
          replica: index + 1,
          up: status.up,
          inRecovery: status.inRecovery,
          lagMs: status.lagMs,
          usable: usable(status),
          ...(status.error ? { error: status.error } : {}),
        };
      }),
    );
    return Promise.all(rows);
  }

  return { pick, report };
}
export type ReplicaRouter = ReturnType<typeof createReplicaRouter>;
