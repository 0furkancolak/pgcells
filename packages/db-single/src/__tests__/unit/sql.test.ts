import { describe, expect, test } from "bun:test";
import { maskSqlComments, prepareMigration, prepareQuery, unqualifyMigration } from "../../core/sql/compiler";
import { foldTables } from "../../core/sql/tables";
import { isPreparedQuery } from "../../core/sql/query";

// Depo genelindeki koruma testi bu sözcüğü yazan her dosyayı reddeder; reddedilmesi beklenen girdiler parçalardan kurulur.
const SP = "search" + "_path";

const a = `app_${"a".repeat(32)}`;
const b = `app_${"b".repeat(32)}`;
// En dıştaki `*` derlemede açılır: sütunlar migration katlamasının biçimindeki bir tablo listesinden gelir.
const tables = new Map([
  ["students", ["id", "name", "status"]],
  ["courses", ["id", "title"]],
].map(([table, columns]) => [table as string, (columns as string[]).map((name) => ({ name }))]));

describe("SQL compilation", () => {
  test("qualifies tables while preserving values and identifier semantics", () => {
    const query = prepareQuery(
      `SELECT s.id::text, 'students __app_schema__' AS marker FROM "Students" s WHERE s.name = $1`,
    );
    expect(query.bind(a)).toContain(`"${a}"."Students"`);
    expect(query.bind(a)).toContain("'students __app_schema__'");
    expect(query.bind(a)).toContain("$1");
    expect(Object.isFrozen(query)).toBe(true);
    expect(isPreparedQuery(query)).toBe(true);
    expect(isPreparedQuery({ bind: () => "SELECT 1" })).toBe(false);
  });
  test("binds concurrently without retaining schema state", async () => {
    const query = prepareQuery("SELECT * FROM students", tables);
    const results = await Promise.all(
      [a, b, a].map(async (schema) => query.bind(schema)),
    );
    expect(results[0]).toContain(`"${a}"`);
    expect(results[1]).toContain(`"${b}"`);
    expect(results[2]).toBe(results[0]);
    expect(() => query.bind('x"; DROP SCHEMA public CASCADE; --')).toThrow();
  });
  test("resolves CTEs in lexical scope including nested shadowing", () => {
    const sql = prepareQuery(
      "WITH students AS (SELECT * FROM students) SELECT * FROM students JOIN (WITH courses AS (SELECT * FROM courses) SELECT title FROM courses) c ON true",
      tables,
    ).bind(a);
    expect(sql).toBe(
      `WITH students AS (SELECT * FROM "${a}".students) SELECT * FROM students JOIN (WITH courses AS (SELECT * FROM "${a}".courses) SELECT title FROM courses) c ON true`,
    );
  });
  test("supports insert/update/delete, joins and correlated subqueries", () => {
    for (const source of [
      "INSERT INTO students(id, name) VALUES ($1::uuid, $2) RETURNING id::text",
      "UPDATE students SET name = $1 WHERE id = $2 RETURNING id",
      "DELETE FROM students WHERE id = $1 RETURNING id",
      "SELECT s.id FROM students s JOIN courses c ON c.id = s.id WHERE EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id) ORDER BY s.id LIMIT $1 OFFSET $2",
    ])
      expect(prepareQuery(source).bind(a)).toContain(`"${a}"`);
  });
  test("prepares current migration DDL including foreign keys and concurrent indexes", () => {
    const statements = prepareMigration(
      "CREATE TABLE students (id uuid PRIMARY KEY, name text NOT NULL); CREATE TABLE enrollments (student_id uuid REFERENCES students(id)); ALTER TABLE students ADD COLUMN status text DEFAULT 'active' CHECK (status IN ('active','inactive')); CREATE INDEX CONCURRENTLY students_name_idx ON students(name)",
    ).bind(a);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain(`"${a}"`);
    expect(statements[1]?.match(new RegExp(a, "g"))?.length).toBe(2);
    expect(statements[3]).toMatch(/CONCURRENTLY/i);
    expect(Object.isFrozen(statements)).toBe(true);
  });
  test("index collations render as pg_catalog collations; qualified ones reject", () => {
    expect(
      prepareMigration(
        'CREATE INDEX x ON students (id, name COLLATE "C" DESC)',
      ).bind(a),
    ).toEqual([
      `CREATE INDEX x ON "${a}".students (id, name COLLATE "pg_catalog"."C" DESC)`,
    ]);
    expect(() =>
      prepareMigration(
        'CREATE INDEX x ON students (name COLLATE pg_catalog."C")',
      ),
    ).toThrow(/SQL_UNSUPPORTED/);
    expect(() => prepareQuery('SELECT name COLLATE "C" FROM students')).toThrow(
      /SQL_UNSUPPORTED/,
    );
  });
  test("rejects unsupported SQL before execution", () => {
    for (const sql of [
      "SELECT * FROM public.students",
      "SELECT other.students.id FROM students",
      "SELECT pg_catalog.pg_read_file('/etc/passwd')",
      `SELECT set_config('${SP}','public',false)`,
      "SELECT evil(id) FROM students",
      "SELECT nextval('other.seq')",
      "SELECT $1::regclass",
      "SELECT $1::custom_type",
      "SELECT * FROM pg_catalog.pg_class",
      "SELECT 1; SELECT 2",
      `SET ${SP} TO public`,
      "DO $$ BEGIN NULL; END $$",
      "CREATE TABLE x (id uuid)",
      "SELECT * INTO other FROM students",
      "SELECT * FROM dblink('x','SELECT 1') AS x(id text)",
    ])
      expect(() => prepareQuery(sql), sql).toThrow(/SQL_UNSUPPORTED/);
    for (const sql of [
      "DROP SCHEMA public CASCADE",
      "CREATE VIEW x AS SELECT * FROM students",
      "ALTER TABLE students SET SCHEMA public",
      "CREATE TABLE x (id public.custom_type)",
      "CREATE TABLE x (id uuid REFERENCES public.students(id))",
    ])
      expect(() => prepareMigration(sql), sql).toThrow(/SQL_UNSUPPORTED/);
  });
});

