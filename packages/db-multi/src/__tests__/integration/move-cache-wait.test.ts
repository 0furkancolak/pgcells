/** A move waits for the cache duration after the placement becomes `migrating` and before copying data (for processes without hooks). */
import { afterAll, beforeAll, expect } from "bun:test";
import { startMove } from "../../core/tools/move";
import { bootstrap, provisionTenant } from "../../management";
import { createTestManagement, enabled, integration, removeTenants } from "./helpers";

const WAIT_MS = 1500;
let app: ReturnType<typeof createTestManagement>;
const tenantId = `wait-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
beforeAll(async () => {
  if (!enabled) return;
  app = createTestManagement({ placementCacheWaitMs: WAIT_MS });
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

integration("move waits placementCacheWaitMs with the placement already migrating before copying", async () => {
  await provisionTenant(app, tenantId, "db0");
  const statuses: string[] = [];
  const started = Date.now();
  const moving = startMove(app, tenantId, "db1", true);
  // Sample the placement while the move waits: routing already refuses it, so no cached `active` copy can be refreshed.
  while (Date.now() - started < WAIT_MS - 300) {
    const p = await app.platform.get(tenantId);
    statuses.push(p.status);
    await Bun.sleep(100);
  }
  await moving;
  expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS);
  expect(statuses.at(-1)).toBe("migrating");
  expect(await app.platform.get(tenantId)).toMatchObject({ databaseId: "db1", status: "active" });
});
