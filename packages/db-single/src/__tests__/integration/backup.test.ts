import { expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { schemaExists, schemaIsEmpty } from "../../core/catalog";
import type { Database } from "../../core/database";
import { errorCode } from "../../core/errors";
import type { Management } from "../../core/management";
import { createRunner } from "../../core/migrations/runner";
import type { Registry } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";
import { backupSchema, exportSchema, restoreSchema } from "../../core/tools/backup";
import { createTestManagement, definitions, dropSchema, dump, failure, integration, q, raw, testSchema } from "./helpers";

const FIRST = ["20260101000001_users", "--up\nCREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, tags text[] NOT NULL DEFAULT '{}', meta jsonb);\n--down\nDROP TABLE users;\n"] as const;
const SECOND = ["20260101000002_posts", "--up\nCREATE TABLE posts (id integer PRIMARY KEY, user_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE, body text NOT NULL);\nCREATE INDEX posts_user_idx ON posts (user_id);\n--down\nDROP TABLE posts;\n"] as const;
const OLD: Registry = { migrations: compileMigrations([FIRST]), seeds: [] };
const NEW: Registry = { migrations: compileMigrations([FIRST, SECOND]), seeds: [] };

async function withBackup(work: (ctx: { m: Management; schema: string; admin: Database; dir: string }) => Promise<void>) {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema });
  const dir = await mkdtemp(join(import.meta.dir, "../../../.tmp-backup-"));
  try {
    await work({ m, schema, admin, dir });
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
}
/** Sırası `ADD VALUE ... BEFORE` ile değişmiş, tırnak/ters bölü/boşluk/unicode etiketli enum; enum ve enum[] sütunları, default'lar,
 * CHECK, kısmi ve ifade index'i; NULL'lu satırlar. */
async function withEnums(admin: Database, schema: string) {
  const [status, items] = [q(schema, "status"), q(schema, "items")];
  await admin.exec(`CREATE TYPE ${status} AS ENUM ('b', 'it''s', 'back\\slash', 'çğ')`);
  await admin.exec(`ALTER TYPE ${status} ADD VALUE 'a b' BEFORE 'it''s'`);
  await admin.exec(`CREATE TABLE ${items} (id integer PRIMARY KEY, s ${status} DEFAULT 'b', all_s ${status}[] NOT NULL DEFAULT '{b,"a b"}',
      CONSTRAINT s_check CHECK (s <> 'çğ' AND all_s <> '{çğ}'));
    CREATE INDEX items_b_idx ON ${items} (id) WHERE s = 'b';
    CREATE INDEX items_expr_idx ON ${items} ((s > 'a b'), (all_s[1]));
    INSERT INTO ${items} VALUES (1, 'it''s', '{b,"it''s"}'), (2, NULL, '{}'), (3, 'back\\slash', '{NULL,"a b"}');
    INSERT INTO ${items} (id) VALUES (4)`);
}
const LABELS = ["b", "a b", "it's", "back\\slash", "çğ"];
const labels = async (admin: Database, schema: string) =>
  JSON.parse((await admin.query<{ l: string }>(`SELECT to_json(enum_range(NULL::${q(schema, "status")}))::text AS l`))[0]?.l ?? "null") as string[];

/** `schema`'daki kısıtların (yabancı anahtar) ve default'ların (sequence) kendi tabloları dışında başvurduğu ilişkilerin schema'ları:
 * katalog metni `public`'i nitelemesiz yazdığından metin karşılaştırması bunu göremez. */
const referencedSchemas = async (admin: Database, schema: string) =>
  (
    await admin.query<{ ns: string }>(
      `SELECT DISTINCT r.relnamespace::regnamespace::text AS ns FROM pg_depend d JOIN pg_class r ON d.refclassid='pg_class'::regclass AND r.oid=d.refobjid
        LEFT JOIN pg_constraint co ON d.classid='pg_constraint'::regclass AND co.oid=d.objid
        LEFT JOIN pg_attrdef ad ON d.classid='pg_attrdef'::regclass AND ad.oid=d.objid LEFT JOIN pg_class t ON t.oid=ad.adrelid
       WHERE $1::text::regnamespace IN (co.connamespace, t.relnamespace) AND r.oid<>COALESCE(co.conrelid, ad.adrelid)`,
      [schema],
    )
  ).map((row) => row.ns);

