/** `bootstrap --mark-applied`: pull edilmiş platform migration'ı yalnızca kaynak schema'nın bugünkü kataloğu migration'ın yapı özetiyle
 * aynıysa işaretlenir; kaynak verilmezse, schema farklıysa ya da değiştiyse hiçbir şey yazılmadan reddedilir. Paket kopyası (ayrı
 * registry) ve bu teste özel bir DB kullanır: ortak test DB'lerinin ledger'ı değişmez. */
import { afterAll, beforeAll, expect } from "bun:test";
import { createConfig } from "../../core/config";
import type { Database } from "../../core/database";
import { directConfig, driver, enabled, failure, integration, packageCopy, q, raw } from "./helpers";

const name = `markproof_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: Database | undefined;
let copy: Awaited<ReturnType<typeof packageCopy>> | undefined;
let url = "";

/** CREATE/DROP DATABASE transaction'da çalışamaz: bootstrap'ın runtime statement_timeout'u olmadan ayrılmış oturum. */
async function outsideTimeout(db: Database, sql: string) {
  const connection = await db.pool.reserve();
  try {
    await connection.exec("SET statement_timeout = 0");
    await connection.exec(sql);
  } finally {
    await connection.exec("RESET statement_timeout").catch(() => {});
    connection.release();
  }
}

beforeAll(async () => {
  if (!enabled) return;
  admin = raw();
  await outsideTimeout(admin, `CREATE DATABASE ${q(name)}`);
  const target = new URL(directConfig().nodes[0]?.url ?? "");
  target.pathname = `/${name}`;
  url = target.href;
  copy = await packageCopy("mark-applied");
});
afterAll(async () => {
  await copy?.remove();
  if (admin) {
    await outsideTimeout(admin, `DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`);
    await admin.close();
  }
});

integration("mark-applied requires the source schema and refuses a different or changed structure without writing anything", async () => {
  if (!copy) throw new Error("Missing package copy");
  const db = raw(0, url);
  try {
    await db.exec("CREATE SCHEMA panel; CREATE TABLE panel.admins (id uuid PRIMARY KEY, email text NOT NULL); CREATE SCHEMA staging; CREATE TABLE staging.admins (id uuid PRIMARY KEY)");
    const previous = process.env.DATABASE_URLS;
    process.env.DATABASE_URLS = url;
    let pulled: { id: string };
    try {
      pulled = await copy.cli("pull", "panel", "--scope", "platform", "--name", "panel_init");
    } finally {
      process.env.DATABASE_URLS = previous;
    }
    await copy.codegen();
    const { bootstrap, createManagement } = await copy.management();
    const m = createManagement(createConfig([url]), { driver });
    const ledgerExists = async () => (await db.query<{ exists: boolean }>("SELECT pg_catalog.to_regclass('platform._migrations') IS NOT NULL AS exists"))[0]?.exists;
    try {
      expect(await failure(bootstrap(m, { markApplied: [pulled.id] }))).toBe("USAGE");
      expect(await failure(bootstrap(m, { markApplied: [pulled.id], fromSchema: "staging" }))).toBe("SCHEMA_DRIFT");
      expect(await failure(bootstrap(m, { markApplied: [pulled.id], fromSchema: "missing" }))).toBe("SOURCE_SCHEMA_MISSING");
      await db.exec("ALTER TABLE panel.admins ADD COLUMN name text");
      expect(await failure(bootstrap(m, { markApplied: [pulled.id], fromSchema: "panel" }))).toBe("SCHEMA_DRIFT");
      expect(await ledgerExists()).toBe(false); // reddedilen hiçbir çağrı ledger'a (ya da platform'a) yazmadı

      await db.exec("ALTER TABLE panel.admins DROP COLUMN name");
      const result = await bootstrap(m, { markApplied: [pulled.id], fromSchema: "panel" });
      expect(result.markedApplied).toEqual([pulled.id]);
      expect(await db.query("SELECT id FROM platform._migrations WHERE id=$1", [pulled.id])).toHaveLength(1);
      // İşaretlenen migration çalıştırılmadı: tablosu platform'da yok (başka bir araç getirir).
      expect(await db.query<{ absent: boolean }>("SELECT pg_catalog.to_regclass('platform.admins') IS NULL AS absent")).toEqual([{ absent: true }]);
    } finally {
      await m.close();
    }
  } finally {
    await db.close();
  }
});
