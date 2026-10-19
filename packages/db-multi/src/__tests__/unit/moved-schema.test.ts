import { expect, test } from "bun:test";
import { MOVED_SCHEMA_PATTERN, movedSchemaName, TENANT_ID_MAX, tenantSchema, validateSchema } from "../../core/tenants/model";

const operation = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

test("a fenced source schema keeps its name plus a marker built from the move id", () => {
  expect(movedSchemaName("tenant_acme", operation)).toBe("tenant_acme__moved_0a1b2c3d");
  expect(movedSchemaName("demo_x_y", operation)).toBe("demo_x_y__moved_0a1b2c3d");
});

test("the marker never fits a real tenant schema: IDs allow no double underscore", () => {
  const retained = movedSchemaName(tenantSchema("acme-shop"), operation);
  expect(retained).toMatch(MOVED_SCHEMA_PATTERN);
  expect(tenantSchema("acme-shop")).not.toMatch(MOVED_SCHEMA_PATTERN);
});

test("the longest tenant schema still fits PostgreSQL's 63-byte identifier limit and stays distinguishable", () => {
  const longest = tenantSchema("a".repeat(TENANT_ID_MAX));
  const retained = movedSchemaName(longest, operation);
  expect(new TextEncoder().encode(retained).length).toBeLessThanOrEqual(63);
  expect(retained).toMatch(MOVED_SCHEMA_PATTERN);
  expect(() => validateSchema(retained)).not.toThrow();
  expect(movedSchemaName(longest, "ffffffff-4e5f-4a6b-8c7d-9e0f1a2b3c4d")).not.toBe(retained);
});