async function seeded(m: Management, schema: string, admin: Database, registry: Registry = NEW) {
  await createRunner(registry).migrate(m);
  await admin.exec(`INSERT INTO ${q(schema, "users")} (email, tags, meta) VALUES ('a@example.com','{x,y}','{"k":1}'),('b@example.com','{}',NULL)`);
  if (registry === NEW) await admin.exec(`INSERT INTO ${q(schema, "posts")} VALUES (1, 1, 'hello'),(2, 2, 'it''s')`);
}

integration("export then restore into a dropped schema reproduces tables, rows, sequences and the ledger", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    const before = await dump(admin, schema);
    const exported = await exportSchema(m, join(dir, "x"));
    expect(exported).toMatchObject({ dir: join(dir, "x") });
    expect(exported.rows).toBe(Object.values(before).flat().length);
    await dropSchema(admin, schema);
    const restored = await restoreSchema(m, join(dir, "x"), { registry: NEW });
    expect(restored).toMatchObject({ restoredFrom: join(dir, "x"), migrationsApplied: [], rows: exported.rows });
    expect(await dump(admin, schema)).toEqual(before);
    // serial dizisi kaldığı yerden sürer
    await admin.exec(`INSERT INTO ${q(schema, "users")} (email) VALUES ('c@example.com')`);
    expect((await admin.query<{ id: number }>(`SELECT max(id) AS id FROM ${q(schema, "users")}`))[0]?.id).toBe(3);
    // geri yüklenen schema'da migrate bir şey yapmaz
    expect(await createRunner(NEW).migrate(m)).toEqual({ dryRun: false, migrations: [] });
  });
});

integration("a backup restores into a different schema name too", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    await exportSchema(m, join(dir, "x"));
    const other = testSchema();
    const target = createTestManagement({ schema: other });
    try {
      await restoreSchema(target, join(dir, "x"), { registry: NEW });
      expect(await dump(admin, other)).toEqual(await dump(admin, schema));
      // varsayılanlar, yabancı anahtarlar ve index'ler kaynak schema'ya değil hedefe bağlıdır
      expect(await definitions(admin, other)).not.toContain(schema);
    } finally {
      await target.close();
      await dropSchema(admin, other);
    }
  });
});

integration("enums, enum[] columns and enum defaults, CHECKs and indexes round-trip with label order into the same and another schema", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin, OLD);
    await withEnums(admin, schema);
    const [rows, shape] = [await dump(admin, schema), (await definitions(admin, schema)).split("\n").sort()];
    expect(await labels(admin, schema)).toEqual(LABELS);
    await exportSchema(m, join(dir, "x"));
    await dropSchema(admin, schema);
    await restoreSchema(m, join(dir, "x"), { registry: OLD });
    expect(await dump(admin, schema)).toEqual(rows);
    expect((await definitions(admin, schema)).split("\n").sort()).toEqual(shape);
    expect(await labels(admin, schema)).toEqual(LABELS);
    const other = testSchema();
    const target = createTestManagement({ schema: other });
    try {
      await restoreSchema(target, join(dir, "x"), { registry: OLD });
      expect(await dump(admin, other)).toEqual(rows);
      expect(await labels(admin, other)).toEqual(LABELS);
      // tip, default, CHECK ve index'ler kaynak schema'ya değil hedefe bağlıdır
      const restored = await definitions(admin, other);
      expect(restored).not.toContain(schema);
      expect(restored).toContain(`column items.all_s #3 ${other}.status[]`);
      expect(restored).toContain(`'{b,"a b"}'::${other}.status[]`);
    } finally {
      await target.close();
      await dropSchema(admin, other);
    }
  });
});

