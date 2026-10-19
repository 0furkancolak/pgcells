/** Replica health and selection. The status (health + lag) stays cached for `statusMs`; probing is lazy (no background timer, which
 * cannot live on Workers) and concurrent calls for the same replica share a single probe. The cache and the rotation order live at module level and
 * hold only numbers: on Workers the state survives even though the pool is closed per request. Lag: 0 if the replay LSN has reached the primary's LSN, otherwise
 * the time since the last replayed commit (it can briefly look too high while WAL without commits is flowing; the error direction is safe). */
import type { Database, Pools } from "./database";
import type { Connection } from "./driver";
import { errorCode } from "./errors";

export type ReplicaStatus = { up: boolean; inRecovery: boolean; lagMs: number | null; at: number; error?: string };
export type StatusCache = Map<string, ReplicaStatus>;
export type ReplicaHandle = { db: Database; markDown(): void };
export type ReplicaReport = { replica: number; up: boolean; inRecovery: boolean; lagMs: number | null; usable: boolean; error?: string };

const sharedCache: StatusCache = new Map();
/** Round-robin order: on Workers, which builds a router per request, not every request starts from replica 1. */
const sharedRotation = { turn: 0 };
const PRIMARY_LSN = "SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn";
const REPLICA_STATE = `SELECT pg_catalog.pg_is_in_recovery() AS in_recovery,
  pg_catalog.pg_last_wal_replay_lsn() >= $1::pg_catalog.pg_lsn AS caught_up,
  (pg_catalog.date_part('epoch', pg_catalog.now() - pg_catalog.pg_last_xact_replay_timestamp()) * 1000)::pg_catalog.float8 AS lag_ms`;

type Lsn = Promise<string | undefined>;
/** The primary's current WAL position. */
async function primaryLsn(primary: Connection) {
  const [row] = await primary.query<{ lsn: string }>(PRIMARY_LSN);
  return row?.lsn;
}

/** The primary's LSN (`lsn`; read if not given) is compared on the replica; both run on the given connections. The router reads the position once
 * for all replicas in a round and passes it to every probe. */
export async function probeReplica(primary: Connection, replica: Connection, lsn: Lsn = primaryLsn(primary)): Promise<{ inRecovery: boolean; lagMs: number | null }> {
  const [row] = await replica.query<{ in_recovery: boolean; caught_up: boolean | null; lag_ms: number | null }>(REPLICA_STATE, [await lsn]);
  if (!row) return { inRecovery: false, lagMs: null };
  const lagMs = row.caught_up ? 0 : row.lag_ms === null || row.lag_ms === undefined ? null : Math.max(0, Math.round(Number(row.lag_ms)));
  return { inRecovery: row.in_recovery === true, lagMs };
}

export interface ReplicaRouterOptions {
  pools: Pick<Pools, "primary" | "replica" | "replicaUrls">;
  maxLagMs: number;
  statusMs: number;
  cache?: StatusCache;
  rotation?: { turn: number };
  now?: () => number;
}

export function createReplicaRouter({ pools, maxLagMs, statusMs, cache = sharedCache, rotation = sharedRotation, now = () => performance.now() }: ReplicaRouterOptions) {
  const inflight = new Map<string, Promise<ReplicaStatus>>();
  const usable = (status: ReplicaStatus) => status.up && status.lagMs !== null && status.lagMs <= maxLagMs;
  const down = (error?: string): ReplicaStatus => ({ up: false, inRecovery: false, lagMs: null, at: now(), ...(error ? { error } : {}) });

  /** A round (`pick`, `report`) reads the primary position once for all stale replicas; if no probe starts, it is never read. */
  function round() {
    let lsn: Lsn | undefined;
    return () => (lsn ??= primaryLsn(pools.primary));
  }

  /** Runs the probe (or joins the one in flight); the result is written to the cache. */
  function refresh(index: number, url: string, position: () => Lsn): Promise<ReplicaStatus> {
    let running = inflight.get(url);
    if (!running) {
      running = probeReplica(pools.primary, pools.replica(index), position())
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

  /** Returns synchronously if a fresh record exists (no Promise on the hot path). */
  function current(index: number, url: string, position: () => Lsn): ReplicaStatus | Promise<ReplicaStatus> {
    const cached = cache.get(url);
    return cached && now() - cached.at < statusMs ? cached : refresh(index, url, position);
  }

  async function pick(): Promise<ReplicaHandle | undefined> {
    const urls = pools.replicaUrls;
    if (!urls.length) return undefined;
    const position = round();
    const states = urls.map((url, index) => current(index, url, position));
    const statuses = states.some((state) => state instanceof Promise) ? await Promise.all(states) : (states as ReplicaStatus[]);
    const candidates = statuses.flatMap((status, index) => (usable(status) ? [index] : []));
    if (!candidates.length) return undefined;
    const index = candidates[rotation.turn++ % candidates.length] as number;
    return { db: pools.replica(index), markDown: () => void cache.set(urls[index] as string, down()) };
  }

  /** Probes every replica without consulting the cache; the output contains no URL (`replica`: 1-based number in config order). */
  async function report(): Promise<ReplicaReport[]> {
    const position = round();
    return Promise.all(
      pools.replicaUrls.map(async (url, index): Promise<ReplicaReport> => {
        const status = await refresh(index, url, position);
        return {
          replica: index + 1,
          up: status.up,
          inRecovery: status.inRecovery,
          lagMs: status.lagMs,
          usable: usable(status),
          ...(status.error ? { error: status.error } : {}),
        };
      }),
    );
  }

  return { pick, report };
}
export type ReplicaRouter = ReturnType<typeof createReplicaRouter>;
