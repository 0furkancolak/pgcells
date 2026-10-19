/** `pull`: canlı schema → başlangıç migration'ı → tenant schema'sında aynı yapı; farklı schema farklı özet; desteklenmeyen nesneler. */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { bootstrap, type Management } from "../../management";
import { compileMigrations } from "../../core/migrations/source";
import { pullSchema, pullStructure } from "../../core/tools/pull";
import { createTestManagement, enabled, integration, q } from "./helpers";

let app: Management;
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
beforeAll(async () => {
  if (enabled) {
    app = createTestManagement();
    await bootstrap(app);
  }
});
afterAll(async () => {
  if (app) await app.close();
});

/** Eski uygulamanın bir tenant schema'sı: enum, identity, yabancı anahtar, CHECK, kısmi ifade index'i ve Drizzle ledger'ı. */
const legacySchema = (schema: string) => `CREATE SCHEMA ${q(schema)};
CREATE TYPE ${q(schema, "task_status")} AS ENUM ('TODO', 'DONE');
CREATE TABLE ${q(schema, "users")} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(255) NOT NULL, created_at timestamp(3) with time zone DEFAULT now() NOT NULL, tags text[] DEFAULT '{}'::text[]);
CREATE TABLE ${q(schema, "tasks")} (number integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES ${q(schema, "users")}(id) ON DELETE CASCADE,
  status ${q(schema, "task_status")} DEFAULT 'TODO' NOT NULL, title varchar(80), CONSTRAINT title_check CHECK (title::varchar(20) <> ''));
CREATE UNIQUE INDEX users_email_lower ON ${q(schema, "users")} (lower(email)) WHERE created_at IS NOT NULL;
CREATE TABLE ${q(schema, "drizzle_migrations")} (id serial PRIMARY KEY, hash text)`;

integration("pull writes an initial migration that rebuilds the same structure in a tenant schema", async () => {
  const db = app.pools.node("db0");
  const [source, copy, drifted] = [`pull_source_${suffix}`, `tenant_pull_${suffix}`, `pull_drifted_${suffix}`];
  const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-pull-"));
  try {
    await db.exec(legacySchema(source));
    await mkdir(join(root, "src/migrations/tenant"), { recursive: true });
    const result = await pullSchema(app, source, { root, now: new Date(Date.UTC(2026, 8, 15, 18, 4, 27)) });
    expect(result).toMatchObject({ id: "20260915180427_init", schema: source, databaseId: "db0", enums: 1, tables: 2, exclude: ["_migrations", "_seeds", "drizzle_migrations"] });
    const text = await Bun.file(join(root, result.path)).text();
    // Only the header names the source; the SQL is schema-less.
    expect(text.split("\n").slice(3).join("\n")).not.toContain(source);
    const [migration] = compileMigrations("tenant", [[result.id, text]]);
    expect(migration?.pulled?.structure).toBe(result.structure);
    expect(migration?.down).toBeUndefined();

    await db.exec(`CREATE SCHEMA ${q(copy)}`);
    await db.transaction(async (tx) => {
      for (const statement of migration?.up.bind(copy) ?? []) await tx.exec(statement);
    });
    expect((await pullStructure(db, copy)).structure).toBe(result.structure);
    await db.exec(`INSERT INTO ${q(copy, "users")} (email) VALUES ('a@example.com'); INSERT INTO ${q(copy, "tasks")} (user_id) SELECT id FROM ${q(copy, "users")}`);

    // The same legacy schema without one index has another structure: adopt reports SCHEMA_DRIFT for it.
    await db.exec(`${legacySchema(drifted)}; DROP INDEX ${q(drifted, "users_email_lower")}`);
    expect((await pullStructure(db, drifted)).structure).not.toBe(result.structure);
  } finally {
    for (const schema of [source, copy, drifted]) await db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await rm(root, { recursive: true, force: true });
  }
});

integration("pull lists every object an initial migration cannot express and refuses", async () => {
  const db = app.pools.node("db0");
  const schema = `pull_unsupported_${suffix}`;
  try {
    await db.exec(
      `CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "items")} (id integer); CREATE VIEW ${q(schema, "report")} AS SELECT id FROM ${q(schema, "items")}; CREATE SEQUENCE ${q(schema, "loose_seq")}`,
    );
    const error = await pullStructure(db, schema).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PULL_UNSUPPORTED" });
    expect((error as Error).message).toContain("sequence loose_seq");
    expect((error as Error).message).toContain("view report");
  } finally {
    await db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
  }
  await expect(pullStructure(db, `pull_missing_${suffix}`)).rejects.toMatchObject({ code: "SOURCE_SCHEMA_MISSING" });
  await expect(pullStructure(db, "platform")).rejects.toMatchObject({ code: "USAGE" });
});
