/** Demo sıfırlama tekrar denemesi: `maintenance`'ta yarım kalmış bir sıfırlamadan sonra bile her çağrı, yıkıcı SQL'den önce placement
 * geçersiz kılar ve `placementCacheWaitMs`'in tamamını bekler. */
import { afterAll, beforeAll, expect } from "bun:test";
import { createManagement, type Management } from "../../core/management";
import { bootstrap, provisionTenant, resetDemoTenant } from "../../management";
import { directConfig, driver, enabled, integration, q, removeTenants } from "./helpers";

const WAIT_MS = 1500;
const tenantId = `reset-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let app: Management;
/** Her `onPlacementChange` çağrısının anı; `onChange` testin o anda yapacağı iş. */
const changes: number[] = [];
let onChange: (() => void) | undefined;

beforeAll(async () => {
  if (!enabled) return;
  app = createManagement(directConfig(), {
    driver,
    placementCacheWaitMs: WAIT_MS,
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

  // 1) İlk sıfırlama placement `maintenance` olur olmaz (önbellek beklemesinde) kesilir.
  const controller = new AbortController();
  onChange = () => controller.abort();
  const first = resetDemoTenant(app, tenantId, { signal: controller.signal });
  await expect(first).rejects.toBeDefined();
  onChange = undefined;
  expect(await app.platform.get(tenantId)).toMatchObject({ status: "maintenance", schemaVersion: provisioned.schemaVersion });
  expect(await markerExists()).toBe(true);

  // 2) Tekrar deneme: placement zaten `maintenance`; yine de geçersiz kılar ve beklemenin tamamı bitmeden hiçbir şey düşmez.
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
  // Tablo, geçersiz kılmadan en az WAIT_MS sonra hâlâ vardı (düşürme bekleme bitince oldu).
  expect(lastSeen - invalidatedAt).toBeGreaterThanOrEqual(WAIT_MS - 40);
  // schema_version=0 da bekleme bitmeden yazılmadı.
  expect(versions.filter((read) => read.at < invalidatedAt + WAIT_MS - 40 && read.schemaVersion === 0)).toEqual([]);
  expect(reset).toMatchObject({ tenantId, status: "active" });
  expect(await markerExists()).toBe(false);
});

integration("demo reset refuses a maintenance placement owned by an unfinished move and drops nothing", async () => {
  const id = `${tenantId}-mv`;
  const provisioned = await provisionTenant(app, id, "db0", { demo: true });
  const users = `${q(provisioned.schemaName)}.${q("users")}`;
  // Başarısız taşımanın bıraktığı durum: hedefte `maintenance`, sahibi taşıma kaydı.
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
