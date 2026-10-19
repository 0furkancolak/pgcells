# Cache and keys

`createCache` is a two-layer cache for application data: in-process LRU → Redis → loader function. Global keys and tenant-specific keys are separate; a tenant’s entire cache is invalidated with a single command, and clearing propagates to other processes. This document covers the API, the semantics and the key names.

## Usage

```ts
import { createCache, createRedis, loadRedisConfig } from "@0furkancolak/pgcells-redis";

const redis = createRedis(loadRedisConfig());
const cache = createCache({ redis, max: 10_000, localTtlMs: 5_000, ttlSeconds: 60, onError: console.error });

// global: key g:c:plans
const plans = await cache.wrap("plans", () => loadPlans());

// tenant: key t:{abc}:c:<generation>:users:page:1 (listUsers: a query compiled with prepareQuery, see the getting-started document)
const t = cache.forTenant(c.get("db").tenantId);
const users = await t.wrap("users:page:1", () => c.get("db").tenant.query(listUsers, [20, 0]));
await t.set("settings", { theme: "dark" });
await t.get<{ theme: string }>("settings");
await t.del("users:page:1");          // a single key
await cache.invalidateTenant("abc");  // the tenant's entire cache
```

### Options (`CacheOptions`)

| Option | Default | Meaning |
|---|---:|---|
| `redis` | none | If omitted, only the local layer is used (tests, development) |
| `max` | 10000 | Maximum in-process entries (LRU) |
| `localTtlMs` | 5000 | In-process entry lifetime; `0` turns the local layer off |
| `ttlSeconds` | 60 | Redis entry lifetime |
| `prefix` | none | Key prefix for applications that share the same Redis |
| `onError` | none | Redis errors; the request does not fail even if it throws |

### Methods

| Method | Behavior |
|---|---|
| `get(key)` | Local → Redis; `undefined` if absent |
| `set(key, value)` | Writes to both layers and broadcasts so other processes delete their local entry |
| `del(key)` | Deletes from both layers and broadcasts |
| `wrap(key, loader)` | Local → Redis → `loader`; writes the result (does not broadcast) and returns once the write is done |
| `forTenant(tenantId)` | An object offering the same four methods with tenant keys; the tenant ID is validated (`INVALID_TENANT_ID`) |
| `invalidateTenant(tenantId)` | Invalidates the tenant’s entire cache |
| `raw` | `peek` (synchronous, local only), `get`, `set`, `del`, `wrap` — with full keys to which no prefix or generation is added |
| `close()` | Removes the pub/sub listener; the subscriptions of other caches sharing the same subscriber connection continue. Call it if you open the cache for a shorter life than the process (it can be called again) |

## Semantics

- **Layers:** local LRU (`max` entries, `localTtlMs`) → Redis (`ttlSeconds`) → `loader`. Concurrent misses for the same key in the same process call `loader` once.
- **Values are JSON.** `undefined` is not written (no negative cache), `null` is. Non-JSON types such as `Date` come back from Redis as strings: when caching a query result, convert dates yourself.
- **The local layer shares the same object:** do not mutate the returned value.
- **Tenant invalidation is O(1):** tenant keys have the form `t:{id}:c:<generation>:<key>`. `invalidateTenant` does an `INCR` on the generation counter (`t:{id}:gen`) and broadcasts (no SCAN). Old entries become unreachable and expire through their TTL.
- **Invalidation race:** `set` and `del` (in this process or arriving by broadcast) advance the key’s in-process counter and the version key in Redis. The answer of a Redis read that started before is not written to the local layer. The result of a `loader` that started before is written to no layer: the write to Redis is done with a single Lua script if the version is the same as the one read before loading, and to the local layer only once that is accepted. A caller arriving after the invalidation does not join the old in-flight load; it starts a new one. The counter record is bounded by `max`; an overflowing record also counts older jobs as changed. The result of a load that takes longer than 5 minutes is not written.
- **Across processes:** `set`, `del` and `invalidateTenant` broadcast on a single channel (`g:cache:invalidate`); other processes delete their local entry. If a message is missed, staleness lasts at most `localTtlMs`. Filling with `wrap` does not broadcast.
- **Fail-open:** if Redis is down or slow (the `command` connection times out at 500 ms), the read counts as a miss, the `loader` result is returned and the write is skipped; the error goes to `onError`. In that case `invalidateTenant` invalidates only its own process.

## Keys

Use the same naming for your own Redis commands:

```ts
import { createKeys, globalKey, tenantKey } from "@0furkancolak/pgcells-redis";

tenantKey("abc", "users", 1);      // "t:{abc}:users:1"
globalKey("plans");                 // "g:plans"

const keys = createKeys("app");     // for applications sharing the same Redis
keys.tenant("abc", "rate", "login");// "app:t:{abc}:rate:login"
keys.global("e2e", "cron");         // "app:g:e2e:cron"
```

- The `{abc}` hash tag puts all of a tenant’s keys in the same slot on Redis Cluster; multi-key commands and Lua work.
- The tenant ID is validated with `validateTenantId`.
- The prefix must not contain `{` or `}`, otherwise the hash tag breaks.
- Every value key has a version key (10 min TTL): `v:<key>` for a key with a hash tag, `v:{<key>}` for a key without a tag. Both are in the same slot on Redis Cluster. Do not use your own keys that start with `v:`.
- `createCache` and `createPlacementCache` take the same `prefix` option.

## Caveats

- Before putting authorization-bearing data (user-specific responses) into a shared cache, even under a tenant key, add the user identity to the key.
- Do not forget to clear the cache in write routes; `wrap` is refreshed only by time.
