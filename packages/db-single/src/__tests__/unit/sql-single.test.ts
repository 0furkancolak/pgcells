import { expect, test } from "bun:test";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { defineQuery, isPreparedQuery } from "../../core/sql/query";

test("a prepared query has no scope and binds to whatever valid schema it is given", () => {
  const query = prepareQuery("SELECT id FROM users");
  expect(Object.keys(query).sort()).toEqual(["bind", "readOnly", "requiresTransaction"]);
  // The compiler only quotes the schema; the table name stays as is (`"schema".table`).
  expect(query.bind("public")).toBe('SELECT id FROM "public".users');
  expect(query.bind("app_1")).toBe('SELECT id FROM "app_1".users');
});

test("bind refuses schemas that are not plain lowercase names", () => {
  const query = prepareQuery("SELECT id FROM users");
  for (const bad of ['x"; DROP SCHEMA public', "Public", "pg_catalog", "information_schema", ""])
    expect(() => query.bind(bad), bad).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
});

test("bind stays correct when schemas alternate, and a bad schema is refused right after a cached good one", () => {
  const query = prepareQuery("SELECT id FROM users");
  const first = query.bind("app_a");
  expect(query.bind("app_a")).toBe(first);
  expect(query.bind("app_b")).toBe('SELECT id FROM "app_b".users');
  expect(query.bind("app_a")).toBe(first);
  expect(() => query.bind("App_A")).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
  expect(query.bind("app_a")).toBe(first);
});

test("readOnly and requiresTransaction come from the statement", () => {
  expect(prepareQuery("SELECT id FROM users")).toMatchObject({ readOnly: true, requiresTransaction: false });
  expect(prepareQuery("INSERT INTO users (id) VALUES (1)")).toMatchObject({ readOnly: false, requiresTransaction: false });
  expect(prepareQuery("SELECT id FROM users FOR UPDATE")).toMatchObject({ readOnly: false, requiresTransaction: true });
});

test("only the compiler's output counts as a prepared query", () => {
  expect(isPreparedQuery(prepareQuery("SELECT 1"))).toBe(true);
  expect(isPreparedQuery(defineQuery(["SELECT 1"], false, true))).toBe(true);
  expect(isPreparedQuery({ bind: () => 'SELECT * FROM "public".users', readOnly: true, requiresTransaction: false })).toBe(false);
  expect(isPreparedQuery(null)).toBe(false);
});

test("a migration binds every statement to the given schema", () => {
  const migration = prepareMigration("CREATE TABLE users (id integer PRIMARY KEY);\nCREATE INDEX users_id_idx ON users (id);");
  const bound = migration.bind("app_1");
  expect(bound).toHaveLength(2);
  expect(bound.join("\n")).toContain('"app_1".users');
  expect(() => migration.bind("Bad")).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
});
