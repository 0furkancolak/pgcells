/** Runtime factory: pools, placement reads (with a short in-process cache) and the tenant context. It does not load the management, parser, tools or driver
 * modules. */
import { type Config, type DatabaseNode, type DatabaseOptions, loadConfig, PLATFORM_DATABASE_ID, replicaPolicy, runtimeSettings } from "./config";
import { createPools, reportSpan, type SpanHandler, spanner } from "./database";
import type { Driver } from "./driver";
import { AppError, databaseUnavailable, errorCode } from "./errors";
import { PLATFORM_SCHEMA } from "./sql/query";
import { createWithTenant, createWithTenantRead, runContext, type TenantContext } from "./tenants/context";
import type { Placement } from "./tenants/model";
import { checkDatabases } from "./tenants/nodes";
import { createPlatform } from "./tenants/placement";
import { createReplicaRouter } from "./tenants/replicas";
import { usesTransactionPooler } from "./tenants/pooler";

export interface RuntimeOptions extends DatabaseOptions {
  /** `@0furkancolak/pgcells/drivers/bun|postgres|pg`; only the imported driver ends up in the bundle. */
  driver: Driver;
  /** Measurement: every placement read, connection wait, query and transaction duration (see `Span`). No extra cost if not provided. */
  onSpan?: SpanHandler;
  /** `verified` (default): `ready()` checks that every DB is behind a transaction-mode pooler, otherwise `POOLER_REQUIRED`.
   * `assumed`: the check is skipped (environments that cannot be probed, e.g. unverified Hyperdrive); ensuring a pooler is in place is the application's job. */
  pooler?: "verified" | "assumed";
}

const PLACEMENT_CACHE_ENTRIES = 10_000;
/** The maximum number of jobs waiting for a connection per DB; `DATABASE_BUSY` if exceeded. */
const RUNTIME_MAX_PENDING = 64;
/** After a directory failure, how long stale placements are served before the directory is asked again. */
const DIRECTORY_RETRY_MS = 2000;
/** Failures that mean "the directory cannot answer" (connection errors, deadlines): the only ones a stale placement may cover. */
const directoryUnreachable = (error: unknown) => databaseUnavailable(error) || errorCode(error) === "DATABASE_TIMEOUT";

/** In-process placement cache: only an `active` placement is kept, for `ttlMs`; when full, the oldest entry is evicted. Invalidation
 * advances the counter: a read of a tenant invalidated after the `epoch()` taken before the read started is not written to the cache.
 * `staleMs`: an expired entry can still be returned by `stale()` for that long (stale-if-error; the caller decides when). */
function activePlacementCache(maxEntries: number, ttlMs: number, staleMs = 0) {
  const entries = new Map<string, { placement: Placement; expires: number }>();
  // Tenant → counter of the last invalidation, at most `maxEntries`. The counter of an evicted record becomes `floor`: every read that started before it is rejected.
  const invalidated = new Map<string, number>();
  let epoch = 0;
  let floor = 0;
  return {
    /** The placement if it has not expired; otherwise `undefined`. */
    hit(tenantId: string): Placement | undefined {
      const entry = entries.get(tenantId);
      return entry && entry.expires > performance.now() ? entry.placement : undefined;
    },
    /** An expired `active` entry that is still inside the stale window; never an invalidated or non-active one (those are removed). */
    stale(tenantId: string): Placement | undefined {
      const entry = staleMs > 0 ? entries.get(tenantId) : undefined;
      return entry && entry.expires + staleMs > performance.now() ? entry.placement : undefined;
    },
    epoch: () => epoch,
    /** Replaces the old entry with the placement that was read (only deletes it if not active) and returns the placement; if the read was invalidated
     * after `readEpoch`, the cache is left untouched. */
    store(tenantId: string, placement: Placement, readEpoch: number): Placement {
      if (readEpoch < floor || (invalidated.get(tenantId) ?? 0) > readEpoch) return placement;
      entries.delete(tenantId);
      if (placement.status === "active") {
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value as string);
        entries.set(tenantId, { placement, expires: performance.now() + ttlMs });
      }
      return placement;
    },
    invalidate(tenantId: string) {
      entries.delete(tenantId);
      invalidated.delete(tenantId);
      invalidated.set(tenantId, ++epoch);
      if (invalidated.size > maxEntries) {
        const [oldest, at] = invalidated.entries().next().value as [string, number];
        invalidated.delete(oldest);
        floor = at;
      }
    },
  };
}

