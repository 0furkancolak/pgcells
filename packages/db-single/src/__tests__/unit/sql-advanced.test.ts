import { expect, test } from "bun:test";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { functions, types } from "../../core/sql/grammar";
import { foldTables, tableModules } from "../../core/sql/tables";

const schema = `app_${"a".repeat(32)}`;
const qualified = `"${schema}".`;
const bind = (source: string) => prepareQuery(source).bind(schema);
const rejects = (source: string, detail: RegExp = /SQL_UNSUPPORTED/) => expect(() => prepareQuery(source)).toThrow(detail);

test("JSON, regex and containment operators pass through unchanged", () => {
  for (const op of ["@>", "<@", "?", "?|", "?&", "#>>", "~", "~*", "!~", "!~*"])
    expect(bind(`SELECT id FROM events WHERE data ${op} 'x'`)).toBe(`SELECT id FROM ${qualified}events WHERE data ${op} 'x'`);
});

// The parser cannot parse the `#>` operator (measured); its equivalent `jsonb_extract_path` (returns jsonb) is allowed.
test("#> is a parser gap and is rejected", () => {
  rejects("SELECT data #> '{a}' AS v FROM events");
});

test("-> and ->> chains pass through unchanged and need a literal key", () => {
  expect(bind("SELECT data->'a' AS a, data->>'b' AS b, data->'c'->>'d' AS d, data->1 AS e FROM events")).toBe(
    `SELECT data->'a' AS a, data->>'b' AS b, data->'c'->>'d' AS d, data->1 AS e FROM ${qualified}events`,
  );
  rejects("SELECT data->>$1 AS v FROM events");
});

test("JSON, array, text and regex functions are qualified with pg_catalog", () => {
  for (const name of [
    "unnest", "jsonb_set", "jsonb_each", "jsonb_each_text", "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_extract_path",
    "jsonb_extract_path_text", "concat", "replace", "btrim", "ltrim", "rtrim", "regexp_replace", "regexp_match", "regexp_matches", "array_length",
  ])
    expect(bind(`SELECT ${name}(name) AS v FROM events`)).toBe(`SELECT "pg_catalog"."${name}"(name) AS v FROM ${qualified}events`);
});

test("trim(x) is the btrim syntax form: written bare, rendered as pg_catalog.btrim", () => {
  expect(bind("SELECT trim(name) AS t, TRIM(name, 'x') AS u FROM events")).toBe(
    `SELECT "pg_catalog"."btrim"(name) AS t, "pg_catalog"."btrim"(name, 'x') AS u FROM ${qualified}events`,
  );
  rejects('SELECT "trim"(name) AS t FROM events');
  rejects("SELECT pg_catalog.trim(name) AS t FROM events");
  rejects("SELECT trim(both 'x' from name) AS t FROM events");
});

test("operator and function look-alikes inside comments and string literals are inert", () => {
  const source = "SELECT id /* data ? 'a' -> trim( */ FROM events WHERE name = 'a ? b -> trim(c)' -- ~ x";
  expect(bind(source)).toBe(source.replace("FROM events", `FROM ${qualified}events`));
});

test("every new construct is a read-only query", () => {
  expect(prepareQuery("SELECT data->>'a' AS a FROM events WHERE data @> '{}' AND name ~ 'x'").readOnly).toBe(true);
});

// Relies on the `readOnly` allow list being free of side effects; this is a regression guard (passes on the first run, catches a violation).
test("the function allowlist never contains side-effecting functions", () => {
  for (const name of [
    "nextval", "currval", "setval", "lastval", "set_config", "pg_advisory_lock", "pg_advisory_xact_lock", "pg_try_advisory_lock", "pg_notify",
    "pg_sleep", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_switch_wal", "lo_import", "lo_export", "lo_create", "lo_unlink",
    "txid_current", "pg_read_file", "pg_ls_dir",
  ])
    expect(functions.has(name)).toBe(false);
});

