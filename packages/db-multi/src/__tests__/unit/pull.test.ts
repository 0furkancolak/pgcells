import { expect, test } from "bun:test";
import { splitArguments } from "../../core/cli";
import { bootstrap } from "../../core/operations/bootstrap";
import { compileMigrations, pulledMarkerOf, pullMarker } from "../../core/migrations/source";
import { type AdoptionFacts, classifyAdoption, normalizeRows } from "../../core/tools/adopt";
import { canonicalTypes, pulledMigration, sqlType } from "../../core/tools/pull";

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
});

test("a pulled migration keeps its structure marker, compiles and cannot be rolled back", () => {
  const structure = "a".repeat(64);
  const pulled = { sql: 'CREATE TABLE "users" (\n  "id" uuid NOT NULL\n);\n', structure, exclude: ["_migrations", "_seeds", "drizzle_migrations"], counts: { enums: 0, tables: 1, constraints: 0, indexes: 0 } };
  const [migration] = compileMigrations("tenant", [["20260915180427_init", pulledMigration(pulled, "chitchat", "db0")]]);
  expect(migration?.pulled).toEqual({ structure, exclude: ["_migrations", "_seeds", "drizzle_migrations"] });
  expect(migration?.down).toBeUndefined();
  expect(pulledMarkerOf("--up\nCREATE TABLE users (id uuid);\n--down\n")).toBeUndefined();
  expect(pullMarker({ structure: "b".repeat(64), exclude: [] })).toBe(`-- @repo/db pull structure=${"b".repeat(64)} exclude=`);
});

test("positional arguments may follow options, as package scripts write options first", () => {
  const create = { usage: "<name> [--scope tenant|platform|node]", flags: ["--scope"] };
  expect(splitArguments(create, ["--scope", "platform", "add_email"])).toEqual({ positional: ["add_email"], options: ["--scope", "platform"] });
  expect(splitArguments(create, ["add_email", "--scope=node"])).toEqual({ positional: ["add_email"], options: ["--scope=node"] });
  const provision = { usage: "<tenant> [dbN] [--size 1-100] [--demo]", flags: ["--size", "--demo"] };
  // Extra positional arguments fall into the options and are rejected there as unknown.
  expect(splitArguments(provision, ["--demo", "abc", "--size", "3", "db1", "extra"])).toEqual({ positional: ["abc", "db1"], options: ["--demo", "--size", "3", "extra"] });
});

const facts = (structure?: AdoptionFacts["structure"]): AdoptionFacts => {
  const schemas = new Set(["chitchat", "kadikoy", "moda"]);
  return { databaseIds: ["db0"], reserved: new Set(), tenants: new Map(), placementOwners: new Map(), schemas: new Map([["db0", schemas]]), populated: new Map([["db0", schemas]]), references: new Map(), structure };
};

test("a pulled baseline blocks schemas whose structure differs or cannot be read", () => {
  const expected = "e".repeat(64);
  const actual = new Map([
    ["db0/chitchat", { structure: expected }],
    ["db0/kadikoy", { structure: "f".repeat(64) }],
    ["db0/moda", { error: "PULL_UNSUPPORTED: schema moda has objects an initial migration cannot express: view report" }],
  ]);
  const rows = normalizeRows(["chitchat", "kadikoy", "moda"].map((schema) => ({ tenantId: schema, schema, databaseId: "db0" })));
  const planned = classifyAdoption(rows, facts({ expected, actual }), { baseline: "20260915180427_init" });
  expect(planned.map((row) => [row.status, ...row.problems.map((problem) => problem.code)])).toEqual([["ready"], ["blocked", "SCHEMA_DRIFT"], ["blocked", "SCHEMA_DRIFT"]]);
  expect(planned[1]?.problems[0]?.message).toContain(`found structure sha256 ${"f".repeat(64)}`);
  expect(planned[2]?.problems[0]?.message).toContain("view report");
  // A baseline without a pull marker is trusted as before; no baseline still requires one.
  expect(classifyAdoption(rows, facts(), { baseline: "20260915180427_init" }).map((row) => row.status)).toEqual(["ready", "ready", "ready"]);
  expect(classifyAdoption(rows, facts()).flatMap((row) => row.problems.map((problem) => problem.code))).toEqual(["BASELINE_REQUIRED", "BASELINE_REQUIRED", "BASELINE_REQUIRED"]);
});

test("bootstrap marks only pulled platform migrations of this code, before touching a database", async () => {
  // The package's own platform migration was not produced by pull; an unknown ID is not in the registry.
  for (const id of ["20260915155443_platform", "20990101083015_unknown"])
    await expect(bootstrap({} as never, { markApplied: [id] })).rejects.toMatchObject({ code: "MIGRATION_NOT_PENDING" });
});
