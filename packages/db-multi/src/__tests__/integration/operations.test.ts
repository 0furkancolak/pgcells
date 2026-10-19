import { afterAll, beforeAll, expect } from "bun:test";
import { bootstrap, type Management, migrateTenant, migrationStatus, provisionTenant } from "../../management";
import { startMove } from "../../core/tools/move";
import { createTestManagement, enabled, integration, q, removeTenants, uniqueEmail } from "./helpers";

let app: Management;
const prefix = `direct-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
beforeAll(async () => {
  if (enabled) {
    app = createTestManagement();
    await bootstrap(app);
  }
});
afterAll(async () => {
  if (!app) return;
  try {
    await removeTenants(app, prefix);
  } finally {
    await app.close();
  }
});
integration("direct provision is idempotent and migration preserves data", async () => {
  const id = `${prefix}-provision`;
  await provisionTenant(app, id, "db0");
  const p = await app.platform.get(id);
  const db = app.pools.node("db0");
  await db.query(`INSERT INTO ${q(p.schemaName, "users")} (name,email) VALUES ('Ada',$1)`, [uniqueEmail()]);
  await provisionTenant(app, id, "db0");
  expect(await migrateTenant(app, id)).toEqual({ tenantId: id, dryRun: false, migrations: [] });
  expect((await migrationStatus(app, id)).pending).toHaveLength(0);
  expect((await db.query<{ name: string }>(`SELECT name FROM ${q(p.schemaName, "users")}`))[0]?.name).toBe("Ada");
  expect((await app.platform.get(id)).status).toBe("active");
});
integration("move retains source, clears ownership and can move back after the retained schema is dropped", async () => {
  const id = `${prefix}-move`;
  await provisionTenant(app, id, "db0");
  const before = await app.platform.get(id);
  const source = app.pools.node(before.databaseId);
  const names = (db: typeof source, schema: string) =>
    db.query<{ name: string }>(`SELECT name FROM ${q(schema, "users")}`).then((rows) => rows[0]?.name);
  await source.query(`INSERT INTO ${q(before.schemaName, "users")} (name,email) VALUES ('Retained',$1)`, [uniqueEmail()]);
  const drained = true;
  const move = await startMove(app, id, "db1", drained);
  expect(move.status).toBe("completed");
  const after = await app.platform.get(id);
  expect(after.placementVersion).toBe(before.placementVersion + 1);
  expect(after.databaseId).toBe("db1");
  expect(after.status).toBe("active");
  expect(
    await app.pools.platform.query("SELECT move_operation_id AS owner FROM platform.placements WHERE tenant_id=$1", [id]),
  ).toEqual([{ owner: null }]);
  const target = app.pools.node(after.databaseId);
  expect(await names(target, after.schemaName)).toBe("Retained");
  expect(await names(source, before.schemaName)).toBe("Retained");
  // The retained source is never adopted: the reverse move stops with a
  // clear error, is rolled back, and succeeds after the documented DROP.
  let refused = "";
  await expect(
    startMove(app, id, "db0", drained, (m) => {
      refused = m.id;
    }),
  ).rejects.toMatchObject({ code: "TARGET_EXISTS" });
  const { rollbackMove } = await import("../../core/tools/move");
  await rollbackMove(app, refused, drained);
  await source.exec(`DROP SCHEMA ${q(before.schemaName)} CASCADE`);
  const back = await startMove(app, id, "db0", drained);
  expect(back.status).toBe("completed");
  const final = await app.platform.get(id);
  expect(final.databaseId).toBe("db0");
  expect(final.status).toBe("active");
  for (const db of [source, target])
    expect(await db.query("SELECT tenant_id FROM platform.move_targets WHERE tenant_id=$1", [id])).toHaveLength(0);
  expect(await names(source, before.schemaName)).toBe("Retained");
});
