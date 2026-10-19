import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { createReplicaRouter, type StatusCache } from "../../core/tenants/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

type State = { inRecovery?: boolean; caughtUp?: boolean; lagMs?: number | null; fail?: string };
/** Replica state by URL; the primary always reports position `0/3000000`. */
function fixture(states: Record<string, State>, options: { maxLagMs?: number; statusMs?: number; sharedRotation?: boolean } = {}) {
  const urls = Object.keys(states);
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    const state = states[pool.url] ?? {};
    if (state.fail) throw Object.assign(new Error(`secret ${pool.url}`), { code: state.fail });
    return [{ in_recovery: state.inRecovery ?? true, caught_up: state.caughtUp ?? false, lag_ms: state.lagMs === undefined ? 50 : state.lagMs }];
  });
  const config = { ...createConfig(["postgres://p@h/d"], urls.map((url) => `db0=${url}`)), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 2, { deadlineMs: 1000, maxPending: 8 });
  let clock = 1000;
  const cache: StatusCache = new Map();
  const router = createReplicaRouter({ pools, maxLagMs: options.maxLagMs ?? 1000, statusMs: options.statusMs ?? 5000, cache, ...(options.sharedRotation ? {} : { rotation: new Map<string, number>() }), now: () => clock });
  const probes = () => fake.commands.filter((command) => command.text.includes("pg_is_in_recovery")).length;
  return { router, fake, probes, tick: (ms: number) => (clock += ms), urls };
}

const R1 = "postgres://r1@h/d";
const R2 = "postgres://r2@h/d";

test("pick rotates over usable replicas and pins nothing itself", async () => {
  const { router } = fixture({ [R1]: {}, [R2]: {} });
  const a = await router.pick("db0");
  const b = await router.pick("db0");
  const c = await router.pick("db0");
  expect(a?.db).not.toBe(b?.db);
  expect(c?.db).toBe(a?.db);
});

test("a replica over the lag threshold or not in recovery is skipped; caught-up counts as zero lag", async () => {
  const { router } = fixture({ [R1]: { lagMs: 5000 }, [R2]: { inRecovery: false } });
  expect(await router.pick("db0")).toBeUndefined();
  const idle = fixture({ [R1]: { caughtUp: true, lagMs: 999_999 } });
  expect(await idle.router.pick("db0")).toBeDefined();
  const unknown = fixture({ [R1]: { lagMs: null } });
  expect(await unknown.router.pick("db0")).toBeUndefined();
});

test("status is cached for statusMs and concurrent picks share one probe", async () => {
  const { router, probes, tick } = fixture({ [R1]: {} });
  await Promise.all([router.pick("db0"), router.pick("db0"), router.pick("db0"), router.pick("db0"), router.pick("db0")]);
  expect(probes()).toBe(1);
  await router.pick("db0");
  expect(probes()).toBe(1);
  tick(5001);
  await router.pick("db0");
  expect(probes()).toBe(2);
});

test("a failing probe marks the replica down with the error code only, once per statusMs", async () => {
  const { router, probes, tick } = fixture({ [R1]: { fail: "ECONNREFUSED" } });
  expect(await router.pick("db0")).toBeUndefined();
  expect(await router.pick("db0")).toBeUndefined();
  expect(probes()).toBe(1);
  const [row] = await router.report(["db0"]);
  expect(row).toMatchObject({ databaseId: "db0", replica: 1, up: false, usable: false, error: "ECONNREFUSED" });
  expect(JSON.stringify(row)).not.toContain("secret");
  tick(5001);
  await router.pick("db0");
  expect(probes()).toBe(3); // report forced a refresh + a new probe after freshness
});

test("markDown removes a replica until its status expires", async () => {
  const { router, tick } = fixture({ [R1]: {} });
  const handle = await router.pick("db0");
  handle?.markDown();
  expect(await router.pick("db0")).toBeUndefined();
  tick(5001);
  expect(await router.pick("db0")).toBeDefined();
});

test("report probes every replica fresh and lists 1-based numbers without URLs", async () => {
  const { router } = fixture({ [R1]: { lagMs: 10 }, [R2]: { lagMs: 5000 } });
  const rows = await router.report(["db0"]);
  expect(rows.map((row) => [row.replica, row.usable, row.lagMs])).toEqual([[1, true, 10], [2, false, 5000]]);
  expect(JSON.stringify(rows)).not.toContain("r1@h");
});

test("the default rotation is shared by routers, so per-request routers (Workers) do not all start on replica 1", async () => {
  const picked = async () => {
    const f = fixture({ [R1]: {}, [R2]: {} }, { sharedRotation: true }); // new pool and router; the rotation shares the module-level default
    const handle = await f.router.pick("db0");
    await handle?.db.query("SELECT 1");
    return f.fake.commands.at(-1)?.url;
  };
  const first = await picked();
  const second = await picked();
  expect(first).toBeDefined();
  expect(second).not.toBe(first);
});
