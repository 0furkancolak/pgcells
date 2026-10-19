import { expect, test } from "bun:test";
import { camelCase } from "../../core/sql/casing";
import { generate } from "../../core/sql/codegen";
import { prepareQuery } from "../../core/sql/compiler";

const schema = `tenant_${"a".repeat(32)}`;
// Shape of the migration fold: table → columns.
const tables = new Map(
  Object.entries({
    students: ["id", "first_name", "last_name", "created_at"],
    courses: ["id", "title"],
    enrollments: ["student_id", "course_id"],
  }).map(([table, columns]) => [table, columns.map((name) => ({ name }))]),
);
/** Compiled SQL with the schema qualifier stripped for readability. */
const compiled = (source: string) => prepareQuery(source, "tenant", tables).bind(schema).replaceAll(`"${schema}".`, "");
const rejects = (source: string, message: RegExp = /SQL_UNSUPPORTED/) => expect(() => compiled(source), source).toThrow(message);

test("camelCase joins lowercase snake segments and leaves other names alone", () => {
  expect(["first_name", "a_1", "id", "emailVerified", "Some_Col", "a__b", "_x"].map(camelCase)).toEqual(["firstName", "a1", "id", "emailVerified", "Some_Col", "a__b", "_x"]);
});

test("qualified and unqualified column refs get camelCase aliases; single words and camelCase names stay unchanged", () => {
  expect(compiled("SELECT first_name, s.last_name, id FROM students s")).toBe(`SELECT first_name AS "firstName", s.last_name AS "lastName", id FROM students s`);
  for (const source of [
    "SELECT id, title FROM courses ORDER BY courses.id LIMIT $1",
    `SELECT student_id AS "studentId", course_id AS "courseId" FROM enrollments`,
    `SELECT "emailVerified", name FROM "user"`,
    "SELECT * FROM courses",
  ])
    expect(compiled(source)).toBe(source);
});

test("explicit unquoted snake aliases become quoted camelCase; quoted aliases are kept verbatim", () => {
  expect(compiled("SELECT first_name AS given_name, last_name family_name, id AS Key FROM students")).toBe(
    `SELECT first_name AS "givenName", last_name "familyName", id AS Key FROM students`,
  );
  expect(compiled("SELECT first_name /* comment */ given_name FROM students")).toBe(`SELECT first_name /* comment */ "givenName" FROM students`);
  const quoted = `SELECT first_name AS "first_name", last_name "Last_Name" FROM students`;
  expect(compiled(quoted)).toBe(quoted);
});

test("expressions keep PostgreSQL's default name; casts and parentheses around a column still get the column alias", () => {
  expect(compiled("SELECT count(*), lower(first_name), created_at::text, (last_name)::varchar(10), ((id)) FROM students")).toBe(
    `SELECT "pg_catalog"."count"(*), "pg_catalog"."lower"(first_name), created_at::"pg_catalog"."text" AS "createdAt", (last_name)::"pg_catalog"."varchar"(10) AS "lastName", ((id)) FROM students`,
  );
  expect(compiled("SELECT (first_name) FROM students")).toBe(`SELECT (first_name) AS "firstName" FROM students`);
});

test("* and t.* over migration tables expand to aliased columns only when a name changes", () => {
  expect(compiled("SELECT * FROM students")).toBe(
    `SELECT "students"."id", "students"."first_name" AS "firstName", "students"."last_name" AS "lastName", "students"."created_at" AS "createdAt" FROM students`,
  );
  expect(compiled("SELECT c.title, s.* FROM courses c JOIN students s ON true")).toBe(
    `SELECT c.title, "s"."id", "s"."first_name" AS "firstName", "s"."last_name" AS "lastName", "s"."created_at" AS "createdAt" FROM courses c JOIN students s ON true`,
  );
  expect(compiled("SELECT e.*, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id")).toBe(
    `SELECT "e"."student_id" AS "studentId", "e"."course_id" AS "courseId", c.title FROM enrollments e JOIN courses c ON c.id = e.course_id`,
  );
});

test("* over CTEs and subqueries expands from their explicit projections; unknown columns reject", () => {
  expect(compiled("WITH x AS (SELECT first_name, count(*) AS n FROM students GROUP BY first_name) SELECT * FROM x")).toBe(
    `WITH x AS (SELECT first_name, "pg_catalog"."count"(*) AS n FROM students GROUP BY first_name) SELECT "x"."first_name" AS "firstName", "x"."n" FROM x`,
  );
  expect(compiled("SELECT * FROM (SELECT first_name, last_name FROM students) sub(given_name)")).toBe(
    `SELECT "sub"."given_name" AS "givenName", "sub"."last_name" AS "lastName" FROM (SELECT first_name, last_name FROM students) sub(given_name)`,
  );
  for (const source of [
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "SELECT * FROM missing",
    "SELECT * FROM students JOIN enrollments USING (id)",
    "SELECT q.* FROM students",
  ])
    rejects(source, /list the columns explicitly/);
  // Without a table list the compiler cannot know the real table's columns.
  expect(() => prepareQuery("SELECT * FROM courses")).toThrow(/list the columns explicitly/);
  expect(prepareQuery("SELECT id, title FROM courses").bind(schema)).toBe(`SELECT id, title FROM "${schema}".courses`);
});

