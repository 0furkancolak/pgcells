# Placement cache

Every tenant request must first know the tenant’s placement (which DB, which schema, which state). In a single process, the built-in in-process cache of `@0furkancolak/pgcells` is enough; with multiple processes or servers, `createPlacementCache` keeps the placement in an in-process LRU and in Redis, so the platform database is not read separately by every process and invalidation reaches all processes. This document covers the API, the time limits, invalidation and why it is safe during a move.

## Setup

```ts
import { createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createDbScope, dbMiddleware } from "@0furkancolak/pgcells/middleware";
import { createPlacementCache, createRedis, loadRedisConfig } from "@0furkancolak/pgcells-redis";

const db = createDatabase({ driver: bunDriver });
const redis = createRedis(loadRedisConfig());
const placements = createPlacementCache({ redis, db, localTtlMs: 5_000, ttlSeconds: 20 });

app.use(dbMiddleware({ database: db, rootDomain: "example.com", placement: placements.loadPlacement }));
const scope = createDbScope(db, "abc", placements.loadPlacement); // cron / queue
```

`db` is used only for `platform.get`; pass the same `createDatabase` instance you gave to the middleware (no separate pool is needed).

## API

`createPlacementCache(options)` returns a callable function:

| Call | Behavior |
|---|---|
| `placements(id)` | Local → Redis. `undefined` on a miss; in that case `dbMiddleware` uses `@0furkancolak/pgcells`’s own cache and the platform database but does not write to Redis. |
| `placements.loadPlacement(id)` | Local → Redis → `db.platform.get(id)`; if the result is `active`, it is written to both layers. This is what you usually give to the middleware and the worker. Throws `TENANT_NOT_FOUND` if the tenant does not exist. |
| `placements.invalidatePlacement(id)` | Deletes the Redis record, advances its version and clears other processes’ local record through pub/sub. A Redis read or a `db.platform.get` load that started before the invalidation cannot write the old placement back to any layer ([cache.md](cache.md#semantics)). |
| `placements.close()` | Removes the pub/sub listener. |

- A local hit returns **synchronously** (no Promise); the extra cost on the hot path is a Map read.
- Only an `active` placement is stored. `loadPlacement` returns a non-active placement without writing it; the request then gets `TENANT_UNAVAILABLE`.
- A record read from Redis is validated with `placementSchema` and must be an `active` record belonging to the requested tenant; a malformed or mismatching record counts as a miss.
- Concurrent misses for the same tenant in the same process read the platform database once.
- The tenant ID is validated (`INVALID_TENANT_ID`).

### Options

| Option | Default | Meaning |
|---|---:|---|
| `db` | — (required) | An object with `platform.get` (a `createDatabase` instance) |
| `redis` | none | The result of `createRedis`; if omitted, only the local layer is used |
| `localTtlMs` | 5000 | In-process entry lifetime |
| `ttlSeconds` | 20 | Redis entry lifetime |
| `max` | 100000 | Maximum in-process entries (LRU) |
| `prefix` | none | Key prefix for applications that share the same Redis |
| `onError` | none | Redis errors (the request does not fail) |

Key: `t:{<tenant>}:placement` (with a prefix, `<prefix>:t:{<tenant>}:placement`).

## Time limit

`ttlSeconds * 1000 + localTtlMs` can be at most `PLACEMENT_CACHE_MAX_MS` (25 s); anything above gives `INVALID_CONFIG` in the `createPlacementCache` call. Why: after a move or demo reset sets the placement to `migrating`/`maintenance`, it waits `placementCacheWaitMs` (default 30 s) before touching the data. An old `active` entry in the cache drops out of every process within 25 s at the latest; so even if an invalidation message is missed, no process can write to the old DB for a tenant that is being moved.

Short durations speed up the switch to the new DB after a move, and long durations reduce reads of the platform database. The end-to-end tests use `localTtlMs: 2000`, `ttlSeconds: 5` (upper bound of staleness ≈ 7 s).

## Invalidation

Give the hook to the management context:

```ts
import { createManagement } from "@0furkancolak/pgcells/management";

const management = createManagement({
  driver: bunDriver,
  onPlacementChange: (tenantId) => placements.invalidatePlacement(tenantId),
});
```

The hook is called once a state change (`maintenance`, `migrating` …), a move switchover or an activation is committed: the Redis record is deleted and other processes’ local record is cleared through pub/sub. If the hook throws, the management operation stops (the move stays resumable with `resume-move`).

**A process without the hook is also safe.** `bun run cli move …` does not connect to Redis and does not call the hook; safety comes from the time limit above and `placementCacheWaitMs`. The cost: after a move, applications may take up to `ttlSeconds + localTtlMs` to see the new DB, and the move command takes at least `placementCacheWaitMs`.

If you changed the placement by hand (e.g. with psql), call `placements.invalidatePlacement(id)` and the in-process `db.invalidatePlacement(id)`, or wait for the time to expire.

## Caveats

- **A stale placement is expected behavior.** While a move is in the maintenance phase, reads with the `active` placement in the cache keep coming from the source schema; if the writers were not stopped, writes go to the old schema. This is why `move` requires the writers to be stopped from outside (`--writers-drained`, [`@0furkancolak/pgcells` operations](https://github.com/0furkancolak/pgcells/blob/main/packages/db-multi/docs/operations.md#tenant-move)).
- **A deleted tenant.** If a tenant’s schema and platform record are deleted by hand, requests go with the old placement for the duration of the cache and may get `42P01` (table missing); when the time expires it becomes `TENANT_NOT_FOUND`.
- **Redis is down.** Reads count as misses and `loadPlacement` reads from the platform database (fail-open); writes and broadcasts are skipped, and the error goes to `onError`. An `invalidatePlacement` done while Redis is down does not reach other processes; the time limit still applies.

## Measurement

`bun run bench` (see [operations.md](operations.md#micro-benchmark)) writes the time per operation as JSON for a local hit, a Redis hit (`localTtlMs: 0`) and a direct `db.platform.get`.
