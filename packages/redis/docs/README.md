# @0furkancolak/pgcells-redis documentation

This folder explains how to use the `@0furkancolak/pgcells-redis` package. The package exports a single entry point (`@0furkancolak/pgcells-redis`) and is used together with `@0furkancolak/pgcells`; for the database side, see the [`@0furkancolak/pgcells` documentation](https://github.com/0furkancolak/pgcells/blob/main/packages/db-multi/docs/README.md).

## Reading order

1. [getting-started.md](getting-started.md) — the dependency, `REDIS_URL`, connections, and wiring them into an HTTP application + a worker process.
2. [placement-cache.md](placement-cache.md) — `createPlacementCache`: time limits, invalidation, the `onPlacementChange` hook, fail-open and move safety.
3. [cache.md](cache.md) — `createCache`: global and tenant caches, O(1) tenant invalidation, cross-process clearing; key names (`tenantKey`, `globalKey`; the `prefix` option for a shared Redis).
4. [auth-storage.md](auth-storage.md) — `createAuthStorage`: Better Auth `secondaryStorage` (session, rate limit, verification); backward-compatible prefixes and fail-open.
5. [queues.md](queues.md) — `createTenantQueue` and `createTenantWorker`: tenant-bound BullMQ jobs.
6. [telemetry.md](telemetry.md) — `onSpan`: cache, placement and queue spans; Sentry / OpenTelemetry.
7. [operations.md](operations.md) — behavior while Redis is down, Redis Cluster, shutdown order, tests and the micro benchmark.

## Exports

| Name | Document |
|---|---|
| `createRedis`, `loadRedisConfig`, `RedisClient` | [getting-started.md](getting-started.md#connections) |
| `createPlacementCache` | [placement-cache.md](placement-cache.md) |
| `createCache`, `Cache` | [cache.md](cache.md) |
| `tenantKey`, `globalKey` | [cache.md](cache.md#keys) |
| `createAuthStorage` | [auth-storage.md](auth-storage.md) |
| `createTenantQueue`, `createTenantWorker` | [queues.md](queues.md) |
