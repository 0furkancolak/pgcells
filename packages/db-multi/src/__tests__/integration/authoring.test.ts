/** Migration yazımı uçtan uca: create → codegen → migrate/down (geçici paket kopyasında CLI) ve baseline işareti. */
import { afterAll, beforeAll, expect } from "bun:test";
import { join } from "node:path";
import { bootstrap, type Management, markMigrationApplied, migrateTenant, migrationStatus } from "../../management";
import { tenantMigrations } from "../../core/migrations/registry";
import { createMigration } from "../../core/sql/codegen";
import { tenantSchema } from "../../core/tenants/model";
import { createTestManagement, enabled, forgetTenant, integration, packageCopy, q, removeTenants } from "./helpers";

let app: Management;
const prefix = `authoring-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
beforeAll(async () => {
  if (enabled) {
    app = createTestManagement();
    await bootstrap(app);
  }
});
afterAll(async () => {
  if (!app) return;
  try {
    await removeTenants(app, prefix);
  } finally {
    await app.close();
  }
});

integration("create → codegen → provision, migrate-down and migrate through the CLI of a package copy", async () => {
  const copy = await packageCopy("authoring");
  const tenant = `${prefix}-created`;
  const last = tenantMigrations.at(-1)?.id;
  try {
    const { id, path } = await createMigration({ name: "add_notes", root: copy.root, now: new Date(Date.UTC(2026, 8, 16, 10, 5, 12)) });
    expect(id).toBe("20260916100512_add_notes");
    await copy.write(
      path,
      "--up\nCREATE TABLE notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE, body text);\n\n--down\nDROP TABLE notes;\n",
    );
    await copy.codegen();
    expect(await Bun.file(join(copy.root, "src/tables/tenant/notes.gen.ts")).text()).toContain("body: z.string().nullable(),");

    expect(await copy.cli("provision", tenant, "db0")).toMatchObject({ status: "active", schemaVersion: tenantMigrations.length + 1 });
    expect(await copy.cli("migrate-down", tenant, "--steps", "2")).toMatchObject({ migrations: [id, last] });
    const notes = async () =>
      (
        await app.pools
          .node("db0")
          .query<{ found: boolean }>("SELECT to_regclass($1) IS NOT NULL AS found", [`${tenantSchema(tenant)}.notes`])
      )[0]?.found;
    expect(await notes()).toBe(false);
    expect((await copy.cli("migration-status", tenant)).pending.map((m: { id: string }) => m.id)).toEqual([last, id]);
    expect(await copy.cli("migrate", tenant)).toMatchObject({ migrations: [last, id] });
    expect(await notes()).toBe(true);
    expect((await app.platform.get(tenant)).schemaVersion).toBe(tenantMigrations.length + 1);
  } finally {
    await forgetTenant(app, tenant);
    await copy.remove();
  }
});

integration("migration baseline adopts only a matching existing schema, then later migrations run normally", async () => {
  const tenant = `${prefix}-adopt`;
  const schema = tenantSchema(tenant);
  const db = app.pools.node("db0");
  const [initial, ...rest] = tenantMigrations;
  if (!initial) throw new Error("Missing migration");
  await expect(markMigrationApplied(app, `${prefix}-nothing`, initial.id)).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  await db.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "users")} (id uuid PRIMARY KEY, name text NOT NULL)`);
  await expect(markMigrationApplied(app, tenant, initial.id)).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
  await expect(markMigrationApplied(app, tenant, initial.id, { databaseId: "db1" })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await db.exec(`DROP TABLE ${q(schema, "users")}`);
  for (const statement of initial.up.bind(schema)) await db.exec(statement);
  expect(await markMigrationApplied(app, tenant, initial.id, { databaseId: "db0" })).toEqual({ tenantId: tenant, migrations: [initial.id] });
  expect(await app.platform.get(tenant)).toMatchObject({ status: "active", schemaVersion: 1 });
  expect((await migrationStatus(app, tenant)).pending.map((m) => m.id)).toEqual(rest.map((m) => m.id));
  await expect(markMigrationApplied(app, tenant, initial.id)).rejects.toMatchObject({ code: "MIGRATION_NOT_PENDING" });
  expect(await migrateTenant(app, tenant)).toMatchObject({ migrations: rest.map((m) => m.id) });
  expect((await app.platform.get(tenant)).schemaVersion).toBe(tenantMigrations.length);
});
