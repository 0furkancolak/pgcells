/** `platform.tenants` uygulama alanları (gerçek PostgreSQL): uygulamanın NOT NULL sütunları provision, benimseme ve geri yüklemede
 * tenant satırıyla aynı deyimde yazılır; export ve yedek setleri satırın bütün sütunlarını taşır. Paylaşılan DB'ler temiz kalsın diye
 * eklenen sütunlar, tenant'lar ve schema'lar `afterAll`'da kaldırılır. */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantFields } from "../../core/tenants/fields";
import { adoptSchemas, planAdoption } from "../../core/tools/adopt";
import { backupAll, exportTenant, restoreTenant, type TenantBackup } from "../../core/tools/backup";
import { bootstrap, provisionTenant } from "../../management";
import { createTestManagement, enabled, failure, integration, q } from "./helpers";

let app: ReturnType<typeof createTestManagement>;
let root: string;
const u = `x${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const id = (label: string) => `fields-${u}-${label}`;
const legacy = (label: string) => `legacy_fields_${u}_${label}`;
/** Bu çalıştırmaya özgü uygulama sütunları; başka test dosyalarının sütunlarıyla (ör. birleştirmedeki `name`) çakışmaz. */
const [nameColumn, emailColumn, joinedColumn, lateColumn] = [`app_name_${u}`, `owner_email_${u}`, `joined_${u}`, `late_${u}`];
const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
/** Zorunlu iki alan; e-posta sütunu camelCase anahtarla verilir. */
const fields = (label: string) => ({ [nameColumn]: `Name ${label}`, [camel(emailColumn)]: `${label}@fields.test` });

beforeAll(async () => {
  if (!enabled) return;
  app = createTestManagement();
  await bootstrap(app);
  root = await mkdtemp(join(tmpdir(), "db-tenant-fields-"));
  // Var olan satırlar geçici varsayılanla dolar; sonra varsayılan kalkar ve yeni satırlar değeri vermek zorundadır.
  await app.pools.platform.exec(`ALTER TABLE platform.tenants ADD COLUMN ${q(nameColumn)} text NOT NULL DEFAULT '',
      ADD COLUMN ${q(emailColumn)} text NOT NULL DEFAULT '', ADD COLUMN ${q(joinedColumn)} timestamptz;
    ALTER TABLE platform.tenants ALTER COLUMN ${q(nameColumn)} DROP DEFAULT, ALTER COLUMN ${q(emailColumn)} DROP DEFAULT`);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (!app) return;
  try {
    const drops = [nameColumn, emailColumn, joinedColumn, lateColumn].map((column) => `DROP COLUMN IF EXISTS ${q(column)}`);
    await app.pools.platform.exec(`ALTER TABLE platform.tenants ${drops.join(", ")}`);
    await app.pools.platform.transaction(async (tx) => {
      await tx.query("DELETE FROM platform.placements WHERE pg_catalog.starts_with(tenant_id,$1)", [`fields-${u}-`]);
      await tx.query("DELETE FROM platform.tenants WHERE pg_catalog.starts_with(tenant_id,$1)", [`fields-${u}-`]);
    });
    for (const databaseId of ["db0", "db1"]) {
      const db = app.pools.node(databaseId);
      const schemas = await db.query<{ name: string }>(
        "SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE pg_catalog.starts_with(nspname,$1) OR pg_catalog.starts_with(nspname,$2)",
        [`tenant_fields_${u}_`, legacy("")],
      );
      for (const { name } of schemas) await db.exec(`DROP SCHEMA ${q(name)} CASCADE`);
    }
  } finally {
    await app.close();
  }
});

/** Tenant satırının bütün sütunları `row_to_json` metni olarak (birebir karşılaştırma için). */
const tenantRow = async (tenantId: string) =>
  (await app.pools.platform.query<{ row: string }>("SELECT pg_catalog.row_to_json(t)::text AS row FROM platform.tenants t WHERE t.tenant_id=$1", [tenantId]))[0]?.row;
const appFields = async (tenantId: string) =>
  (
    await app.pools.platform.query(
      `SELECT ${q(nameColumn)} AS name,${q(emailColumn)} AS email,${q(joinedColumn)}='2024-01-02T03:04:05Z'::timestamptz AS joined FROM platform.tenants WHERE tenant_id=$1`,
      [tenantId],
    )
  )[0];

/** Tenant'ı kaybetmek: schema ve platform satırları silinir. */
async function destroy(tenantId: string) {
  const p = await app.platform.get(tenantId);
  await app.pools.node(p.databaseId).exec(`DROP SCHEMA ${q(p.schemaName)} CASCADE`);
  await app.pools.platform.transaction(async (tx) => {
    await tx.query("DELETE FROM platform.placements WHERE tenant_id=$1", [tenantId]);
    await tx.query("DELETE FROM platform.tenants WHERE tenant_id=$1", [tenantId]);
  });
}
async function rewriteBackup(file: string, change: (backup: TenantBackup) => TenantBackup) {
  await writeFile(file, JSON.stringify(change(JSON.parse(await readFile(file, "utf8")) as TenantBackup)));
}

integration("provision writes application fields with the tenant row; a missing NOT NULL field fails with 23502, bad keys with INVALID_CONFIG", async () => {
  const one = await provisionTenant(app, id("one"), "db0", { tenant: { ...fields("one"), [joinedColumn]: "2024-01-02T03:04:05Z" } });
  expect(one.status).toBe("active");
  expect(await appFields(id("one"))).toEqual({ name: "Name one", email: "one@fields.test", joined: true });
  // Aynı niyetle tekrar: var olan kayıt değişmez.
  await provisionTenant(app, id("one"), "db0", { tenant: fields("other") });
  expect(await appFields(id("one"))).toMatchObject({ name: "Name one" });

  const missing = await provisionTenant(app, id("bare"), "db0").catch((error: unknown) => error);
  expect(missing).toMatchObject({ code: "23502", message: expect.stringContaining(`platform.tenants.${nameColumn} is NOT NULL`) });
  expect(await failure(app.platform.get(id("bare")))).toBe("TENANT_NOT_FOUND");

  const rejected: TenantFields[] = [{ nope: "x" }, { tenant_id: id("x") }, { createdAt: "2024-01-01T00:00:00Z" }, { ...fields("x"), [emailColumn]: "twice@fields.test" }];
  for (const tenant of rejected) expect(await failure(provisionTenant(app, id("bad"), "db0", { tenant }))).toBe("INVALID_CONFIG");
  expect(await failure(app.platform.get(id("bad")))).toBe("TENANT_NOT_FOUND");

  // Bağlam sütunları okuduktan sonra eklenen sütun da bulunur (önbellek tazelenir).
  await app.pools.platform.exec(`ALTER TABLE platform.tenants ADD COLUMN ${q(lateColumn)} integer`);
  await provisionTenant(app, id("late"), "db1", { tenant: { ...fields("late"), [lateColumn]: 7 } });
  expect((await app.pools.platform.query(`SELECT ${q(lateColumn)} AS late FROM platform.tenants WHERE tenant_id=$1`, [id("late")]))[0]).toEqual({ late: 7 });
});

integration("adoption rows write their tenant object; invalid fields reject the plan, a row without required fields fails with 23502", async () => {
  await app.pools.node("db0").exec(`CREATE SCHEMA ${q(legacy("ok"))}; CREATE SCHEMA ${q(legacy("bare"))}`);
  const withFields = { tenantId: id("adopted"), schema: legacy("ok"), databaseId: "db0", tenant: fields("adopted") };
  const bare = { tenantId: id("adopted-bare"), schema: legacy("bare"), databaseId: "db0" };
  expect(await failure(planAdoption(app, [{ ...withFields, tenant: { nope: 1 } }]))).toBe("INVALID_CONFIG");

  const plan = await planAdoption(app, [withFields, bare]);
  expect(plan.rows.map((row) => [row.status, row.tenant])).toEqual([
    ["ready", { [nameColumn]: "Name adopted", [emailColumn]: "adopted@fields.test" }],
    ["ready", undefined],
  ]);
  const result = await adoptSchemas(app, [withFields, bare]);
  expect(result.results.map((row) => [row.status, row.error])).toEqual([
    ["adopted", undefined],
    ["failed", "23502"],
  ]);
  expect(await appFields(id("adopted"))).toEqual({ name: "Name adopted", email: "adopted@fields.test", joined: null });
  expect(await failure(app.platform.get(id("adopted-bare")))).toBe("TENANT_NOT_FOUND");
});

integration("export and backup sets carry the whole tenant row; restore round-trips it, older backups need the tenant option", async () => {
  const tenantId = id("saved");
  await provisionTenant(app, tenantId, "db1", { tenant: { ...fields("saved"), [joinedColumn]: "2024-01-02T03:04:05Z" } });
  const before = (await tenantRow(tenantId)) as string;
  const exported = join(root, "export");
  await exportTenant(app, tenantId, exported);
  expect(JSON.parse(await readFile(join(exported, "tenant.json"), "utf8")).tenant).toEqual(JSON.parse(before));
  const sets = join(root, "sets");
  const set = await backupAll(app, sets, { full: true, tenants: [tenantId] });

  // Export klasöründen: created_at dahil satır birebir döner.
  await destroy(tenantId);
  expect((await restoreTenant(app, tenantId, exported)).placement.status).toBe("active");
  expect(await tenantRow(tenantId)).toBe(before);

  // Yedek kökünden: `tenant.json`'da satır olmasa da setin platform kaydı kullanılır.
  await destroy(tenantId);
  await rewriteBackup(join(sets, set.id, "tenants", tenantId, "tenant.json"), ({ tenant: _, ...backup }) => backup);
  await restoreTenant(app, tenantId, sets);
  expect(await tenantRow(tenantId)).toBe(before);

  // Hedefte artık olmayan sütun atlanır ve raporlanır.
  await destroy(tenantId);
  const gone = `gone_${u}`;
  await rewriteBackup(join(exported, "tenant.json"), (backup) => ({ ...backup, tenant: { ...backup.tenant, [gone]: 1 } }));
  expect(await restoreTenant(app, tenantId, exported)).toMatchObject({ skippedTenantColumns: [gone] });
  expect(await tenantRow(tenantId)).toBe(before);

  // Bu alandan önce alınmış yedek: zorunlu sütunlar `tenant` seçeneğiyle verilir.
  await destroy(tenantId);
  await rewriteBackup(join(exported, "tenant.json"), ({ tenant: _, ...backup }) => backup);
  expect(await failure(restoreTenant(app, tenantId, exported))).toBe("23502");
  await restoreTenant(app, tenantId, exported, { tenant: fields("old") });
  expect(await appFields(tenantId)).toEqual({ name: "Name old", email: "old@fields.test", joined: null });
});
