/** Runtime factory: pools, placement reads (with a short in-process cache) and the tenant context. It does not load the management, parser, tools or driver
 * modules. */
import { boundedInteger, type Config, type DatabaseNode, type DatabaseOptions, loadConfig, PLATFORM_DATABASE_ID, replicaPolicy, runtimeSettings } from "./config";
import { createPools, type PoolStats, reportSpan, type SpanHandler, spanner } from "./database";
import type { Driver } from "./driver";
import { AppError, databaseUnavailable, errorCode, WrongRegionError } from "./errors";
import { PLATFORM_SCHEMA } from "./sql/query";
import { type ContextLifecycle, createWithTenant, createWithTenantRead, runContext, type TenantContext } from "./tenants/context";
import { type Placement, validateRegionName } from "./tenants/model";
import { checkDatabases } from "./tenants/nodes";
import { createPlatform } from "./tenants/placement";
import { createReplicaRegionLoader, createReplicaRouter } from "./tenants/replicas";
import { usesTransactionPooler } from "./tenants/pooler";

export interface RuntimeOptions extends DatabaseOptions {
  /** `@0furkancolak/pgcells/drivers/bun|postgres|pg`; only the imported driver ends up in the bundle. */
  driver: Driver;
  /** Measurement: every placement read, connection wait, query and transaction duration (see `Span`). No extra cost if not provided. */
  onSpan?: SpanHandler;
  /** `verified` (default): `ready()` checks that every DB is behind a transaction-mode pooler, otherwise `POOLER_REQUIRED`.
   * `assumed`: the check is skipped (environments that cannot be probed, e.g. unverified Hyperdrive); ensuring a pooler is in place is the application's job. */
  pooler?: "verified" | "assumed";
  /** The region this application runs in (e.g. `eu-west`). A tenant whose node is in another region is refused with `WRONG_REGION` instead of being served across
   * regions. Without it nothing is checked (single-region mode); a tenant on a node with no region is always served. */
  region?: string;
  /** Called with the placement each time a tenant context is refused for `WRONG_REGION` (metrics, logging). It cannot allow the request: the error is thrown after it returns. */
  onWrongRegion?: (placement: Placement) => void;
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
function openDatabase(input: Config, { driver, onSpan, pooler = "verified", replicaOnUnavailable, region, onWrongRegion, ...options }: RuntimeOptions) {
  // The requirement can be skipped only by a deliberate decision: a typo or an unexpected value does not silently disable the check.
  if (pooler !== "verified" && pooler !== "assumed") throw new AppError("INVALID_CONFIG", 'pooler must be "verified" or "assumed"');
  const onUnavailable = replicaPolicy(replicaOnUnavailable);
  if (region !== undefined) validateRegionName(region);
  /** Refuses a placement whose node is in another region (a node with no region is never refused). */
  const guard =
    region === undefined
      ? undefined
      : (placement: Placement) => {
          if (placement.region && placement.region !== region) {
            onWrongRegion?.(placement);
            throw new WrongRegionError(placement.tenantId, placement.region, region);
          }
        };
  const config = runtimeSettings(input, options);
  // Server-side timeouts are DB defaults (bootstrap): a single query is a single round trip.
  const pools = createPools(config, driver, config.poolMax, { deadlineMs: config.statementTimeoutMs, maxPending: RUNTIME_MAX_PENDING, onSpan });
  const platform = createPlatform(pools);
  const timed = spanner(onSpan);

  // After `migrating`, a move waits longer than `placementCacheMs` (`PLACEMENT_CACHE_MAX_MS`), so the cache never lets any request
  // write to the old DB of the tenant being moved.
  const cache = activePlacementCache(PLACEMENT_CACHE_ENTRIES, config.placementCacheMs, config.staleIfErrorMs);
  // Replica locality needs the directory's replica regions, but only for an application that has a region.
  const replicaCounts = Object.fromEntries(config.nodes.filter((node) => node.replicas.length).map((node) => [node.id, node.replicas.length]));
  const replicaRouter = createReplicaRouter({
    pools,
    maxLagMs: config.replicaMaxLagMs,
    statusMs: config.replicaStatusMs,
    ...(region !== undefined && { region, regions: createReplicaRegionLoader(pools.platform, replicaCounts, config.replicaStatusMs) }),
  });
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

  const lifecycle = createLifecycle(config.tenantMaxInflight);
  const withTenant = createWithTenant(pools, { get: placement }, lifecycle, guard);
  /** `src/queries/tenant/` read queries go to a replica; see `docs/replicas.md`. */
  const withTenantRead = createWithTenantRead(pools, { get: placement }, replicaRouter, onUnavailable, lifecycle, guard);
  /** Replica status (health, lag, availability); probes without consulting the cache. Contains no URL. */
  const replicas = () => replicaRouter.report(config.nodes.map((node) => node.id));
  /** `src/queries/platform/` queries: the platform database (db0, schema `platform`). */
  const withPlatform = <T>(work: (db: TenantContext) => Promise<T>) =>
    runContext(pools.platform, pools.platform, PLATFORM_SCHEMA, "platform", work, undefined, { lifecycle });
  /** `src/queries/node/` queries: the `platform` schema of the `databaseId` DB (the same pool as the tenants). */
  const withNode = <T>(databaseId: string, work: (db: TenantContext) => Promise<T>) => {
    const db = pools.node(databaseId);
    return runContext(db, db, PLATFORM_SCHEMA, "node", work, undefined, { lifecycle });
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
    lifecycle.assertOpen();
    await checkDatabases(pools, config.nodes.map((node) => node.id));
    if (pooler === "verified") await Promise.all(config.nodes.map(checkPooler));
  };
  /** Counters without a tracing backend: one entry per opened pool (`db0`, `db1`, replicas as `db0#1`) and the context counts of this process. */
  const stats = (): { databases: Record<string, PoolStats>; contexts: ContextStats } => ({ databases: pools.stats(), contexts: lifecycle.stats() });
  /** `drain: true` first refuses new contexts (`DATABASE_CLOSED`, `ready()` fails) and waits up to `timeoutMs` (default 10 s) for the started ones; the pools are
   * closed in any case. The result says how many contexts were still running when the wait ended. */
  const close = async (options: CloseOptions = {}): Promise<CloseResult> => {
    const remaining = options.drain ? await lifecycle.drain(options.timeoutMs ?? DRAIN_TIMEOUT_MS) : lifecycle.stats().active;
    await pools.close();
    return { drained: remaining === 0, remaining };
  };
  return { config, region, pools, platform, placement, invalidatePlacement, withTenant, withTenantRead, replicas, withNode, withPlatform, ready, stats, close };
}

export interface CloseOptions {
  /** Refuse new work and wait for the started contexts before closing. */
  drain?: boolean;
  /** The longest the drain waits (default 10000, at most `DRAIN_TIMEOUT_MAX_MS`). */
  timeoutMs?: number;
}
export interface CloseResult {
  /** `false` if contexts were still running when the pools were closed. */
  drained: boolean;
  remaining: number;
}
export interface ContextStats {
  /** Contexts running now. */
  active: number;
  /** Contexts refused by `tenantMaxInflight`. */
  tenantBusyRejected: number;
  draining: boolean;
}
const DRAIN_TIMEOUT_MS = 10_000;

/** Counts started contexts, refuses new ones while draining and over the per-tenant limit. With the limit off nothing is kept per tenant. */
function createLifecycle(tenantMaxInflight: number): ContextLifecycle & { drain(timeoutMs: number): Promise<number>; assertOpen(): void; stats(): ContextStats } {
  let active = 0;
  let tenantBusyRejected = 0;
  let draining = false;
  let idle: (() => void) | undefined;
  const perTenant = tenantMaxInflight > 0 ? new Map<string, number>() : undefined;
  const closed = () => new AppError("DATABASE_CLOSED", "Database clients are closed");
  return {
    enter(tenantId) {
      if (draining) throw closed();
      if (perTenant && tenantId !== undefined) {
        const running = perTenant.get(tenantId) ?? 0;
        if (running >= tenantMaxInflight) {
          tenantBusyRejected++;
          throw new AppError("DATABASE_BUSY", `Tenant ${tenantId} has too many requests in flight`);
        }
        perTenant.set(tenantId, running + 1);
      }
      active++;
    },
    leave(tenantId) {
      active--;
      if (perTenant && tenantId !== undefined) {
        const running = (perTenant.get(tenantId) ?? 1) - 1;
        if (running > 0) perTenant.set(tenantId, running);
        else perTenant.delete(tenantId);
      }
      if (active === 0) idle?.();
    },
    assertOpen() {
      if (draining) throw closed();
    },
    drain(timeoutMs) {
      draining = true;
      if (active === 0) return Promise.resolve(0);
      return new Promise<number>((resolve) => {
        const timer = setTimeout(() => {
          idle = undefined;
          resolve(active);
        }, boundedInteger(timeoutMs, "timeoutMs", DRAIN_TIMEOUT_MAX_MS));
        timer.unref?.();
        idle = () => {
          clearTimeout(timer);
          idle = undefined;
          resolve(0);
        };
      });
    },
    stats: () => ({ active, tenantBusyRejected, draining }),
  };
}
const DRAIN_TIMEOUT_MAX_MS = 300_000;

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
    close(closeOptions?: CloseOptions) {
      closed = true;
      return current.close(closeOptions);
    },
  };
  return new Proxy(own as unknown as RotatingDatabase, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : Reflect.get(current, key)),
    has: (target, key) => key in target || key in current,
  });
}
