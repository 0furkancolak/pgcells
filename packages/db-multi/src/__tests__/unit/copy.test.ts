import { expect, test } from "bun:test";
import { tenantSchema } from "../../core/tenants/model";
import { columnDefinition, sequenceDefinition } from "../../core/tools/copy";

test("identity reconstruction preserves generated mode and qualified sequence name", () => {
  const schema = tenantSchema("copy");
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
  const sql = sequenceDefinition(tenantSchema("copy"), {
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
    sequenceDefinition(tenantSchema("copy"), {
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
  const local = `${tenantSchema("copy")}.counter`;
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
      "pg_catalog.set_config('search_path','public',true) IS NOT NULL",
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
