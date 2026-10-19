/** Alan adı tenant ID'leri, schema adlandırma, demo tenant'lar ve seed'ler (gerçek PostgreSQL). Paketin tek seed'i demo profilindeki
 * `demo_login`dir (Demo kullanıcısı + parola hesabı); install profili boştur. */
import { afterAll, beforeAll, expect } from "bun:test";
import { bootstrap, provisionTenant, resetDemoTenant, seedAll, seedTenant } from "../../management";
import { seeds, tenantMigrations } from "../../core/migrations/registry";
import type { SeedProfile } from "../../core/migrations/source";
import { type Placement, tenantFromHost, tenantSchema } from "../../core/tenants/model";
import { createTestManagement, createTestRuntime, enabled, failure, integration, listUsers, q, removeTenants } from "./helpers";

let app: ReturnType<typeof createTestManagement>;
const base = `seeds-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const domain = (label: string) => `${base}-${label}`;
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

const count = async (p: Placement, table: string) =>
  (
    await app.pools
      .node(p.databaseId)
      .query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${q(p.schemaName, table)}`)
  )[0]?.n;
const seedEvents = (events: Record<string, unknown>[]) =>
  events.filter((event) => event.seed && event.status === "succeeded").map((event) => event.seed);
const ids = (profile: SeedProfile) => seeds[profile].map((seed) => seed.id);

integration("tenant ids map to readable schemas; a 56-char id fits 63 bytes; invalid and reserved ids are refused", async () => {
  const dash = domain("a-b");
  const long = `${base}-${"l".repeat(56 - base.length - 1)}`;
  const placements = [await provisionTenant(app, dash, "db0"), await provisionTenant(app, long, "db1")];
  expect(placements.map((p) => p.schemaName)).toEqual([tenantSchema(dash), tenantSchema(long)]);
  expect(placements[0]?.schemaName).toBe(`tenant_${base.replaceAll("-", "_")}_a_b`);
  expect(placements[1]?.schemaName.length).toBe(63);
  for (const id of ["Acme", "ab", "1abc", "a_b", "a--b", "abc.def", "-abc", `${long}x`])
    expect(await failure(provisionTenant(app, id)), id).toBe("INVALID_TENANT_ID");
  for (const id of ["www", "admin", "api", "demo"]) expect(await failure(provisionTenant(app, id)), id).toBe("TENANT_RESERVED");
});

integration("a real tenant gets only install seeds and a seed ledger; demo seeds and reset are refused there", async () => {
  const id = domain("shop");
  const events: Record<string, unknown>[] = [];
  const p = await provisionTenant(app, id, "db1", { report: (event) => events.push(event) });
  expect(p).toMatchObject({ kind: "tenant", schemaName: tenantSchema(id), status: "active" });
  expect(seedEvents(events)).toEqual(ids("install"));
  // Demo girişi gerçek tenant'a yazılmaz.
  expect([await count(p, "_seeds"), await count(p, "users"), await count(p, "account")]).toEqual([ids("install").length, 0, 0]);
  expect(await seedTenant(app, id)).toEqual({ tenantId: id, profile: "install", dryRun: false, seeds: [] });
  expect(await provisionTenant(app, id, "db1")).toMatchObject({ status: "active" });
  expect(await count(p, "_seeds")).toBe(ids("install").length);
  expect(await failure(seedTenant(app, id, { profile: "demo" }))).toBe("DEMO_TENANT_REQUIRED");
  expect(await failure(seedTenant(app, id, { profile: "demo", dryRun: true }))).toBe("DEMO_TENANT_REQUIRED");
  expect(await failure(resetDemoTenant(app, id))).toBe("DEMO_TENANT_REQUIRED");
  expect(await failure(provisionTenant(app, id, "db1", { demo: true }))).toBe("TENANT_CONFLICT");
});

