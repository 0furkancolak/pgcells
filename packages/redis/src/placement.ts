/** Placement cache for `dbMiddleware({ placement })` / `createDbScope(db, id, placement)`. A local hit returns synchronously (no Promise),
 * so on the hot path the cost is one Map read. Only an `active` placement is stored; after a move or a status change,
 * `invalidatePlacement(id)` must be called (for a missed broadcast, staleness is at most `localTtlMs`, and in Redis at most `ttlSeconds`).
 * `onSpan`: `placement.cache` (tenantId, detail `hit-local` | `hit-redis` | `miss` | `db`). */
import { AppError, type Placement, PLACEMENT_CACHE_MAX_MS, placementSchema } from "@0furkancolak/pgcells";
import type { Database } from "@0furkancolak/pgcells/middleware";
import { type CacheOptions, createCache } from "./cache";
import { createKeys } from "./keys";
import { type EndSpan, startSpan } from "./span";

export interface PlacementCacheOptions extends CacheOptions {
  db: Pick<Database, "platform">;
}

/** A value from Redis is accepted only if it is a valid, `active` placement of this tenant. */
const activePlacement = (tenantId: string) => (value: unknown) => {
  const parsed = placementSchema.safeParse(value);
  return parsed.success && parsed.data.tenantId === tenantId && parsed.data.status === "active";
};

/** If a `wrap` miss called `loader`, the source is the platform database. */
const loadedFromDb = (end: EndSpan): EndSpan => (detail, error) => end(detail === "miss" ? "db" : detail, error);

export function createPlacementCache({ db, localTtlMs = 5_000, ttlSeconds = 20, max = 100_000, onSpan, ...options }: PlacementCacheOptions) {
  // A move waits for the old placement to drop out of every process according to PLACEMENT_CACHE_MAX_MS; a longer cache is not safe.
  if (ttlSeconds * 1000 + localTtlMs > PLACEMENT_CACHE_MAX_MS)
    throw new AppError("INVALID_CONFIG", `Placement cache ttlSeconds*1000 + localTtlMs must be <= ${PLACEMENT_CACHE_MAX_MS}`);
  const cache = createCache({ ...options, localTtlMs, ttlSeconds, max });
  const keys = createKeys(options.prefix);
  const key = (tenantId: string) => keys.tenant(tenantId, "placement");

  /** Local → Redis; `undefined` on a miss (the middleware reads from the platform database and does not write to the cache). */
  function placement(tenantId: string): Placement | undefined | Promise<Placement | undefined> {
    const k = key(tenantId);
    const end = startSpan(onSpan, "placement.cache", tenantId);
    const hit = cache.raw.peek<Placement>(k);
    if (hit === undefined) return cache.raw.get<Placement>(k, activePlacement(tenantId), end);
    end?.("hit-local");
    return hit;
  }
  /** Local → Redis → `db.platform.get`, writes if `active`. Same signature: can be passed directly as the `placement` option. */
  function loadPlacement(tenantId: string): Placement | Promise<Placement> {
    const k = key(tenantId);
    const end = startSpan(onSpan, "placement.cache", tenantId);
    const hit = cache.raw.peek<Placement>(k);
    if (hit === undefined) return cache.raw.wrap<Placement>(k, () => db.platform.get(tenantId), activePlacement(tenantId), end && loadedFromDb(end));
    end?.("hit-local");
    return hit;
  }
  /** Deletes the Redis entry, advances its version and clears the local entry of other processes: an in-flight read or load cannot write
   * the old placement back to any layer. */
  const invalidatePlacement = (tenantId: string) => cache.raw.del(key(tenantId));

  return Object.assign(placement, { loadPlacement, invalidatePlacement, close: cache.close });
}