/** Bun: once per process. Workers: once per request with `{ poolMax: 1 }` (sockets cannot outlive a request). */
function openDatabase(input: Config, { driver, onSpan, pooler = "verified", replicaOnUnavailable, ...options }: RuntimeOptions) {
  // The requirement can be skipped only by a deliberate decision: a typo or an unexpected value does not silently disable the check.
  if (pooler !== "verified" && pooler !== "assumed") throw new AppError("INVALID_CONFIG", 'pooler must be "verified" or "assumed"');
  const onUnavailable = replicaPolicy(replicaOnUnavailable);
  const config = runtimeSettings(input, options);
  // Server-side timeouts are DB defaults (bootstrap): a single query is a single round trip.
  const pools = createPools(config, driver, config.poolMax, { deadlineMs: config.statementTimeoutMs, maxPending: RUNTIME_MAX_PENDING, onSpan });
  const platform = createPlatform(pools);
  const timed = spanner(onSpan);

  // After `migrating`, a move waits longer than `placementCacheMs` (`PLACEMENT_CACHE_MAX_MS`), so the cache never lets any request
  // write to the old DB of the tenant being moved.
  const cache = activePlacementCache(PLACEMENT_CACHE_ENTRIES, config.placementCacheMs, config.staleIfErrorMs);
  const replicaRouter = createReplicaRouter({ pools, maxLagMs: config.replicaMaxLagMs, statusMs: config.replicaStatusMs });
  const hasDirectoryReplicas = config.nodes.some((node) => node.id === PLATFORM_DATABASE_ID && node.replicas.length > 0);
  /** One directory lookup. With db0 replicas an `active` record comes from a usable replica; anything else (not active, not found yet, no usable
   * replica, replica error) is answered by the primary, which is the only authority for `migrating`/`maintenance`. The error policy for tenant reads
   * does not apply here: a directory lookup is tiny and cached, and the replica is only an offload. */
  async function readDirectory(tenantId: string): Promise<Placement> {
    const handle = hasDirectoryReplicas ? await replicaRouter.pick(PLATFORM_DATABASE_ID) : undefined;
    if (handle) {
      try {
        const found = await platform.find(tenantId, handle.db);
        if (found?.status === "active") return found;
      } catch (error) {
        if (databaseUnavailable(error)) handle.markDown();
      }
    }
    return platform.get(tenantId);
  }
  /** After a directory failure, stale entries are served without asking the directory again for this long, so an outage does not add a connection wait to every request. */
  let directoryDownAt = Number.NEGATIVE_INFINITY;
  const useStale = (tenantId: string, error?: unknown): Placement | undefined => {
    const stale = cache.stale(tenantId);
    if (stale && onSpan) reportSpan(onSpan, { name: "placement.stale", startTime: Date.now(), ms: 0, tenantId, ...(error ? { error: errorCode(error) } : {}) });
    return stale;
  };
  /** Returns synchronously on a hit (no Promise). */
  function placement(tenantId: string): Placement | Promise<Placement> {
    const cached = cache.hit(tenantId);
    if (cached) {
      if (onSpan) reportSpan(onSpan, { name: "placement.cache", startTime: Date.now(), ms: 0, tenantId });
      return cached;
    }
    if (config.staleIfErrorMs > 0 && performance.now() - directoryDownAt < DIRECTORY_RETRY_MS) {
      const stale = useStale(tenantId);
      if (stale) return stale;
    }
    const readEpoch = cache.epoch();
    const read = timed("placement.read", () => readDirectory(tenantId), { tenantId }).then((placed) => cache.store(tenantId, placed, readEpoch));
    if (config.staleIfErrorMs === 0) return read;
    return read.catch((error: unknown) => {
      if (!directoryUnreachable(error)) throw error;
      directoryDownAt = performance.now();
      const stale = useStale(tenantId, error);
      if (!stale) throw error;
      return stale;
    });
  }
  /** Invalidates the placement in this process immediately (e.g. when an `onPlacementChange` broadcast is received); an in-flight read is not written to the cache either. */
  const invalidatePlacement = cache.invalidate;

  const withTenant = createWithTenant(pools, { get: placement });
  /** `src/queries/tenant/` read queries go to a replica; see `docs/replicas.md`. */
  const withTenantRead = createWithTenantRead(pools, { get: placement }, replicaRouter, onUnavailable);
  /** Replica status (health, lag, availability); probes without consulting the cache. Contains no URL. */
  const replicas = () => replicaRouter.report(config.nodes.map((node) => node.id));
  /** `src/queries/platform/` queries: the platform database (db0, schema `platform`). */
  const withPlatform = <T>(work: (db: TenantContext) => Promise<T>) => runContext(pools.platform, pools.platform, PLATFORM_SCHEMA, "platform", work);
  /** `src/queries/node/` queries: the `platform` schema of the `databaseId` DB (the same pool as the tenants). */
  const withNode = <T>(databaseId: string, work: (db: TenantContext) => Promise<T>) => {
    const db = pools.node(databaseId);
    return runContext(db, db, PLATFORM_SCHEMA, "node", work);
  };
  // One check per node: concurrent `ready()` calls wait for the same result; a successful result is kept and a failed one is removed.
  const poolerChecks = new Map<string, Promise<void>>();
  const checkPooler = (node: DatabaseNode) => {
    let check = poolerChecks.get(node.id);
    if (!check) {
      check = usesTransactionPooler(driver, node.url, { deadlineMs: config.statementTimeoutMs + 1000 }).then(
        (pooled) => {
          if (!pooled)
            throw new AppError(
              "POOLER_REQUIRED",
              `Database ${node.id} is reachable without a transaction pooler; use a transaction-mode pooler URL in DATABASE_URLS or set pooler: "assumed"`,
            );
        },
        (error: unknown) => {
          throw databaseUnavailable(error) ? new AppError("DATABASE_UNAVAILABLE", `Database ${node.id} is not reachable`) : error;
        },
      );
      check.catch(() => poolerChecks.delete(node.id));
      poolerChecks.set(node.id, check);
    }
    return check;
  };
  /** Ready: every DB registered in `platform.nodes` has a URL, is reachable and has the right identity; with `pooler: "verified"`, every URL goes to a
   * transaction-mode pooler. Otherwise `DATABASE_NOT_CONFIGURED`, `DATABASE_NOT_REGISTERED`, `DATABASE_UNAVAILABLE`,
   * `DATABASE_ORDER_CHANGED`, `DATABASE_TIMEOUT` or `POOLER_REQUIRED`. Call it at startup and on the health endpoint (not on the request path). */
  const ready = async () => {
    await checkDatabases(pools, config.nodes.map((node) => node.id));
    if (pooler === "verified") await Promise.all(config.nodes.map(checkPooler));
  };
  return { config, pools, platform, placement, invalidatePlacement, withTenant, withTenantRead, replicas, withNode, withPlatform, ready, close: pools.close };
}

