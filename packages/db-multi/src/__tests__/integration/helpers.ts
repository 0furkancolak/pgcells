/** Entegrasyon yardımcıları. Belgelenen tek env `DATABASE_URLS` (doğrudan URL'ler); testler ayrıca `DB_DRIVER=bun|postgres|pg`
 * ve isteğe bağlı `TEST_POOLED_URLS` (PgBouncer transaction pooling; yoksa yerel compose alias'ları) okur. */
import { expect, test } from "bun:test";
import { neonConfig } from "@neondatabase/serverless";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Config, createConfig, loadConfig, type ManagementOptions } from "../../core/config";
import { connect } from "../../core/database";
import type { Driver } from "../../core/driver";
import { bunDriver } from "../../core/drivers/bun";
import { neonDriver } from "../../core/drivers/neon";
import { pgDriver } from "../../core/drivers/pg";
import { postgresDriver } from "../../core/drivers/postgres";
import { errorCode } from "../../core/errors";
import { writeGenerated } from "../../core/sql/codegen";
import { prepareQuery } from "../../core/sql/compiler";
import { createManagement, type Management } from "../../management";
import type * as ManagementModule from "../../management";
import { quoteIdentifier, tenantSchema, tenantSchemas } from "../../core/tenants/model";
import { createDatabase } from "../../index";

export const enabled = process.env.RUN_INTEGRATION === "1";
export const integration = enabled ? test : test.skip;

// Yerel wsproxy (compose `wsproxy`): Neon istemcisi `host:port` yerine yerel proxy'ye WebSocket açar; proxy ana makinenin Postgres/PgBouncer
// portlarına iletir. Gerçek Neon'a karşı çalışma `verify:provider --driver neon`'dur.
neonConfig.useSecureWebSocket = false;
neonConfig.pipelineConnect = false;
neonConfig.wsProxy = (host, port) => `127.0.0.1:5488/v1?address=${["127.0.0.1", "localhost"].includes(host) ? "host.docker.internal" : host}:${port}`;

export const drivers: Record<string, Driver> = { bun: bunDriver, postgres: postgresDriver, pg: pgDriver, neon: neonDriver };
const name = process.env.DB_DRIVER ?? "bun";
if (!drivers[name]) throw new Error(`Unknown DB_DRIVER: ${name}`);
export const driver = drivers[name] as Driver;
/** CLI yönetim aracıdır: Neon (yalnızca runtime) için Bun SQL kullanır. (`packageCopy`'nin `name` parametresi bu dosyadaki `name`'i gölgeler.) */
const cliDriver = name === "neon" ? "bun" : name;

/** Direct URLs for management and fixtures. */
export const directConfig = () => loadConfig();
/** Transaction-pooled URLs (same databases, same credentials) for runtime tests. */
export const pooledConfig = () =>
  createConfig(
    process.env.TEST_POOLED_URLS ??
      "postgres://admin:local_admin_password@127.0.0.1:5543/db0,postgres://admin:local_admin_password@127.0.0.1:5543/db1",
  );

export const createTestManagement = (options: ManagementOptions = {}, config: Config = directConfig()) =>
  createManagement(config, { driver, placementCacheWaitMs: 1, unsafePlacementCacheWait: true, ...options });

/** Runtime through PgBouncer transaction pooling plus a direct management context. */
export function createTestRuntime(options: ManagementOptions = {}) {
  const management = createTestManagement(options);
  const app = createDatabase(pooledConfig(), { driver, ...options });
  return {
    ...app,
    management,
    async close() {
      await app.close();
      await management.close();
    },
  };
}

/** A fixture database with its own small pool on configured position `index` (or any URL). */
export function raw(index = 0, url = directConfig().nodes[index]?.url, max = 2) {
  if (!url) throw new Error(`Integration database ${index} missing`);
  return connect(driver(url, { max, idleTimeoutSeconds: 60, maxLifetimeSeconds: 600, connectTimeoutSeconds: 10 }), {
    deadlineMs: 60000,
    timeouts: { statementTimeoutMs: 60000, lockTimeoutMs: 10000 },
    maxPending: 256,
  });
}

/** `"schema"` or `"schema"."name"`. */
export const q = (schema: string, name?: string) =>
  name === undefined ? quoteIdentifier(schema) : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;

/** Tenant veri testlerinin sorguları: örnek tablolar yok, her tenant'ta Better Auth `users` tablosu var (id veritabanında üretilir). */
export const createUser = prepareQuery("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2, $3) RETURNING id::text AS id, name");
export const listUsers = prepareQuery("SELECT id::text AS id, name FROM users ORDER BY created_at, id LIMIT $1::integer OFFSET $2::integer");
/** `users.email` tekildir: her satıra ayrı adres. */
export const uniqueEmail = () => `${crypto.randomUUID()}@example.com`;

