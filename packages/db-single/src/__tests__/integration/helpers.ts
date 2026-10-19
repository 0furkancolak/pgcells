/** Entegrasyon yardımcıları. Belgelenen tek env `DATABASE_URLS` (doğrudan URL); testler ayrıca `DB_DRIVER=bun|postgres|pg|neon`
 * ve isteğe bağlı `TEST_POOLED_URLS` (PgBouncer transaction pooling; yoksa yerel compose) okur. */
import { expect, test } from "bun:test";
import { neonConfig } from "@neondatabase/serverless";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { type Config, createConfig, loadConfig } from "../../core/config";
import { type Queryable, runContext } from "../../core/context";
import { connect, type Database } from "../../core/database";
import type { Driver } from "../../core/driver";
import { bunDriver } from "../../core/drivers/bun";
import { neonDriver } from "../../core/drivers/neon";
import { pgDriver } from "../../core/drivers/pg";
import { postgresDriver } from "../../core/drivers/postgres";
import { errorCode } from "../../core/errors";
import { quoteIdentifier } from "../../core/identifier";
import { createManagement, type Management, type ManagementFactoryOptions } from "../../core/management";
import type { Registry } from "../../core/migrations/registry";
import { createRunner } from "../../core/migrations/runner";
import { prepareMigration } from "../../core/sql/compiler";
import { writeGenerated } from "../../core/sql/codegen";
import { exportSchema, restoreSchema } from "../../core/tools/backup";

export const enabled = process.env.RUN_INTEGRATION === "1";
export const integration = enabled ? test : test.skip;

// Yerel wsproxy (compose `wsproxy`): Neon istemcisi `host:port` yerine yerel proxy'ye WebSocket açar; proxy ana makinenin Postgres/PgBouncer
// portlarına iletir. Gerçek Neon'a karşı çalışma `verify:provider --driver neon`'dur.
neonConfig.useSecureWebSocket = false;
neonConfig.pipelineConnect = false;
neonConfig.wsProxy = (host, port) => `127.0.0.1:5489/v1?address=${["127.0.0.1", "localhost"].includes(host) ? "host.docker.internal" : host}:${port}`;

export const drivers: Record<string, Driver> = { bun: bunDriver, postgres: postgresDriver, pg: pgDriver, neon: neonDriver };
const name = process.env.DB_DRIVER ?? "bun";
if (!drivers[name]) throw new Error(`Unknown DB_DRIVER: ${name}`);
export const driver = drivers[name] as Driver;
/** Yönetim (advisory lock) Neon'da çalışmaz: Neon seçiliyken Bun SQL kullanılır. */
export const managementDriver = name === "neon" ? bunDriver : driver;

/** Doğrudan URL (yönetim ve fikstürler). */
export const directConfig = (): Config => loadConfig();
/** Transaction-pooled URL (aynı DB, aynı kimlik bilgileri): runtime testleri. */
export const pooledConfig = (): Config => createConfig(process.env.TEST_POOLED_URLS ?? "postgres://admin:local_admin_password@127.0.0.1:5563/app");

export const createTestManagement = (options: Partial<ManagementFactoryOptions> = {}, config: Config = directConfig()) =>
  createManagement(config, { driver: managementDriver, ...options });

/** Kendi küçük havuzu olan fikstür bağlantısı (varsayılan: doğrudan URL). */
export function raw(url = directConfig().url, max = 2): Database {
  return connect(driver(url, { max, idleTimeoutSeconds: 60, maxLifetimeSeconds: 600, connectTimeoutSeconds: 10 }), {
    deadlineMs: 60000,
    timeouts: { statementTimeoutMs: 60000, lockTimeoutMs: 10000 },
    maxPending: 256,
  });
}