export type Database = ReturnType<typeof openDatabase>;

/** Once per process (`poolMax: 1` per request on Workers). If no config is given, `DATABASE_URLS` is read:
 *   createDatabase({ driver: bunDriver })
 *   createDatabase(createConfig([env.DB0.connectionString]), { driver: postgresDriver, poolMax: 1 }) */
export function createDatabase(options: RuntimeOptions): Database;
export function createDatabase(config: Config, options: RuntimeOptions): Database;
export function createDatabase(configOrOptions: Config | RuntimeOptions, options?: RuntimeOptions): Database {
  return "nodes" in configOrOptions ? openDatabase(configOrOptions, options as RuntimeOptions) : openDatabase(loadConfig(), configOrOptions);
}

/** A `Database` whose pools can be replaced while the process keeps serving: `rotate()` is for new credentials or a changed node list. */
export type RotatingDatabase = Database & {
  /** Resolves the config again, opens a new `Database` and checks its `ready()`; only then does it replace the current one, which is closed gracefully
   * (in-flight work gets the pool close timeout). If anything fails the current one stays in place and the error is thrown. Concurrent calls share one rotation.
   * The placement cache starts empty. */
  rotate(): Promise<void>;
};

/** `resolve` returns the `Config` (secret manager, vault, bindings); it is called once now and again on every `rotate()`. The returned object forwards every
 * `Database` member to the current instance, so it can be passed to `dbMiddleware({ database })` and Better Auth like a plain `Database`.
 * Nothing polls: call `rotate()` from your own schedule or signal handler. `ready()` is the caller's job for the first instance, as with `createDatabase`. */
export async function createRotatingDatabase(resolve: () => Config | Promise<Config>, options: RuntimeOptions): Promise<RotatingDatabase> {
  let current = createDatabase(await resolve(), options);
  let closed = false;
  let rotation: Promise<void> | undefined;

  async function replace() {
    const next = createDatabase(await resolve(), options);
    try {
      await next.ready();
    } catch (error) {
      await next.close().catch(() => {});
      throw error;
    }
    if (closed) {
      await next.close().catch(() => {});
      throw new AppError("DATABASE_CLOSED", "Database clients are closed");
    }
    const previous = current;
    current = next;
    await previous.close().catch(() => {});
  }
  const own = {
    rotate() {
      if (closed) return Promise.reject(new AppError("DATABASE_CLOSED", "Database clients are closed"));
      return (rotation ??= replace().finally(() => {
        rotation = undefined;
      }));
    },
    close() {
      closed = true;
      return current.close();
    },
  };
  return new Proxy(own as unknown as RotatingDatabase, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : Reflect.get(current, key)),
    has: (target, key) => key in target || key in current,
  });
}