/** Paketin geçici kopyası (testler hariç; `packages/db-multi` altında, bağımlılıklar çözülür). Test-yerel migration ve seed kaynakları
 * buraya yazılır; `codegen` sonrası kopyanın CLI'si ve modülleri kendi registry'siyle çalışır, bu sürecin registry'si değişmez. */
export async function packageCopy(name: string) {
  const root = await mkdtemp(join(import.meta.dir, `../../../.tmp-${name}-`));
  await cp(join(import.meta.dir, "../.."), join(root, "src"), { recursive: true, filter: (path) => !path.includes("__tests__") });
  return {
    root,
    write: (path: string, source: string) => Bun.write(join(root, path), source),
    codegen: () => writeGenerated(root),
    /** Kopyada `src/core/cli.ts`; çıkış kodu 0 olmalı, son JSON satırı döner. */
    async cli(...args: string[]) {
      const child = Bun.spawn([process.execPath, "src/core/cli.ts", ...args, `--driver=${cliDriver}`], {
        cwd: root,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, `${args.join(" ")}: ${stderr}`).toBe(0);
      return JSON.parse(stdout.split(/\n(?=\{)/).at(-1) ?? "");
    },
    /** Kopyanın yönetim girişi: ayrı modül grafiği, dolayısıyla ayrı (test-yerel kaynakları içeren) registry. */
    management: () => import(join(root, "src/management.ts")) as Promise<typeof ManagementModule>,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

/** Başka bir registry ile (paket kopyası) kurulmuş tenant'ı iz bırakmadan siler: sonraki migrate-all drift görmesin. */
export async function forgetTenant(m: Management, tenantId: string) {
  for (const node of m.config.nodes) await m.pools.node(node.id).exec(`DROP SCHEMA IF EXISTS ${q(tenantSchema(tenantId))} CASCADE`);
  await m.pools.platform.query("DELETE FROM platform.placements WHERE tenant_id=$1", [tenantId]);
  await m.pools.platform.query("DELETE FROM platform.tenants WHERE tenant_id=$1", [tenantId]);
}

const TENANT_CLEANUP = [
  "DELETE FROM platform.move_targets t USING pg_catalog.jsonb_array_elements_text($1::text::jsonb) AS p(v) WHERE t.tenant_id=p.v OR pg_catalog.starts_with(t.tenant_id, p.v || '-')",
  "DELETE FROM platform.moves t USING pg_catalog.jsonb_array_elements_text($1::text::jsonb) AS p(v) WHERE t.tenant_id=p.v OR pg_catalog.starts_with(t.tenant_id, p.v || '-')",
  "DELETE FROM platform.placements t USING pg_catalog.jsonb_array_elements_text($1::text::jsonb) AS p(v) WHERE t.tenant_id=p.v OR pg_catalog.starts_with(t.tenant_id, p.v || '-')",
  "DELETE FROM platform.tenants t USING pg_catalog.jsonb_array_elements_text($1::text::jsonb) AS p(v) WHERE t.tenant_id=p.v OR pg_catalog.starts_with(t.tenant_id, p.v || '-')",
];
const SCHEMAS_BY_PREFIX =
  "SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements_text($1::text::jsonb) AS p(v) WHERE nspname=p.v OR pg_catalog.starts_with(nspname, p.v || '_'))";

/** Bu çalıştırmanın tenant'larını paylaşılan DB'lerden siler (`leak-guard.ts` kalanı yakalar). Her `prefix` tam ID'yi ve `prefix-…`
 * ID'lerini kapsar: taşıma kayıtları, placement ve tenant satırları, her node'daki tenant ve demo schema'ları. */
export async function removeTenants(m: Management, ...prefixes: string[]) {
  const ids = [JSON.stringify(prefixes)];
  await m.pools.platform.transaction(async (tx) => {
    for (const statement of TENANT_CLEANUP) await tx.query(statement, ids);
  });
  const schemas = [JSON.stringify(prefixes.flatMap(tenantSchemas))];
  for (const node of m.config.nodes) {
    const db = m.pools.node(node.id);
    for (const { name } of await db.query<{ name: string }>(SCHEMAS_BY_PREFIX, schemas)) await db.exec(`DROP SCHEMA ${q(name)} CASCADE`);
  }
}

/** Driver-independent failure code of a promise that must reject. */
export async function failure(promise: Promise<unknown>) {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => errorCode(error),
  );
  expect(outcome).toBeDefined();
  return outcome;
}
