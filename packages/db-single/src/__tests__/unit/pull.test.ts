import { afterEach, expect, test } from "bun:test";
import { main } from "../../core/cli";
import { compileMigrations } from "../../core/migrations/source";
import { canonicalTypes, pulledMigration, pullStructure, sqlType } from "../../core/tools/pull";

afterEach(() => {
  process.exitCode = 0;
});

test("catalog type names become the compiler's canonical spelling, quoted text stays", () => {
  expect(sqlType("character varying(255)")).toBe("varchar(255)");
  expect(sqlType("character varying[]")).toBe("varchar[]");
  expect(sqlType("timestamp(3) with time zone")).toBe("timestamptz(3)");
  expect(sqlType("timestamp without time zone")).toBe("timestamp");
  expect(sqlType("time with time zone")).toBe("timetz");
  expect(sqlType("double precision")).toBe("float8");
  expect(sqlType("character(2)")).toBe("bpchar(2)");
  expect(sqlType("chitchat.task_status")).toBe("chitchat.task_status");
  expect(canonicalTypes(`((code)::character varying = 'character varying'::text) AND ("double precision" > (0)::double precision)`)).toBe(
    `((code)::varchar = 'character varying'::text) AND ("double precision" > (0)::float8)`,
  );
  // character(n) is canonicalized too; it is not confused with `character varying`.
  expect(canonicalTypes(`(((n)::character(3) = 'abc'::bpchar) AND ((m)::character varying(5) <> ''::character varying) AND (c)::character <> 'x')`)).toBe(
    `(((n)::bpchar(3) = 'abc'::bpchar) AND ((m)::varchar(5) <> ''::varchar) AND (c)::bpchar <> 'x')`,
  );
});

test("a pulled migration names its source, compiles and cannot be rolled back", () => {
  const pulled = { sql: 'CREATE TABLE "users" (\n  "id" uuid NOT NULL\n);\n', structure: "a".repeat(64), exclude: ["_migrations"], counts: { enums: 0, tables: 1, constraints: 0, indexes: 0 } };
  const source = pulledMigration(pulled, "chitchat");
  expect(source.split("\n")[1]).toContain("schema chitchat");
  const [migration] = compileMigrations([["20260915180427_init", source]]);
  expect(migration?.down).toBeUndefined();
  expect(migration?.up.statements).toHaveLength(1);
});

test("--exclude takes any table name as data: mixed case and hyphens are excluded, and the list is sorted with the always-excluded ledgers", async () => {
  const params: unknown[][] = [];
  const db = {
    query: async (text: string, values: unknown[]) => {
      params.push(values);
      if (text.includes("AS found")) return [{ found: true }];
      return text.includes("seq_name") ? [{ table_name: "t", column_name: "id", type: "integer", not_null: true, default_expr: null, identity: "", collation: null }] : [];
    },
  };
  const result = await pullStructure(db as never, "app_x", ["Legacy-Log", "MixedCase"]);
  expect(result.exclude).toEqual(["Legacy-Log", "MixedCase", "_migrations", "_seeds", "drizzle_migrations"]);
  expect(params.some((values) => values[1] === JSON.stringify(result.exclude))).toBe(true);
});

test("the CLI lists pull, and pull takes the source schema as an argument, not --schema", async () => {
  const [log, error] = [console.log, console.error];
  const out: string[] = [];
  console.log = console.error = (message?: unknown) => void out.push(String(message));
  try {
    await main(["--help"]);
    expect(out.join("\n")).toContain("pull [schema]");
    out.length = 0;
    await main(["pull", "--schema", "app_x"]);
  } finally {
    [console.log, console.error] = [log, error];
  }
  expect(JSON.parse(out.join("\n"))).toEqual({ error: "USAGE", message: "Unknown option: --schema" });
  expect(process.exitCode).toBe(1);
});
