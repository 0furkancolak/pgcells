import { afterAll, expect } from "bun:test";
import type { Connection, Driver } from "../../core/driver";
import { provisionTenant } from "../../core/operations/provision";
import { createDatabase } from "../../index";
import { createDbScope, dbMiddleware, type MiddlewareContext, type RequestDb } from "../../middleware";
import { getNodeIdentity } from "../../queries/node/identity.gen";
import { listTenants } from "../../queries/platform/tenants.gen";
import { createTestManagement, createUser, driver, integration, listUsers, pooledConfig, removeTenants, uniqueEmail } from "./helpers";

const management = createTestManagement();
/** Each test gets its own `mw-` tenant; no trace stays in the shared DBs. */
const tenantIds: string[] = [];
function tenantId() {
  const id = `mw-${crypto.randomUUID().slice(0, 8)}`;
  tenantIds.push(id);
  return id;
}
afterAll(async () => {
  try {
    if (tenantIds.length) await removeTenants(management, ...tenantIds);
  } finally {
    await management.close();
  }
});

/** A fake context with just the surface Hono uses. */
function context(host: string) {
  const vars: { db?: RequestDb } = {};
  const c: MiddlewareContext = { req: { header: (name) => (name === "host" ? host : undefined) }, set: (_key, value) => (vars.db = value) };
  return { c, vars };
}

/** Wraps the driver; counts queries that read `platform.placements` (pool and reserved connection paths). */
function countingPlacements() {
  const counter = { reads: 0 };
  const track = <T extends Connection>(connection: T, rest: Omit<T, keyof Connection>): T =>
    ({
      ...rest,
      query: (text: string, params?: readonly unknown[]) => {
        if (text.includes("platform.placements")) counter.reads++;
        return connection.query(text, params);
      },
      exec: (sql: string) => connection.exec(sql),
    }) as T;
  const counting: Driver = (url, options) => {
    const pool = driver(url, options);
    return track(pool, {
      reserve: async () => {
        const reserved = await pool.reserve();
        return track(reserved, { release: () => reserved.release() });
      },
      close: (ms) => pool.close(ms),
    });
  };
  return { counter, driver: counting };
}

integration("middleware adds a tenant-bound db to the context, shared or per request", async () => {
  const id = tenantId();
  await provisionTenant(management, id, "db1");
  for (const perRequest of [false, true]) {
    const middleware = dbMiddleware({ driver, rootDomain: "test", config: pooledConfig(), perRequest });
    const { c, vars } = context(`${id}.test:443`);
    let rows: unknown[] = [];
    await middleware(c, async () => {
      const db = vars.db!;
      expect(db.tenantId).toBe(id);
      await db.tenant.transaction(async (tx) => {
        await tx.query(createUser, [crypto.randomUUID(), `user ${perRequest}`, uniqueEmail()]);
      });
      rows = await db.tenant.query(listUsers, [10, 0]);
    });
    expect(rows).toHaveLength(perRequest ? 2 : 1);
  }
  // Placement is read once per request: concurrent and sequential queries and transactions share it.
  const counted = countingPlacements();
  const request = context(`${id}.test:443`);
  await dbMiddleware({ driver: counted.driver, rootDomain: "test", config: pooledConfig(), perRequest: true })(request.c, async () => {
    const db = request.vars.db!;
    await Promise.all([db.tenant.query(listUsers, [1, 0]), db.tenant.query(listUsers, [1, 0])]);
    await db.tenant.transaction((tx) => tx.query(listUsers, [1, 0]));
    await db.tenant.query(listUsers, [1, 0]);
  });
  expect(counted.counter.reads).toBe(1);
  // A route that never touches db does not need a valid tenant.
  const { c } = context("not a host");
  await dbMiddleware({ driver, rootDomain: "test", config: pooledConfig(), perRequest: true })(c, async () => {});
  const bad = context("not a host");
  await dbMiddleware({ driver, rootDomain: "test", config: pooledConfig(), perRequest: true })(bad.c, async () => {
    await expect(bad.vars.db!.tenant.query(listUsers, [1, 0])).rejects.toMatchObject({ code: "INVALID_TENANT_ID" });
    // The platform database needs no tenant.
    expect((await bad.vars.db!.platform.query(listTenants, [1, 0])).length).toBeLessThanOrEqual(1);
  });
});

integration("tenant, node and platform databases in one request; a cached placement skips the platform read", async () => {
  const id = tenantId();
  await provisionTenant(management, id, "db1");
  const runtime = createDatabase(pooledConfig(), { driver });
  const cachedPlacement = await runtime.platform.get(id);
  await runtime.close();

  const counted = countingPlacements();
  const request = context(`${id}.test:443`);
  const middleware = dbMiddleware({ driver: counted.driver, rootDomain: "test", config: pooledConfig(), perRequest: true, placement: async () => cachedPlacement });
  await middleware(request.c, async () => {
    const db = request.vars.db!;
    const [tenants, users, identity] = await Promise.all([
      db.platform.query<{ tenantId: string }[]>(listTenants, [100_000, 0]),
      db.tenant.query(listUsers, [10, 0]),
      db.node.query<{ databaseId: string }[]>(getNodeIdentity),
    ]);
    expect(tenants.map((t) => t.tenantId)).toContain(id);
    expect(users).toEqual([]);
    // The node context is the tenant's database.
    expect(identity.map((row) => row.databaseId)).toEqual(["db1"]);
    await db.platform.transaction((tx) => tx.query(listTenants, [1, 0]));
    // Scopes never mix.
    for (const [run, query] of [
      [db.tenant.query, listTenants],
      [db.tenant.query, getNodeIdentity],
      [db.node.query, listUsers],
      [db.node.query, listTenants],
      [db.platform.query, listUsers],
      [db.platform.query, getNodeIdentity],
    ] as const)
      await expect(run(query, [1, 0])).rejects.toMatchObject({ code: "QUERY_SCOPE" });
  });
  // listTenants is not a placement lookup (it reads "platform".placements); the tenant lookup came from the cache.
  expect(counted.counter.reads).toBe(0);
});

integration("createDbScope gives cron and queue jobs the same tenant, node and platform contexts without HTTP", async () => {
  const id = tenantId();
  await provisionTenant(management, id, "db1");
  const counted = countingPlacements();
  const db = createDatabase(pooledConfig(), { driver: counted.driver });
  try {
    // A scheduled job: list tenants from the platform DB, then work inside each tenant.
    const tenants = await createDbScope(db, () => {
      throw new Error("platform-only work must not resolve a tenant");
    }).platform.query<{ tenantId: string }[]>(listTenants, [100_000, 0]);
    expect(tenants.map((t) => t.tenantId)).toContain(id);
    const job = createDbScope(db, id);
    await job.tenant.transaction((tx) => tx.query(createUser, [crypto.randomUUID(), "cron", uniqueEmail()]));
    const [users, identity] = await Promise.all([job.tenant.query(listUsers, [10, 0]), job.node.query<{ databaseId: string }[]>(getNodeIdentity)]);
    expect(users).toHaveLength(1);
    expect(identity.map((row) => row.databaseId)).toEqual(["db1"]);
    expect(counted.counter.reads).toBe(1);
  } finally {
    await db.close();
  }
});