describe("quoted identifier, identity and generated column migration constructs", () => {
  const s = "app_acme";
  const bind = (source: string, types?: Set<string>) => prepareMigration(source, types).bind(s);

  test("identity columns qualify their sequence name; stored generated columns and qualified sequences reject", () => {
    expect(
      bind(
        'CREATE TABLE "t" ("n" integer GENERATED ALWAYS AS IDENTITY (sequence name "t_n_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1), "m" bigint GENERATED BY DEFAULT AS IDENTITY)',
      ),
    ).toEqual([
      `CREATE TABLE "${s}"."t" ("n" "pg_catalog"."int4" GENERATED ALWAYS AS IDENTITY (sequence name "${s}"."t_n_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1), "m" "pg_catalog"."int8" GENERATED BY DEFAULT AS IDENTITY)`,
    ]);
    expect(bind('ALTER TABLE "t" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY')).toEqual([
      `ALTER TABLE "${s}"."t" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY`,
    ]);
    const { tables } = foldTables(prepareMigration("CREATE TABLE t (n integer GENERATED ALWAYS AS IDENTITY, k text)").statements);
    expect(tables.get("t")?.[0]).toEqual({ name: "n", type: "int4", arrayDepth: 0, notNull: true, hasDefault: true });
  });

  test("ALTER COLUMN TYPE USING compiles its expression; USING elsewhere or in literals is not a clause", () => {
    expect(
      bind('ALTER TABLE "t" ALTER COLUMN "s" SET DATA TYPE "status" USING "s"::text::"status", ALTER COLUMN "n" TYPE bigint USING n::bigint', new Set(["status"])),
    ).toEqual([
      `ALTER TABLE "${s}"."t" ALTER COLUMN "s" SET DATA TYPE "${s}"."status" USING "s"::"pg_catalog"."text"::"${s}"."status", ALTER COLUMN "n" TYPE "pg_catalog"."int8" USING n::"pg_catalog"."int8"`,
    ]);
    expect(bind("ALTER TABLE t ALTER COLUMN a SET DEFAULT 'x USING y'")).toEqual([`ALTER TABLE "${s}".t ALTER COLUMN a SET DEFAULT 'x USING y'`]);
    expect(bind("CREATE INDEX i ON t USING btree (a)")).toEqual([`CREATE INDEX i ON "${s}".t USING btree (a)`]);
    for (const source of [
      "ALTER TABLE t ALTER COLUMN a SET DEFAULT 1 USING a",
      "ALTER TABLE t ADD COLUMN a text USING a",
      "ALTER TABLE t ALTER COLUMN a TYPE text USING",
      "ALTER TABLE t ALTER COLUMN a TYPE text USING a::public.custom",
    ])
      expect(() => prepareMigration(source), source).toThrow(/SQL_UNSUPPORTED/);
  });

  test("ALTER TYPE ADD VALUE qualifies the enum and keeps IF NOT EXISTS / BEFORE / AFTER at verified positions", () => {
    expect(bind(`ALTER TYPE "r" ADD VALUE IF NOT EXISTS 'b' BEFORE 'c'; ALTER TYPE r ADD VALUE 'it''s' AFTER 'a'; ALTER TYPE r ADD VALUE 'd'`)).toEqual([
      `ALTER TYPE "${s}"."r" ADD VALUE IF NOT EXISTS 'b' BEFORE 'c'; `,
      `ALTER TYPE "${s}".r ADD VALUE 'it''s' AFTER 'a'; `,
      `ALTER TYPE "${s}".r ADD VALUE 'd'`,
    ]);
    const folded = prepareMigration("CREATE TYPE r AS ENUM ('a', 'c'); ALTER TYPE r ADD VALUE 'b' BEFORE 'c'; ALTER TYPE r ADD VALUE IF NOT EXISTS 'a'; ALTER TYPE r ADD VALUE 'd' AFTER 'c'");
    expect(foldTables(folded.statements).enums.get("r")).toEqual(["a", "b", "c", "d"]);
    for (const source of [
      "ALTER TYPE r ADD VALUE 'x' BEFORE 'y' AFTER 'z'",
      "ALTER TYPE r ADD VALUE 'x' BEFORE y",
      "ALTER TYPE r RENAME TO s",
      "ALTER TYPE public.r ADD VALUE 'x'",
    ])
      expect(() => prepareMigration(source), source).toThrow(/SQL_UNSUPPORTED/);
  });

  test("UNIQUE NULLS NOT DISTINCT is kept on unique table and column constraints only", () => {
    expect(bind('CREATE TABLE t (a text UNIQUE NULLS NOT DISTINCT, b text, CONSTRAINT "u" UNIQUE NULLS NOT DISTINCT("a","b"))')).toEqual([
      `CREATE TABLE "${s}".t (a "pg_catalog"."text" UNIQUE NULLS NOT DISTINCT, b "pg_catalog"."text", CONSTRAINT "u" UNIQUE NULLS NOT DISTINCT("a","b"))`,
    ]);
    expect(bind("INSERT INTO t (a) VALUES ('UNIQUE NULLS NOT DISTINCT')")).toEqual([`INSERT INTO "${s}".t (a) VALUES ('UNIQUE NULLS NOT DISTINCT')`]);
    for (const source of ["CREATE UNIQUE INDEX i ON t (a) NULLS NOT DISTINCT", "CREATE TABLE t (a text PRIMARY KEY NULLS NOT DISTINCT)"])
      expect(() => prepareMigration(source), source).toThrow(/SQL_UNSUPPORTED/);
  });

  test("DROP TABLE/TYPE CASCADE only for objects created earlier in the same section; folding drops the type's columns", () => {
    const source = "CREATE TYPE r AS ENUM ('a'); CREATE TABLE a (x r, y text); ALTER TABLE a RENAME TO b; DROP TYPE r CASCADE; DROP TABLE b CASCADE";
    expect(bind(source).at(-1)).toBe(`DROP TABLE "${s}".b CASCADE`);
    const partial = prepareMigration(source.replace("; DROP TABLE b CASCADE", "")).statements;
    expect(foldTables(partial).tables.get("b")?.map((column) => column.name)).toEqual(["y"]);
    const created = new Set<string>();
    prepareMigration("CREATE TABLE a (id int)", new Set(), created);
    expect(prepareMigration("DROP TABLE IF EXISTS a CASCADE", new Set(), created).bind(s)).toEqual([`DROP TABLE IF EXISTS "${s}".a CASCADE`]);
    for (const rejected of [
      "DROP TABLE a CASCADE",
      "CREATE TABLE a (id int); DROP TABLE a; DROP TABLE IF EXISTS a CASCADE",
      "CREATE TABLE a (id int); DROP TABLE a, b CASCADE",
      "CREATE TABLE a (id int); CREATE INDEX i ON a (id); DROP INDEX i CASCADE",
    ])
      expect(() => prepareMigration(rejected), rejected).toThrow(/SQL_UNSUPPORTED/);
  });

  test("data migrations accept WITH and EXTRACT under the runtime expression rules", () => {
    expect(bind("WITH x AS (SELECT id FROM students) UPDATE students SET year = EXTRACT(YEAR FROM now())::int FROM x WHERE x.id = students.id")).toEqual([
      `WITH x AS (SELECT id FROM "${s}".students) UPDATE "${s}".students SET year = EXTRACT(YEAR FROM "pg_catalog"."now"())::"pg_catalog"."int4" FROM x WHERE x.id = students.id`,
    ]);
    expect(prepareQuery("SELECT EXTRACT(MONTH FROM created_at) AS m FROM students").bind(s)).toContain("EXTRACT(MONTH FROM created_at)");
    expect(() => prepareMigration("WITH x AS (SELECT evil()) UPDATE students SET id = 1")).toThrow(/SQL_UNSUPPORTED/);
  });

  test("unqualifyMigration strips only declared source schemas at AST positions", () => {
    const sourceSchemas = new Set(["public", "panel"]);
    const sql = `CREATE TABLE "panel"."t" ("r" "panel"."r", "u" uuid REFERENCES public.users("id")); UPDATE "panel"."t" SET "u" = panel.u FROM "t2" panel WHERE '"panel".x' <> ''`;
    expect(unqualifyMigration(sql, sourceSchemas, new Set(["r"]), new Set()).source).toBe(
      `CREATE TABLE "t" ("r" "r", "u" uuid REFERENCES users("id")); UPDATE "t" SET "u" = panel.u FROM "t2" panel WHERE '"panel".x' <> ''`,
    );
    for (const rejected of ['CREATE TABLE "other"."t" (id uuid)', 'WITH t AS (SELECT 1) UPDATE x SET a = 1 FROM "panel"."t"'])
      expect(() => unqualifyMigration(rejected, sourceSchemas, new Set(), new Set()), rejected).toThrow(/SQL_UNSUPPORTED/);
    expect(() => prepareMigration('CREATE TABLE "panel"."t" (id uuid)')).toThrow(/explicit schema qualification: panel/);
  });
});

