import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement, migrateAll, migrateTenant } from "../../management";
import { tenantMigrations } from "../../core/migrations/registry";
import type { ManagementPlatform } from "../../core/tenants/placement";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

const target = {
  tenantId: "one-tenant",
  databaseId: "db0",
  kind: "tenant" as const,
  schemaName: "tenant_one_tenant",
  status: "active",
};
const allPending = tenantMigrations.map((m) => m.id);

/** Sessions (and therefore locks or writes) start with pg_backend_pid; a dry run must never reach one. */
function setup(urls: string[], platform: Partial<ManagementPlatform>, handler: Handler) {
  const fake = fakeDriver((text, params, pool) => {
    if (text.includes("pg_backend_pid")) throw new Error("Dry-run opened a session");
    return handler(text, params, pool);
  });
  const base = createManagement(createConfig(urls), { driver: fake.driver });
  return { app: { ...base, platform: platform as ManagementPlatform }, fake };
}

test("single-tenant dry-run rejects an excluded database before any schema read", async () => {
  let reads = 0;
  const { app } = setup(
    ["postgres://admin@localhost/one", "postgres://admin@localhost/two"],
    { get: async () => ({ ...target, status: "active", schemaVersion: 0, placementVersion: 1 }) },
    () => {
      reads++;
      return [{ exists: false }];
    },
  );
  await expect(migrateTenant(app, "one-tenant", { dryRun: true, databaseIds: ["db1"] })).rejects.toMatchObject({
    code: "INVALID_CONFIG",
  });
  expect(reads).toBe(0);
  const events: unknown[] = [];
  const result = await migrateTenant(app, "one-tenant", {
    dryRun: true,
    databaseIds: ["db0"],
    report: (event) => events.push(event),
  });
  expect(reads).toBe(1);
  expect(result).toEqual({ tenantId: "one-tenant", dryRun: true, migrations: allPending });
  expect(events).toMatchObject([
    { tenantId: "one-tenant", dryRun: true, pending: allPending, limits: { databases: [{ id: "db0" }] } },
  ]);
  await app.close();
});

test("batch dry-run reads page placement without opening lock sessions or refetching tenants", async () => {
  const { app } = setup(
    ["postgres://admin@localhost/one"],
    {
      listPage: async () => [target as never],
      get: async () => {
        throw new Error("Dry-run refetched page placement");
      },
    },
    (text) => {
      if (!text.startsWith("SELECT to_regclass(")) throw new Error("Unexpected dry-run query");
      return [{ exists: false }];
    },
  );
  const events: unknown[] = [];
  const result = await migrateAll(app, { dryRun: true, report: (event) => events.push(event) });
  expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  expect(events).toContainEqual({ ...target, dryRun: true, pending: allPending });
  await app.close();
});

test("migrate-all skips a current page row before any lock, session or schema query", async () => {
  const { app, fake } = setup(
    ["postgres://admin@localhost/one"],
    {
      listPage: async () => [{ ...target, schemaVersion: tenantMigrations.length } as never],
      get: async () => {
        throw new Error("Up-to-date tenant was refetched");
      },
    },
    () => {
      throw new Error("Up-to-date tenant was queried");
    },
  );
  const events: unknown[] = [];
  const result = await migrateAll(app, { dryRun: true, report: (event) => events.push(event) });
  expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  expect(events).not.toContainEqual(expect.objectContaining({ pending: [] }));
  expect(fake.commands).toEqual([]);
  await app.close();
});
