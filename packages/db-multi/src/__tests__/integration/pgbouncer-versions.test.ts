/** PgBouncer version matrix: the same smoke and deadline checks against several PgBouncer releases. Off by default (it builds an image per release);
 * the CI matrix and a local loop set `PGBOUNCER_ALPINE` (3.19 -> 1.21, 3.21 -> 1.23, 3.22 -> 1.24) and optionally `PGBOUNCER_PREPARED` (`max_prepared_statements`). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { bunDriver } from "../../core/drivers/bun";
import { bootstrap, provisionTenant } from "../../management";
import { createDatabase } from "../../index";
import { createTestManagement, createUser, driver, enabled, listUsers, removeTenants, uniqueEmail } from "./helpers";
import { startPgbouncer } from "./pgbouncer-container";

const alpine = process.env.PGBOUNCER_ALPINE;
const prepared = Number(process.env.PGBOUNCER_PREPARED ?? 0);
const active = enabled && alpine !== undefined && Bun.which("docker") !== null;
const run = active ? test : test.skip;
const prefix = `ver-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const tenantId = `${prefix}-a`;
let management: ReturnType<typeof createTestManagement>;
let pooler: Awaited<ReturnType<typeof startPgbouncer>>;

beforeAll(async () => {
  if (!active) return;
  management = createTestManagement();
  await bootstrap(management);
  await provisionTenant(management, tenantId, "db0");
  pooler = await startPgbouncer({ alpine, maxPreparedStatements: prepared, port: 5562 });
});
afterAll(async () => {
  if (!active) return;
  await pooler?.stop();
  await removeTenants(management, prefix).catch(() => {});
  await management.close();
});

const open = (options: Record<string, unknown> = {}) => createDatabase(createConfig(pooler.urls), { driver, poolMax: 5, ...options });

run(`PgBouncer from alpine ${alpine} (max_prepared_statements ${prepared}): ready(), a tenant round trip and the console version`, async () => {
  const consolePool = bunDriver(pooler.consoleUrl, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 30, connectTimeoutSeconds: 5 });
  try {
    const [row] = await consolePool.query<{ version: string }>("SHOW VERSION");
    console.log(`PgBouncer ${row?.version} (alpine ${alpine}, max_prepared_statements ${prepared})`);
    expect(row?.version).toMatch(/^PgBouncer 1\.\d+\.\d+/);
  } finally {
    await consolePool.close(1000);
  }
  const db = open();
  try {
    await db.ready();
    const id = crypto.randomUUID();
    await db.withTenant(tenantId, (t) => t.query(createUser, [id, "Matrix", uniqueEmail()]));
    expect((await db.withTenant(tenantId, (t) => t.query<{ id: string }[]>(listUsers, [10, 0]))).map((r) => r.id)).toContain(id);
    // Transactions and concurrent use of the same pooled connections.
    await Promise.all(Array.from({ length: 40 }, () => db.withTenant(tenantId, (t) => t.transaction((tx) => tx.query(listUsers, [1, 0])))));
  } finally {
    await db.close();
  }
});

run("the application deadline wins over the server: a slow statement ends with DATABASE_TIMEOUT within statementTimeoutMs + 1.5 s", async () => {
  const db = open({ statementTimeoutMs: 2000 });
  try {
    await db.ready();
    const start = performance.now();
    await expect(db.pools.node("db0").query("SELECT pg_sleep(8)")).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(2000 + 1500 + 400);
  } finally {
    await db.close();
  }
});

run("the database-level statement_timeout (bootstrap) ends a slow statement through this PgBouncer, with DATABASE_TIMEOUT", async () => {
  const db = open({ statementTimeoutMs: 6000 });
  try {
    const start = performance.now();
    await expect(db.pools.node("db0").query("SELECT pg_sleep(8)")).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThan(4500);
    expect(elapsed).toBeLessThan(6500);
  } finally {
    await db.close();
  }
});
