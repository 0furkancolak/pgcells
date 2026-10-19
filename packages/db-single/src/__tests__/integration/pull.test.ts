/** `pull`: live schema → initial migration → same structure in another schema; a different structure gives a different digest; unsupported objects; applied via baseline. */
import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { compileMigrations } from "../../core/migrations/source";
import { createRunner } from "../../core/migrations/runner";
import { pullSchema, pullStructure } from "../../core/tools/pull";
import { createTestManagement, dropSchema, failure, integration, packageCopy, q, raw, testSchema } from "./helpers";

/** A schema of a legacy application: enum, identity, foreign key, CHECK, partial expression index and the Drizzle ledger. */
const legacySchema = (schema: string) => `CREATE SCHEMA ${q(schema)};
CREATE TYPE ${q(schema, "task_status")} AS ENUM ('TODO', 'DONE');
CREATE TABLE ${q(schema, "users")} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(255) NOT NULL, created_at timestamp(3) with time zone DEFAULT now() NOT NULL, tags text[] DEFAULT '{}'::text[]);
CREATE TABLE ${q(schema, "tasks")} (number integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES ${q(schema, "users")}(id) ON DELETE CASCADE,
  status ${q(schema, "task_status")} DEFAULT 'TODO' NOT NULL, title varchar(80), CONSTRAINT title_check CHECK (title::varchar(20) <> ''), CONSTRAINT code_check CHECK (title::character(3) <> 'abc'));
CREATE UNIQUE INDEX users_email_lower ON ${q(schema, "users")} (lower(email)) WHERE created_at IS NOT NULL;
CREATE TABLE ${q(schema, "drizzle_migrations")} (id serial PRIMARY KEY, hash text)`;

integration("pull writes an initial migration that rebuilds the same structure in another schema, and baseline marks the source applied", async () => {
  const admin = raw();
  const m = createTestManagement();
  const [source, copy, drifted] = [testSchema(), testSchema(), testSchema()];
  const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-pull-"));
  try {
    await admin.exec(legacySchema(source));
    await mkdir(join(root, "src/migrations"), { recursive: true });
    const result = await pullSchema(m, source, { root, now: new Date(Date.UTC(2026, 8, 15, 18, 4, 27)) });
    expect(result).toMatchObject({ id: "20260915180427_init", schema: source, enums: 1, tables: 2, exclude: ["_migrations", "_seeds", "drizzle_migrations"] });
    expect(result.path).toBe("src/migrations/20260915180427_init.sql");
    const text = await Bun.file(join(root, result.path)).text();
    // Only the header names the source; the SQL is schema-free.
    expect(text.split("\n").slice(2).join("\n")).not.toContain(source);
    expect(text).toContain("bpchar(3)");
    const [migration] = compileMigrations([[result.id, text]]);
    expect(migration?.down).toBeUndefined();

    await admin.exec(`CREATE SCHEMA ${q(copy)}`);
    await admin.transaction(async (tx) => {
      for (const statement of migration?.up.bind(copy) ?? []) await tx.exec(statement);
    });
    expect((await pullStructure(admin, copy)).structure).toBe(result.structure);
    await admin.exec(`INSERT INTO ${q(copy, "users")} (email) VALUES ('a@example.com'); INSERT INTO ${q(copy, "tasks")} (user_id) SELECT id FROM ${q(copy, "users")}`);

    // The same legacy schema with one index missing has a different structure (digest).
    await admin.exec(`${legacySchema(drifted)}; DROP INDEX ${q(drifted, "users_email_lower")}`);
    expect((await pullStructure(admin, drifted)).structure).not.toBe(result.structure);

    // No migration runs in the source schema; it is marked as applied (CLI flow: pull → codegen → baseline).
    const runner = createRunner({ migrations: compileMigrations([[result.id, text]]), seeds: [] });
    const target = createTestManagement({ schema: source });
    try {
      expect(await runner.baseline(target, result.id)).toEqual({ migrations: [result.id] });
      expect(await runner.migrate(target)).toEqual({ dryRun: false, migrations: [] });
    } finally {
      await target.close();
    }
  } finally {
    for (const schema of [source, copy, drifted]) await dropSchema(admin, schema);
    await admin.close();
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});

integration("pull --exclude takes any table name, mixed case and hyphen included", async () => {
  const admin = raw();
  const schema = testSchema();
  try {
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "notes")} (id integer PRIMARY KEY); CREATE TABLE ${q(schema, "Legacy-Log")} (id integer PRIMARY KEY)`);
    expect((await pullStructure(admin, schema)).sql).toContain("Legacy-Log");
    const pulled = await pullStructure(admin, schema, ["Legacy-Log"]);
    expect(pulled.sql).toContain('"notes"');
    expect(pulled.sql).not.toContain("Legacy-Log");
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
  }
});

integration("pull refuses objects an initial migration cannot express, names them, and does not write a file", async () => {
  const admin = raw();
  const m = createTestManagement();
  const schema = testSchema();
  const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-pull-"));
  try {
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "t")} (id integer PRIMARY KEY); CREATE VIEW ${q(schema, "v")} AS SELECT id FROM ${q(schema, "t")}`);
    await mkdir(join(root, "src/migrations"), { recursive: true });
    const error = (await pullSchema(m, schema, { root }).catch((e: unknown) => e)) as { code: string; message: string };
    expect(error.code).toBe("PULL_UNSUPPORTED");
    expect(error.message).toContain("view v");
    expect(await Array.fromAsync(new Bun.Glob("src/migrations/*.sql").scan(root))).toEqual([]);
    expect(await failure(pullSchema(m, "information_schema", { root }))).toBe("USAGE");
    expect(await failure(pullSchema(m, "Bad-Name", { root }))).toBe("USAGE");
    expect(await failure(pullSchema(m, testSchema(), { root }))).toBe("SOURCE_SCHEMA_MISSING");
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});