/** `"schema"` ya da `"schema"."ad"`. */
export const q = (schema: string, name?: string) => (name === undefined ? quoteIdentifier(schema) : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`);

/** `db`'de verilen schema'ya bağlı sorgu bağlamı: testlerde `createDb` yerine tek bağlantılı kısa yol (`runContext`). */
export const inSchema = (db: Database, schema: string) => <T>(work: (ctx: Queryable) => Promise<T>) => runContext(db, db, schema, work);

/** Her test kendi schema'sını kurar ve siler (`leak-guard.ts` kalanı yakalar). */
export const testSchema = () => `app_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
export const dropSchema = (db: Pick<Database, "exec">, schema: string) => db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);

/** Reddetmesi gereken işin sürücüden bağımsız hata kodu. */
export async function failure(promise: Promise<unknown>) {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => errorCode(error),
  );
  expect(outcome).toBeDefined();
  return outcome;
}

/** CLI Neon (yalnızca runtime) kullanamaz: Neon seçiliyken Bun SQL. */
const cliDriver = name === "neon" ? "bun" : name;

/** Paketin geçici kopyası (testler hariç; `packages/db-single` altında, bağımlılıklar çözülür). Test-yerel migration ve seed kaynakları
 * buraya yazılır; `codegen` sonrası kopyanın CLI'si kendi registry'siyle çalışır, bu sürecin registry'si değişmez. */