test("functions in FROM are qualified and need an alias", () => {
  expect(bind("SELECT g FROM generate_series(1, 10) AS g")).toBe(`SELECT g FROM "pg_catalog"."generate_series"(1, 10) AS g`);
  expect(bind("SELECT e.key, e.value FROM events, jsonb_each(events.data) AS e")).toBe(
    `SELECT e.key, e.value FROM ${qualified}events, "pg_catalog"."jsonb_each"(events.data) AS e`,
  );
  expect(bind("SELECT events.id, e.elem FROM events CROSS JOIN LATERAL jsonb_array_elements(events.data->'list') AS e(elem)")).toBe(
    `SELECT events.id, e.elem FROM ${qualified}events CROSS JOIN LATERAL "pg_catalog"."jsonb_array_elements"(events.data->'list') AS e(elem)`,
  );
  rejects("SELECT 1 FROM generate_series(1, 3)", /needs an alias/);
  rejects("SELECT g FROM nextval('s') AS g", /unsupported function: nextval/);
  rejects("SELECT g FROM app.generate_series(1, 3) AS g");
});

test("star over a function source is expanded only when the alias lists its columns", () => {
  rejects("SELECT g.* FROM generate_series(1, 3) AS g", /columns known at compile time/);
  expect(bind("SELECT g.* FROM generate_series(1, 3) AS g(n)")).toBe(`SELECT g.* FROM "pg_catalog"."generate_series"(1, 3) AS g(n)`);
  const expanded = bind("SELECT e.* FROM events, jsonb_each(events.data) AS e(key_name, val)");
  expect(expanded).toContain(`"e"."key_name" AS "keyName", "e"."val"`);
  expect(expanded).toContain(`AS e(key_name, val)`);
});

test("a function source in FROM keeps the query read-only", () => {
  expect(prepareQuery("SELECT g FROM generate_series(1, 3) AS g").readOnly).toBe(true);
});

test("INTERSECT and EXCEPT keep their original keywords and qualify every branch", () => {
  for (const keyword of ["INTERSECT", "INTERSECT ALL", "EXCEPT", "EXCEPT ALL", "intersect", "except   all"])
    expect(bind(`SELECT id FROM events ${keyword} SELECT id FROM archived`)).toBe(
      `SELECT id FROM ${qualified}events ${keyword} SELECT id FROM ${qualified}archived`,
    );
  expect(bind("SELECT id FROM a UNION SELECT id FROM b INTERSECT SELECT id FROM c EXCEPT SELECT id FROM d ORDER BY id")).toBe(
    `SELECT id FROM ${qualified}a UNION SELECT id FROM ${qualified}b INTERSECT SELECT id FROM ${qualified}c EXCEPT SELECT id FROM ${qualified}d ORDER BY id`,
  );
  expect(prepareQuery("SELECT id FROM a EXCEPT SELECT id FROM b").readOnly).toBe(true);
});

test("the first branch still names the output columns of INTERSECT/EXCEPT", () => {
  expect(bind("SELECT first_name FROM a INTERSECT SELECT first_name FROM b ORDER BY first_name")).toBe(
    `SELECT first_name AS "firstName" FROM ${qualified}a INTERSECT SELECT first_name FROM ${qualified}b ORDER BY "firstName"`,
  );
});

test("IS [NOT] DISTINCT FROM keeps its original text and still validates both operands", () => {
  expect(bind("SELECT id FROM events WHERE name IS DISTINCT FROM $1 OR name IS NOT DISTINCT FROM 'x'")).toBe(
    `SELECT id FROM ${qualified}events WHERE name IS DISTINCT FROM $1 OR name IS NOT DISTINCT FROM 'x'`,
  );
  const spread = "SELECT id FROM events WHERE name IS\n  NOT   DISTINCT\tFROM note";
  expect(bind(spread)).toBe(spread.replace("FROM events", `FROM ${qualified}events`));
  rejects("SELECT id FROM events WHERE nextval('s') IS DISTINCT FROM 1", /unsupported function: nextval/);
});

