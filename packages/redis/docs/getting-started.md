# Getting started

This document adds `@0furkancolak/pgcells-redis` to an application: Redis connections, wiring the placement cache into `dbMiddleware` and the management context, the application cache, a queue producer and a separate worker process. It assumes the `@0furkancolak/pgcells` setup ([`@0furkancolak/pgcells` getting started](https://github.com/0furkancolak/pgcells/blob/main/packages/db-multi/docs/getting-started.md)) is already done.

## 1. Dependency and environment

In the application package’s `package.json`:

```json
{ "dependencies": { "@0furkancolak/pgcells": "workspace:*", "@0furkancolak/pgcells-redis": "workspace:*" } }
```

The only environment variable is `REDIS_URL` (e.g. `redis://redis:6379`); without it `loadRedisConfig()` gives `INVALID_CONFIG`. For BullMQ, Redis must run with `maxmemory-policy noeviction`.

Local Redis:

```sh
docker run -d --name redis -p 127.0.0.1:6390:6379 redis:7.4-alpine
export REDIS_URL=redis://127.0.0.1:6390
```

## Connections

```ts
import { createRedis, loadRedisConfig } from "@0furkancolak/pgcells-redis";

const redis = createRedis(loadRedisConfig(), { onError: (error) => console.error(error) }); // once per process
```

`createRedis({ url }, options)` gives three separate ioredis connections; each opens on first use:

| Connection | Setting | Use |
|---|---|---|
| `redis.command` | `maxRetriesPerRequest: 1`, `commandTimeout: 500` | Cache commands; while Redis is down a command fails after 500 ms and the cache stays fail-open |
| `redis.subscriber` | — | Pub/sub (a subscriber connection cannot run other commands) |
| `redis.queue` | `maxRetriesPerRequest: null` | BullMQ (blocking commands) |

- `options` are ioredis options and apply only to `command` and `subscriber` (for `command` they can also override the two settings above).
- `onError` receives connection errors; if not given, ioredis prints “Unhandled error event”. Reconnection is handled by ioredis.
- `redis.close()` drops the connections immediately and does not wait for pending replies: close queues and workers first.

## 2. HTTP application

```ts
import { Hono } from "hono";
import { createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { prepareQuery } from "@0furkancolak/pgcells/management";
import { dbMiddleware, type RequestDb } from "@0furkancolak/pgcells/middleware";
import { createCache, createPlacementCache, createRedis, createTenantQueue, loadRedisConfig } from "@0furkancolak/pgcells-redis";

const db = createDatabase({ driver: bunDriver, poolMax: 10 });
const redis = createRedis(loadRedisConfig(), { onError: console.error });
const placements = createPlacementCache({ redis, db });
const cache = createCache({ redis, onError: console.error });
const welcome = createTenantQueue<{ userId: string }>("welcome", { connection: redis.queue });
// Compiled once at startup (the same compiler as codegen); the table name is qualified with the tenant schema at runtime.
const listUsers = prepareQuery("SELECT id::text AS id, name, email FROM users ORDER BY users.id LIMIT $1 OFFSET $2");

const app = new Hono<{ Variables: { db: RequestDb } }>();
app.use(dbMiddleware({ database: db, rootDomain: "example.com", placement: placements.loadPlacement }));

app.get("/users", async (c) => {
  const request = c.get("db");
  const users = await cache.forTenant(request.tenantId).wrap("users:page:1", () => request.tenant.query(listUsers, [20, 0]));
  return c.json(users);
});
app.post("/users/:id/welcome", async (c) => {
  const tenantId = c.get("db").tenantId;
  await placements.loadPlacement(tenantId); // unknown tenant → TENANT_NOT_FOUND (before the job enters the queue)
  await welcome.add(tenantId, "send", { userId: c.req.param("id") }, { jobId: c.req.param("id") });
  return c.json({ queued: true }, 202);
});

const server = Bun.serve({ port: 8080, fetch: app.fetch });
process.once("SIGTERM", async () => {
  await server.stop();
  await welcome.close();
  await Promise.all([db.close(), redis.close()]);
  process.exit(0);
});
```

In the routes where you write, clear the relevant cache: `await cache.forTenant(tenantId).del("users:page:1")`, or `await cache.invalidateTenant(tenantId)` for the tenant’s entire cache.

## 3. Worker process

```ts
import { createDatabase, errorCode } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createPlacementCache, createRedis, createTenantWorker, loadRedisConfig } from "@0furkancolak/pgcells-redis";

const db = createDatabase({ driver: bunDriver, poolMax: 3 });
const redis = createRedis(loadRedisConfig(), { onError: console.error });
const placements = createPlacementCache({ redis, db });

const worker = createTenantWorker<{ userId: string }>(
  "welcome",
  async (job, { tenantId, db: scope }) => {
    // scope.tenant / scope.node / scope.platform — the same as c.get("db") in dbMiddleware
    console.log(JSON.stringify({ tenantId, userId: job.data.payload.userId }));
  },
  { connection: redis.queue, db, placement: placements.loadPlacement, concurrency: 10 },
);
worker.on("failed", (job, error) => console.error(JSON.stringify({ id: job?.id, code: errorCode(error) })));

process.once("SIGTERM", async () => {
  await worker.close();
  await Promise.all([db.close(), redis.close()]);
  process.exit(0);
});
```

## 4. Management context

So that the cache is cleared immediately when the placement state changes (move, demo reset, activation), give the hook to the management context:

```ts
import { createManagement } from "@0furkancolak/pgcells/management";

const management = createManagement({ driver: bunDriver, onPlacementChange: (tenantId) => placements.invalidatePlacement(tenantId) });
```

Management without the hook (e.g. a CLI that does not connect to Redis) is also safe; details in [placement-cache.md](placement-cache.md#invalidation).

## Common mistakes

- **`INVALID_CONFIG: Placement cache ttlSeconds*1000 + localTtlMs must be <= 25000`** — the sum of the placement cache durations exceeds 25 s.
- **Queue jobs get stuck / “maxRetriesPerRequest must be null”** — `redis.command` was given to the queue or worker; use `connection: redis.queue`.
- **“Connection is closed” on shutdown** — `redis.close()` was called before the worker/queue.
