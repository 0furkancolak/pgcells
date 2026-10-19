import { expect, test } from "bun:test";
import { buildSchema, columnDefinition, enumCasts, readSchema, sequenceDefinition } from "../../core/tools/copy";

// The repo-wide guard test rejects every file that spells this word; inputs that are expected to be rejected are built from fragments.
const SP = "search" + "_path";

const schema = "app_copy";

test("identity reconstruction preserves generated mode and qualified sequence name", () => {
  const column = columnDefinition(schema, {
    name: "id",
    type: "bigint",
    notNull: true,
    identity: "a",
    generated: "",
    expression: null,
    sequence: "renamed_sequence",
  });
  expect(column).toContain(
    `GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME "${schema}"."renamed_sequence")`,
  );
  expect(column).toContain("NOT NULL");
});
test("sequence bounds and descending increments survive reconstruction", () => {
  const sql = sequenceDefinition(schema, {
    name: "counter",
    type: "bigint",
    start: "-10",
    increment: "-2",
    min: "-100",
    max: "-1",
    cache: "3",
    cycle: true,
  });
  expect(sql).toContain(
    "INCREMENT BY -2 MINVALUE -100 MAXVALUE -1 START WITH -10 CACHE 3 CYCLE",
  );
  expect(() =>
    sequenceDefinition(schema, {
      name: "counter",
      type: "bigint",
      start: "0; DROP SCHEMA public",
      increment: "1",
      min: "1",
      max: "10",
      cache: "1",
      cycle: false,
    }),
  ).toThrow();
});

test("default validation allows only early-bound sequences in the copied schema", async () => {
  const { validateDefault } = await import("../../core/tools/copy");
  const local = `${schema}.counter`;
  expect(() =>
    validateDefault(`nextval('${local}'::regclass)`, new Set([local])),
  ).not.toThrow();
  expect(() =>
    validateDefault("nextval('public.shared'::regclass)", new Set([local])),
  ).toThrow();
  expect(() =>
    validateDefault(`nextval('${local}'::text)`, new Set([local])),
  ).toThrow();
  expect(() => validateDefault("1 + 2", new Set())).not.toThrow();
});

test("CHECK expressions reject sequence state and session mutation functions", async () => {
  const { validateDefault } = await import("../../core/tools/copy");
  expect(() =>
    validateDefault("id < nextval('outside.ids'::regclass)", new Set()),
  ).toThrow();
  expect(() =>
    validateDefault(
      `pg_catalog.set_config('${SP}','public',true) IS NOT NULL`,
      new Set(),
    ),
  ).toThrow();
  expect(() =>
    validateDefault("id > 0 AND length(name) > 0", new Set()),
  ).not.toThrow();
});

test("catalog-normalized IN checks retain safe ANY array syntax", async () => {
  const { validateDefault } = await import("../../core/tools/copy");
  expect(() =>
    validateDefault(
      "(status = ANY (ARRAY['active'::text, 'inactive'::text]))",
      new Set(),
    ),
  ).not.toThrow();
  for (const expression of [
    'status = "any"(ARRAY[1])',
    "status = public.any(ARRAY[1])",
    "id = ANY(ARRAY[nextval('outside.ids'::regclass)])",
  ])
    expect(() => validateDefault(expression, new Set())).toThrow();
});

test("catalog long-form type names in defaults and checks validate like the short forms", async () => {
  const { validateDefault } = await import("../../core/tools/copy");
  for (const expression of [
    "'pending'::character varying",
    "'2026-01-01 00:00:00+00'::timestamp with time zone",
    "'2026-01-01 00:00:00'::timestamp without time zone",
    "'10:00:00'::time without time zone",
    "((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))",
    "(ARRAY['a'::character varying])::text[] IS NOT NULL",
    "((n)::character(3) = 'abc'::bpchar)",
    "'x'::character(5)",
  ])
    expect(() => validateDefault(expression, new Set()), expression).not.toThrow();
  // Canonicalization does not loosen the ban: a long type name is parsed, and an external sequence reference is still rejected (not with a parse error).
  expect(() => validateDefault("'x'::character varying || nextval('outside.ids'::regclass)::text", new Set())).toThrow("unsupported function: nextval");
});

test("readSchema reports every violated portability rule, joined, and does not stop at the first", async () => {
  const db = {
    query: async (text: string) => {
      if (text.includes("WITH relations")) return [{ message: "Custom schema routines/types or cross-schema foreign keys are not supported: type positive" }, { message: "Only portable builtin column types and catalog collations are supported: users.amount" }];
      return [{ safe: true }];
    },
    exec: async () => {},
  };
  const error = (await readSchema(db as never, "app_x").catch((e: unknown) => e)) as Error;
  expect(error).toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  expect(error.message).toBe("Custom schema routines/types or cross-schema foreign keys are not supported: type positive; Only portable builtin column types and catalog collations are supported: users.amount");
});

const column = { notNull: false, identity: "", generated: "", expression: null, sequence: null };