integration("the default schema public exports, restores in place and restores into another schema name", async () => {
  const [admin, other] = [raw(), testSchema()];
  const [m, target] = [createTestManagement(), createTestManagement({ schema: other })];
  const dir = await mkdtemp(join(import.meta.dir, "../../../.tmp-backup-"));
  // `public` paylaşılır (leak-guard): test kendi tablolarını ve tipini siler
  const clean = () => admin.exec(`DROP TABLE IF EXISTS public.items, public.posts, public.users, public._migrations CASCADE; DROP TYPE IF EXISTS public.status`);
  try {
    expect(await schemaIsEmpty(admin, "public")).toBe(true);
    await seeded(m, "public", admin);
    // `public` çözüm yolunda: katalog enum'u nitelemesiz yazar (`'b'::status`)
    await withEnums(admin, "public");
    const before = await dump(admin, "public");
    await exportSchema(m, join(dir, "x"));
    await clean();
    await restoreSchema(m, join(dir, "x"), { registry: NEW });
    expect(await dump(admin, "public")).toEqual(before);
    expect(await labels(admin, "public")).toEqual(LABELS);
    await restoreSchema(target, join(dir, "x"), { registry: NEW });
    expect(await dump(admin, other)).toEqual(before);
    expect(await labels(admin, other)).toEqual(LABELS);
    expect(await definitions(admin, other)).not.toContain("public");
    expect(await referencedSchemas(admin, other)).toEqual([other]);
    expect(await definitions(admin, other)).not.toMatch(/::status\b/);
  } finally {
    await Promise.all([m.close(), target.close()]);
    await clean();
    await dropSchema(admin, other);
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
});

integration("concurrent runs aimed at the same folder leave one complete set each, the loser fails cleanly or takes the next second, and no .partial", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    const before = await dump(admin, schema);
    const runs = await Promise.allSettled([exportSchema(m, join(dir, "x")), exportSchema(m, join(dir, "x"))]);
    expect(runs.map((run) => run.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(runs.map((run) => (run.status === "rejected" ? errorCode(run.reason) : "ok")).sort()).toEqual(["BACKUP_EXISTS", "ok"]);
    const sets = await Promise.all([backupSchema(m, join(dir, "root")), backupSchema(m, join(dir, "root"))]);
    expect(new Set(sets.map((set) => set.id)).size).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(["root", "x"]);
    expect((await readdir(join(dir, "root"))).sort()).toEqual(sets.map((set) => set.id).sort());
    for (const source of [join(dir, "x"), ...sets.map((set) => set.dir)]) {
      await dropSchema(admin, schema);
      await restoreSchema(m, source, { registry: NEW });
      expect(await dump(admin, schema)).toEqual(before);
    }
  });
});