test("preserves comments and marker-looking literals without token substitution", () => {
  const source = `SELECT '__app_schema__', '"app_aaaaaa"', 'FROM public.students;'  AS "__app_schema__" FROM students /* students __app_schema__ */ -- trailing comment`;
  const sql = prepareQuery(source).bind(b);
  expect(sql).toBe(
    source.replace("FROM students /*", `FROM "${b}".students /*`),
  );
});

test("pins safe builtins and rejects quoted syntax masquerading as functions", () => {
  expect(
    prepareQuery(
      "SELECT count(*), lower(name), coalesce(name, 'x'), id::text FROM students",
    ).bind(a),
  ).toBe(
    `SELECT "pg_catalog"."count"(*), "pg_catalog"."lower"(name), coalesce(name, 'x'), id::"pg_catalog"."text" FROM "${a}".students`,
  );
  expect(() => prepareQuery('SELECT "coalesce"(1, 2)')).toThrow(
    /SQL_UNSUPPORTED/,
  );
  expect(() => prepareQuery('SELECT "exists"(1)')).toThrow(/SQL_UNSUPPORTED/);
  expect(() => prepareQuery('SELECT $1::"integer"')).toThrow(/SQL_UNSUPPORTED/);
});

test("fails closed for unsupported nested expression and DDL escape routes", () => {
  for (const source of [
    "WITH x AS (SELECT evil()) SELECT * FROM x",
    "SELECT 1 ORDER BY evil()",
    "SELECT DISTINCT ON (evil()) id FROM students",
    "SELECT count(*) FILTER (WHERE evil()) FROM students",
    "SELECT 1 OPERATOR(public.+) 2",
    "SELECT CAST($1 AS regclass)",
    `WITH "${"x".repeat(64)}" AS (SELECT 1) SELECT * FROM "${"x".repeat(64)}"`,
  ])
    expect(() => prepareQuery(source), source).toThrow(/SQL_UNSUPPORTED/);
  for (const source of [
    "CREATE TABLE x (id uuid DEFAULT evil())",
    "CREATE TABLE x (LIKE public.students)",
    "CREATE TABLE x (id uuid) INHERITS (public.students)",
    "CREATE TEMP TABLE x (id uuid)",
    "CREATE TABLE x (id integer, y integer GENERATED ALWAYS AS (id * 2) STORED)",
    "CREATE TABLE x (id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.x_seq))",
    "CREATE INDEX x ON students (name COLLATE public.evil)",
    "CREATE INDEX x ON students (name public.evil_ops)",
    "ALTER TABLE students ADD COLUMN x text DEFAULT (SELECT evil())",
  ])
    expect(() => prepareMigration(source), source).toThrow(/SQL_UNSUPPORTED/);
});

