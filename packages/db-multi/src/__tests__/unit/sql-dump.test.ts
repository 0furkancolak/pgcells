/** SQL yedeği ayrıştırma: pg_dump COPY/INSERT, mysqldump, tip dönüşümü, parçalama ve aktarım iskeleti (DB'siz). */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { jsonLinesSource } from "../../core/tools/import-users";
import { type DumpState, readSqlDump, scaffoldAppMigration, splitSqlDump } from "../../core/tools/sql-dump";

const dirs: string[] = [];
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "sql-dump-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const PG_DUMP = `--
-- PostgreSQL database dump
--
SET standard_conforming_strings = on;
CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated := now(); RETURN NEW; END; $$;

CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    full_name text,
    password character varying(100),
    is_active boolean DEFAULT true,
    settings jsonb,
    balance numeric(12,2),
    created_at timestamp without time zone DEFAULT now()
);

CREATE TABLE public."Lessons" (
    id bigint NOT NULL,
    user_id integer REFERENCES public.users(id),
    title text NOT NULL,
    CONSTRAINT lessons_title CHECK ((length(title) > 0))
);

COPY public.users (id, email, full_name, password, is_active, settings, balance, created_at) FROM stdin;
1	Ada@Example.com	Ada Lovelace	$2b$10$abc	t	{"theme": "dark"}	10.50	2020-01-02 03:04:05
2	grace@example.com	\\N	\\N	f	\\N	\\N	2021-05-06 07:08:09
3	tab@example.com	Tab\\tName; with\\nnewline \\\\ slash	\\N	t	\\N	0	2022-01-01 00:00:00
\\.

INSERT INTO public."Lessons" (id, user_id, title) VALUES (9007199254740993, 1, 'It''s; (tricky)'), (2, NULL, E'line\\nbreak');
INSERT INTO public."Lessons" VALUES (3, 2, 'multi
line'::text);
ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
`;

const MYSQL_DUMP = `-- MySQL dump 10.13  Distrib 8.0.36
/*!40101 SET NAMES utf8mb4 */;
CREATE TABLE \`members\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`e_mail\` varchar(191) CHARACTER SET utf8mb4 NOT NULL,
  \`name\` varchar(100) DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx_mail\` (\`e_mail\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO \`members\` VALUES (1,'o\\'neil@example.com','O\\'Neil'),(2,'x@example.com',NULL);
`;

test("reads pg_dump COPY and INSERT rows with escapes, types and multi-line strings", async () => {
  const dir = await temp();
  const file = join(dir, "backup.sql.gz");
  await writeFile(file, gzipSync(PG_DUMP));
  const state: DumpState = { tables: new Map() };
  const rows = [];
  for await (const row of readSqlDump(file, state)) rows.push(row);
  expect(state.dialect).toBeUndefined();
  expect(state.tables.get("users")?.map((c) => c.type)).toEqual(["integer", "character varying(255)", "text", "character varying(100)", "boolean", "jsonb", "numeric(12,2)", "timestamp without time zone"]);
  expect(rows[0]).toEqual({
    table: "users",
    values: { id: 1, email: "Ada@Example.com", full_name: "Ada Lovelace", password: "$2b$10$abc", is_active: true, settings: { theme: "dark" }, balance: "10.50", created_at: "2020-01-02 03:04:05" },
  });
  expect(rows[1]?.values).toMatchObject({ id: 2, full_name: null, is_active: false, settings: null });
  expect(rows[2]?.values.full_name).toBe("Tab\tName; with\nnewline \\ slash");
  expect(rows.slice(3)).toEqual([
    { table: "Lessons", values: { id: "9007199254740993", user_id: 1, title: "It's; (tricky)" } },
    { table: "Lessons", values: { id: 2, user_id: null, title: "line\nbreak" } },
    { table: "Lessons", values: { id: 3, user_id: 2, title: "multi\nline" } },
  ]);
});

test("reads mysqldump backtick identifiers and backslash escapes", async () => {
  const dir = await temp();
  const file = join(dir, "backup.sql");
  await writeFile(file, MYSQL_DUMP);
  const state: DumpState = { tables: new Map() };
  const rows = [];
  for await (const row of readSqlDump(file, state)) rows.push(row);
  expect(state.dialect).toBe("mysql");
  expect(state.tables.get("members")).toEqual([
    { name: "id", type: "int" },
    { name: "e_mail", type: "varchar(191)" },
    { name: "name", type: "varchar(100)" },
  ]);
  expect(rows.map((row) => row.values)).toEqual([
    { id: 1, e_mail: "o'neil@example.com", name: "O'Neil" },
    { id: 2, e_mail: "x@example.com", name: null },
  ]);
});

test("rejects rows that do not match the column list and unterminated COPY", async () => {
  const dir = await temp();
  const bad = join(dir, "bad.sql");
  await writeFile(bad, "CREATE TABLE t (a int, b int);\nINSERT INTO t VALUES (1);\n");
  await expect((async () => { for await (const _ of readSqlDump(bad)) void _; })()).rejects.toMatchObject({ code: "DUMP_INVALID" });
  await writeFile(bad, "COPY t (a) FROM stdin;\n1\n");
  await expect((async () => { for await (const _ of readSqlDump(bad)) void _; })()).rejects.toMatchObject({ code: "DUMP_INVALID" });
});

test("splits a dump into per-table gzip JSON Lines with analysis, then scaffolds a typed app migration", async () => {
  const dir = await temp();
  const file = join(dir, "backup.sql");
  await writeFile(file, PG_DUMP);
  const out = join(dir, "work");
  const analysis = await splitSqlDump(file, out);
  expect(analysis).toMatchObject({ format: 1, source: "backup.sql", dialect: "postgres" });
  expect(analysis.tables.users).toMatchObject({ rows: 3, file: "tables/users.jsonl.gz", nulls: { full_name: 1, password: 2, settings: 2, balance: 1 } });
  expect(analysis.tables.Lessons?.rows).toBe(3);
  expect(JSON.parse(await readFile(join(out, "analysis.json"), "utf8"))).toEqual(analysis);
  const lessons = [];
  for await (const row of jsonLinesSource(join(out, "tables/Lessons.jsonl.gz"))) lessons.push(row);
  expect(lessons).toHaveLength(3);

  const code = scaffoldAppMigration(analysis, { name: "legacy2app", source: "aristo" });
  expect(code).toContain('import { defineAppMigration } from "@0furkancolak/pgcells/tools";');
  expect(code).toContain('source: "aristo"');
  expect(code).toContain('{ table: "users", users: (row) => ({ externalId: row["id"], email: row["email"], name: row["full_name"], passwordHash: row["password"], createdAt: row["created_at"] }) },');
  expect(code).toContain('// { table: "Lessons", into: "target_table", map: (row, ctx) => ({ id: ctx.uuid("Lessons", row.id)');
  expect(code).toContain("    full_name: string | null; // text");
  expect(code).toContain("    id: number | string; // bigint");
  expect(code.indexOf('table: "users"')).toBeLessThan(code.indexOf('table: "Lessons"'));
  expect(code).not.toContain("Ada");
});
