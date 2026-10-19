import { expect } from "bun:test";
import { schemaExists } from "../../core/catalog";
import { runtimeDatabaseDefaults } from "../../core/config";
import type { Database } from "../../core/database";
import { MIGRATION_KEY, openManagementSession } from "../../core/locks";
import type { Management } from "../../core/management";
import { createRunner } from "../../core/migrations/runner";
import { compileMigrations, compileSeeds } from "../../core/migrations/source";
import { prepareQuery } from "../../core/sql/compiler";
import { createTestManagement, dropSchema, failure, integration, q, raw, testSchema } from "./helpers";

const IDS: [string, string, string] = ["20260101000001_users", "20260101000002_posts", "20260101000003_posts_user_idx"];
const migrations = compileMigrations([
  [IDS[0] as string, "--up\nCREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL);\n--down\nDROP TABLE users;\n"],
  [IDS[1] as string, "--up\nCREATE TABLE posts (id integer PRIMARY KEY, user_id integer NOT NULL REFERENCES users (id));\n--down\nDROP TABLE posts;\n"],
  [IDS[2] as string, "--up\nCREATE INDEX CONCURRENTLY posts_user_idx ON posts (user_id);\n--down\nDROP INDEX CONCURRENTLY posts_user_idx;\n"],
]);
const SEED = "20260101000004_first_user";
const seeds = compileSeeds([[SEED, "INSERT INTO users (id, name) VALUES (1, 'Ada');"]]);
const runner = createRunner({ migrations, seeds });

async function withManagement(work: (m: Management, schema: string, admin: Database) => Promise<void>) {
  const schema = testSchema();
  const admin = raw();
  const m = createTestManagement({ schema });
  try {
    await work(m, schema, admin);
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
  }
}
const rows = (admin: Database, schema: string, table: string) => admin.query<{ id: string }>(`SELECT id FROM ${q(schema, table)} ORDER BY id`);
const regclass = async (admin: Database, name: string) => (await admin.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [name]))[0]?.ok;

integration("migrate creates the schema, applies pending migrations in order, and a second run applies none", async () => {
  await withManagement(async (m, schema, admin) => {
    expect(await schemaExists(admin, schema)).toBe(false);
    expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: IDS });
    expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS);
    expect(await regclass(admin, `${q(schema)}.posts`)).toBe(true);
    const [index] = await admin.query<{ valid: boolean }>("SELECT indisvalid AS valid FROM pg_catalog.pg_index WHERE indexrelid = to_regclass($1)", [`${q(schema)}.posts_user_idx`]);
    expect(index?.valid).toBe(true);
    expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: [] });
  });
});

integration("a dry run lists what would run and creates nothing", async () => {
  await withManagement(async (m, schema, admin) => {
    expect(await runner.migrate(m, { dryRun: true })).toEqual({ dryRun: true, migrations: IDS });
    expect(await schemaExists(admin, schema)).toBe(false);
  });
});

integration("status reports applied count and which pending migrations are transactional", async () => {
  await withManagement(async (m, schema) => {
    expect(await runner.migrationStatus(m)).toEqual({
      schema,
      applied: 0,
      pending: [
        { id: IDS[0], transactional: true },
        { id: IDS[1], transactional: true },
        { id: IDS[2], transactional: false },
      ],
    });
    await runner.migrate(m);
    expect((await runner.migrationStatus(m)).pending).toEqual([]);
  });
});

integration("migrate writes the runtime timeouts as database defaults", async () => {
  await withManagement(async (m, _schema, admin) => {
    await runner.migrate(m);
    const [stored] = await admin.query<{ settings: string }>(
      "SELECT pg_catalog.array_to_string(setconfig, ',') AS settings FROM pg_catalog.pg_db_role_setting WHERE setrole=0 AND setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())",
    );
    for (const setting of runtimeDatabaseDefaults(m.config)) expect(stored?.settings.split(",")).toContain(setting);
  });
});

integration("rollback undoes the newest migrations by steps or to, and refuses impossible targets", async () => {
  await withManagement(async (m, schema, admin) => {
    await runner.migrate(m);
    expect(await runner.rollback(m, { dryRun: true })).toEqual({ dryRun: true, migrations: [IDS[2]] });
    expect(await runner.rollback(m)).toEqual({ dryRun: false, migrations: [IDS[2]] });
    expect(await regclass(admin, `${q(schema)}.posts_user_idx`)).toBe(false);
    expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS.slice(0, 2));
    expect(await runner.rollback(m, { to: IDS[0] })).toEqual({ dryRun: false, migrations: [IDS[1]] });
    expect(await failure(runner.rollback(m, { steps: 2 }))).toBe("USAGE");
    expect(await failure(runner.rollback(m, { to: "20260101000009_nope" }))).toBe("MIGRATION_NOT_APPLIED");
    expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: IDS.slice(1) });
  });
});

