/** Region model: node metadata, filtered placement, residency zones and cross-region moves, against real databases (db0, db1). */
import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { bootstrap, type Management, provisionTenant } from "../../management";
import { exportTenant, restoreTenant } from "../../core/tools/backup";
import { startMove } from "../../core/tools/move";
import { type DatabaseSettings, listDatabases, setDatabase } from "../../core/tools/tenancy";
import { createTestManagement, enabled, failure, integration, removeTenants } from "./helpers";

let app: Management;
const prefix = `reg-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
let scratch = "";
const id = (name: string) => `${prefix}-${name}`;
const node = async (databaseId: string) => (await listDatabases(app)).find((row) => row.databaseId === databaseId);
/** db0: eu-west in zone eu; db1: us-east in zone us. */
const describeNodes = async () => {
  await setDatabase(app, "db0", { region: "eu-west", zone: "eu" });
  await setDatabase(app, "db1", { region: "us-east", zone: "us" });
};

beforeAll(async () => {
  if (!enabled) return;
  app = createTestManagement();
  await bootstrap(app);
  scratch = await mkdtemp(join(import.meta.dir, "../../../.tmp-regions-"));
});
/** Every test starts from plain databases and no tenants of its own. */
async function reset() {
  await removeTenants(app, prefix);
  for (const databaseId of ["db0", "db1"]) {
    const row = await node(databaseId);
    await setDatabase(app, databaseId, { region: "none", zone: "none", ...(row && Object.keys(row.labels).length ? { unlabel: Object.keys(row.labels) } : {}) });
  }
}
afterEach(async () => {
  if (app) await reset();
});
afterAll(async () => {
  if (!app) return;
  try {
    await reset();
  } finally {
    await app.close();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
});

integration("node metadata: region, zone and labels are stored, listed, changed and cleared", async () => {
  await setDatabase(app, "db1", { region: "eu-west", zone: "eu", labels: { tier: "gold", env: "prod" } });
  expect(await node("db1")).toMatchObject({ region: "eu-west", residencyZone: "eu", labels: { tier: "gold", env: "prod" } });
  await setDatabase(app, "db1", { labels: { tier: "silver" }, unlabel: ["env"] });
  expect((await node("db1"))?.labels).toEqual({ tier: "silver" });
  await setDatabase(app, "db1", { region: "none", zone: "none", unlabel: ["tier"] });
  expect(await node("db1")).toMatchObject({ region: null, residencyZone: null, labels: {} });
  // Existing behaviour is untouched.
  expect(await node("db1")).toMatchObject({ status: "active", capacity: expect.any(Number) });
});

integration("node metadata is validated, and an empty call is a usage error", async () => {
  const invalid: DatabaseSettings[] = [{ region: "EU West" }, { zone: "1eu" }, { region: "x".repeat(64) }, { labels: { Tier: "gold" } }, { labels: { tier: "Gold!" } }];
  for (const bad of invalid) expect(await failure(setDatabase(app, "db1", bad))).toBe("INVALID_CONFIG");
  expect(await failure(setDatabase(app, "db1", {}))).toBe("USAGE");
  expect(await failure(setDatabase(app, "db1", { labels: { a: "b" }, unlabel: ["a"] }))).toBe("USAGE");
  expect(await failure(setDatabase(app, "db9", { region: "eu-west" }))).toBe("DATABASE_NOT_FOUND");
});

integration("automatic placement honours region, zone and label requests; the placement carries region and residency zone", async () => {
  await describeNodes();
  const eu = await provisionTenant(app, id("eu"), undefined, { region: "eu-west" });
  expect(eu).toMatchObject({ databaseId: "db0", region: "eu-west", residencyZone: "eu" });
  const us = await provisionTenant(app, id("us"), undefined, { zone: "us" });
  expect(us).toMatchObject({ databaseId: "db1", region: "us-east", residencyZone: "us" });
  expect(await app.platform.get(id("us"))).toMatchObject({ databaseId: "db1", residencyZone: "us", region: "us-east" });
  expect(await failure(provisionTenant(app, id("none"), undefined, { region: "ap-south" }))).toBe("NO_CAPACITY");
  expect(await failure(provisionTenant(app, id("none"), undefined, { zone: "eu", region: "us-east" }))).toBe("NO_CAPACITY");
});

integration("an explicit database outside the requested zone is a residency violation; without a request the tenant inherits the node's zone", async () => {
  await describeNodes();
  expect(await failure(provisionTenant(app, id("wrong"), "db1", { zone: "eu" }))).toBe("RESIDENCY_VIOLATION");
  expect(await app.platform.get(id("wrong")).catch(() => "absent")).toBe("absent");
  const inherited = await provisionTenant(app, id("inherit"), "db1");
  expect(inherited.residencyZone).toBe("us");
  // Retrying with the same intent returns the same placement; a different zone is a conflict.
  expect((await provisionTenant(app, id("inherit"), "db1", { zone: "us" })).databaseId).toBe("db1");
  expect(await failure(provisionTenant(app, id("inherit"), undefined, { zone: "eu" }))).toBe("TENANT_CONFLICT");
});

integration("a database on no zone leaves the tenant unrestricted", async () => {
  await setDatabase(app, "db0", { region: "none", zone: "none" });
  await setDatabase(app, "db1", { region: "none", zone: "none" });
  const open = await provisionTenant(app, id("open"), "db0");
  expect(open.residencyZone ?? null).toBeNull();
  await setDatabase(app, "db1", { zone: "us" });
  const moved = await startMove(app, id("open"), "db1", true);
  expect(moved.status).toBe("completed");
  await startMove(app, id("open"), "db0", true);
});

integration("a database labelled dedicated=true is skipped by automatic choice unless the request names the label or the database", async () => {
  await describeNodes();
  // db0 is busy, so by load alone the next tenant would go to db1.
  await provisionTenant(app, id("busy"), "db0", { size: 60 });
  await setDatabase(app, "db1", { labels: { dedicated: "true" } });
  try {
    expect((await provisionTenant(app, id("auto"), undefined, { zone: "us" }).catch((error: unknown) => error)) as unknown).toMatchObject({ code: "NO_CAPACITY" });
    expect((await provisionTenant(app, id("auto-any"))).databaseId).toBe("db0");
    expect((await provisionTenant(app, id("asks"), undefined, { labels: { dedicated: "true" } })).databaseId).toBe("db1");
    expect((await provisionTenant(app, id("pinned"), "db1")).databaseId).toBe("db1");
  } finally {
    await setDatabase(app, "db1", { unlabel: ["dedicated"] });
  }
});

integration("changing a node's zone is refused while it hosts tenants bound to another zone, and allowed once they are gone", async () => {
  await describeNodes();
  await provisionTenant(app, id("bound"), "db0");
  expect(await failure(setDatabase(app, "db0", { zone: "us" }))).toBe("RESIDENCY_VIOLATION");
  expect((await node("db0"))?.residencyZone).toBe("eu");
  expect(await failure(setDatabase(app, "db0", { zone: "none" }))).toBe("RESIDENCY_VIOLATION");
  await removeTenants(app, id("bound"));
  await setDatabase(app, "db0", { zone: "eu" });
});

integration("a tenant never moves out of its residency zone; a move to another region of the same zone needs --allow-cross-region", async () => {
  await setDatabase(app, "db0", { region: "eu-west", zone: "eu" });
  await setDatabase(app, "db1", { region: "us-east", zone: "us" });
  await provisionTenant(app, id("stay"), "db0");
  expect(await failure(startMove(app, id("stay"), "db1", true))).toBe("RESIDENCY_VIOLATION");
  expect(await failure(startMove(app, id("stay"), "db1", true, undefined, { allowCrossRegion: true }))).toBe("RESIDENCY_VIOLATION");
  expect(await app.platform.get(id("stay"))).toMatchObject({ databaseId: "db0", status: "active" });

  // Same zone, different region: allowed, but only on request.
  await setDatabase(app, "db1", { zone: "eu", region: "eu-central" });
  expect(await failure(startMove(app, id("stay"), "db1", true))).toBe("CROSS_REGION_MOVE");
  const moved = await startMove(app, id("stay"), "db1", true, undefined, { allowCrossRegion: true });
  expect(moved.status).toBe("completed");
  expect(await app.platform.get(id("stay"))).toMatchObject({ databaseId: "db1", residencyZone: "eu", region: "eu-central" });
  // Back inside the same region needs no flag.
  await setDatabase(app, "db0", { region: "eu-central" });
  expect((await startMove(app, id("stay"), "db0", true)).status).toBe("completed");
});

integration("a backup keeps the tenant's residency zone, and restore refuses a database outside it", async () => {
  await describeNodes();
  await provisionTenant(app, id("backup"), "db0");
  const dir = join(scratch, "export");
  await exportTenant(app, id("backup"), dir);
  await removeTenants(app, id("backup"));
  expect(await failure(restoreTenant(app, id("backup"), dir, { databaseId: "db1" }))).toBe("RESIDENCY_VIOLATION");
  const restored = await restoreTenant(app, id("backup"), dir);
  expect(restored.placement).toMatchObject({ databaseId: "db0", residencyZone: "eu" });
});

integration("concurrent provisions in different regions each land in their own region", async () => {
  await describeNodes();
  const placed = await Promise.all([
    provisionTenant(app, id("race-eu-1"), undefined, { region: "eu-west" }),
    provisionTenant(app, id("race-us-1"), undefined, { region: "us-east" }),
    provisionTenant(app, id("race-eu-2"), undefined, { region: "eu-west" }),
    provisionTenant(app, id("race-us-2"), undefined, { region: "us-east" }),
  ]);
  expect(placed.map((p) => [p.tenantId.slice(prefix.length + 1), p.databaseId, p.residencyZone])).toEqual([
    ["race-eu-1", "db0", "eu"],
    ["race-us-1", "db1", "us"],
    ["race-eu-2", "db0", "eu"],
    ["race-us-2", "db1", "us"],
  ]);
});
