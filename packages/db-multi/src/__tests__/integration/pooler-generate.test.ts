/** The generated pgbouncer.ini is accepted by a real PgBouncer, and a runtime pointed at its aliases passes `ready()` and runs tenant queries. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { bootstrap, provisionTenant } from "../../management";
import { createDatabase } from "../../index";
import { createTestManagement, createUser, driver, enabled, listUsers, removeTenants, uniqueEmail } from "./helpers";
import { startPgbouncer } from "./pgbouncer-container";

const docker = enabled && Bun.which("docker") !== null;
const run = docker ? test : test.skip;
const prefix = `gen-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
let management: ReturnType<typeof createTestManagement>;
let pooler: Awaited<ReturnType<typeof startPgbouncer>>;

beforeAll(async () => {
  if (!docker) return;
  management = createTestManagement();
  await bootstrap(management);
  pooler = await startPgbouncer({ port: 5561 });
});
afterAll(async () => {
  if (!docker) return;
  await pooler?.stop();
  await removeTenants(management, prefix).catch(() => {});
  await management.close();
});

run("a runtime behind the generated PgBouncer config passes ready() and serves tenant queries through the aliases", async () => {
  const tenantId = `${prefix}-a`;
  await provisionTenant(management, tenantId, "db0");
  const db = createDatabase(createConfig(pooler.urls), { driver });
  try {
    await db.ready(); // identities, and the transaction-pooler probe
    const id = crypto.randomUUID();
    await db.withTenant(tenantId, (t) => t.query(createUser, [id, "Through generated", uniqueEmail()]));
    const rows = await db.withTenant(tenantId, (t) => t.query<{ id: string }[]>(listUsers, [10, 0]));
    expect(rows.map((row) => row.id)).toContain(id);
  } finally {
    await db.close();
  }
});
