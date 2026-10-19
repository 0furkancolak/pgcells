import { expect, test } from "bun:test";
import { createWithTenant, type TenantContext } from "../../core/tenants/context";
import { tenantSchema } from "../../core/tenants/model";
import { createPasswordUser } from "../../queries/tenant/auth.gen";

test("one tenant operation resolves placement once and expires its context", async () => {
  let reads = 0;
  let escaped!: TenantContext;
  const pools = { node: () => ({ query: async () => [] }) };
  const withTenant = createWithTenant(pools as never, {
    get: async () => {
      reads++;
      return {
        tenantId: "demo-tenant",
        kind: "tenant",
        databaseId: "a",
        schemaName: tenantSchema("demo-tenant"),
        status: "active",
        schemaVersion: 1,
        placementVersion: 1,
      };
    },
  });
  expect(
    await withTenant("demo-tenant", async (db) => {
      escaped = db;
      return 42;
    }),
  ).toBe(42);
  expect(reads).toBe(1);
  await expect(Promise.resolve().then(() => escaped.query(createPasswordUser, ["Ada", "ada@x", "hash"]))).rejects.toMatchObject({
    code: "TRANSACTION_CLOSED",
  });
});
