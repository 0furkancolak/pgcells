/** Fencing: once a move cuts over, the source schema is renamed, so a process still holding the old placement cannot write to the abandoned copy. */
import { afterAll, beforeAll, expect } from "bun:test";
import { bootstrap, provisionTenant } from "../../management";
import { movedSchemaName } from "../../core/tenants/model";
import { startMove } from "../../core/tools/move";
import type { TenantContext } from "../../index";
import { createTestRuntime, createUser, enabled, failure, integration, listUsers, q, removeTenants, uniqueEmail } from "./helpers";

let app: ReturnType<typeof createTestRuntime>;
const prefix = `fence-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
beforeAll(async () => {
  if (!enabled) return;
  // The runtime caches `active` placements for 5 s, long enough to stay stale across the whole test.
  app = createTestRuntime({ placementCacheWaitMs: 1 });
  await bootstrap(app.management);
});
afterAll(async () => {
  if (!app) return;
  try {
    await removeTenants(app.management, prefix);
  } finally {
    await app.close();
  }
});

const add = (db: TenantContext, name: string) => db.query(createUser, [crypto.randomUUID(), name, uniqueEmail()]);

integration("a stale writer is refused with undefined_table after the move, and the abandoned copy keeps its rows", async () => {
  const id = `${prefix}-stale`;
  await provisionTenant(app.management, id, "db0");
  await app.withTenant(id, (db) => add(db, "Before")); // warms this process's placement cache with db0
  const before = await app.management.platform.get(id);
  const move = await startMove(app.management, id, "db1", true);

  // This process was not told (no onPlacementChange), so it still routes to db0, where the tenant's own schema name is gone.
  expect(await failure(app.withTenant(id, (db) => add(db, "Stale write")))).toBe("42P01");
  expect(await failure(app.withTenant(id, (db) => db.query(listUsers, [10, 0])))).toBe("42P01");

  const source = app.management.pools.node("db0");
  const retained = await source.query<{ name: string }>(`SELECT name FROM ${q(movedSchemaName(before.schemaName, move.id), "users")} ORDER BY name`);
  expect(retained.map((row) => row.name)).toEqual(["Before"]);
  const target = app.management.pools.node("db1");
  expect((await target.query<{ name: string }>(`SELECT name FROM ${q(before.schemaName, "users")}`)).map((row) => row.name)).toEqual(["Before"]);
});