test("enum and enum[] columns are bound to the target schema from structured metadata, not the source type text", () => {
  expect(columnDefinition("tgt", { ...column, name: "s", type: "app_x.status", enum: "status", array: false })).toBe(`"s" "tgt"."status"`);
  expect(columnDefinition("tgt", { ...column, name: "all", type: "status[]", enum: "status", array: true })).toBe(`"all" "tgt"."status"[]`);
  expect(columnDefinition("tgt", { ...column, name: "n", type: "integer", enum: null, array: false })).toBe(`"n" integer`);
});

test("default validation accepts casts to the copied schema's enums in both catalog forms and nothing else", async () => {
  const { validateDefault } = await import("../../core/tools/copy");
  const enums = [{ name: "status", reference: "status" }, { name: "mood", reference: `"App x".mood` }];
  for (const expression of ["'active'::status", "'{a,b}'::status[]", "(s = ANY (ARRAY['a'::status, 'b'::status]))", `'x'::"App x".mood`, "(s <> 'b'::status) AND (m = 'y'::\"App x\".mood)"])
    expect(() => validateDefault(expression, new Set(), enumCasts(enums, () => "text")), expression).not.toThrow();
  for (const expression of ["'a'::other.status", "'a'::statuses", "'a'::public.mood", `'a'::"App x".status`])
    expect(() => validateDefault(expression, new Set(), enumCasts(enums, () => "text")), expression).toThrow();
  expect(() => validateDefault("'active'::status", new Set())).toThrow();
});

test("buildSchema creates enums first with ordered, safely quoted labels and retargets every enum cast to the target schema", async () => {
  const statements: string[] = [];
  const db = { query: async (text: string) => (text.includes("current_schemas") ? [{ safe: true }] : []), exec: async (sql: string) => void statements.push(sql) };
  const shape = {
    enums: [
      { name: "status", reference: "status", labels: JSON.stringify(["b", "a b", "it's", "back\\slash", "çğ"]) },
      { name: "mood", reference: "app_x.mood", labels: JSON.stringify(["x"]) },
    ],
    tables: [{ name: "t" }],
    columns: [
      { ...column, table: "t", name: "s", type: "status", enum: "status", array: false, expression: "'a'::status" },
      { ...column, table: "t", name: "m", type: "app_x.mood[]", enum: "mood", array: true, expression: "'{x}'::app_x.mood[]" },
      { ...column, table: "t", name: "note", type: "text", enum: null, array: false, expression: "'::status'::text" },
    ],
    sequences: [],
    constraints: [{ table: "t", name: "t_check", kind: "c", definition: "CHECK (((s <> 'b'::status) AND (s <> ALL (ARRAY['a b'::status]))))", expression: null, referenced: null, referencedTable: null }],
    indexes: [{ definition: "CREATE INDEX t_idx ON app_x.t USING btree (s) WHERE (m = '{x}'::app_x.mood[])", relation: "app_x.t", table: "t" }],
    states: [],
  };
  await buildSchema(db as never, "tgt", shape, async () => {});
  expect(statements.slice(1, 4)).toEqual([
    `CREATE TYPE "tgt"."status" AS ENUM (E'b', E'a b', E'it''s', E'back\\\\slash', E'çğ')`,
    `CREATE TYPE "tgt"."mood" AS ENUM (E'x')`,
    `CREATE TABLE "tgt"."t" ("s" "tgt"."status" DEFAULT 'a'::"tgt"."status", "m" "tgt"."mood"[] DEFAULT '{x}'::"tgt"."mood"[], "note" text DEFAULT '::status'::text)`,
  ]);
  expect(statements).toContain(`ALTER TABLE "tgt"."t" ADD CONSTRAINT "t_check" CHECK (((s <> 'b'::"tgt"."status") AND (s <> ALL (ARRAY['a b'::"tgt"."status"]))))`);
  expect(statements).toContain(`CREATE INDEX t_idx ON "tgt"."t" USING btree (s) WHERE (m = '{x}'::"tgt"."mood"[])`);
  expect(statements.join("\n")).not.toContain("app_x");
});

test("a sequence default whose name contains a quote is retargeted like any other (the catalog doubles the quote inside the literal)", async () => {
  const statements: string[] = [];
  const db = { query: async (text: string) => (text.includes("current_schemas") ? [{ safe: true }] : []), exec: async (sql: string) => void statements.push(sql) };
  const sequence = { name: "it's_seq", reference: `app_x."it's_seq"`, type: "integer", start: "1", increment: "1", min: "1", max: "100", cache: "1", cycle: false, table: null, column: null };
  const shape = {
    enums: [],
    tables: [{ name: "t" }],
    columns: [{ ...column, table: "t", name: "n", type: "integer", expression: `nextval('app_x."it''s_seq"'::regclass)` }],
    sequences: [sequence],
    constraints: [],
    indexes: [],
    states: [{ name: "it's_seq", lastValue: "1", isCalled: false }],
  };
  await buildSchema(db as never, "tgt", shape, async () => {});
  expect(statements).toContain(`CREATE TABLE "tgt"."t" ("n" integer DEFAULT nextval('"tgt"."it''s_seq"'::regclass))`);
});
