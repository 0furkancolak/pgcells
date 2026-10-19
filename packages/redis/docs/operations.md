# Operations and tests

This document describes how a system that uses `@0furkancolak/pgcells-redis` behaves in production: what happens while Redis is down, what to watch for on Redis Cluster, what the order should be when a process shuts down, and how to run the package’s tests and micro benchmark.

## While Redis is down

| Component | Behavior |
|---|---|
| `createCache` read/`wrap` | From a local hit if there is one; otherwise the Redis command fails after `commandTimeout` (500 ms), counts as a miss and the `loader` result is returned (fail-open) |
| `createCache` write, `del`, broadcast | Skipped; the error goes to `onError` |
| `invalidateTenant` | Invalidates only its own process; other processes refresh after `localTtlMs` |
| `createPlacementCache.loadPlacement` | A local hit or a read from the platform database; requests are answered from the DB |
| `invalidatePlacement` | Does not reach other processes; safety comes from the time limit and the move wait ([placement-cache.md](placement-cache.md#time-limit)) |
| `createAuthStorage` read, write | Read gives `null` (the session is not visible), write is skipped |
| `createAuthStorage.delete` | Throws `AUTH_STORAGE_UNAVAILABLE`; the key is not read in this process and the delete is retried ([auth-storage.md](auth-storage.md#redis-errors)) |
| `createAuthStorage.increment` | An in-process fixed-window counter (at most 10,000 keys; when full, a new key counts as having exceeded the limit) |
| `createTenantQueue.add` | Fails; the caller must retry |
| `createTenantWorker` | Reconnects through ioredis and continues processing |

Measured in the end-to-end test ([`@0furkancolak/pgcells-e2e` results](https://github.com/0furkancolak/pgcells/blob/main/packages/e2e/docs/results.md)): with Redis down, a request served from the local cache took 1–2 ms, a request whose local entry had expired took 512–518 ms (500 ms `commandTimeout` + the DB read), an insert took 10–34 ms; after Redis came back, the queue job completed within 0.8–1.0 s.

So that errors do not flood the log, throttle `onError` (e.g. a function that writes once every 5 s).

### Caveat

Every miss waits 500 ms: if Redis stays down for a long time, every request whose local entry has expired is delayed by that much. To shorten it, pass `createRedis(config, { commandTimeout: 200 })` (applies only to the `command`/`subscriber` connections).

## Redis Cluster

- Tenant keys have the form `t:{<tenant>}:…`; the `{…}` hash tag puts all of a tenant’s keys in the same slot.
- The `prefix` option must not contain `{` or `}`.
- Give BullMQ queues and workers `prefix: "{bull}"`.
- The cache invalidation channel `g:cache:invalidate` (with a prefix, `<prefix>:g:cache:invalidate`) is a single pub/sub channel.
- The cache’s version key is in the same slot as the value key (`v:t:{<tenant>}:…`, `v:{<key>}` for a key without a tag); the version-comparing Lua script uses the two keys together ([cache.md](cache.md#keys)).

## Shutdown order

1. Stop the HTTP server (so it takes no new requests).
2. Close workers and queues: `await worker.close()`, `await queue.close()`.
3. `await redis.close()` — drops the connections immediately and does not wait for pending replies.
4. `await db.close()`.

```ts
process.once("SIGTERM", async () => {
  await server.stop();
  await worker.close();
  await queue.close();
  await Promise.all([redis.close(), db.close()]);
  process.exit(0);
});
```

## Redis settings

- `maxmemory-policy noeviction` for BullMQ. If you keep the cache and the queue in separate Redis instances, `allkeys-lru` can be used on the cache Redis; if they are in the same Redis, `noeviction` is mandatory and you should choose cache TTLs accordingly.
- Persistence matters for the queue; it can be turned off for a cache-only Redis.

## Tests

```sh
cd packages/redis
bun run test                 # unit tests, no Redis needed
bun run typecheck && bun run lint
```

Integration tests use a real Redis and the `@0furkancolak/pgcells` compose PostgreSQL:

```sh
(cd ../db-multi && docker compose up -d --wait && bun run cli bootstrap)
docker run -d --name redis-test -p 127.0.0.1:6390:6379 redis:7.4-alpine
RUN_REDIS=1 bun run test:integration
# REDIS_URL defaults to redis://127.0.0.1:6390; DATABASE_URLS defaults to the direct URLs of the packages/db-multi compose
```

Without `RUN_REDIS=1`, the integration tests are skipped. The tests provision a tenant named `redis-test` onto db0. CI runs the same steps at the end of the `packages/db-multi` job.

## Micro benchmark

```sh
bun run bench   # env: REDIS_URL (default redis://127.0.0.1:6390), DATABASE_URLS (direct URLs), BENCH_N (default 50000)
```

It is not a test: it provisions a `redis-bench` tenant onto db0 and measures the time per placement — a local hit, a Redis hit (`localTtlMs: 0`) and a direct `db.platform.get`. The output is JSON of the form `[{ name, n, opsPerSec, p50Us, p99Us }]`.
