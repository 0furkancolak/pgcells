/** Demo reset retry: even after a reset left half-done in `maintenance`, every call invalidates the placement before the destructive SQL
 * and waits the full `placementCacheWaitMs`. */
import { afterAll, beforeAll, expect } from "bun:test";
import { createManagement, type Management } from "../../core/management";
import { bootstrap, provisionTenant, resetDemoTenant } from "../../management";
import { directConfig, driver, enabled, integration, q, removeTenants } from "./helpers";

const WAIT_MS = 1500;
const tenantId = `reset-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let app: Management;
/** The moment of each `onPlacementChange` call; `onChange` is the work the test does at that moment. */
const changes: number[] = [];
let onChange: (() => void) | undefined;

beforeAll(async () => {
  if (!enabled) return;
  app = createManagement(directConfig(), {
    driver,
    placementCacheWaitMs: WAIT_MS,
    unsafePlacementCacheWait: true,
    onPlacementChange: () => {
      changes.push(performance.now());
      onChange?.();
    },
  });
  await bootstrap(app);
});
afterAll(async () => {
  if (!app) return;
  try {
    await removeTenants(app, tenantId);
  } finally {
    await app.close();
  }
});

integration("an interrupted demo reset leaves maintenance; the retry still invalidates and waits the full cache drain before dropping", async () => {
  const provisioned = await provisionTenant(app, tenantId, "db0", { demo: true });
  const db = app.pools.node(provisioned.databaseId);
  const marker = `${q(provisioned.schemaName)}.${q("reset_marker")}`;
  await db.exec(`CREATE TABLE ${marker} (id integer)`);
  const markerExists = async () => (await db.query<{ exists: boolean }>("SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists", [marker]))[0]?.exists === true;

  // 1) The first reset is cut as soon as the placement becomes `maintenance` (during the cache wait).
  const controller = new AbortController();
  onChange = () => controller.abort();
  const first = resetDemoTenant(app, tenantId, { signal: controller.signal });
  await expect(first).rejects.toBeDefined();
  onChange = undefined;
  expect(await app.platform.get(tenantId)).toMatchObject({ status: "maintenance", schemaVersion: provisioned.schemaVersion });
  expect(await markerExists()).toBe(true);

  // 2) Retry: the placement is already `maintenance`; it still invalidates, and nothing is dropped before the whole wait is over.
  changes.length = 0;
  const started = performance.now();
  const retry = resetDemoTenant(app, tenantId);
  let lastSeen = started;
  const versions: { at: number; schemaVersion: number }[] = [];
  while (await markerExists()) {
    lastSeen = performance.now();
    if (changes.length) versions.push({ at: performance.now(), schemaVersion: (await app.platform.get(tenantId)).schemaVersion });
    await Bun.sleep(20);
  }
  const reset = await retry;
  const invalidatedAt = changes[0] ?? Number.POSITIVE_INFINITY;
  expect(changes.length).toBeGreaterThan(0);
  // The table was still there at least WAIT_MS after the invalidation (the drop happened once the wait ended).
  expect(lastSeen - invalidatedAt).toBeGreaterThanOrEqual(WAIT_MS - 40);
  // schema_version=0 was not written before the wait ended either.
  expect(versions.filter((read) => read.at < invalidatedAt + WAIT_MS - 40 && read.schemaVersion === 0)).toEqual([]);
  expect(reset).toMatchObject({ tenantId, status: "active" });
  expect(await markerExists()).toBe(false);
});

integration("demo reset refuses a maintenance placement owned by an unfinished move and drops nothing", async () => {
  const id = `${tenantId}-mv`;
  const provisioned = await provisionTenant(app, id, "db0", { demo: true });
  const users = `${q(provisioned.schemaName)}.${q("users")}`;
  // State left by a failed move: `maintenance` on the target, owned by the move record.
  await app.pools.platform.query("UPDATE platform.placements SET status='maintenance',move_operation_id=$1 WHERE tenant_id=$2", [crypto.randomUUID(), id]);
  try {
    await expect(resetDemoTenant(app, id)).rejects.toMatchObject({ code: "TENANT_UNAVAILABLE" });
    const [table] = await app.pools.node(provisioned.databaseId).query<{ exists: boolean }>("SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists", [users]);
    expect(table?.exists).toBe(true);
    expect(await app.platform.get(id)).toMatchObject({ status: "maintenance", schemaVersion: provisioned.schemaVersion });
  } finally {
    await app.pools.platform.query("UPDATE platform.placements SET status='active',move_operation_id=NULL WHERE tenant_id=$1", [id]);
  }
});
