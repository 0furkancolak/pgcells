/** The region model against two simulated regions (compose.regions.yaml): wrong-region requests, a directory partition, and the cost of crossing the ocean.
 * Run with `REGIONS_STACK=1` and the stack up; the latency is simulated, so real-network timings stay "not verified". */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { failoverClass } from "../../core/failover";
import { setDatabase } from "../../core/tools/tenancy";
import type { Driver } from "../../core/driver";
import { bootstrap, createManagement, type Management, provisionTenant } from "../../management";
import { createDatabase, type Database } from "../../index";
import { createDbScope, regionGuard } from "../../middleware";
import { available, config, directUrls, euUrls, path, paths, regionsEnabled, resetPaths, usUrls } from "./regions-fixture";
import { createUser, driver, uniqueEmail } from "./helpers";

const run = regionsEnabled ? test : test.skip;
const SEA_MS = 40; // one way; a round trip is 80 ms
let management: Management;
const opened: Database[] = [];
const prefix = `rs-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const eu = `${prefix}-eu`;
const us = `${prefix}-us`;

/** A driver that records the URL of every statement, so a test can prove which databases a request touched. */
function recordingDriver(): { driver: Driver; touched: () => Set<string> } {
  const urls = new Set<string>();
  const recording: Driver = (url, options) => {
    const pool = driver(url, options);
    const note = (text: string) => !/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text) && urls.add(url);
    return {
      ...pool,
      query: ((text: string, params?: readonly unknown[]) => (note(text), pool.query(text, params))) as typeof pool.query,
      exec: (text: string) => (note(text), pool.exec(text)),
      reserve: async () => {
        const reserved = await pool.reserve();
        return {
          ...reserved,
          query: ((text: string, params?: readonly unknown[]) => (note(text), reserved.query(text, params))) as typeof reserved.query,
          exec: (text: string) => (note(text), reserved.exec(text)),
          release: (discard?: boolean) => reserved.release(discard),
          ...(reserved.cancel ? { cancel: () => reserved.cancel?.() } : {}),
        };
      },
    };
  };
  return { driver: recording, touched: () => urls };
}
function app(region: "eu-west" | "us-east", extra: Record<string, unknown> = {}) {
  const recorder = recordingDriver();
  const db = createDatabase(config(region === "eu-west" ? euUrls : usUrls), { driver: recorder.driver, pooler: "assumed", region, poolMax: 3, statementTimeoutMs: 3000, ...extra });
  opened.push(db);
  return { db, touched: recorder.touched };
}
const add = (db: Database, tenant: string) => db.withTenant(tenant, (t) => t.query(createUser, [crypto.randomUUID(), "Region", uniqueEmail()]));

beforeAll(async () => {
  if (!regionsEnabled) return;
  if (!(await available())) throw new Error("Start the stack: docker compose -p pgcells-regions -f compose.regions.yaml up -d --wait");
  await resetPaths();
  management = createManagement(config(directUrls), { driver, placementCacheWaitMs: 1, unsafePlacementCacheWait: true });
  await bootstrap(management);
  await setDatabase(management, "db0", { region: "eu-west", zone: "eu" });
  await setDatabase(management, "db1", { region: "eu-west", zone: "eu" });
  await setDatabase(management, "db2", { region: "us-east", zone: "us" });
  await provisionTenant(management, eu, "db1", { zone: "eu" });
  await provisionTenant(management, us, undefined, { zone: "us" });
});
afterEach(async () => {
  if (regionsEnabled) await resetPaths();
});
afterAll(async () => {
  if (!regionsEnabled) return;
  await resetPaths().catch(() => {});
  for (const db of opened) await db.close().catch(() => {});
  const { removeTenants } = await import("./helpers");
  await removeTenants(management, prefix).catch(() => {});
  for (const id of ["db0", "db1", "db2"]) await setDatabase(management, id, { region: "none", zone: "none" }).catch(() => {});
  await management.close();
});

run("zones decide placement: the eu tenant is on an eu database, the us tenant on db2", async () => {
  expect(await management.platform.get(eu)).toMatchObject({ databaseId: "db1", residencyZone: "eu", region: "eu-west" });
  expect(await management.platform.get(us)).toMatchObject({ databaseId: "db2", residencyZone: "us", region: "us-east" });
});

run("a request for an eu tenant that reaches the us application is refused before any data is touched; the guard answers 421 or 307", async () => {
  await Promise.all(paths.map((name) => path(name).latency(SEA_MS)));
  const { db, touched } = app("us-east");
  await expect(add(db, eu)).rejects.toMatchObject({ code: "WRONG_REGION", tenantRegion: "eu-west", appRegion: "us-east" });
  // Only the directory was read (db0, across the ocean); the tenant's own cell (db1) was never queried.
  expect(touched().has(usUrls[0] as string)).toBe(true);
  expect(touched().has(usUrls[1] as string)).toBe(false);

  const scope = createDbScope(db, eu);
  const context = { get: () => scope, req: { url: `https://${eu}.example.com/users` } };
  const refused = await regionGuard<typeof context>()(context, async () => {});
  expect((refused as Response).status).toBe(421);
  const redirected = await regionGuard<typeof context>({ mode: "redirect", locate: (placement) => `https://${placement.region}.example.com/users` })(context, async () => {});
  expect((redirected as Response).status).toBe(307);
  expect((redirected as Response).headers.get("location") ?? "").toBe("https://eu-west.example.com/users");
  // The us tenant is served locally.
  await add(db, us);
});