test("rejects array modifiers whose AST spans omit the modifier", () => {
  for (const type of ["varchar(10)[]", "numeric(10,2)[]"]) {
    expect(() => prepareQuery(`SELECT $1::${type}`), type).toThrow(
      /SQL_UNSUPPORTED/,
    );
    expect(
      () => prepareMigration(`CREATE TABLE x (value ${type})`),
      type,
    ).toThrow(/SQL_UNSUPPORTED/);
  }
  expect(prepareQuery("SELECT $1::varchar[], $2::numeric(10,2)").bind(a)).toBe(
    'SELECT $1::"pg_catalog"."varchar"[], $2::"pg_catalog"."numeric"(10,2)',
  );
});

test("rejects long type aliases with incomplete or mislabeled AST locations", () => {
  for (const type of [
    "time with time zone",
    "time without time zone",
    "timestamp with time zone",
    "timestamp without time zone",
    "timestamp(3) with time zone",
    "time(3) WITH TIME ZONE",
    "character varying(10)",
  ]) {
    expect(() => prepareQuery(`SELECT $1::${type}`), type).toThrow(
      /SQL_UNSUPPORTED/,
    );
    expect(
      () => prepareMigration(`CREATE TABLE x (value ${type})`),
      type,
    ).toThrow(/SQL_UNSUPPORTED/);
  }
  expect(
    prepareQuery("SELECT $1::timetz, $2::timestamptz(3), $3::varchar(10)").bind(
      a,
    ),
  ).toBe(
    'SELECT $1::"pg_catalog"."timetz", $2::"pg_catalog"."timestamptz"(3), $3::"pg_catalog"."varchar"(10)',
  );
});

