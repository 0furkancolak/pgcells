import { expect, test } from "bun:test";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";

const schema = `tenant_${"a".repeat(32)}`;
const qualified = `"${schema}".`;

test("upserts preserve excluded and target aliases while qualifying nested relations", () => {
  const source = `INSERT INTO "Students" AS s(id,name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name=excluded.name WHERE s.id=(SELECT id FROM students WHERE name='excluded') RETURNING s.id`;
  expect(prepareQuery(source).bind(schema)).toBe(
    source
      .replace('INTO "Students"', `INTO ${qualified}"Students"`)
      .replace("FROM students", `FROM ${qualified}students`),
  );
  for (const clause of [
    "DO NOTHING",
    "(id) DO NOTHING",
    "ON CONSTRAINT students_pkey DO NOTHING",
    "ON CONSTRAINT students_pkey DO UPDATE SET name=excluded.name",
    "(lower(name)) DO UPDATE SET name=(SELECT name FROM students LIMIT 1)",
  ]) {
    const bound = prepareQuery(
      `INSERT INTO students(id,name) VALUES ($1,$2) ON CONFLICT ${clause}`,
    ).bind(schema);
    expect(bound).toContain(`INTO ${qualified}students`);
    expect(bound).not.toContain(`${qualified}excluded`);
    if (clause.includes("lower")) {
      expect(bound).toContain('"pg_catalog"."lower"(name)');
      expect(bound).toContain(`FROM ${qualified}students`);
    }
  }
});

test("upsert scopes do not confuse real excluded tables or shadowed CTE targets", () => {
  const source =
    "WITH students AS (SELECT id FROM students) INSERT INTO students(id) SELECT id FROM students ON CONFLICT (id) DO UPDATE SET id=(SELECT id FROM excluded)";
  expect(prepareQuery(source).bind(schema)).toBe(
    `WITH students AS (SELECT id FROM ${qualified}students) INSERT INTO ${qualified}students(id) SELECT id FROM students ON CONFLICT (id) DO UPDATE SET id=(SELECT id FROM ${qualified}excluded)`,
  );
  const commented =
    'INSERT /* \' */ INTO "Students" VALUES ($1) ON CONFLICT ON CONSTRAINT "unique--name" DO NOTHING; -- trailing';
  expect(prepareQuery(commented).bind(schema)).toBe(
    commented.replace('INTO "Students"', `INTO ${qualified}"Students"`),
  );
});

test("window functions keep default frames and qualify nested partition/order expressions", () => {
  for (const call of [
    "row_number()",
    "rank()",
    "dense_rank()",
    "percent_rank()",
    "cume_dist()",
    "ntile(2)",
    "lag(id)",
    "lead(id)",
    "first_value(id)",
    "last_value(id)",
    "nth_value(id,2)",
    "sum(id)",
  ]) {
    const source = `SELECT ${call} OVER () FROM students`;
    const name = call.slice(0, call.indexOf("("));
    expect(prepareQuery(source).bind(schema)).toBe(
      source
        .replace(name, `"pg_catalog"."${name}"`)
        .replace("FROM students", `FROM ${qualified}students`),
    );
  }
  const bound = prepareQuery(
    "WITH s AS (SELECT id FROM students) SELECT count(*) OVER (PARTITION BY (SELECT id FROM courses LIMIT 1) ORDER BY id DESC) FROM s /* frame remains default */",
  ).bind(schema);
  expect(bound).toContain(`FROM ${qualified}students`);
  expect(bound).toContain(`FROM ${qualified}courses`);
  expect(bound).toContain("FROM s /* frame remains default */");
});

test("row locks flag trusted prepared queries including nested and CTE locks", () => {
  for (const strength of ["UPDATE", "NO KEY UPDATE", "SHARE", "KEY SHARE"]) {
    for (const wait of ["", " NOWAIT", " SKIP LOCKED"]) {
      const source = `SELECT id FROM students FOR ${strength}${wait}`;
      const query = prepareQuery(source);
      expect(query.requiresTransaction).toBe(true);
      expect(query.bind(schema)).toBe(
        source.replace("FROM students", `FROM ${qualified}students`),
      );
    }
  }
  expect(
    prepareQuery(
      "WITH locked AS (SELECT id FROM students FOR UPDATE) SELECT * FROM locked",
    ).requiresTransaction,
  ).toBe(true);
  expect(
    prepareQuery("SELECT s.id FROM (SELECT * FROM students FOR SHARE) s")
      .requiresTransaction,
  ).toBe(true);
  expect(
    prepareQuery("SELECT 'FOR UPDATE' FROM students /* FOR SHARE */")
      .requiresTransaction,
  ).toBe(false);
});

test("migration drops qualify each target and preserve restrict/comments/quotes", () => {
  for (const kind of ["TABLE", "INDEX"]) {
    const source = `DROP ${kind} IF EXISTS "Students", /* ' */ courses RESTRICT;`;
    expect(prepareMigration(source).bind(schema)).toEqual([
      source
        .replace('"Students"', `${qualified}"Students"`)
        .replace("courses", `${qualified}courses`),
    ]);
    expect(prepareMigration(`DROP ${kind} students`).bind(schema)).toEqual([
      `DROP ${kind} ${qualified}students`,
    ]);
  }
});