run("crossing the ocean has a price: a cold placement read from the us application pays the round trip to the directory, a cached one does not", async () => {
  await path("us-to-dir").latency(SEA_MS);
  const { db } = app("us-east");
  await db.ready();
  const cold = performance.now();
  await db.placement(us);
  const coldMs = performance.now() - cold;
  const warm = performance.now();
  await db.placement(us);
  const warmMs = performance.now() - warm;
  console.log(`placement read across the simulated ocean: cold ${Math.round(coldMs)} ms, cached ${warmMs.toFixed(2)} ms (round trip ${SEA_MS * 2} ms)`);
  expect(coldMs).toBeGreaterThanOrEqual(SEA_MS * 2 - 10);
  expect(warmMs).toBeLessThan(5);
});

run("the directory is unreachable from the us application: a cached tenant keeps working for the stale window, an uncached one fails with a classified error, and it heals", async () => {
  const { db } = app("us-east", { placementCacheMs: 200, staleIfErrorMs: 20_000 });
  await add(db, us); // warm
  await Bun.sleep(300); // the cached placement has expired
  await path("us-to-dir").partition();
  const start = performance.now();
  await add(db, us); // served by the stale placement; the tenant's own cell (db2) is local and reachable
  expect(performance.now() - start).toBeLessThan(5000);
  // Another application without stale-if-error cannot resolve the expired placement at all.
  const strict = app("us-east", { placementCacheMs: 200 });
  const failure = await add(strict.db, us).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeDefined();
  expect(["unreachable", "timeout"]).toContain(failoverClass(failure) ?? "");
  await path("us-to-dir").reset();
  await add(strict.db, us);
});

run("provisioning into the other region from a management process in eu works across the ocean and costs visibly more", async () => {
  await path("eu-to-us").latency(SEA_MS);
  const remote = createManagement(config(euUrls), { driver, placementCacheWaitMs: 1, unsafePlacementCacheWait: true });
  try {
    const local = performance.now();
    await provisionTenant(remote, `${prefix}-near`, undefined, { region: "eu-west" });
    const nearMs = performance.now() - local;
    const far = performance.now();
    await provisionTenant(remote, `${prefix}-far`, undefined, { region: "us-east" });
    const farMs = performance.now() - far;
    console.log(`provision: eu-west cell ${Math.round(nearMs)} ms, us-east cell across the simulated ocean ${Math.round(farMs)} ms`);
    expect((await remote.platform.get(`${prefix}-far`)).databaseId).toBe("db2");
    expect(farMs).toBeGreaterThan(nearMs);
  } finally {
    await remote.close();
  }
});