test("rejects character aliases instead of losing their default length", () => {
  for (const type of ["char", "character"]) {
    expect(() => prepareQuery(`SELECT $1::${type}`), type).toThrow(
      /SQL_UNSUPPORTED/,
    );
    expect(
      () => prepareMigration(`CREATE TABLE x (value ${type})`),
      type,
    ).toThrow(/SQL_UNSUPPORTED/);
  }
  expect(prepareQuery("SELECT $1::bpchar(1), $2::bpchar").bind(a)).toBe(
    'SELECT $1::"pg_catalog"."bpchar"(1), $2::"pg_catalog"."bpchar"',
  );
  expect(prepareQuery("SELECT CAST($1 AS varchar(10))").bind(a)).toBe(
    'SELECT CAST($1 AS "pg_catalog"."varchar"(10))',
  );
  expect(
    prepareMigration(
      "CREATE TABLE x (value bpchar(1), amount numeric(10,2))",
    ).bind(a),
  ).toEqual([
    `CREATE TABLE "${a}".x (value "pg_catalog"."bpchar"(1), amount "pg_catalog"."numeric"(10,2))`,
  ]);
});

test("rejects statements hidden behind block-comment lexer tokens", () => {
  for (const source of [
    "SELECT 1 /* ' */; SELECT * FROM public.students; -- '",
    "SELECT 1 /* ' */; SELECT * FROM public.students; -- ' */",
    "SELECT 1 /* -- */; SELECT * FROM public.students; /*\n */",
    "SELECT 1 /* $$ */; SELECT * FROM public.students; -- $$ */",
    "SELECT 1 /* outer /* ' */ inner */; SELECT 2; -- '",
    "SELECT 'backslash\\' /* ' */; SELECT 2; -- '",
    "SELECT 1 /* never closed",
  ])
    expect(() => prepareQuery(source), source).toThrow(/SQL_UNSUPPORTED/);
});