test("window frames pass through when strict and reject everything else", () => {
  for (const frame of [
    "ROWS BETWEEN 1 PRECEDING AND CURRENT ROW",
    "ROWS UNBOUNDED PRECEDING",
    "RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING",
    "GROUPS BETWEEN 2 PRECEDING AND 1 FOLLOWING",
    "ROWS 3 PRECEDING",
    "rows between current row and unbounded following",
  ])
    expect(bind(`SELECT sum(id) OVER (PARTITION BY name ORDER BY id ${frame}) AS s FROM events`)).toBe(
      `SELECT "pg_catalog"."sum"(id) OVER (PARTITION BY name ORDER BY id ${frame}) AS s FROM ${qualified}events`,
    );
  rejects("SELECT sum(id) OVER (ORDER BY id ROWS BETWEEN $1 PRECEDING AND CURRENT ROW) AS s FROM events");
  rejects("SELECT sum(id) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES) AS s FROM events");
  rejects("SELECT sum(id) OVER (ORDER BY id ROWS BETWEEN (SELECT 1) PRECEDING AND CURRENT ROW) AS s FROM events");
  rejects("SELECT ROWS UNBOUNDED PRECEDING FROM events");
});

test("look-alike words in strings, comments, quoted identifiers and plain columns are inert", () => {
  const source = `SELECT 'a INTERSECT b' AS v, "except" AS w, rows, range, groups FROM events WHERE rows BETWEEN 1 AND 2 -- IS DISTINCT FROM
    AND 'GROUPING SETS' = 'x' /* ROWS UNBOUNDED PRECEDING) */`;
  expect(bind(source)).toBe(source.replace("FROM events", `FROM ${qualified}events`));
});

test("migration-only clauses still fail closed in runtime queries", () => {
  rejects("SELECT id FROM events WHERE id = 1 UNIQUE NULLS NOT DISTINCT");
  rejects("ALTER TABLE events ALTER COLUMN id TYPE bigint USING id::bigint");
});

test("WITH RECURSIVE: the CTE sees itself; the same SQL without RECURSIVE reads a real table", () => {
  const body = "SELECT id, parent_id FROM nodes WHERE id = $1 UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN tree t ON n.parent_id = t.id";
  expect(bind(`WITH RECURSIVE tree AS (${body}) SELECT id FROM tree`)).toBe(
    `WITH RECURSIVE tree AS (SELECT id, parent_id FROM ${qualified}nodes WHERE id = $1 UNION ALL SELECT n.id, n.parent_id FROM ${qualified}nodes n JOIN tree t ON n.parent_id = t.id) SELECT id FROM tree`,
  );
  // Without RECURSIVE, `tree` in the body is a real table, and PostgreSQL resolves it that way too.
  expect(bind(`WITH tree AS (${body}) SELECT id FROM tree`)).toContain(`JOIN ${qualified}tree t`);
});

test("WITH RECURSIVE works nested, in lower case, and a star over it expands from the first branch", () => {
  const nested = "SELECT id FROM events WHERE EXISTS (with recursive r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT 1 FROM r)";
  expect(bind(nested)).toBe(nested.replace("FROM events", `FROM ${qualified}events`));
  const inFrom = "SELECT s.n FROM (WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r) s";
  expect(bind(inFrom)).toBe(inFrom);
  const star = bind("WITH RECURSIVE r AS (SELECT 1 AS n_one UNION ALL SELECT n_one + 1 FROM r WHERE n_one < 3) SELECT * FROM r");
  expect(star).toContain(`"r"."n_one" AS "nOne"`);
  expect(prepareQuery("WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r").readOnly).toBe(true);
});