integration("restore refuses a schema that already has objects and changes nothing", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    await exportSchema(m, join(dir, "x"));
    const before = await dump(admin, schema);
    expect(await failure(restoreSchema(m, join(dir, "x"), { registry: NEW }))).toBe("SCHEMA_NOT_EMPTY");
    expect(await dump(admin, schema)).toEqual(before);
    expect(await schemaIsEmpty(admin, schema)).toBe(false);
    // yalnızca artakalan bir enum tipi de schema'yı dolu sayar
    await dropSchema(admin, schema);
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TYPE ${q(schema, "leftover")} AS ENUM ('x')`);
    expect(await schemaIsEmpty(admin, schema)).toBe(false);
    expect(await failure(restoreSchema(m, join(dir, "x"), { registry: NEW }))).toBe("SCHEMA_NOT_EMPTY");
  });
});

integration("an older backup is brought up to date after restore; a newer one than this code is MIGRATION_DRIFT", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin, OLD);
    await exportSchema(m, join(dir, "old"));
    await dropSchema(admin, schema);
    expect(await restoreSchema(m, join(dir, "old"), { registry: NEW })).toMatchObject({ migrationsApplied: ["20260101000002_posts"] });
    await exportSchema(m, join(dir, "new"));
    await dropSchema(admin, schema);
    expect(await failure(restoreSchema(m, join(dir, "new"), { registry: OLD }))).toBe("MIGRATION_DRIFT");
    expect(await schemaExists(admin, schema)).toBe(false);
  });
});

integration("export refuses an existing folder, leaves no .partial behind on failure, and restore needs a real backup", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    await exportSchema(m, join(dir, "x"));
    expect(await failure(exportSchema(m, join(dir, "x")))).toBe("BACKUP_EXISTS");
    expect(await failure(restoreSchema(m, join(dir, "missing"), { registry: NEW }))).toBe("BACKUP_NOT_FOUND");
    // desteklenmeyen nesne (view) → hiçbir dosya kalmaz
    await admin.exec(`CREATE VIEW ${q(schema, "v")} AS SELECT id FROM ${q(schema, "users")}`);
    expect(await failure(exportSchema(m, join(dir, "y")))).toBe("UNSUPPORTED_SCHEMA");
    expect((await readdir(dir)).filter((name) => name.startsWith("y"))).toEqual([]);
    // ileti engelleyen nesneyi adlandırır (taşınamayan sütun türü, ör. PostGIS geometry, `tablo.sütun` olarak)
    await expect(exportSchema(m, join(dir, "y"))).rejects.toThrow(/: v$/);
    await admin.exec(`DROP VIEW ${q(schema, "v")}; CREATE TABLE ${q(schema, "shapes")} (id integer PRIMARY KEY, p money)`);
    await expect(exportSchema(m, join(dir, "y"))).rejects.toThrow(/: shapes\.p$/);
    // domain, range, composite, fonksiyon ve başka schema'daki enum: tip/rutin ve onu kullanan sütun adlandırılır (ihlal edilen her
    // kural bildirilir); değerler iletiye girmez
    const elsewhere = testSchema();
    try {
      await admin.exec(`DROP TABLE ${q(schema, "shapes")}; CREATE SCHEMA ${q(elsewhere)}; CREATE TYPE ${q(elsewhere, "mood")} AS ENUM ('secret_value');
        CREATE DOMAIN ${q(schema, "positive")} AS integer CHECK (VALUE > 0); CREATE TYPE ${q(schema, "span")} AS RANGE (subtype = float8);
        CREATE TYPE ${q(schema, "pair")} AS (a integer, b integer); CREATE FUNCTION ${q(schema, "one")}() RETURNS integer LANGUAGE sql AS 'SELECT 1';
        CREATE TABLE ${q(schema, "moods")} (id integer PRIMARY KEY, feeling ${q(elsewhere, "mood")}, amount ${q(schema, "positive")})`);
      const refused = (await exportSchema(m, join(dir, "y")).catch((e: unknown) => e)) as Error;
      expect(refused).toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
      for (const name of ["pair", "type positive", "type span", "routine one", "moods.amount", "moods.feeling"]) expect(refused.message).toContain(name);
      expect(refused.message).not.toContain("secret_value");
    } finally {
      await dropSchema(admin, elsewhere);
    }
  });
});

integration("an index casting to an enum the backup does not copy (another schema's or an extension's) is refused, not left bound to it", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin, OLD);
    const elsewhere = testSchema();
    try {
      await admin.exec(`CREATE SCHEMA ${q(elsewhere)}; CREATE TYPE ${q(elsewhere, "mood")} AS ENUM ('x');
        CREATE INDEX users_mood_idx ON ${q(schema, "users")} (id) WHERE ARRAY['x'::${q(elsewhere, "mood")}] IS NOT NULL`);
      await expect(exportSchema(m, join(dir, "x"))).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA", message: expect.stringContaining("users_mood_idx") });
      await admin.exec(`DROP INDEX ${q(schema, "users_mood_idx")}; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA ${q(schema)};
        CREATE TYPE ${q(schema, "ext_kind")} AS ENUM ('y'); ALTER EXTENSION pgcrypto ADD TYPE ${q(schema, "ext_kind")};
        CREATE INDEX users_kind_idx ON ${q(schema, "users")} (id) WHERE 'y'::${q(schema, "ext_kind")} IS NOT NULL`);
      await expect(exportSchema(m, join(dir, "x"))).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA", message: expect.stringContaining("users_kind_idx") });
    } finally {
      await dropSchema(admin, elsewhere);
    }
  });
});

integration("export names a missing or empty schema, and a target written with a trailing slash is the same folder", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await expect(exportSchema(m, join(dir, "x"))).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA", message: "Schema is missing or empty" });
    await admin.exec(`CREATE SCHEMA ${q(schema)}`);
    await expect(exportSchema(m, join(dir, "x"))).rejects.toMatchObject({ message: "Schema is missing or empty" });
    await seeded(m, schema, admin, OLD);
    await exportSchema(m, `${join(dir, "x")}/`);
    expect(await readdir(dir)).toEqual(["x"]);
    expect(await readdir(join(dir, "x"))).toContain("backup.json");
  });
});

integration("the export refusal lists at most 20 objects per rule and counts the rest", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin, OLD);
    const types = Array.from({ length: 25 }, (_, i) => `CREATE DOMAIN ${q(schema, `kind_${String(i).padStart(2, "0")}`)} AS integer;`).join(" ");
    await admin.exec(types);
    const refused = (await exportSchema(m, join(dir, "x")).catch((e: unknown) => e)) as Error;
    expect(refused).toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
    expect(refused.message.match(/type kind_\d\d/g)).toHaveLength(20);
    expect(refused.message).toContain("type kind_19 and 5 more");
    expect(refused.message).not.toContain("kind_20");
  });
});

integration("a character(n) cast in a default or CHECK exports and restores like any other expression", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin, OLD);
    await admin.exec(`CREATE TABLE ${q(schema, "codes")} (id integer PRIMARY KEY, label text NOT NULL DEFAULT 'abc'::character(3), CONSTRAINT label_check CHECK (label::character(3) <> 'xyz')); INSERT INTO ${q(schema, "codes")} (id) VALUES (1)`);
    const rows = await dump(admin, schema);
    await exportSchema(m, join(dir, "x"));
    await dropSchema(admin, schema);
    await restoreSchema(m, join(dir, "x"), { registry: OLD });
    expect(await dump(admin, schema)).toEqual(rows);
    // Tanımlar (default ve CHECK) yeni schema'da yine character(3) cast'iyle kurulur.
    const shape = await definitions(admin, schema);
    expect(shape).toContain("'abc'::character(3)");
    expect(shape).toContain("(label)::character(3)");
  });
});

integration("backup writes a full timestamped set per run, --keep prunes older ones, and restore from the root takes the latest or a chosen set", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    const at = (second: number) => () => new Date(Date.UTC(2026, 0, 1, 0, 0, second));
    const ids: string[] = [];
    for (const second of [1, 2, 3]) ids.push((await backupSchema(m, dir, { keep: 2, now: at(second) })).id);
    expect(ids).toEqual(["20260101000001", "20260101000002", "20260101000003"]);
    expect((await readdir(dir)).sort()).toEqual(["20260101000002", "20260101000003"]);
    const before = await dump(admin, schema);
    await dropSchema(admin, schema);
    expect((await restoreSchema(m, dir, { registry: NEW })).restoredFrom).toBe(join(dir, "20260101000003"));
    expect(await dump(admin, schema)).toEqual(before);
    await dropSchema(admin, schema);
    expect((await restoreSchema(m, dir, { set: "20260101000002", registry: NEW })).restoredFrom).toBe(join(dir, "20260101000002"));
    expect(await failure(restoreSchema(m, dir, { set: "20260101000001", registry: NEW }))).toBe("BACKUP_NOT_FOUND");
  });
});

integration("objects owned by an extension in the schema block neither export nor restore", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA ${q(schema)}; CREATE EXTENSION IF NOT EXISTS pg_stat_statements SCHEMA ${q(schema)}`);
    // eklentiye ait enum da kopyalanmaz ve reddedilmez
    await admin.exec(`CREATE TYPE ${q(schema, "ext_kind")} AS ENUM ('x'); ALTER EXTENSION pgcrypto ADD TYPE ${q(schema, "ext_kind")}`);
    // eklentinin tablosundaki index'in o enum'a cast'i de engel değildir
    await admin.exec(`CREATE TABLE ${q(schema, "ext_table")} (id integer); CREATE INDEX ext_table_idx ON ${q(schema, "ext_table")} (id) WHERE 'x'::${q(schema, "ext_kind")} IS NOT NULL;
      ALTER EXTENSION pgcrypto ADD TABLE ${q(schema, "ext_table")}`);
    await createRunner(OLD).migrate(m);
    await admin.exec(`INSERT INTO ${q(schema, "users")} (email) VALUES ('a@example.com')`);
    const before = await dump(admin, schema);
    expect(await exportSchema(m, join(dir, "x"))).toMatchObject({ tables: 2, rows: 2 });
    const meta = (await Bun.file(join(dir, "x", "backup.json")).json()) as { shape: { tables: { name: string }[]; enums: unknown[] } };
    expect(meta.shape.tables.map((table) => table.name)).toEqual(["_migrations", "users"]);
    expect(meta.shape.enums).toEqual([]);
    // eklentiler schema'da kalır; yalnızca uygulama tabloları silinir, geri yükleme yine de çalışır
    await admin.exec(`DROP TABLE ${q(schema, "users")}, ${q(schema, "_migrations")}`);
    expect(await schemaIsEmpty(admin, schema)).toBe(true);
    await restoreSchema(m, join(dir, "x"), { registry: OLD });
    expect(await dump(admin, schema)).toEqual(before);
  });
});
