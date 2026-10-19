/** `createDatabase({ region })` refuses tenants of other regions, and `regionGuard` turns that into 421 / 307 before any tenant data is touched. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDatabase, type RuntimeOptions } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import type { Placement } from "../../core/tenants/model";
import { createDbScope, regionGuard, type RequestDb } from "../../middleware";
import { fakeDriver } from "../fixtures/fake-driver";

const select = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const row = (region: string | null) => ({
  tenantId: "acme",
  databaseId: "db0",
  kind: "tenant",
  schemaName: "tenant_acme",
  status: "active",
  schemaVersion: 1,
  placementVersion: 1,
  residencyZone: null,
  region,
});

function database(nodeRegion: string | null, options: Partial<RuntimeOptions> = {}) {
  const fake = fakeDriver((text) => (text.includes("platform.placements") ? [row(nodeRegion)] : []));
  const db = createDatabase(createConfig(["postgres://u:p@h/a"]), { driver: fake.driver, pooler: "assumed", ...options });
  return { db, fake, queries: () => fake.commands.filter((command) => command.text.includes("students")).length };
}
const query = (db: ReturnType<typeof createDatabase>) => db.withTenant("acme", (t) => t.query(select, [crypto.randomUUID()]));

test("a tenant on a node in another region is refused with WRONG_REGION, and no tenant query is sent", async () => {
  const seen: Placement[] = [];
  const { db, queries } = database("us-east", { region: "eu-west", onWrongRegion: (placement) => void seen.push(placement) });
  const error = await query(db).then(
    () => undefined,
    (caught: unknown) => caught as { code: string; tenantRegion: string; appRegion: string },
  );
  expect(error).toMatchObject({ code: "WRONG_REGION", tenantRegion: "us-east", appRegion: "eu-west" });
  expect(queries()).toBe(0);
  expect(seen.map((placement) => [placement.tenantId, placement.region])).toEqual([["acme", "us-east"]]);
  await db.close();
});

test("reads are refused the same way", async () => {
  const { db, queries } = database("us-east", { region: "eu-west" });
  await expect(db.withTenantRead("acme", (t) => t.query(select, [crypto.randomUUID()]))).rejects.toMatchObject({ code: "WRONG_REGION" });
  expect(queries()).toBe(0);
  await db.close();
});

test("the same region, a node with no region, and an application without a region are all served", async () => {
  for (const [nodeRegion, appRegion] of [["eu-west", "eu-west"], [null, "eu-west"], ["us-east", undefined], [null, undefined]] as const) {
    const { db, queries } = database(nodeRegion, appRegion ? { region: appRegion } : {});
    await query(db);
    expect(queries()).toBe(1);
    await db.close();
  }
});

test("the application region must be a valid region name", () => {
  expect(() => database(null, { region: "EU West" })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

type Guarded = { get(key: "db"): RequestDb; req: { url: string } };
const context = (db: ReturnType<typeof createDatabase>): Guarded => {
  const scope = createDbScope(db, "acme");
  return { get: () => scope, req: { url: "https://acme.example.com/users?page=2" } };
};
const run = async (guard: ReturnType<typeof regionGuard<Guarded>>, c: Guarded) => {
  let reachedNext = false;
  const response = await guard(c, async () => void (reachedNext = true));
  return { response: response ?? undefined, reachedNext };
};

test("regionGuard answers 421 with the tenant's region and never reaches the route", async () => {
  const { db, queries } = database("us-east", { region: "eu-west" });
  const { response, reachedNext } = await run(regionGuard(), context(db));
  expect(reachedNext).toBe(false);
  expect(response?.status).toBe(421);
  expect(response?.headers.get("x-pgcells-region")).toBe("us-east");
  expect(await response?.json()).toEqual({ error: "WRONG_REGION", region: "us-east" });
  expect(queries()).toBe(0);
  await db.close();
});

test("regionGuard in redirect mode answers 307 to the located URL, and falls back to 421 without one", async () => {
  const { db } = database("us-east", { region: "eu-west" });
  const locate = (placement: Placement, c: Guarded) => `https://${placement.region}.example.com${new URL(c.req.url).pathname}`;
  const redirect = await run(regionGuard({ mode: "redirect", locate }), context(db));
  expect(redirect.response?.status).toBe(307);
  expect(redirect.response?.headers.get("location")).toBe("https://us-east.example.com/users");
  expect((await run(regionGuard({ mode: "redirect", locate: () => undefined }), context(db))).response?.status).toBe(421);
  expect((await run(regionGuard({ mode: "redirect" }), context(db))).response?.status).toBe(421);
  await db.close();
});

test("regionGuard calls its hook for a wrong-region request and passes right-region, region-less and single-region requests through", async () => {
  const hooked: string[] = [];
  const guard = regionGuard<Guarded>({ onWrongRegion: (placement) => void hooked.push(String(placement.region)) });
  const wrong = database("us-east", { region: "eu-west" });
  await run(guard, context(wrong.db));
  expect(hooked).toEqual(["us-east"]);
  for (const [nodeRegion, appRegion] of [["eu-west", "eu-west"], [null, "eu-west"], ["us-east", undefined]] as const) {
    const { db } = database(nodeRegion, appRegion ? { region: appRegion } : {});
    expect((await run(guard, context(db))).reachedNext).toBe(true);
    await db.close();
  }
  expect(hooked).toEqual(["us-east"]);
  await wrong.db.close();
});
