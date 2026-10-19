# Queues

`createTenantQueue` and `createTenantWorker` bind BullMQ to the tenant: job data carries the tenant ID, and for every job the worker builds a tenant-bound `db` with `@0furkancolak/pgcells`’s `createDbScope`. This document covers the producer and consumer API, job IDs, error and retry behavior, and how BullMQ options are passed through.

## Producer

```ts
import { createRedis, createTenantQueue, loadRedisConfig } from "@0furkancolak/pgcells-redis";

const redis = createRedis(loadRedisConfig());
const emails = createTenantQueue<{ userId: string }>("emails", { connection: redis.queue });

await emails.add("abc", "welcome", { userId }, { jobId: userId, attempts: 3, removeOnComplete: 1000, removeOnFail: 1000 });
// job data: { tenantId: "abc", payload: { userId } }, jobId: "abc_<userId>"

await emails.close();
```

- `createTenantQueue(name, options)` → `{ queue, add, close }`. `options` are BullMQ `QueueOptions`; `queue` is the raw BullMQ `Queue` object.
- The queue name must be `[a-z0-9-]` (`INVALID_QUEUE_NAME`).
- `add(tenantId, jobName, payload, opts)` validates the tenant ID (`INVALID_TENANT_ID`). If `opts.jobId` is given it becomes `<tenantId>_<jobId>`: the same ID does not collide across tenants, and a job added again for the same tenant is deduplicated by BullMQ.
- `add` does not check the placement. To avoid adding a job for an unknown tenant, first call `await placements.loadPlacement(tenantId)` (`TENANT_NOT_FOUND`).
- For repeating jobs, use the raw queue: `emails.queue.upsertJobScheduler(...)`.

## Consumer

```ts
import { createDatabase, errorCode } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { prepareQuery } from "@0furkancolak/pgcells/management";
import { createPlacementCache, createRedis, createTenantWorker, loadRedisConfig } from "@0furkancolak/pgcells-redis";

const db = createDatabase({ driver: bunDriver, poolMax: 3 });
const redis = createRedis(loadRedisConfig());
const placements = createPlacementCache({ redis, db });
const createUser = prepareQuery("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2::text, $3::text)");

const worker = createTenantWorker<{ id: string; name: string; email: string }>(
  "users",
  async (job, { tenantId, db: scope }) => {
    const { id, name, email } = job.data.payload;
    try {
      await scope.tenant.query(createUser, [id, name, email]);
    } catch (error) {
      if (errorCode(error) !== "23505") throw error; // on a retry the row may already be written
    }
  },
  { connection: redis.queue, db, placement: placements.loadPlacement, concurrency: 10 },
);
worker.on("failed", (job, error) => console.error(JSON.stringify({ id: job?.id, code: errorCode(error) })));
```

- `createTenantWorker(name, handler, options)` returns a BullMQ `Worker`.
- `handler(job, { tenantId, db })`: `db` = `createDbScope(db, tenantId, placement)` → the `tenant`, `node`, `platform` contexts ([`@0furkancolak/pgcells` middleware and jobs](https://github.com/0furkancolak/pgcells/blob/main/packages/db-multi/docs/middleware-and-jobs.md#outside-http-createdbscope)).
- `options`: BullMQ `WorkerOptions` + `db` (a `createDatabase` instance, required) + `placement` (optional placement cache). Other BullMQ options (`concurrency`, `limiter` …) are passed through as they are. `createDatabase` opens the pool, and the application closes it.
- A job with an invalid tenant ID fails with `UnrecoverableError`, **without retry**.
- Other errors thrown from the handler (`TENANT_NOT_FOUND`, `TENANT_UNAVAILABLE`, `DATABASE_TIMEOUT` …) are retried according to BullMQ’s `attempts`/`backoff` settings. During a move, `TENANT_UNAVAILABLE` is transient; give a `backoff`.
- Write jobs to be idempotent: on a retry the same job may run a second time (the `23505` pattern above).

## Connection and Cluster

- The connection must be `redis.queue` (`maxRetriesPerRequest: null`); `redis.command` does not suit BullMQ’s blocking commands.
- On Redis Cluster, give both the queue and the worker `prefix: "{bull}"`; BullMQ keys then land in the same slot.
- Redis must have `maxmemory-policy noeviction` (a BullMQ requirement).

## Shutdown

```ts
process.once("SIGTERM", async () => {
  await worker.close();   // waits for running jobs to finish
  await emails.close();
  await Promise.all([db.close(), redis.close()]);
});
```

## Caveats

- **`add` fails while Redis is down** (it is not fail-open); the caller must retry or return the request with an error. The worker reconnects by itself when Redis returns; in the end-to-end test, the queue job completed within ≈ 1 s after Redis came back.
- Jobs of a tenant that is being moved write to the new DB once the placement cache has expired; stop the workers that write to that tenant during the move too (`--writers-drained`).
