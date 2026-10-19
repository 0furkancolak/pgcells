/** Tenant yer seçimi (boyut, kapasite, draining), bütün DB'lerde schema tekilliği, ayrılmış ID'ler ve DB hazırlığı (gerçek PostgreSQL). */
import { afterAll, beforeAll, expect } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { listDatabases, releaseTenantIds, reserveTenantIds, setDatabase } from "../../core/tools/tenancy";
import { createDatabase } from "../../index";
import { bootstrap, provisionTenant } from "../../management";
import { createTestManagement, directConfig, driver, enabled, failure, integration, pooledConfig, q, removeTenants } from "./helpers";

let app: ReturnType<typeof createTestManagement>;
const base = `place-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const id = (label: string) => `${base}-${label}`;
beforeAll(async () => {
  if (!enabled) return;
  app = createTestManagement();
  await bootstrap(app);
});
afterAll(async () => {
  if (!app) return;
  try {
    await removeTenants(app, base);
  } finally {
    await app.close();
  }
});

/** Runs `work` with node settings changed, then restores every node's status and capacity. */
async function withNodes<T>(work: (loads: Record<string, number>) => Promise<T>) {
  const before = await listDatabases(app);
  try {
    return await work(Object.fromEntries(before.map((d) => [d.databaseId, d.load])));
  } finally {
    for (const d of before) await setDatabase(app, d.databaseId, { status: d.status, capacity: d.capacity });
  }
}

integration("provision picks the least loaded active database for the tenant size and honours draining and capacity", async () => {
  await withNodes(async (load) => {
    const [l0, l1] = [load.db0 ?? 0, load.db1 ?? 0];
    // db0 has plenty of room, db1 exactly fits: size 50 lands on db0 (lower ratio).
    await setDatabase(app, "db0", { status: "active", capacity: l0 + 10_000 });
    await setDatabase(app, "db1", { status: "active", capacity: l1 + 50 });
    const big = await provisionTenant(app, id("big"), undefined, { size: 50 });
    expect(big.databaseId).toBe("db0");
    // Swap: db0 is left with room for exactly 50 more, db1 becomes the roomy one.
    await setDatabase(app, "db0", { capacity: l0 + 50 + 50 });
    await setDatabase(app, "db1", { capacity: l1 + 10_000 });
    expect((await provisionTenant(app, id("second"), undefined, { size: 50 })).databaseId).toBe("db1");
    // A draining database receives no new tenants even when it is emptier.
    await setDatabase(app, "db1", { status: "draining" });
    expect((await provisionTenant(app, id("third"), undefined, { size: 10 })).databaseId).toBe("db0");
    // Nothing fits: db0 is full for size 100, db1 drains; an explicit database must fit too.
    expect(await failure(provisionTenant(app, id("none"), undefined, { size: 100 }))).toBe("NO_CAPACITY");
    expect(await failure(provisionTenant(app, id("pinned"), "db1"))).toBe("NO_CAPACITY");
    expect(await failure(provisionTenant(app, id("sized"), undefined, { size: 101 }))).toBe("INVALID_CONFIG");
    // A refused choice leaves no placement behind.
    expect(await failure(app.platform.get(id("none")))).toBe("TENANT_NOT_FOUND");
    const listed = await listDatabases(app);
    expect(listed.find((d) => d.databaseId === "db0")?.load).toBe(l0 + 50 + 10);
    expect(listed.every((d) => d.configured)).toBe(true);
  });
});

integration("a tenant id has one schema across all databases; reserved ids are refused until released", async () => {
  // A leftover schema for this id on db1 blocks provisioning it on db0 (both tenant_ and demo_ names).
  for (const [kind, demo] of [["tenant", false], ["demo", true]] as const) {
    const tenant = id(`dup-${kind}`);
    const schema = `${kind}_${tenant.replaceAll("-", "_")}`;
    await app.pools.node("db1").exec(`CREATE SCHEMA ${q(schema)}`);
    try {
      expect(await failure(provisionTenant(app, tenant, "db0", { demo: !demo }))).toBe("SCHEMA_EXISTS");
      expect(await failure(app.platform.get(tenant))).toBe("TENANT_NOT_FOUND");
    } finally {
      await app.pools.node("db1").exec(`DROP SCHEMA ${q(schema)}`);
    }
  }
  const reserved = id("reserved");
  expect(await reserveTenantIds(app, [reserved], "brand")).toEqual({ reserved: [reserved] });
  expect(await failure(provisionTenant(app, reserved, "db0"))).toBe("TENANT_RESERVED");
  expect(await releaseTenantIds(app, [reserved])).toEqual({ released: [reserved] });
  expect((await provisionTenant(app, reserved, "db0")).status).toBe("active");
  expect(await failure(reserveTenantIds(app, [reserved]))).toBe("TENANT_EXISTS");
});

integration("ready and provisioning fail when a registered database is missing, unregistered, unreachable or reordered", async () => {
  const pooled = pooledConfig().nodes.map((node) => node.url);
  const direct = directConfig().nodes.map((node) => node.url);
  const closedPort = (url: string) => url.replace(/:\d+\//, ":1/");
  const readiness = async (urls: string[]) => {
    const runtime = createDatabase(createConfig(urls), { driver, statementTimeoutMs: 3000 });
    try {
      return await failure(runtime.ready());
    } finally {
      await runtime.close();
    }
  };
  const ok = createDatabase(createConfig(pooled), { driver });
  await ok.ready();
  await ok.close();
  // A database that was never bootstrapped: the server's built-in `postgres` database.
  const fresh = (direct[1] as string).replace(/\/[^/?]+(?=\?|$)/, "/postgres");
  expect(await readiness([pooled[0] as string])).toBe("DATABASE_NOT_CONFIGURED");
  expect(await readiness([...pooled, fresh])).toBe("DATABASE_NOT_REGISTERED");
  expect(await readiness([...pooled, `${pooled[1]}?application_name=extra`])).toBe("DATABASE_ORDER_CHANGED");
  expect(await readiness([pooled[0] as string, closedPort(pooled[1] as string)])).toBe("DATABASE_UNAVAILABLE");
  expect(await readiness([pooled[1] as string, pooled[0] as string])).toBe("DATABASE_ORDER_CHANGED");

  // Management: an unreachable database stops provisioning before any placement is written.
  const down = createTestManagement({}, createConfig([direct[0] as string, closedPort(direct[1] as string)]));
  try {
    expect(await failure(provisionTenant(down, id("down"), "db0"))).toBe("DATABASE_UNAVAILABLE");
    expect(await failure(app.platform.get(id("down")))).toBe("TENANT_NOT_FOUND");
  } finally {
    await down.close();
  }
  const swapped = createTestManagement({}, createConfig([direct[1] as string, direct[0] as string]));
  try {
    expect(await failure(provisionTenant(swapped, id("swapped")))).toBe("DATABASE_ORDER_CHANGED");
  } finally {
    await swapped.close();
  }
});

integration("onPlacementChange runs after committed placement status changes", async () => {
  const changes: string[] = [];
  const hooked = createManagement(directConfig(), { driver, onPlacementChange: (tenantId) => void changes.push(tenantId) });
  try {
    const p = await provisionTenant(hooked, id("hooked"), "db0");
    expect(changes).toEqual([p.tenantId]);
    const maintenance = await hooked.platform.setStatus(p, "maintenance");
    await hooked.platform.setSchemaVersion(maintenance, maintenance.schemaVersion);
    expect(changes).toEqual([p.tenantId, p.tenantId]);
  } finally {
    await hooked.close();
  }
});
