/** Real Redis (`REDIS_URL`, default 127.0.0.1:6390) and the packages/db-multi compose PostgreSQL (`DATABASE_URLS`). Runs with `RUN_REDIS=1`. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createConfig, createDatabase, type Span } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createManagement, prepareQuery, provisionTenant } from "@0furkancolak/pgcells/management";
import { createCache } from "../../cache";
import { createRedis } from "../../client";
import { createPlacementCache } from "../../placement";
import { createTenantQueue, createTenantWorker } from "../../queue";

const integration = process.env.RUN_REDIS === "1" ? test : test.skip;
const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6390";
const config = createConfig(
  process.env.DATABASE_URLS ?? "postgres://admin:local_admin_password@127.0.0.1:5540/app,postgres://admin:local_admin_password@127.0.0.1:5541/app",
);
const tenantId = "redis-test";
const listUsers = prepareQuery("SELECT id::text AS id, name FROM users ORDER BY users.id LIMIT $1");
const one = createRedis({ url });
const two = createRedis({ url });
const db = createDatabase(config, { driver: bunDriver, poolMax: 2 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  if (process.env.RUN_REDIS !== "1") return;
  const management = createManagement(config, { driver: bunDriver });
  try {
    await provisionTenant(management, tenantId, "db0");
  } finally {
    await management.close();
  }
});
afterAll(async () => {
  await Promise.all([one.close(), two.close(), db.close()]);
});

integration("cache: tenant invalidation and cross-process local invalidation over pub/sub", async () => {
  const prefix = `test-${crypto.randomUUID()}`;
  const a = createCache({ redis: one, prefix });
  const b = createCache({ redis: two, prefix });
  await sleep(100); // subscriptions
  await a.forTenant(tenantId).set("x", { v: 1 });
  expect(await b.forTenant(tenantId).get<{ v: number }>("x")).toEqual({ v: 1 });
  await a.forTenant(tenantId).set("x", { v: 2 });
  await sleep(50);
  expect(await b.forTenant(tenantId).get<{ v: number }>("x")).toEqual({ v: 2 });
  await a.invalidateTenant(tenantId);
  await sleep(50);
  expect(await b.forTenant(tenantId).get("x")).toBeUndefined();
});

integration("cache fails open when Redis is unreachable", async () => {
  const down = createRedis({ url: "redis://127.0.0.1:6399" }, { retryStrategy: () => 200, onError: () => {} });
  const errors: unknown[] = [];
  const cache = createCache({ redis: down, onError: (error) => errors.push(error) });
  const started = Date.now();
  expect(await cache.forTenant(tenantId).wrap("k", () => 7)).toBe(7);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(errors.length).toBeGreaterThan(0);
  await down.close();
});

integration("placement cache fills from the platform DB and invalidates across processes", async () => {
  const a = createPlacementCache({ redis: one, db, prefix: "test-placement" });
  const b = createPlacementCache({ redis: two, db, prefix: "test-placement" });
  await sleep(100);
  await a.invalidatePlacement(tenantId);
  const placement = await a.loadPlacement(tenantId);
  expect(placement.status).toBe("active");
  expect(a(tenantId)).toEqual(placement); // synchronous local hit
  await sleep(50); // wrap writes to Redis in the background (`void set`); the other connection may read before the write
  expect(await b(tenantId)).toEqual(placement); // Redis hit
  await a.invalidatePlacement(tenantId);
  await sleep(50);
  expect(await b(tenantId)).toBeUndefined();
});

integration("management onPlacementChange invalidates cached placements in every process", async () => {
  const a = createPlacementCache({ redis: one, db, prefix: "test-hook" });
  const b = createPlacementCache({ redis: two, db, prefix: "test-hook" });
  const management = createManagement(config, { driver: bunDriver, onPlacementChange: (id) => a.invalidatePlacement(id) });
  await sleep(100);
  try {
    const active = await b.loadPlacement(tenantId);
    expect(b(tenantId)).toEqual(active);
    const maintenance = await management.platform.setStatus(await management.platform.get(tenantId), "maintenance");
    await sleep(50);
    expect(await b(tenantId)).toBeUndefined();
    await management.platform.setStatus(maintenance, "active");
  } finally {
    await management.close();
  }
});

integration("tenant worker runs the job with a tenant-bound db scope", async () => {
  const name = `test-${crypto.randomUUID().slice(0, 8)}`;
  const placements = createPlacementCache({ redis: one, db, prefix: "test-placement" });
  const spans: Span[] = [];
  const onSpan = (span: Span) => void spans.push(span);
  const queue = createTenantQueue<{ limit: number }>(name, { connection: one.queue, onSpan });
  const worker = createTenantWorker<{ limit: number }, { tenantId: string; rows: number }>(
    name,
    async (job, scope) => ({ tenantId: scope.tenantId, rows: (await scope.db.tenant.query(listUsers, [job.data.payload.limit])).length }),
    { connection: one.queue, db, placement: placements.loadPlacement, onSpan },
  );
  try {
    const done = new Promise<unknown>((resolve, reject) => {
      worker.on("completed", (_job, result) => resolve(result));
      worker.on("failed", (_job, error) => reject(error));
    });
    const job = await queue.add(tenantId, "count", { limit: 5 }, { jobId: "one" });
    expect(job.id).toBe(`${tenantId}_one`);
    expect(job.data.tenantId).toBe(tenantId);
    const result = (await done) as { tenantId: string; rows: number };
    expect(result.tenantId).toBe(tenantId);
    expect(result.rows).toBeGreaterThanOrEqual(0);
    await sleep(50); // the queue.job span ends after the "completed" event
    expect(spans.map(({ name, tenantId, detail, error }) => ({ name, tenantId, detail, error }))).toEqual([
      { name: "queue.add", tenantId, detail: "count", error: undefined },
      { name: "queue.job", tenantId, detail: "count", error: undefined },
    ]);
    expect(() => queue.add("Bad Id", "count", { limit: 1 })).toThrow();
    expect(() => createTenantQueue("Bad_Name", { connection: one.queue })).toThrow();
  } finally {
    await worker.close();
    await queue.queue.obliterate({ force: true });
    await queue.close();
  }
});