integration("a migration without a --down section cannot be rolled back", async () => {
  await withManagement(async (m) => {
    const irreversible = createRunner({ migrations: compileMigrations([["20260101000001_t", "--up\nCREATE TABLE t (id integer PRIMARY KEY);\n--down\n"]]), seeds: [] });
    await irreversible.migrate(m);
    expect(await failure(irreversible.rollback(m))).toBe("MIGRATION_IRREVERSIBLE");
  });
});

integration("an edited migration is drift, never silently re-applied or skipped", async () => {
  await withManagement(async (m, schema, admin) => {
    await runner.migrate(m);
    await admin.query(`UPDATE ${q(schema, "_migrations")} SET checksum='edited' WHERE id=$1`, [IDS[0]]);
    expect(await failure(runner.migrate(m))).toBe("MIGRATION_DRIFT");
    expect(await failure(runner.migrationStatus(m))).toBe("MIGRATION_DRIFT");
  });
});

integration("a failing migration rolls its DDL and ledger row back and stops the chain", async () => {
  await withManagement(async (m, schema, admin) => {
    const broken = createRunner({
      migrations: compileMigrations([
        ["20260101000001_ok", "--up\nCREATE TABLE ok (id integer PRIMARY KEY);\n--down\nDROP TABLE ok;\n"],
        ["20260101000002_bad", "--up\nCREATE TABLE b (id integer PRIMARY KEY);\nCREATE TABLE b (id integer);\n--down\nDROP TABLE b;\n"],
      ]),
      seeds: [],
    });
    expect(await failure(broken.migrate(m))).toBe("42P07");
    expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(["20260101000001_ok"]);
    expect(await regclass(admin, `${q(schema)}.b`)).toBe(false);
  });
});

integration("a second run while the migration lock is held is MIGRATION_RUNNER_BUSY, and works once it is released", async () => {
  await withManagement(async (m) => {
    const held = await openManagementSession(m, MIGRATION_KEY);
    try {
      expect(await failure(runner.migrate(m))).toBe("MIGRATION_RUNNER_BUSY");
      expect(await failure(runner.rollback(m))).toBe("MIGRATION_RUNNER_BUSY");
    } finally {
      await held.release();
      await held.close();
    }
    expect((await runner.migrate(m)).migrations).toEqual(IDS);
  });
});

// Kilidi tutan bağlantı ölünce (sunucu backend'i sonlandırır) advisory lock düşer; bir sonraki çalıştırma beklemeden devam eder.
integration("a busy run leaves the ledger intact, and a dead lock holder does not block the next run", async () => {
  await withManagement(async (m, schema, admin) => {
    await runner.migrate(m);
    const held = await openManagementSession(m, MIGRATION_KEY);
    try {
      expect(await failure(runner.rollback(m))).toBe("MIGRATION_RUNNER_BUSY");
      expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS);
      // Zaman aşımlı biçim backend gerçekten çıkana kadar bekler: kilit bir sonraki çalıştırmadan önce düşmüş olur.
      await admin.query("SELECT pg_catalog.pg_terminate_backend($1, 5000)", [held.pid]);
      expect(await runner.rollback(m)).toEqual({ dryRun: false, migrations: [IDS[2]] });
      // Ölü oturum yeniden bağlanmaz: ilk sorgu bağlantı hatasıyla düşer, sonrakiler kilidin kaybını söyler.
      await held.db.query("SELECT 1").catch(() => {});
      expect(await failure(held.db.query("SELECT 1"))).toBe("LOCK_LOST");
    } finally {
      await held.close();
    }
  });
});

integration("baseline marks migrations applied without running them, only when the live schema already has their objects", async () => {
  await withManagement(async (m, schema, admin) => {
    expect(await failure(runner.baseline(m, IDS[0] as string))).toBe("SCHEMA_MISMATCH");
    await admin.exec(`CREATE SCHEMA ${q(schema)}`);
    for (const migration of migrations.slice(0, 2)) for (const sql of migration.up.bind(schema)) await admin.exec(sql);
    expect(await runner.baseline(m, IDS[1] as string)).toEqual({ migrations: IDS.slice(0, 2) });
    expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS.slice(0, 2));
    expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: [IDS[2]] });
    expect(await failure(runner.baseline(m, IDS[0] as string))).toBe("MIGRATION_NOT_PENDING");
  });
  await withManagement(async (m, schema, admin) => {
    await admin.exec(`CREATE SCHEMA ${q(schema)}`);
    await admin.exec(`CREATE TABLE ${q(schema, "users")} (id integer PRIMARY KEY)`);
    expect(await failure(runner.baseline(m, IDS[0] as string))).toBe("SCHEMA_MISMATCH");
    expect(await regclass(admin, `${q(schema)}._migrations`)).toBe(true);
    expect((await rows(admin, schema, "_migrations")).length).toBe(0);
  });
});

