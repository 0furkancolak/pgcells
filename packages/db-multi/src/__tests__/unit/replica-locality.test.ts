/** Replica locality: with an application region, only replicas in that region are used; a replica without a row lives in its node's region. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { createReplicaRegionLoader, createReplicaRouter, type ReplicaRegions, type StatusCache } from "../../core/tenants/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

const R1 = "postgres://r1@h/d";
const R2 = "postgres://r2@h/d";
const R3 = "postgres://r3@h/d";

function fixture(regions: ReplicaRegions | (() => Promise<ReplicaRegions>), region: string | undefined, urls = [R1, R2, R3]) {
  const fake = fakeDriver((text) => (text.includes("pg_current_wal_lsn") ? [{ lsn: "0/3000000" }] : [{ in_recovery: true, caught_up: true, lag_ms: 0 }]));
  const config = { ...createConfig(["postgres://p@h/d"], urls.map((url) => `db0=${url}`)), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 2, { deadlineMs: 1000, maxPending: 8 });
  const cache: StatusCache = new Map();
  const router = createReplicaRouter({
    pools,
    maxLagMs: 1000,
    statusMs: 5000,
    cache,
    rotation: new Map<string, number>(),
    ...(region ? { region, regions: typeof regions === "function" ? regions : async () => regions } : {}),
  });
  const urlOf = (handle: Awaited<ReturnType<typeof router.pick>>) => config.nodes[0]?.replicas[pools.replicas("db0").indexOf(handle?.db as never)];
  return { router, urlOf };
}

test("with an application region only replicas in that region are picked, round-robin among them", async () => {
  const { router, urlOf } = fixture({ db0: [{ region: "eu-west" }, { region: "us-east" }, { region: "eu-west" }] }, "eu-west");
  const picked = [urlOf(await router.pick("db0")), urlOf(await router.pick("db0")), urlOf(await router.pick("db0")), urlOf(await router.pick("db0"))];
  expect(new Set(picked)).toEqual(new Set([R1, R3]));
  expect(picked[0]).not.toBe(picked[1]);
});

test("when no replica is in the application's region nothing is picked, so the read policy decides (primary or error)", async () => {
  const { router } = fixture({ db0: [{ region: "us-east" }, { region: "ap-south" }, { region: "us-east" }] }, "eu-west");
  expect(await router.pick("db0")).toBeUndefined();
});

test("a replica whose region is unknown (a node with no region) is not excluded", async () => {
  const { router, urlOf } = fixture({ db0: [{ region: null }, { region: "us-east" }, { region: "us-east" }] }, "eu-west");
  expect(urlOf(await router.pick("db0"))).toBe(R1);
});

test("a down replica in the right region does not make a far replica eligible", async () => {
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/1" }];
    if (pool.url === R1) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    return [{ in_recovery: true, caught_up: true, lag_ms: 0 }];
  });
  const config = { ...createConfig(["postgres://p@h/d"], [R1, R2].map((url) => `db0=${url}`)), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const router = createReplicaRouter({
    pools: createPools(config, fake.driver, 2, { deadlineMs: 1000, maxPending: 8 }),
    maxLagMs: 1000,
    statusMs: 5000,
    cache: new Map(),
    rotation: new Map(),
    region: "eu-west",
    regions: async () => ({ db0: [{ region: "eu-west" }, { region: "us-east" }] }),
  });
  expect(await router.pick("db0")).toBeUndefined();
});

test("without an application region replica regions are ignored and the directory is never read", async () => {
  let reads = 0;
  const { router } = fixture(async () => {
    reads++;
    return { db0: [{ region: "us-east" }, { region: "us-east" }, { region: "us-east" }] };
  }, undefined);
  expect(await router.pick("db0")).toBeDefined();
  expect(reads).toBe(0);
});

test("if the regions cannot be read, a regional application uses no replica rather than guessing", async () => {
  const { router } = fixture(async () => {
    throw new Error("directory down");
  }, "eu-west");
  expect(await router.pick("db0")).toBeUndefined();
});

test("the region loader maps node and replica rows, defaults a missing replica row to the node's region, and caches for the TTL", async () => {
  let clock = 0;
  let reads = 0;
  const platform = {
    query: async () => {
      reads++;
      return [
        { databaseId: "db0", nodeRegion: "eu-west", ordinal: 2, region: "us-east" },
        { databaseId: "db0", nodeRegion: "eu-west", ordinal: null, region: null },
        { databaseId: "db1", nodeRegion: null, ordinal: null, region: null },
      ];
    },
  };
  const load = createReplicaRegionLoader(platform as never, { "db0": 3, "db1": 1 }, 5000, () => clock);
  const first = await load();
  expect(first.db0).toEqual([{ region: "eu-west" }, { region: "us-east" }, { region: "eu-west" }]);
  expect(first.db1).toEqual([{ region: null }]);
  await Promise.all([load(), load()]);
  expect(reads).toBe(1);
  clock = 6000;
  await load();
  expect(reads).toBe(2);
});