test("ROLLUP, CUBE and GROUPING SETS keep their text; grouping() is not qualified", () => {
  expect(bind("SELECT name, count(*) AS n, grouping(name) AS g FROM events GROUP BY ROLLUP (name)")).toBe(
    `SELECT name, "pg_catalog"."count"(*) AS n, grouping(name) AS g FROM ${qualified}events GROUP BY ROLLUP (name)`,
  );
  for (const group of ["CUBE (name, status)", "GROUPING SETS ((name, status), (name), (status))", "status, ROLLUP (name)", "rollup ((name, status), (name))"])
    expect(bind(`SELECT name, status FROM events GROUP BY ${group}`)).toBe(`SELECT name, status FROM ${qualified}events GROUP BY ${group}`);
  expect(prepareQuery("SELECT name FROM events GROUP BY GROUPING SETS ((name), (name))").readOnly).toBe(true);
});

test("ROLLUP, CUBE and GROUPING SETS are accepted only directly under GROUP BY", () => {
  rejects("SELECT rollup(name) AS r FROM events", /only directly in GROUP BY/);
  rejects("SELECT name FROM events GROUP BY name HAVING cube(name) IS NOT NULL", /only directly in GROUP BY/);
  rejects("SELECT name FROM events GROUP BY GROUPING SETS ((name), ROLLUP (status))", /only directly in GROUP BY/);
  rejects("SELECT name FROM events GROUP BY GROUPING SETS ((name), ())");
  rejects('SELECT name FROM events GROUP BY "rollup" (name)', /quoted SQL syntax/);
  rejects("SELECT name FROM events GROUP BY ROLLUP (nextval('s'))", /unsupported function: nextval/);
});
const NEW_TYPES = ["inet", "cidr", "macaddr", "tsvector", "tsquery", "int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange"];
const fold = (ddl: string) => foldTables(prepareMigration(ddl).statements);
const moduleOf = (ddl: string) => tableModules(fold(ddl)).get("src/tables/t.gen.ts") as string;

test("new scalar types are qualified with pg_catalog in casts", () => {
  for (const type of NEW_TYPES)
    expect(bind(`SELECT c::${type} AS v FROM hosts`)).toBe(`SELECT c::"pg_catalog"."${type}" AS v FROM ${qualified}hosts`);
  expect(prepareQuery("SELECT c::inet AS v FROM hosts").readOnly).toBe(true);
});

test("every builtin type has a zod mapping and the new types are strings", () => {
  for (const type of new Set(Object.values(types))) expect(moduleOf(`CREATE TABLE t (c ${type} NOT NULL)`)).not.toContain("undefined");
  for (const type of NEW_TYPES) expect(moduleOf(`CREATE TABLE t (c ${type})`)).toContain("  c: z.string().nullable(),");
});

test("serial types are written bare in CREATE TABLE / ADD COLUMN and fold to integer, NOT NULL, with a default", () => {
  expect(prepareMigration("CREATE TABLE t (id serial PRIMARY KEY, big bigserial, small smallserial)").bind(schema)).toEqual([
    `CREATE TABLE ${qualified}t (id serial PRIMARY KEY, big bigserial, small smallserial)`,
  ]);
  expect(prepareMigration("ALTER TABLE t ADD COLUMN extra SERIAL").bind(schema)).toEqual([`ALTER TABLE ${qualified}t ADD COLUMN extra SERIAL`]);
  const shapes = fold("CREATE TABLE t (id serial PRIMARY KEY, big bigserial, small smallserial, plain integer)");
  expect(shapes.tables.get("t")).toEqual([
    { name: "id", type: "int4", arrayDepth: 0, notNull: true, hasDefault: true },
    { name: "big", type: "int8", arrayDepth: 0, notNull: true, hasDefault: true },
    { name: "small", type: "int2", arrayDepth: 0, notNull: true, hasDefault: true },
    { name: "plain", type: "int4", arrayDepth: 0, notNull: false, hasDefault: false },
  ]);
  const module = moduleOf("CREATE TABLE t (id serial PRIMARY KEY, big bigserial)");
  for (const line of ["  id: z.number().int(),", "  id: z.number().int().optional(),", "  big: z.string(),", "  big: z.string().optional(),"])
    expect(module).toContain(line);
});