integration("objects an extension owns in the schema (functions, types, tables) and label-less enums are neither refused nor pulled", async () => {
  const admin = raw();
  const schema = testSchema();
  try {
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE EXTENSION pgcrypto SCHEMA ${q(schema)};
      CREATE TYPE ${q(schema, "ext_kind")} AS ENUM ('x'); CREATE DOMAIN ${q(schema, "ext_positive")} AS integer CHECK (VALUE > 0);
      CREATE TABLE ${q(schema, "ext_table")} (id integer PRIMARY KEY);
      ALTER EXTENSION pgcrypto ADD TYPE ${q(schema, "ext_kind")}; ALTER EXTENSION pgcrypto ADD DOMAIN ${q(schema, "ext_positive")}; ALTER EXTENSION pgcrypto ADD TABLE ${q(schema, "ext_table")};
      CREATE TABLE ${q(schema, "notes")} (id integer PRIMARY KEY); CREATE TYPE ${q(schema, "no_labels")} AS ENUM ()`);
    const pulled = await pullStructure(admin, schema);
    expect(pulled.counts).toEqual({ enums: 0, tables: 1, constraints: 1, indexes: 0 });
    expect(pulled.sql).toContain('"notes"');
    // A label-less enum is not written either (legacy pull behavior).
    expect(pulled.sql).not.toMatch(/ext_|gen_random_bytes|no_labels/);
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
  }
});

integration("pull through the CLI prints next steps whose baseline targets the source schema, and they work as printed", async () => {
  const copy = await packageCopy("pull-cli");
  const admin = raw();
  const schema = testSchema();
  try {
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "notes")} (id integer PRIMARY KEY)`);
    const pulled = (await copy.cli("pull", schema)) as { id: string; next: string };
    expect(pulled.next).toContain(`bun run cli migration baseline ${pulled.id} --schema ${schema}`);
    // The suggested command is run exactly as printed: codegen, then baseline (in the source schema, not in public).
    await copy.codegen();
    const printed = /bun run cli (migration baseline [^)]+)\)/.exec(pulled.next)?.[1] ?? "";
    expect(await copy.cli(...printed.split(" "))).toEqual({ migrations: [pulled.id] });
    expect(await copy.cli("migrate", "--schema", schema)).toEqual({ dryRun: false, migrations: [] });
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await copy.remove();
  }
});