test("RETURNING of INSERT, UPDATE and DELETE is aliased; ON CONFLICT and excluded stay untouched", () => {
  expect(
    compiled("INSERT INTO students (id, first_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET first_name = excluded.first_name RETURNING id, first_name"),
  ).toBe(`INSERT INTO students (id, first_name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET first_name = excluded.first_name RETURNING id, first_name AS "firstName"`);
  expect(compiled("UPDATE students SET last_name = $1 WHERE id = $2 RETURNING *")).toBe(
    `UPDATE students SET last_name = $1 WHERE id = $2 RETURNING "students"."id", "students"."first_name" AS "firstName", "students"."last_name" AS "lastName", "students"."created_at" AS "createdAt"`,
  );
  expect(compiled("DELETE FROM students WHERE id = $1 RETURNING created_at AS deleted_at;")).toBe(`DELETE FROM students WHERE id = $1 RETURNING created_at AS "deletedAt";`);
});

test("only the statement after WITH is aliased; CTE projections and data-modifying CTEs stay untouched", () => {
  expect(compiled("WITH recent AS (SELECT id, first_name, created_at AS created_on FROM students) SELECT r.first_name, created_on FROM recent r")).toBe(
    `WITH recent AS (SELECT id, first_name, created_at AS created_on FROM students) SELECT r.first_name AS "firstName", created_on AS "createdOn" FROM recent r`,
  );
  expect(compiled("WITH gone AS (DELETE FROM enrollments WHERE course_id = $1 RETURNING student_id) SELECT student_id FROM gone")).toBe(
    `WITH gone AS (DELETE FROM enrollments WHERE course_id = $1 RETURNING student_id) SELECT student_id AS "studentId" FROM gone`,
  );
});

test("UNION takes names from its first branch; the trailing ORDER BY follows the new names", () => {
  expect(compiled("SELECT first_name FROM students UNION SELECT title FROM courses ORDER BY first_name")).toBe(
    `SELECT first_name AS "firstName" FROM students UNION SELECT title FROM courses ORDER BY "firstName"`,
  );
  expect(compiled("(SELECT first_name FROM students) UNION ALL (SELECT title FROM courses ORDER BY title)")).toBe(
    `(SELECT first_name AS "firstName" FROM students) UNION ALL (SELECT title FROM courses ORDER BY title)`,
  );
});

test("ORDER BY and DISTINCT ON follow renamed outputs; GROUP BY on a renamed alias rejects", () => {
  expect(compiled("SELECT DISTINCT ON (first_name) first_name, created_at AS created_on FROM students ORDER BY first_name, created_on, students.id")).toBe(
    `SELECT DISTINCT ON ("firstName") first_name AS "firstName", created_at AS "createdOn" FROM students ORDER BY "firstName", "createdOn", students.id`,
  );
  expect(compiled("SELECT first_name, count(*) FROM students GROUP BY first_name")).toBe(
    `SELECT first_name AS "firstName", "pg_catalog"."count"(*) FROM students GROUP BY first_name`,
  );
  rejects("SELECT date_trunc('day', created_at) AS day_start, count(*) FROM students GROUP BY day_start", /GROUP BY day_start/);
  expect(compiled("SELECT date_trunc('day', created_at) AS day_start FROM students GROUP BY 1")).toBe(
    `SELECT "pg_catalog"."date_trunc"('day', created_at) AS "dayStart" FROM students GROUP BY 1`,
  );
});

test("INSERT ... SELECT and projection subqueries keep their inner projections", () => {
  const insertSelect = "INSERT INTO enrollments (student_id, course_id) SELECT student_id, $1 FROM enrollments WHERE course_id = $2";
  expect(compiled(insertSelect)).toBe(insertSelect);
  expect(
    compiled("SELECT s.first_name, (SELECT count(*) FROM enrollments e WHERE e.student_id = s.id) AS course_count, (SELECT e.course_id FROM enrollments e LIMIT 1) FROM students s"),
  ).toBe(
    `SELECT s.first_name AS "firstName", (SELECT "pg_catalog"."count"(*) FROM enrollments e WHERE e.student_id = s.id) AS "courseCount", (SELECT e.course_id FROM enrollments e LIMIT 1) FROM students s`,
  );
});

test("duplicate output names after camelCase reject", () => {
  for (const source of [
    `SELECT first_name, "firstName" FROM students`,
    "SELECT s.id, c.id FROM students s JOIN courses c ON true",
    "SELECT first_name AS a, last_name AS a FROM students",
    "SELECT *, first_name FROM students",
  ])
    rejects(source, /duplicate output column name/);
});

test("codegen compiles queries with the scope's migration tables", () => {
  const module = generate([["src/queries/tenant/q.sql", "-- name: listQ\nSELECT * FROM enrollments"]], new Map([["tenant", tables]]));
  expect(module.get("src/queries/tenant/q.gen.ts")).toContain(String.raw`\"enrollments\".\"student_id\" AS \"studentId\"`);
  expect(() => generate([["src/queries/tenant/q.sql", "-- name: listQ\nSELECT * FROM enrollments"]])).toThrow(/listQ: SQL_UNSUPPORTED/);
});
