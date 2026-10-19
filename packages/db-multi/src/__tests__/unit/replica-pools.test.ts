import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { fakeDriver } from "../fixtures/fake-driver";

const open = () => {
  const fake = fakeDriver();
  const config = { ...createConfig(["postgres://p@h/d"], "db0=postgres://r1@h/d,db0=postgres://r2@h/d"), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 3, { deadlineMs: 1000, maxPending: 8 });
  return { fake, pools };
};

test("replica pools open lazily, in config order, once, with the same pool size", () => {
  const { fake, pools } = open();
  expect(fake.pools.map((pool) => pool.url)).toEqual(["postgres://p@h/d"]); // yalnızca platform havuzu
  const first = pools.replicas("db0");
  expect(first).toHaveLength(2);
  expect(fake.pools.map((pool) => pool.url)).toEqual(["postgres://p@h/d", "postgres://r1@h/d", "postgres://r2@h/d"]);
  expect(fake.pools.slice(1).every((pool) => pool.options.max === 3)).toBe(true);
  expect(pools.replicas("db0")).toBe(first);
});

test("a node without replicas has an empty list and unknown nodes are rejected", () => {
  const fake = fakeDriver();
  const config = { ...createConfig(["postgres://p@h/d"]), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 3, { deadlineMs: 1000, maxPending: 8 });
  expect(pools.replicas("db0")).toEqual([]);
  expect(() => pools.replicas("db9")).toThrow(expect.objectContaining({ code: "DATABASE_NOT_FOUND" }));
});

test("close() closes replica pools too and later use is refused", async () => {
  const { fake, pools } = open();
  pools.replicas("db0");
  await pools.close();
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
  expect(() => pools.replicas("db0")).toThrow(expect.objectContaining({ code: "DATABASE_CLOSED" }));
});
