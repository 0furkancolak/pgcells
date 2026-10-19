import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { createReplicaRouter, type StatusCache } from "../../core/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

type State = { inRecovery?: boolean; caughtUp?: boolean; lagMs?: number | null; fail?: string };
const PRIMARY = "postgres://p@h/d";
/** Replica state by URL; the primary always reports position `0/3000000`. */
function fixture(states: Record<string, State>, options: { maxLagMs?: number; statusMs?: number; sharedRotation?: boolean } = {}) {
  const urls = Object.keys(states);
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    const state = states[pool.url] ?? {};
    if (state.fail) throw Object.assign(new Error(`secret ${pool.url}`), { code: state.fail });
    return [{ in_recovery: state.inRecovery ?? true, caught_up: state.caughtUp ?? false, lag_ms: state.lagMs === undefined ? 50 : state.lagMs }];
  });
  const config = { ...createConfig(PRIMARY, urls), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 2, { deadlineMs: 1000, maxPending: 8 });
  let clock = 1000;
  const cache: StatusCache = new Map();
  const router = createReplicaRouter({
    pools,
    maxLagMs: options.maxLagMs ?? 1000,
    statusMs: options.statusMs ?? 5000,
    cache,
    ...(options.sharedRotation ? {} : { rotation: { turn: 0 } }),
    now: () => clock,
  });
  const probes = () => fake.commands.filter((command) => command.text.includes("pg_is_in_recovery")).length;
  const lsnReads = () => fake.commands.filter((command) => command.text.includes("pg_current_wal_lsn")).length;
  return { router, fake, probes, lsnReads, tick: (ms: number) => (clock += ms) };
}

const R1 = "postgres://r1@h/d";
const R2 = "postgres://r2@h/d";

test("pick rotates over usable replicas and pins nothing itself", async () => {
  const { router } = fixture({ [R1]: {}, [R2]: {} });
  const a = await router.pick();
  const b = await router.pick();
  const c = await router.pick();
  expect(a?.db).not.toBe(b?.db);
  expect(c?.db).toBe(a?.db);
});

test("a replica over the lag threshold or not in recovery is skipped; caught-up counts as zero lag", async () => {
  const { router } = fixture({ [R1]: { lagMs: 5000 }, [R2]: { inRecovery: false } });
  expect(await router.pick()).toBeUndefined();
  expect(await fixture({ [R1]: { caughtUp: true, lagMs: 999_999 } }).router.pick()).toBeDefined();
  expect(await fixture({ [R1]: { lagMs: null } }).router.pick()).toBeUndefined();
});

test("with usable and unusable replicas mixed, picks rotate over the usable ones by their own index", async () => {
  const [R3, R4] = ["postgres://r3@h/d", "postgres://r4@h/d"];
  const { router, fake } = fixture({ [R1]: { lagMs: 5000 }, [R2]: {}, [R3]: { fail: "ECONNREFUSED" }, [R4]: {} });
  const urls: (string | undefined)[] = [];
  for (let i = 0; i < 4; i++) {
    await (await router.pick())?.db.query("SELECT 1");
    urls.push(fake.commands.at(-1)?.url);
  }
  expect(urls).toEqual([R2, R4, R2, R4]);
});

test("with no replica configured pick finds nothing and probes nothing", async () => {
  const { router, probes } = fixture({});
  expect(await router.pick()).toBeUndefined();
  expect(await router.report()).toEqual([]);
  expect(probes()).toBe(0);
});

test("status is cached for statusMs and concurrent picks share one probe", async () => {
  const { router, probes, tick } = fixture({ [R1]: {} });
  await Promise.all([router.pick(), router.pick(), router.pick(), router.pick(), router.pick()]);
  expect(probes()).toBe(1);
  await router.pick();
  expect(probes()).toBe(1);
  tick(5001);
  await router.pick();
  expect(probes()).toBe(2);
});

test("a failing probe marks the replica down with the error code only, once per statusMs", async () => {
  const { router, probes, tick } = fixture({ [R1]: { fail: "ECONNREFUSED" } });
  expect(await router.pick()).toBeUndefined();
  expect(await router.pick()).toBeUndefined();
  expect(probes()).toBe(1);
  const [row] = await router.report();
  expect(row).toMatchObject({ replica: 1, up: false, usable: false, error: "ECONNREFUSED" });
  expect(JSON.stringify(row)).not.toContain("secret");
  tick(5001);
  await router.pick();
  expect(probes()).toBe(3); // report forced a refresh + a new probe after freshness
});

test("one refresh round reads the primary position once, however many replicas it probes", async () => {
  const R3 = "postgres://r3@h/d";
  const { router, probes, lsnReads, tick } = fixture({ [R1]: {}, [R2]: {}, [R3]: {} });
  await router.pick();
  expect([probes(), lsnReads()]).toEqual([3, 1]);
  await router.pick();
  expect([probes(), lsnReads()]).toEqual([3, 1]); // fresh: neither a replica nor the primary is queried
  tick(5001);
  await Promise.all([router.pick(), router.pick()]);
  expect([probes(), lsnReads()]).toEqual([6, 2]); // a concurrent second round shares the in-flight probes and does not ask the primary again
  await router.report();
  expect([probes(), lsnReads()]).toEqual([9, 3]);
});

test("a failing primary position read marks every probed replica down with the error code only", async () => {
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_current_wal_lsn")) throw Object.assign(new Error(`secret ${pool.url}`), { code: "ECONNRESET" });
    return [{ in_recovery: true, caught_up: true, lag_ms: 0 }];
  });
  const config = { ...createConfig(PRIMARY, [R1, R2]), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const router = createReplicaRouter({ pools: createPools(config, fake.driver, 2, { deadlineMs: 1000, maxPending: 8 }), maxLagMs: 1000, statusMs: 5000, cache: new Map(), rotation: { turn: 0 } });
  expect(await router.pick()).toBeUndefined();
  const rows = await router.report();
  expect(rows.map((row) => row.error)).toEqual(["ECONNRESET", "ECONNRESET"]);
  expect(JSON.stringify(rows)).not.toContain("secret");
});

test("markDown removes a replica until its status expires", async () => {
  const { router, tick } = fixture({ [R1]: {} });
  (await router.pick())?.markDown();
  expect(await router.pick()).toBeUndefined();
  tick(5001);
  expect(await router.pick()).toBeDefined();
});

test("report probes every replica fresh and lists 1-based numbers without URLs", async () => {
  const { router } = fixture({ [R1]: { lagMs: 10 }, [R2]: { lagMs: 5000 } });
  const rows = await router.report();
  expect(rows.map((row) => [row.replica, row.usable, row.lagMs])).toEqual([[1, true, 10], [2, false, 5000]]);
  expect(JSON.stringify(rows)).not.toContain("r1@h");
});

test("the default rotation is shared by routers, so per-request routers (Workers) do not all start on replica 1", async () => {
  const picked = async () => {
    const f = fixture({ [R1]: {}, [R2]: {} }, { sharedRotation: true });
    await (await f.router.pick())?.db.query("SELECT 1");
    return f.fake.commands.at(-1)?.url;
  };
  const first = await picked();
  const second = await picked();
  expect(first).toBeDefined();
  expect(second).not.toBe(first);
});