integration("seeds need current migrations, run once, and an edited seed is SEED_DRIFT", async () => {
  await withManagement(async (m, schema, admin) => {
    expect(await failure(runner.seed(m))).toBe("MIGRATIONS_PENDING");
    await runner.migrate(m);
    expect(await runner.seed(m, { dryRun: true })).toEqual({ dryRun: true, seeds: [SEED] });
    expect(await runner.seed(m)).toEqual({ dryRun: false, seeds: [SEED] });
    expect(await admin.query(`SELECT name FROM ${q(schema, "users")}`)).toEqual([{ name: "Ada" }]);
    expect(await runner.seed(m)).toEqual({ dryRun: false, seeds: [] });
    await admin.query(`UPDATE ${q(schema, "_seeds")} SET checksum='edited' WHERE id=$1`, [SEED]);
    expect(await failure(runner.seed(m))).toBe("SEED_DRIFT");
  });
});

integration("a TypeScript seed gets a schema-bound context and its own transaction", async () => {
  await withManagement(async (m, schema, admin) => {
    const insertUser = prepareQuery("INSERT INTO users (id, name) VALUES ($1::integer, $2::text)");
    const typed = createRunner({
      migrations,
      seeds: compileSeeds([["20260101000005_ts", { checksum: "ts-1", run: async ({ query, schema: bound }) => void (await query(insertUser, [7, `in-${bound === schema}`])) }]]),
    });
    await typed.migrate(m);
    await typed.seed(m);
    expect(await admin.query(`SELECT id, name FROM ${q(schema, "users")}`)).toEqual([{ id: 7, name: "in-true" }]);
  });
});

integration("an aborted signal stops before taking the lock", async () => {
  await withManagement(async (m) => {
    const controller = new AbortController();
    controller.abort();
    expect(await failure(runner.migrate(m, { signal: controller.signal }))).toBe("MIGRATION_CANCELLED");
  });
});

/** Yarıda kalmış CONCURRENTLY adımının tekrar denemeleri: önce ilk iki migration, sonra index elle hazırlanır. */
async function withIndex(prepare: (admin: Database, schema: string) => Promise<void>, work: (m: Management, schema: string, admin: Database) => Promise<void>) {
  await withManagement(async (m, schema, admin) => {
    await createRunner({ migrations: migrations.slice(0, 2), seeds: [] }).migrate(m);
    await prepare(admin, schema);
    await work(m, schema, admin);
  });
}
const indexValid = async (admin: Database, schema: string) =>
  (await admin.query<{ valid: boolean }>("SELECT indisvalid AS valid FROM pg_catalog.pg_index WHERE indexrelid = to_regclass($1)", [`${q(schema)}.posts_user_idx`]))[0]?.valid;

integration("a valid concurrent index without its ledger row is accepted, an invalid one is rebuilt", async () => {
  await withIndex(
    (admin, schema) => admin.exec(`CREATE INDEX posts_user_idx ON ${q(schema, "posts")} (user_id)`),
    async (m, schema, admin) => {
      expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: [IDS[2]] });
      expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS);
    },
  );
  await withIndex(
    async (admin, schema) => {
      await admin.exec(`CREATE INDEX posts_user_idx ON ${q(schema, "posts")} (user_id)`);
      await admin.query("UPDATE pg_catalog.pg_index SET indisvalid = false WHERE indexrelid = to_regclass($1)", [`${q(schema)}.posts_user_idx`]);
    },
    async (m, schema, admin) => {
      expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: [IDS[2]] });
      expect(await indexValid(admin, schema)).toBe(true);
    },
  );
});

integration("a same-name index on another table is drift, and rollback after a manual drop only removes the ledger row", async () => {
  await withIndex(
    (admin, schema) => admin.exec(`CREATE INDEX posts_user_idx ON ${q(schema, "users")} (name)`),
    async (m, schema, admin) => {
      expect(await failure(runner.migrate(m))).toBe("MIGRATION_DRIFT");
      expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS.slice(0, 2));
      await admin.exec(`DROP INDEX ${q(schema, "posts_user_idx")}`);
      await runner.migrate(m);
      await admin.exec(`DROP INDEX ${q(schema, "posts_user_idx")}`);
      expect(await runner.rollback(m)).toEqual({ dryRun: false, migrations: [IDS[2]] });
      expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS.slice(0, 2));
    },
  );
});