integration("a demo tenant gets a demo_ schema with install and demo seeds once, resolves by Host and resets", async () => {
  const id = domain("demo");
  const events: Record<string, unknown>[] = [];
  const p = await provisionTenant(app, id, "db0", { demo: true, report: (event) => events.push(event) });
  expect(p).toMatchObject({ kind: "demo", schemaName: tenantSchema(id, "demo"), status: "active" });
  expect(p.schemaName.startsWith("demo_")).toBe(true);
  expect(seedEvents(events)).toEqual([...ids("install"), ...ids("demo")]);
  expect(seedEvents(events)).toContain("20260915155445_demo_login");
  expect(await seedTenant(app, id, { profile: "demo" })).toMatchObject({ seeds: [] });
  expect(await seedTenant(app, id, { profile: "demo", dryRun: true })).toMatchObject({ dryRun: true, seeds: [] });
  const [login] = await app.pools
    .node(p.databaseId)
    .query<{ email: string; provider: string }>(
      `SELECT u.email, a.provider_id AS provider FROM ${q(p.schemaName, "users")} u JOIN ${q(p.schemaName, "account")} a ON a.user_id=u.id`,
    );
  expect(login).toEqual({ email: `demo@${id}.example.com`, provider: "credential" });

  const runtime = createTestRuntime();
  try {
    const rows = await runtime.withTenant(tenantFromHost(`${id.toUpperCase()}.Example.TEST.:8443`, "example.test"), (tenant) =>
      tenant.query<{ name: string }[]>(listUsers, [10, 0]),
    );
    expect(rows.map((row) => row.name)).toEqual(["Demo"]);
  } finally {
    await runtime.close();
  }

  await app.pools.node(p.databaseId).query(`INSERT INTO ${q(p.schemaName, "users")} (name,email) VALUES ('Geçici','gecici@example.com')`);
  expect(await count(p, "users")).toBe(2);
  const reset = await resetDemoTenant(app, id);
  expect(reset).toMatchObject({ status: "active", schemaVersion: tenantMigrations.length, placementVersion: p.placementVersion });
  expect([await count(p, "users"), await count(p, "account"), await count(p, "_seeds")]).toEqual([1, 1, ids("install").length + ids("demo").length]);
});

integration("a changed checksum of an applied seed is SEED_DRIFT and nothing reruns", async () => {
  const id = domain("drift");
  const p = await provisionTenant(app, id, undefined, { demo: true });
  await app.pools.node(p.databaseId).query(`UPDATE ${q(p.schemaName, "_seeds")} SET checksum='changed'`);
  expect(await failure(seedTenant(app, id, { profile: "demo" }))).toBe("SEED_DRIFT");
  expect(await failure(seedTenant(app, id, { profile: "demo", dryRun: true }))).toBe("SEED_DRIFT");
  expect(await count(p, "users")).toBe(1);
});

integration("seeds need current migrations; seedAll applies pending seeds to active tenants once", async () => {
  const id = domain("all");
  const p = await provisionTenant(app, id, undefined, { demo: true });
  const db = app.pools.node(p.databaseId);
  const last = tenantMigrations.at(-1);
  if (!last) throw new Error("No tenant migrations");
  // Seed'ler hiç çalışmamış gibi: ledger ve demo girişinin yazdıkları (hesap cascade ile) silinir.
  await db.query(`DELETE FROM ${q(p.schemaName, "_seeds")}`);
  await db.query(`DELETE FROM ${q(p.schemaName, "users")}`);
  await db.query(`DELETE FROM ${q(p.schemaName, "_migrations")} WHERE id=$1`, [last.id]);
  expect(await failure(seedTenant(app, id, { profile: "demo" }))).toBe("MIGRATIONS_PENDING");
  expect(await count(p, "users")).toBe(0);
  await db.query(`INSERT INTO ${q(p.schemaName, "_migrations")} (id,checksum) VALUES ($1,$2)`, [last.id, last.checksum]);

  // Other suites leave drifted or partially migrated tenants on the database: continue and inspect this tenant only.
  const run = async (profile: SeedProfile) => {
    const events: Record<string, unknown>[] = [];
    await seedAll(app, { databaseIds: [p.databaseId], profile, continueOnError: true, report: (event) => events.push(event) });
    return events.filter((event) => event.tenantId === id);
  };
  expect(seedEvents(await run("install"))).toEqual(ids("install"));
  const first = await run("demo");
  expect(seedEvents(first)).toEqual(ids("demo"));
  expect(first.at(-1)).toMatchObject({ status: "succeeded" });
  expect(seedEvents(await run("demo"))).toEqual([]);
  expect(seedEvents(await run("install"))).toEqual([]);
  expect([await count(p, "users"), await count(p, "account")]).toEqual([1, 1]);
});
