/** Better Auth end to end: the package's `auth` migration → `createAuth` → real PostgreSQL; the CI drift check uses the same options object. */
import { expect } from "bun:test";
import { betterAuth } from "better-auth";
import authOptions from "../fixtures/auth-options";
import { migrations, seeds } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";
import migrationList from "../../migrations/index.gen";
import { createRunner } from "../../core/migrations/runner";
import { createAuth } from "../../core/auth";
import { createDb } from "../../core/runtime";
import { generateAuthMigration } from "../../core/tools/auth";
import { createTestManagement, directConfig, driver, dropSchema, integration, q, raw, testSchema } from "./helpers";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const SECRET = "integration-secret-integration-secret-1";

async function withAuthSchema(work: (ctx: { schema: string; admin: ReturnType<typeof raw>; m: ReturnType<typeof createTestManagement> }) => Promise<void>) {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema });
  try {
    await createRunner({ migrations, seeds }).migrate(m);
    await work({ schema, admin, m });
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
  }
}

integration("sign up, sign in and a wrong password work against the shipped tables in the configured schema", async () => {
  await withAuthSchema(async ({ schema, admin }) => {
    const db = createDb(directConfig(), { driver, schema, pooler: "assumed" });
    try {
      const auth = createAuth(db, ({ options }) => betterAuth({ ...options, ...authOptions, baseURL: "http://localhost:3000" }), { secret: SECRET, baseURL: "http://localhost:3000" })();
      const email = `${crypto.randomUUID()}@example.com`;
      const signedUp = await auth.api.signUpEmail({ body: { email, password: "correct horse battery", name: "Ada" } });
      expect(signedUp.user.email).toBe(email);
      expect(await admin.query(`SELECT email FROM ${q(schema, "users")}`)).toEqual([{ email }]);
      expect(await admin.query(`SELECT provider_id FROM ${q(schema, "account")}`)).toEqual([{ provider_id: "credential" }]);
      const signedIn = await auth.api.signInEmail({ body: { email, password: "correct horse battery" } });
      expect(signedIn.user.id).toBe(signedUp.user.id);
      await expect(auth.api.signInEmail({ body: { email, password: "wrong password!!" } })).rejects.toBeDefined();
      // Sign-up opens a session automatically and sign-in opens the second: two sessions.
      expect((await admin.query(`SELECT count(*)::integer AS n FROM ${q(schema, "session")}`))[0]).toEqual({ n: 2 });
    } finally {
      await db.close();
    }
  });
});

integration("generateAuthMigration finds no difference between the shipped tables and Better Auth's own schema, and writes a migration for a new field", async () => {
  await withAuthSchema(async ({ m }) => {
    const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-auth-"));
    try {
      expect(await generateAuthMigration({ db: m, options: authOptions, root })).toEqual({ created: false });
      const extended = { ...authOptions, user: { ...authOptions.user, additionalFields: { nickname: { type: "string" as const, required: false } } } };
      const result = await generateAuthMigration({ db: m, options: extended, root, now: new Date(Date.UTC(2026, 9, 4, 1, 2, 3)) });
      expect(result).toMatchObject({ created: true, id: "20261004010203_better_auth" });
      const text = await Bun.file(join(root, (result as { path: string }).path)).text();
      expect(text).toContain("--up");
      expect(text).toContain("nickname");
      expect(text).toContain("--down");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

integration("generateAuthMigration replays a CREATE INDEX CONCURRENTLY migration outside a transaction and still drops its temporary schema", async () => {
  await withAuthSchema(async ({ admin, m }) => {
    const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-auth-"));
    try {
      const concurrent = [...migrationList.map(([id, source]) => [id, source] as const), ["20991231000000_users_name_index", "--up\nCREATE INDEX CONCURRENTLY users_name_idx ON users (name);\n--down\nDROP INDEX CONCURRENTLY users_name_idx;\n"] as const];
      expect(await generateAuthMigration({ db: m, options: authOptions, root, registry: { migrations: compileMigrations(concurrent), seeds } })).toEqual({ created: false });
      expect(await admin.query("SELECT 1 FROM pg_namespace WHERE nspname LIKE 'auth_generate_%'")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

integration("generateAuthMigration notices a dropped unique constraint or index in the shipped tables", async () => {
  await withAuthSchema(async ({ m }) => {
    const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-auth-"));
    try {
      const shipped = migrationList.map(([id, source]) => [id, source] as const);
      const without = (line: RegExp) => ({ migrations: compileMigrations(shipped.map(([id, source]) => [id, source.replace(line, "")] as const)), seeds });
      const unique = await generateAuthMigration({ db: m, options: authOptions, root, now: new Date(Date.UTC(2026, 9, 5)), registry: without(/,\n {2}CONSTRAINT users_email_unique UNIQUE \(email\)/) });
      expect(unique).toMatchObject({ created: true });
      expect(await Bun.file(join(root, (unique as { path: string }).path)).text()).toContain('create unique index "users_email_uidx"');
      const index = await generateAuthMigration({ db: m, options: authOptions, root, now: new Date(Date.UTC(2026, 9, 6)), registry: without(/CREATE INDEX session_user_id_idx[^\n]*\n/) });
      expect(await Bun.file(join(root, (index as { path: string }).path)).text()).toContain('create index "session_user_id_idx"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

integration("a plugin table added to the options generates a migration that applies, with uuid ids made by the database", async () => {
  await withAuthSchema(async ({ schema, admin, m }) => {
    const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-auth-"));
    try {
      const widget = {
        id: "widget",
        schema: { widget: { fields: { label: { type: "string" as const }, userId: { type: "string" as const, references: { model: "user", field: "id" }, index: true } } } },
      };
      const options = { ...authOptions, plugins: [...authOptions.plugins, widget] };
      const result = await generateAuthMigration({ db: m, options, root, now: new Date(Date.UTC(2026, 9, 6)) });
      expect(result).toMatchObject({ created: true });
      const source = await Bun.file(join(root, (result as { path: string }).path)).text();
      const extended = compileMigrations([...migrationList.map(([id, text]) => [id, text] as const), [(result as { id: string }).id, source]]);
      await createRunner({ migrations: extended, seeds }).migrate(m);
      const [column] = await admin.query<{ data_type: string; column_default: string }>(
        `SELECT data_type, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'widget' AND column_name = 'id'`,
        [schema],
      );
      expect(column?.data_type).toBe("uuid");
      expect(column?.column_default).toContain("gen_random_uuid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
