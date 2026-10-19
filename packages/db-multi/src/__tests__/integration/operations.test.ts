import { afterAll, beforeAll, expect } from "bun:test";
import { bootstrap, type Management, migrateTenant, migrationStatus, provisionTenant } from "../../management";
import { startMove } from "../../core/tools/move";
import { movedSchemaName } from "../../core/tenants/model";
import { schemaExists } from "../../core/tenants/nodes";
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
integration("move fences the source under a retained name, clears ownership and moves back without manual cleanup", async () => {
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
  expect(move.phase).toBe("completed");
  const after = await app.platform.get(id);
  expect(after.placementVersion).toBe(before.placementVersion + 1);
  expect(after.databaseId).toBe("db1");
  expect(after.status).toBe("active");
  expect(
    await app.pools.platform.query("SELECT move_operation_id AS owner FROM platform.placements WHERE tenant_id=$1", [id]),
  ).toEqual([{ owner: null }]);
  const target = app.pools.node(after.databaseId);
  expect(await names(target, after.schemaName)).toBe("Retained");
  // The source keeps its data under a marker name; the tenant's own name is gone, so a stale writer fails with undefined_table.
  const retained = movedSchemaName(before.schemaName, move.id);
  expect(await names(source, retained)).toBe("Retained");
  expect(await schemaExists(source, before.schemaName)).toBe(false);
  // The name is free again: the reverse move needs no DROP and leaves a second retained copy on db1.
  const back = await startMove(app, id, "db0", drained);
  expect(back.status).toBe("completed");
  const final = await app.platform.get(id);
  expect(final.databaseId).toBe("db0");
  expect(final.status).toBe("active");
  for (const db of [source, target])
    expect(await db.query("SELECT tenant_id FROM platform.move_targets WHERE tenant_id=$1", [id])).toHaveLength(0);
  expect(await names(source, before.schemaName)).toBe("Retained");
  expect(await names(target, movedSchemaName(after.schemaName, back.id))).toBe("Retained");
});
