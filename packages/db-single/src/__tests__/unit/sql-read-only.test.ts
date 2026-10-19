import { expect, test } from "bun:test";
import { generate } from "../../core/sql/codegen";
import { prepareQuery } from "../../core/sql/compiler";

const readOnly = (sql: string) => prepareQuery(sql).readOnly;
const one = (source: string) => generate([["src/queries/q.sql", source]]).get("src/queries/q.gen.ts");

test("SELECT, set operations and read-only CTEs are readOnly", () => {
  expect(readOnly("SELECT id FROM users WHERE id = $1::uuid")).toBe(true);
  expect(readOnly("SELECT id FROM users UNION ALL SELECT id FROM users")).toBe(true);
  expect(readOnly("WITH a AS (SELECT id FROM users) SELECT id FROM a")).toBe(true);
  expect(readOnly("SELECT 1")).toBe(true);
});

test("writes, row locks and data-modifying CTEs are not readOnly", () => {
  expect(readOnly("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2::text, $3::text)")).toBe(false);
  expect(readOnly("UPDATE users SET name = $1::text WHERE id = $2::uuid")).toBe(false);
  expect(readOnly("DELETE FROM users WHERE id = $1::uuid")).toBe(false);
  expect(readOnly("SELECT id FROM users FOR UPDATE")).toBe(false);
  expect(readOnly("WITH d AS (DELETE FROM users WHERE id = $1::uuid RETURNING id) SELECT id FROM d")).toBe(false);
  expect(readOnly("WITH a AS (SELECT id FROM users) INSERT INTO users (id, name, email) SELECT id, 'x', 'y' FROM a")).toBe(false);
});

test("codegen writes the flag as the third defineQuery argument", () => {
  expect(one("-- name: a\nSELECT 1")).toContain('false, true);');
  expect(one("-- name: b\nSELECT id FROM t FOR UPDATE")).toContain('true, false);');
});