test("migration alterations validate and qualify relations and builtin expressions", () => {
  for (const change of [
    "ADD COLUMN email text",
    "DROP COLUMN IF EXISTS email RESTRICT",
    "RENAME COLUMN email TO contact_email",
    "RENAME TO pupils",
    "RENAME CONSTRAINT old TO renamed",
    "ALTER COLUMN name SET DEFAULT lower('UNKNOWN')",
    "ALTER COLUMN name DROP DEFAULT",
    "ALTER COLUMN name SET NOT NULL",
    "ALTER COLUMN name DROP NOT NULL",
    "ALTER COLUMN id TYPE bigint",
    "ADD CONSTRAINT positive CHECK (id > 0)",
    "ADD CONSTRAINT unique_id UNIQUE (id)",
    "ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES courses(id)",
    "DROP CONSTRAINT IF EXISTS fk RESTRICT",
  ]) {
    const bound = prepareMigration(`ALTER TABLE students ${change}`).bind(
      schema,
    )[0];
    expect(bound).toContain(`ALTER TABLE ${qualified}students`);
    if (change.includes("REFERENCES"))
      expect(bound).toContain(`REFERENCES ${qualified}courses`);
    if (change.includes("bigint"))
      expect(bound).toContain('TYPE "pg_catalog"."int8"');
    if (change.includes("lower"))
      expect(bound).toContain('"pg_catalog"."lower"');
  }
  expect(
    prepareMigration(
      'ALTER INDEX IF EXISTS "old--idx" RENAME TO "new--idx"',
    ).bind(schema),
  ).toEqual([
    `ALTER INDEX IF EXISTS ${qualified}"old--idx" RENAME TO "new--idx"`,
  ]);
  expect(
    prepareMigration(
      "ALTER TABLE students ADD COLUMN email text; ALTER TABLE students RENAME COLUMN email TO contact_email;",
    ).bind(schema),
  ).toEqual([
    `ALTER TABLE ${qualified}students ADD COLUMN email "pg_catalog"."text"; `,
    `ALTER TABLE ${qualified}students RENAME COLUMN email TO contact_email;`,
  ]);
});

test("expanded grammar rejects schema escapes and parser-unsupported semantics", () => {
  for (const source of [
    "INSERT INTO public.students VALUES (1) ON CONFLICT DO NOTHING",
    "INSERT INTO students VALUES (1) ON CONFLICT ON CONSTRAINT public.pk DO NOTHING",
    "INSERT INTO students VALUES (1) ON CONFLICT (evil(id)) DO NOTHING",
    "INSERT INTO students VALUES (1) ON CONFLICT (id) DO UPDATE SET id=(SELECT id FROM public.students)",
    "INSERT INTO students VALUES (1) ON CONFLICT (id) DO UPDATE SET id=excluded.id WHERE evil()",
    "INSERT INTO students VALUES (1) ON CONFLICT (id) WHERE id>0 DO NOTHING",
    "SELECT row_number() OVER w FROM students WINDOW w AS (ORDER BY id)",
    "SELECT row_number() OVER (ORDER BY evil()) FROM students",
    "SELECT row_number() OVER (PARTITION BY (SELECT id FROM public.students)) FROM students",
    "SELECT * FROM students FOR UPDATE OF students",
  ])
    expect(() => prepareQuery(source), source).toThrow(/SQL_UNSUPPORTED/);
  for (const source of [
    "DROP TABLE students CASCADE",
    "DROP INDEX students_idx CASCADE",
    "CREATE INDEX x ON students USING custom_am (name)",
    "CREATE TYPE public.mood AS ENUM ('a')",
    "CREATE TYPE text AS ENUM ('a')",
    "CREATE TABLE x (m mood)",
    "UPDATE students SET name = evil(name)",
    "DELETE FROM public.students",
    "DROP TABLE public.students",
    "DROP INDEX a,public.b",
    "ALTER TABLE students DROP COLUMN name CASCADE",
    "ALTER TABLE students DROP CONSTRAINT fk CASCADE",
    "ALTER TABLE students ALTER COLUMN id TYPE public.custom_type",
    "ALTER TABLE students ALTER COLUMN id TYPE bigint USING evil(id)",
    "ALTER TABLE students ALTER COLUMN id TYPE bigint USING (SELECT id FROM public.students)",
    "ALTER TABLE students ALTER COLUMN id SET DEFAULT evil()",
    "ALTER TABLE students ADD CONSTRAINT fk FOREIGN KEY (id) REFERENCES public.students(id)",
    "ALTER TABLE students SET SCHEMA public",
    "ALTER INDEX old RENAME TO public.new",
    "ALTER INDEX old SET TABLESPACE other",
  ])
    expect(() => prepareMigration(source), source).toThrow(/SQL_UNSUPPORTED/);
  expect(() => prepareQuery("DROP TABLE students")).toThrow(/SQL_UNSUPPORTED/);
  expect(() => prepareMigration("SELECT id FROM students FOR UPDATE")).toThrow(
    /SQL_UNSUPPORTED/,
  );
});