export async function packageCopy(label: string) {
  const root = await mkdtemp(join(import.meta.dir, `../../../.tmp-${label}-`));
  await cp(join(import.meta.dir, "../.."), join(root, "src"), { recursive: true, filter: (path) => !path.includes("__tests__") });
  // Kopya paketin kendi migration/seed/sorgu/tablo kayıtlarıyla değil, boş bir kayıtla başlar: testler yalnızca kendi dosyalarını görür.
  for (const dir of ["migrations", "seeds", "queries", "repositories"])
    for await (const file of new Bun.Glob(`src/${dir}/**/*`).scan(root)) if (!file.endsWith("index.gen.ts")) await rm(join(root, file));
  await writeGenerated(root);
  return {
    root,
    write: (path: string, source: string) => Bun.write(join(root, path), source),
    codegen: () => writeGenerated(root),
    /** Kopyada `src/core/cli.ts`; çıkış kodu 0 olmalı, son JSON nesnesi döner. */
    async cli(...args: string[]): Promise<unknown> {
      const child = Bun.spawn([process.execPath, "src/core/cli.ts", ...args, `--driver=${cliDriver}`], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, `${args.join(" ")}: ${stderr}`).toBe(0);
      return JSON.parse(stdout.split(/\n(?=\{)/).at(-1) ?? "");
    },
    /** Çıkış kodu denetlenmeyen komut (başarısız çıkış ya da bütün çıktı beklenir): çıkış kodu, stdout ve stderr döner. */
    async cliRaw(...args: string[]) {
      const child = Bun.spawn([process.execPath, "src/core/cli.ts", ...args, `--driver=${cliDriver}`], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

const BOUNCER_CONSOLE_URL = "postgres://admin:local_admin_password@127.0.0.1:5563/pgbouncer";

/** PgBouncer yönetim konsolu komutu (yalnızca simple protocol kabul eder; pg parametresiz sorguyu öyle gönderir); test altyapısı. */
export async function adminConsole(command: string) {
  const client = new pg.Client({ connectionString: BOUNCER_CONSOLE_URL });
  await client.connect();
  try {
    await client.query(command);
  } finally {
    await client.end();
  }
}

/** Runtime'ın sunucu tarafı varsayılanlarını (`statement_timeout` …) veritabanına yazar: boş kayıtlı `migrate`, atılacak bir schema'da
 * (`public`te ledger bırakmaz). Yeni backend'ler alır; mevcut pooler bağlantıları yeniden bağlanınca: bu yüzden PgBouncer'ın sunucu
 * bağlantıları (`RECONNECT`) burada yenilenir, testler sıraya bağımlı olmaz. */
export async function writeRuntimeDefaults() {
  const schema = testSchema();
  const [m, admin] = [createTestManagement({ schema }), raw()];
  try {
    await createRunner({ migrations: [], seeds: [] }).migrate(m);
  } finally {
    await dropSchema(admin, schema);
    await Promise.all([m.close(), admin.close()]);
  }
  await adminConsole("RECONNECT");
}

/** Her tablonun sıralı `row_to_json` satırları: yedek ve geri yükleme eşitliği için tek oracle. */
export async function dump(db: Database, schema: string) {
  const tables = await db.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY 1", [schema]);
  return Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [name, (await db.query<{ r: string }>(`SELECT row_to_json(t)::text AS r FROM ${q(schema, name)} t ORDER BY 1`)).map((row) => row.r)] as const)));
}

/** Schema'nın şekli, satır satır metin olarak: varsayılan, kısıt ve index tanımları, sütun sırası (silinen sütunlar sayılmaz), tipleri ve bayrakları (NOT NULL, identity,
 * generated, collation) ile sequence parametreleri ve durumu. Başka schema'ya geri yüklemede kaynağa başvuru kalmamalı. */
export async function definitions(db: Database, schema: string) {
  const relations = "SELECT oid FROM pg_class WHERE relnamespace=$1::regnamespace";
  const rows = await db.query<{ d: string }>(
    `SELECT pg_get_expr(adbin, adrelid) AS d FROM pg_attrdef WHERE adrelid IN (${relations})
     UNION ALL SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace=$1::regnamespace
     UNION ALL SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid IN (${relations})
     UNION ALL SELECT format('column %s.%s #%s %s notnull=%s identity=%s generated=%s collation=%s', c.relname, a.attname,
         row_number() OVER (PARTITION BY a.attrelid ORDER BY a.attnum), format_type(a.atttypid, a.atttypmod),
         a.attnotnull, a.attidentity, a.attgenerated, CASE WHEN a.attcollation <> t.typcollation THEN (SELECT collname FROM pg_collation WHERE oid=a.attcollation) END)
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_type t ON t.oid=a.atttypid
       WHERE c.relnamespace=$1::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
     UNION ALL SELECT format('sequence %s %s %s..%s inc=%s cache=%s cycle=%s last=%s', sequencename, data_type, min_value, max_value, increment_by, cache_size, cycle, last_value)
       FROM pg_sequences WHERE schemaname=$2`,
    [schema, schema],
  );
  expect(rows.length).toBeGreaterThan(0);
  return rows.map((row) => row.d).join("\n");
}

/** `from`'un schema'sını geçici klasöre aktarır, siler ve `to` ile (aynı schema) geri yükler; ikisinin de satır ve tanım görüntüsü döner:
 * veri ve şeklin yedekten geçişi için tek oracle. `from` ile `to` farklı sürücü/oturum ayarıyla açılabilir. */
export async function roundTrip(from: Management, to: Management, registry: Registry) {
  const [admin, dir] = [raw(), await mkdtemp(join(import.meta.dir, "../../../.tmp-roundtrip-"))];
  const view = async () => ({ rows: await dump(admin, from.schema), definitions: (await definitions(admin, from.schema)).split("\n").sort() });
  try {
    const before = await view();
    await exportSchema(from, join(dir, "x"));
    await dropSchema(admin, from.schema);
    await restoreSchema(to, join(dir, "x"), { registry });
    return { before, after: await view() };
  } finally {
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Her test kendi schema'sında bir `notes` tablosu kurar; iş bitince schema silinir. */
export async function withNotes(work: (schema: string) => Promise<void>) {
  const admin = raw();
  const schema = testSchema();
  try {
    await admin.exec(`CREATE SCHEMA ${q(schema)}`);
    for (const sql of prepareMigration("CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL)").bind(schema)) await admin.exec(sql);
    await work(schema);
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
  }
}