test("new types are scalar-only: arrays of them are rejected everywhere", () => {
  for (const ddl of ["CREATE TABLE t (c inet[])", "CREATE TABLE t (c int4range[][])", "CREATE TABLE t (c tsvector[])"])
    expect(() => prepareMigration(ddl)).toThrow(/arrays are unsupported/);
  rejects("SELECT $1::inet[] AS v FROM hosts", /arrays are unsupported/);
  rejects("SELECT ARRAY[ip]::cidr[] AS v FROM hosts", /arrays are unsupported/);
  expect(bind("SELECT ARRAY[1, 2]::integer[] AS v FROM hosts")).toContain('"pg_catalog"."int4"[]');
});

test("serial is a column-definition syntax only; citext and other extension types are rejected", () => {
  rejects("SELECT $1::serial AS v FROM hosts", /unsupported type: serial/);
  for (const ddl of ["ALTER TABLE t ALTER COLUMN c TYPE bigserial", "CREATE TABLE t (c serial[])", 'CREATE TABLE t (c "serial")'])
    expect(() => prepareMigration(ddl)).toThrow(/unsupported type: (big)?serial/);
  expect(() => prepareMigration("CREATE TABLE t (c public.serial)")).toThrow(/explicit schema qualification/);
  rejects("SELECT c::citext AS v FROM hosts", /unsupported type: citext/);
  expect(() => prepareMigration("CREATE TABLE t (c citext)")).toThrow(/unsupported type: citext/);
});

test("tsvector, overlap and network operators and the full-text functions compile", () => {
  expect(
    bind("SELECT id FROM docs WHERE tsv @@ to_tsquery('simple', $1) AND ip << '10.0.0.0/8'::inet AND ip >> '10.0.0.1'::inet AND span && '[1,5)'::int4range"),
  ).toBe(
    `SELECT id FROM ${qualified}docs WHERE tsv @@ "pg_catalog"."to_tsquery"('simple', $1) AND ip << '10.0.0.0/8'::"pg_catalog"."inet" AND ip >> '10.0.0.1'::"pg_catalog"."inet" AND span && '[1,5)'::"pg_catalog"."int4range"`,
  );
  for (const name of ["to_tsvector", "to_tsquery", "plainto_tsquery", "websearch_to_tsquery", "ts_rank"])
    expect(bind(`SELECT ${name}(c) AS v FROM docs`)).toBe(`SELECT "pg_catalog"."${name}"(c) AS v FROM ${qualified}docs`);
  for (const operator of ["-|-", "<<=", ">>="]) rejects(`SELECT id FROM docs WHERE span ${operator} other`);
  expect(prepareQuery("SELECT id FROM docs WHERE tsv @@ to_tsquery('simple', $1)").readOnly).toBe(true);
});

// Final review: `rollup`/`cube` is a special call (not qualified); if it appears as a function in FROM or in a parenthesized GROUP BY item, it resolves to an unqualified name.
test("rollup and cube are never emitted as plain functions (FROM source, parenthesised GROUP BY item)", () => {
  for (const source of [
    "SELECT c FROM cube(1.0) AS c",
    "SELECT c FROM rollup(1) AS c",
    "SELECT name FROM events GROUP BY (rollup(name))",
    "SELECT name FROM events GROUP BY (cube(name))",
    "SELECT name FROM events GROUP BY name, (cube(name))",
  ])
    rejects(source);
  expect(prepareMigration("INSERT INTO t (id) SELECT 1").bind(schema).length).toBe(1);
  expect(() => prepareMigration("INSERT INTO t (id) SELECT c FROM cube(1.0) AS c")).toThrow(/SQL_UNSUPPORTED/);
});
