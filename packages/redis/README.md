# @0furkancolak/pgcells-redis — tenant-aware Redis

Redis helpers for `@0furkancolak/pgcells`: tenant keys, a two-layer cache (in-process LRU → Redis), a placement cache for multi-process setups, and tenant-bound BullMQ queues. ioredis 5 + BullMQ 5; the only environment variable is `REDIS_URL`. While Redis is down, cache reads count as misses and requests are answered from the database (fail-open).

## Quick start

```ts
import { createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { dbMiddleware } from "@0furkancolak/pgcells/middleware";
import { createCache, createPlacementCache, createRedis, createTenantQueue } from "@0furkancolak/pgcells-redis";

const db = createDatabase({ driver: bunDriver });
const redis = createRedis();                               // REDIS_URL; connections open on first use
const placements = createPlacementCache({ redis, db });    // local 5 s + Redis 20 s
const cache = createCache({ redis });
const emails = createTenantQueue<{ userId: string }>("emails", { connection: redis.queue });

app.use(dbMiddleware({ database: db, rootDomain: "example.com", placement: placements.loadPlacement }));
// shutdown: await emails.close(); await redis.close(); await db.close();
```

Step by step: [docs/getting-started.md](docs/getting-started.md).

Exports: `createRedis`, `loadRedisConfig`, `RedisClient`, `createCache`, `Cache`, `createPlacementCache`, `createAuthStorage`, `createTenantQueue`, `createTenantWorker`, `tenantKey`, `globalKey`.

## Documentation

- [docs/README.md](docs/README.md) — table of contents
- [Getting started](docs/getting-started.md) · [Placement cache](docs/placement-cache.md) · [Cache and keys](docs/cache.md) · [Better Auth storage](docs/auth-storage.md) · [Queues](docs/queues.md) · [Telemetry](docs/telemetry.md) · [Operations and tests](docs/operations.md)

## Scripts

`test` (without Redis), `test:integration` (`RUN_REDIS=1`), `typecheck`, `lint`, `format`, `bench`.
