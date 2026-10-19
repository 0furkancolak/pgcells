/** Var olan schema'ları tenant olarak benimseme (gerçek PostgreSQL, iki DB). */
import { afterAll, beforeAll, expect } from "bun:test";
import { tenantMigrations } from "../../core/migrations/registry";
import { adoptSchemas, planAdoption, rollbackAdoption } from "../../core/tools/adopt";
import { bootstrap, migrationStatus, provisionTenant } from "../../management";
import { createTestManagement, enabled, failure, integration, q } from "./helpers";

let app: ReturnType<typeof createTestManagement>;
const u = `x${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const id = (label: string) => `adopt-${u}-${label}`;
const legacy = (label: string) => `legacy_${u}_${label}`;
const target = (label: string) => `tenant_adopt_${u}_${label}`;
const row = (label: string, databaseId = "db0") => ({ tenantId: id(label), schema: legacy(label), databaseId });
const baseline = () => tenantMigrations.at(-1)?.id as string;

beforeAll(async () => {
  if (!enabled) return;
  app = createTestManagement();
  await bootstrap(app);
});
afterAll(async () => {
  if (!app) return;
  await removeTestTenants();
  await app.close();
});

/** Paylaşılan DB'ler temiz kalır: bu çalıştırmanın placement, tenant satırları ve schema'ları silinir. */
async function removeTestTenants() {
  const prefix = `adopt-${u}-`;
  await app.pools.platform.transaction(async (tx) => {
    await tx.query("DELETE FROM platform.placements WHERE pg_catalog.starts_with(tenant_id,$1)", [prefix]);
    await tx.query("DELETE FROM platform.tenants WHERE pg_catalog.starts_with(tenant_id,$1)", [prefix]);
  });
  for (const databaseId of ["db0", "db1"]) {
    const db = app.pools.node(databaseId);
    const schemas = await db.query<{ name: string }>(
      "SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE pg_catalog.starts_with(nspname,$1) OR pg_catalog.starts_with(nspname,$2)",
      [`legacy_${u}_`, `tenant_adopt_${u}_`],
    );
    for (const { name } of schemas) await db.exec(`DROP SCHEMA ${q(name)} CASCADE`);
  }
}

/** Paketin tenant DDL'ini taşıyan (baseline ile benimsenebilir) eski schema: provision edilir, placement'sız ve ledger'sız bırakılır,
 * sonra uygulamaya özgü veri, sequence'lı tablo, OID'e bağlı view ve (isteğe bağlı) adı metin olarak geçen fonksiyon eklenir. */
async function createLegacySchema(label: string, databaseId: string, withFunction = false) {
  const s = legacy(label);
  await provisionTenant(app, id(label), databaseId);
  await app.pools.platform.transaction(async (tx) => {
    await tx.query("DELETE FROM platform.placements WHERE tenant_id=$1", [id(label)]);
    await tx.query("DELETE FROM platform.tenants WHERE tenant_id=$1", [id(label)]);
  });
  await app.pools.node(databaseId).exec(`ALTER SCHEMA ${q(target(label))} RENAME TO ${q(s)};
    DROP TABLE ${q(s, "_migrations")}, ${q(s, "_seeds")};
    CREATE TABLE ${q(s, "pupils")} (id serial PRIMARY KEY, name text NOT NULL);
    INSERT INTO ${q(s, "pupils")} (name) VALUES ('ada'), ('bora'), ('cem');
    CREATE VIEW ${q(s, "pupil_names")} AS SELECT name FROM ${q(s, "pupils")};
    ${withFunction ? `CREATE FUNCTION ${q(s, "count_pupils")}() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM ${s}.pupils';` : ""}`);
}

const studentCount = async (databaseId: string, schema: string) =>
  Number((await app.pools.node(databaseId).query<{ n: string }>(`SELECT count(*)::text AS n FROM ${q(schema, "pupils")}`))[0]?.n);

integration("adoption: plan reports problems, apply renames and registers, reruns are idempotent, crashes resume, rollback restores", async () => {
  await createLegacySchema("one", "db0", true);
  await createLegacySchema("two", "db1");
  await createLegacySchema("three", "db0");
  await app.pools.node("db1").exec(`CREATE SCHEMA ${q(target("three"))}`);
  const rows = [row("one"), row("two", "db1"), row("three"), { ...row("bad"), tenantId: "Bad_Id" }, row("gone"), { ...row("far"), databaseId: "db9" }];

  // Dolu schema baseline'sız benimsenemez (etkin olur ama paket migration'ları var olan tablolara çarpar).
  expect((await planAdoption(app, rows.slice(1, 2))).rows.map((r) => [r.status, ...r.problems.map((p) => p.code)])).toEqual([["blocked", "BASELINE_REQUIRED"]]);
  expect((await adoptSchemas(app, rows.slice(1, 2))).results.map((r) => [r.status, r.problems?.[0]?.code])).toEqual([["blocked", "BASELINE_REQUIRED"]]);

  const plan = await planAdoption(app, rows, { baseline: baseline() });
  expect(plan.rows.map((r) => [r.status, ...r.problems.map((p) => p.code)])).toEqual([
    ["blocked", "SCHEMA_REFERENCED_BY_NAME"],
    ["ready"],
    ["blocked", "TARGET_SCHEMA_EXISTS"],
    ["blocked", "INVALID_TENANT_ID"],
    ["blocked", "SOURCE_SCHEMA_MISSING"],
    ["blocked", "DATABASE_NOT_CONFIGURED"],
  ]);
  // Yalnızca fonksiyon gövdesi sayılır: OID'e bağlı view ve serial varsayılanı listede yok.
  expect(plan.rows[0]?.problems[0]?.objects).toEqual([{ kind: "function", name: `${legacy("one")}.count_pupils()` }]);

  // Düzeltme: adı metin olarak geçen fonksiyonu kaldır.
  await app.pools.node("db0").exec(`DROP FUNCTION ${q(legacy("one"), "count_pupils")}()`);
  const events: Record<string, unknown>[] = [];
  const applied = await adoptSchemas(app, rows.slice(0, 2), { baseline: baseline(), report: (event) => void events.push(event) });
  expect(applied.results.map((r) => r.status)).toEqual(["adopted", "adopted"]);
  expect(applied.manifest).toEqual([
    { tenantId: id("one"), databaseId: "db0", from: legacy("one"), to: target("one") },
    { tenantId: id("two"), databaseId: "db1", from: legacy("two"), to: target("two") },
  ]);
  expect(events.filter((e) => e.tenantId === id("one") && e.step).map((e) => e.step)).toEqual(["claimed", "renamed", "baselined"]);

  // Veri placement üzerinden erişilebilir; eski ad yok.
  for (const [label, databaseId] of [["one", "db0"], ["two", "db1"]] as const) {
    const placement = await app.platform.get(id(label));
    expect(placement).toMatchObject({ databaseId, schemaName: target(label), status: "active", placementVersion: 1, schemaVersion: tenantMigrations.length });
    expect(await studentCount(placement.databaseId, placement.schemaName)).toBe(3);
    expect(await failure(app.pools.node(databaseId).query(`SELECT 1 FROM ${q(legacy(label), "pupils")}`))).toBe("42P01");
  }

  // Tekrar: hiçbir şey değişmez, manifest yine tam.
  const rerun = await adoptSchemas(app, rows.slice(0, 2), { baseline: baseline() });
  expect(rerun.results.map((r) => r.status)).toEqual(["alreadyAdopted", "alreadyAdopted"]);
  expect(rerun.manifest).toHaveLength(2);

  // Crash benzetimi: (a) placement sahiplenilmiş, rename yok; (b) rename yapılmış, etkinleştirme yok.
  await createLegacySchema("four", "db0");
  await createLegacySchema("five", "db0");
  await app.platform.create(id("four"), "db0");
  await app.platform.create(id("five"), "db0");
  await app.pools.node("db0").exec(`ALTER SCHEMA ${q(legacy("five"))} RENAME TO ${q(target("five"))}`);
  const resumedPlan = await planAdoption(app, [row("four"), row("five")], { baseline: baseline() });
  expect(resumedPlan.rows.map((r) => [r.status, r.placementStatus])).toEqual([
    ["ready", "provisioning"],
    ["alreadyAdopted", "provisioning"],
  ]);
  const resumed = await adoptSchemas(app, [row("four"), row("five")], { baseline: baseline() });
  expect(resumed.results.map((r) => r.status)).toEqual(["adopted", "alreadyAdopted"]);
  for (const label of ["four", "five"]) expect(await app.platform.get(id(label))).toMatchObject({ status: "active", schemaVersion: tenantMigrations.length });

  // Rollback: taşınmış (placement sürümü değişmiş) tenant reddedilir.
  await app.pools.platform.query("UPDATE platform.placements SET placement_version=2 WHERE tenant_id=$1", [id("two")]);
  const refused = await rollbackAdoption(app, applied.manifest.slice(1));
  expect(refused.results).toEqual([expect.objectContaining({ status: "failed", error: "ROLLBACK_NOT_ALLOWED" })]);
  await app.pools.platform.query("UPDATE platform.placements SET placement_version=1 WHERE tenant_id=$1", [id("two")]);

  const rolledBack = await rollbackAdoption(app, applied.manifest);
  expect(rolledBack.results.map((r) => r.status)).toEqual(["rolledBack", "rolledBack"]);
  for (const [label, databaseId] of [["one", "db0"], ["two", "db1"]] as const) {
    expect(await failure(app.platform.get(id(label)))).toBe("TENANT_NOT_FOUND");
    expect(await studentCount(databaseId, legacy(label))).toBe(3);
  }
  expect((await rollbackAdoption(app, applied.manifest)).results.map((r) => r.status)).toEqual(["alreadyRolledBack", "alreadyRolledBack"]);
  expect(await failure(rollbackAdoption(app, [{ tenantId: id("one"), databaseId: "db0", from: legacy("one"), to: "tenant_other" }]))).toBe("USAGE");
});

integration("adoption with a baseline marks the package migrations applied on a schema that already has them", async () => {
  // Paket şemasını taşıyan "eski" schema: normal provision, sonra placement'sız ve ledger'sız bırakılır.
  const label = "base";
  await provisionTenant(app, id(label), "db0");
  await app.pools.platform.transaction(async (tx) => {
    await tx.query("DELETE FROM platform.placements WHERE tenant_id=$1", [id(label)]);
    await tx.query("DELETE FROM platform.tenants WHERE tenant_id=$1", [id(label)]);
  });
  await app.pools.node("db0").exec(
    `ALTER SCHEMA ${q(target(label))} RENAME TO ${q(legacy(label))}; DROP TABLE ${q(legacy(label), "_migrations")}, ${q(legacy(label), "_seeds")}`,
  );
  expect(await failure(adoptSchemas(app, [row(label)], { baseline: "20000101083015_unknown" }))).toBe("MIGRATION_NOT_PENDING");

  const result = await adoptSchemas(app, [row(label)], { baseline: baseline() });
  expect(result.results.map((r) => r.status)).toEqual(["adopted"]);
  expect(await app.platform.get(id(label))).toMatchObject({ status: "active", schemaVersion: tenantMigrations.length });
  expect((await migrationStatus(app, id(label))).pending).toEqual([]);
  expect((await adoptSchemas(app, [row(label)], { baseline: baseline() })).results.map((r) => r.status)).toEqual(["alreadyAdopted"]);
});
