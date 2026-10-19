import { expect, test } from "bun:test";
import { parseOptions } from "../../core/cli";
import { packageTenantColumns } from "../../core/management";
import { resolveTenantFields, restoredTenantRow, type TenantColumns, tenantInsert, tenantInsertError } from "../../core/tenants/fields";
import { normalizeRows } from "../../core/tools/adopt";

const columns: TenantColumns = {
  writable: new Set(["tenant_id", "created_at", "name", "display_name", "owner_email", "isActive"]),
  packageOwned: new Set(["tenant_id", "created_at"]),
};
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

test("package-owned tenant columns are the columns the package's platform migrations define", () => {
  expect(packageTenantColumns()).toEqual(["tenant_id", "created_at"]);
});

test("tenant fields map to real columns: snake_case names, camelCase keys when unambiguous, exact names first", () => {
  expect(resolveTenantFields({ name: "Abc", displayName: "ABC", owner_email: null }, columns)).toEqual({ name: "Abc", display_name: "ABC", owner_email: null });
  expect(resolveTenantFields({ isActive: true, name: 3 }, columns)).toEqual({ isActive: true, name: 3 });
  expect(resolveTenantFields(undefined, columns)).toEqual({});
  expect(resolveTenantFields({}, columns)).toEqual({});
});

test("tenant fields reject unknown, package-owned and repeated columns and values that are not scalars", () => {
  const rejected: unknown[] = [
    { nmae: "x" },
    { tenant_id: "abc" },
    { tenantId: "abc" },
    { created_at: "2024-01-01" },
    { createdAt: "2024-01-01" },
    { display_name: "a", displayName: "b" },
    { __proto__: null, constructor: "x" },
    { name: { first: "a" } },
    { name: ["a"] },
    ["name"],
    "name",
  ];
  for (const fields of rejected) expect(code(() => resolveTenantFields(fields, columns)), JSON.stringify(fields)).toBe("INVALID_CONFIG");
});

test("a backed-up tenant row keeps every writable column, package columns included, and reports the others", () => {
  const stored = { tenant_id: "abc", created_at: "2024-01-02T03:04:05+00:00", name: "Abc", settings: { a: 1 }, dropped_later: 1 };
  expect(restoredTenantRow(stored, columns)).toEqual({ row: { created_at: "2024-01-02T03:04:05+00:00", name: "Abc" }, skipped: ["settings", "dropped_later"] });
});

test("tenant insert: tenant_id alone without fields; quoted columns and one bound JSON value with fields", () => {
  expect(tenantInsert("abc", {})).toEqual({ sql: "INSERT INTO platform.tenants (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING RETURNING 1", values: ["abc"] });
  const row = { name: "A'); DROP TABLE x;--", 'we"ird': 1 };
  const insert = tenantInsert("abc", row);
  expect(insert.sql.replace(/\s+/g, " ")).toBe(
    'INSERT INTO platform.tenants (tenant_id,"name","we""ird") OVERRIDING SYSTEM VALUE SELECT $1,r."name",r."we""ird" FROM pg_catalog.json_populate_record(NULL::platform.tenants,$2::text::json) r ON CONFLICT (tenant_id) DO NOTHING RETURNING 1',
  );
  expect(insert.values).toEqual(["abc", JSON.stringify(row)]);
  expect(code(() => tenantInsert("abc", { "": 1 }))).toBe("INVALID_IDENTIFIER");
});

test("a NOT NULL violation on the tenant row keeps SQLSTATE 23502 and names the missing column", () => {
  const bun = Object.assign(new Error('null value in column "owner_email" of relation "tenants" violates not-null constraint'), { errno: "23502" });
  expect(tenantInsertError(bun)).toMatchObject({ code: "23502", message: expect.stringContaining("platform.tenants.owner_email is NOT NULL") });
  expect(tenantInsertError(Object.assign(new Error("failed"), { code: "23502", column: "name" }))).toMatchObject({ message: expect.stringContaining("platform.tenants.name") });
  const other = Object.assign(new Error("duplicate"), { errno: "23505" });
  expect(tenantInsertError(other)).toBe(other);
});

test("--tenant takes a JSON object of scalars; adoption rows accept a tenant object", () => {
  expect(parseOptions(["--tenant", '{"name":"Abc","display_name":"ABC","seats":3}'], ["--tenant"])).toEqual({ tenant: { name: "Abc", display_name: "ABC", seats: 3 } });
  for (const value of ["name", "[]", '{"a":{"b":1}}', "{"]) expect(code(() => parseOptions(["--tenant", value], ["--tenant"])), value).toBe("USAGE");
  const row = { tenantId: "abc", schema: "abc", databaseId: "db0" };
  expect(normalizeRows([{ ...row, tenant: { name: "Abc" } }])[0]).toMatchObject({ tenant: { name: "Abc" } });
  expect(code(() => normalizeRows([{ ...row, tenant: { name: { first: "A" } } }]))).toBe("USAGE");
});