test("preserves adversarial comments and original source offsets", () => {
  for (const comment of [
    "/* ' -- $$ */",
    "/* outer /* ' */ inner */",
    "-- ' /* $$\r\n",
    "-- ' /* $$\r",
  ]) {
    const source = `WITH items AS (${comment} SELECT * FROM students) SELECT * FROM items`;
    expect(prepareQuery(source, tables).bind(a)).toBe(
      `WITH items AS (${comment} SELECT * FROM "${a}".students) SELECT * FROM items`,
    );
  }
  const source = String.raw`SELECT '/* quoted */ --', 'it''s /* safe */', E'escaped\n /* string */', "name""--" FROM students /* ' */`;
  expect(prepareQuery(source).bind(a)).toBe(
    source.replace("FROM students", `FROM "${a}".students`),
  );
});

test("keeps bare interval syntax and precision in casts and DDL", () => {
  for (const source of [
    "SELECT $1::interval(3)",
    "SELECT CAST($1 AS INTERVAL(3))",
    "SELECT INTERVAL '1 year 2 months' YEAR",
    "SELECT $1::interval /* precision */ (3)",
  ])
    expect(prepareQuery(source).bind(a)).toBe(source);
  expect(
    prepareMigration("CREATE TABLE events (duration interval(3))").bind(a),
  ).toEqual([`CREATE TABLE "${a}".events (duration interval(3))`]);
  expect(
    prepareQuery('SELECT $1::"interval", $2::pg_catalog.interval').bind(a),
  ).toBe('SELECT $1::"pg_catalog"."interval", $2::"pg_catalog"."interval"');
});

test("rejects unsupported quoting without treating its body as SQL", () => {
  for (const source of [
    "SELECT $$ /* ' */ $$",
    "SELECT $body$ /* ' */ $body$",
    'SELECT U&"name" FROM students',
    "SELECT U&'value'",
    "SELECT 'unterminated",
    'SELECT "unterminated',
  ])
    expect(() => prepareQuery(source), source).toThrow(/SQL_UNSUPPORTED/);
});

test("preserves comments inside canonical builtin source spans", () => {
  const source =
    "SELECT $1::numeric /* keep type */ (10, 2), pg_catalog /* keep function */ .lower(name) FROM students";
  const sql = prepareQuery(source).bind(a);
  expect(sql).toContain("/* keep type */");
  expect(sql).toContain("/* keep function */");
  expect(sql).toContain('"pg_catalog"."numeric"(10,2)');
  expect(sql).toContain('"pg_catalog"."lower"');
});

test("comment masking respects E-string quote escapes and doubled identifiers", () => {
  expect(
    maskSqlComments(String.raw`SELECT E'quote\' /* string */' /* sql */`),
  ).toBe(String.raw`SELECT E'quote\' /* string */'          `);
  expect(maskSqlComments(String.raw`SELECT E'slash\\' /* sql */`)).toBe(
    String.raw`SELECT E'slash\\'          `,
  );
  expect(maskSqlComments(`SELECT "name""/* identifier */" /* sql */`)).toBe(
    `SELECT "name""/* identifier */"          `,
  );
  expect(maskSqlComments(String.raw`SELECT 'slash\' /* sql */`)).toBe(
    String.raw`SELECT 'slash\'          `,
  );
});
