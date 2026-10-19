import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://u:p@primary.example/app";
const R1 = "postgres://u:p@r1.example/app";
const R2 = "postgres://u:p@r2.example/app";
const settings = { deadlineMs: 1000, maxPending: 8 };
const withLimits = (config = createConfig(PRIMARY, [R1, R2])) => ({ ...config, idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 });

test("the primary pool opens at creation; each replica pool opens only when that index is first used, once", () => {
  const { driver, pools } = fakeDriver();
  const set = createPools(withLimits(), driver, 3, settings);
  expect(pools.map((pool) => pool.url)).toEqual([PRIMARY]);
  expect(pools[0]?.options).toMatchObject({ max: 3, idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 });
  const second = set.replica(1);
  expect(set.replica(1)).toBe(second);
  expect(pools.map((pool) => pool.url)).toEqual([PRIMARY, R2]);
  set.replica(0);
  expect(pools.map((pool) => pool.url)).toEqual([PRIMARY, R2, R1]);
  expect(set.replicaUrls).toEqual([R1, R2]);
});

test("without replicas no extra pool is ever opened", () => {
  const { driver, pools } = fakeDriver();
  const set = createPools(withLimits(createConfig(PRIMARY)), driver, 2, settings);
  expect(set.replicaUrls).toEqual([]);
  expect(pools).toHaveLength(1);
});

test("close closes only the opened pools; afterwards replica() is refused with DATABASE_CLOSED", async () => {
  const { driver, pools } = fakeDriver();
  const set = createPools(withLimits(createConfig(PRIMARY, [R1, R2, "postgres://u:p@r3.example/app"])), driver, 2, settings);
  set.replica(2);
  await set.close();
  expect(pools.map((pool) => [pool.url, pool.closed])).toEqual([[PRIMARY, true], ["postgres://u:p@r3.example/app", true]]);
  expect(() => set.replica(0)).toThrow(expect.objectContaining({ code: "DATABASE_CLOSED" }));
  expect(pools).toHaveLength(2);
});

test("concurrent close calls share one close: both settle after every pool closed, each pool closes once", async () => {
  const { driver, pools } = fakeDriver();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: typeof driver = (url, options) => {
    const pool = driver(url, options);
    return { ...pool, close: async (ms) => { await gate; await pool.close(ms); } };
  };
  const set = createPools(withLimits(), slow, 2, settings);
  set.replica(0);
  const first = set.close();
  let secondDone = false;
  const second = set.close().then(() => (secondDone = true));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(secondDone).toBe(false);
  release();
  await Promise.all([first, second]);
  expect(pools.every((pool) => pool.closed)).toBe(true);
  expect(pools).toHaveLength(2);
});

test("a failing pool close surfaces only the driver code, never its message", async () => {
  const { driver } = fakeDriver();
  const failing: typeof driver = (url, options) => ({
    ...driver(url, options),
    close: () => Promise.reject(Object.assign(new Error("terminate connection to db.internal.example as admin"), { code: "57P01" })),
  });
  const error = await createPools(withLimits(createConfig(PRIMARY)), failing, 2, settings)
    .close()
    .then(
      () => undefined,
      (caught: Error) => caught,
    );
  expect(error).toMatchObject({ code: "57P01", message: "Database operation failed (57P01)" });
});

test("spans carry no database identifier, only name, timing, detail and error code", async () => {
  const spans: Record<string, unknown>[] = [];
  const { driver } = fakeDriver(() => [{ ok: true }]);
  const set = createPools(withLimits(createConfig(PRIMARY)), driver, 2, { ...settings, onSpan: (span) => void spans.push({ ...span }) });
  await set.primary.query("SELECT 1");
  expect(spans.map((span) => span.name)).toEqual(["db.acquire", "db.query"]);
  for (const span of spans) {
    expect(Object.keys(span)).toEqual(expect.arrayContaining(["name", "ms", "startTime"]));
    expect(Object.keys(span).filter((key) => !["name", "startTime", "ms", "detail", "error"].includes(key))).toEqual([]);
  }
  await set.close();
});
