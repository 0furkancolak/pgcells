import { expect, test } from "bun:test";
import { DEFAULT_SCHEMA, qualified, quoteIdentifier, validateSchema } from "../../core/identifier";

test("the default schema is public and is a valid name", () => {
  expect(DEFAULT_SCHEMA).toBe("public");
  expect(validateSchema("public")).toBe("public");
  expect(validateSchema("app_1")).toBe("app_1");
  expect(validateSchema("_private")).toBe("_private");
});

test("anything that is not a plain lowercase identifier is rejected with INVALID_SCHEMA", () => {
  for (const bad of ["", "Public", "app-1", "1app", 'a"b', "a b", "a;b", "a".repeat(64), "pg_catalog", "pg_temp_1", "information_schema", "ü", null, undefined, 1] as string[])
    expect(() => validateSchema(bad), bad).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA", message: "invalid schema name" }));
});

test("quoteIdentifier doubles quotes, refuses NUL, empty and over-long names", () => {
  expect(quoteIdentifier("users")).toBe('"users"');
  expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  for (const bad of ["", "a\0b", "a".repeat(64)]) expect(() => quoteIdentifier(bad)).toThrow(expect.objectContaining({ code: "INVALID_IDENTIFIER" }));
});

test("quoteIdentifier limits by bytes, not characters", () => {
  expect(quoteIdentifier("a".repeat(63))).toBe(`"${"a".repeat(63)}"`);
  expect(quoteIdentifier("ü".repeat(31))).toBe(`"${"ü".repeat(31)}"`); // 62 bytes
  for (const bad of ["ü".repeat(32), "€".repeat(22), "😀".repeat(16)]) expect(() => quoteIdentifier(bad)).toThrow(expect.objectContaining({ code: "INVALID_IDENTIFIER" }));
  expect(quoteIdentifier("€".repeat(21))).toBe(`"${"€".repeat(21)}"`); // 63 bytes
});

test("qualified validates the schema and quotes both parts", () => {
  expect(qualified("app_1", "_migrations")).toBe('"app_1"."_migrations"');
  expect(() => qualified('x"; DROP', "t")).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
});
