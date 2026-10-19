/** Unit tests without Redis: keys, LRU, single-flight, generation-based invalidation, fake pub/sub and fail-open. */
import { expect, test } from "bun:test";
import { createCache } from "../../cache";
import type { RedisClient } from "../../client";
import { createKeys, globalKey, tenantKey } from "../../keys";
import { createPlacementCache } from "../../placement";

/** Fake Redis shared across processes: only the commands the cache uses. */
function fakeRedis(store = new Map<string, string>(), listeners: ((channel: string, message: string) => void)[] = []) {
  const calls = { get: 0 };
  let down = false;
  const guard = () => {
    if (down) throw new Error("redis down");
  };
  const redis = {
    command: {
      get: async (key: string) => (guard(), calls.get++, store.get(key) ?? null),
      mget: async (...keys: string[]) => (guard(), calls.get++, keys.map((key) => store.get(key) ?? null)),
      set: async (key: string, value: string) => (guard(), store.set(key, value), "OK"),
      del: async (key: string) => (guard(), Number(store.delete(key))),
      incr: async (key: string) => (guard(), store.set(key, String(Number(store.get(key) ?? 0) + 1)), Number(store.get(key))),
      // The cache's two scripts: write/delete with INCR, and write with a version comparison.
      eval: async (script: string, _count: number, key: string, versionKey: string, value: string, _ttl: number, version: string) => {
        guard();
        if (script.includes("INCR")) {
          store.set(versionKey, String(Number(store.get(versionKey) ?? 0) + 1));
          if (value === "") store.delete(key);
          else store.set(key, value);
          return 1;
        }
        if ((store.get(versionKey) ?? "") !== version) return 0;
        store.set(key, value);
        return 1;
      },
      publish: async (channel: string, message: string) => (guard(), listeners.forEach((listen) => listen(channel, message)), listeners.length),
    },
    subscriber: {
      subscribe: async () => 1,
      unsubscribe: async () => 0,
      on: (_event: string, listen: (channel: string, message: string) => void) => listeners.push(listen),
      off: (_event: string, listen: (channel: string, message: string) => void) => void listeners.splice(listeners.indexOf(listen), 1),
    },
  } as unknown as Pick<RedisClient, "command" | "subscriber">;
  return { redis, store, calls, other: () => fakeRedis(store, listeners), setDown: (value: boolean) => (down = value) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("keys: tenant hash tag, global, prefix and validation", () => {
  expect(tenantKey("abc", "cache", 1)).toBe("t:{abc}:cache:1");
  expect(globalKey("x", "y")).toBe("g:x:y");
  expect(createKeys("app").tenant("abc-shop", "p")).toBe("app:t:{abc-shop}:p");
  expect(() => tenantKey("A}B", "x")).toThrow();
});

test("local LRU is bounded, expires and needs no Redis", async () => {
  const cache = createCache({ max: 2, localTtlMs: 30 });
  await cache.set("a", 1);
  await cache.set("b", 2);
  expect(await cache.get<number>("a")).toBe(1); // a is the newest
  await cache.set("c", 3); // b is evicted
  expect(await cache.get("b")).toBeUndefined();
  expect(await cache.get<number>("a")).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(await cache.get("a")).toBeUndefined();
});

test("wrap is single-flight and does not cache undefined", async () => {
  const { redis } = fakeRedis();
  const cache = createCache({ redis });
  let calls = 0;
  const loader = async () => (calls++, await tick(), { n: 1 });
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.wrap("k", loader)));
  expect(calls).toBe(1);
  expect(results.every((r) => r === results[0])).toBe(true);
  let misses = 0;
  await cache.wrap("none", async () => (misses++, undefined));
  await cache.wrap("none", async () => (misses++, undefined));
  expect(misses).toBe(2);
});

test("tenant generation invalidation and cross-process local invalidation", async () => {
  const one = fakeRedis();
  const two = one.other();
  const a = createCache({ redis: one.redis });
  const b = createCache({ redis: two.redis });
  await a.forTenant("abc").set("x", "v1");
  expect(await b.forTenant("abc").get<string>("x")).toBe("v1");
  await a.set("g", 1);
  expect(await b.get<number>("g")).toBe(1);
  await a.set("g", 2); // b's local entry is removed by the broadcast
  expect(await b.get<number>("g")).toBe(2);
  await a.invalidateTenant("abc");
  expect(await b.forTenant("abc").get("x")).toBeUndefined();
  expect(await a.forTenant("abc").wrap("x", () => "v2")).toBe("v2");
  expect(await a.forTenant("xyz").get("x")).toBeUndefined();
});

test("fails open when Redis is down", async () => {
  const fake = fakeRedis();
  const errors: unknown[] = [];
  const cache = createCache({ redis: fake.redis, onError: (error) => errors.push(error) });
  fake.setDown(true);
  expect(await cache.forTenant("abc").wrap("k", async () => 42)).toBe(42);
  await cache.invalidateTenant("abc");
  await cache.del("k");
  expect(errors.length).toBeGreaterThan(0);
});

test("placement cache: sync local hit, only active placements, invalidation", async () => {
  const fake = fakeRedis();
  const active = { tenantId: "abc", databaseId: "db1", kind: "tenant", schemaName: "tenant_abc", status: "active", schemaVersion: 1, placementVersion: 1 } as const;
  let status: "active" | "maintenance" = "active";
  let reads = 0;
  const db = { platform: { get: async () => (reads++, { ...active, status }) } } as never;
  const placements = createPlacementCache({ redis: fake.redis, db });
  expect(await placements("abc")).toBeUndefined();
  expect((await placements.loadPlacement("abc")).databaseId).toBe("db1");
  expect(placements("abc")).toEqual(active); // not a Promise
  expect(fake.store.has("t:{abc}:placement")).toBe(true);

  const other = createPlacementCache({ redis: fake.other().redis, db });
  expect(await other("abc")).toEqual(active); // Redis hit
  await placements.invalidatePlacement("abc");
  expect(other("abc")).toBeInstanceOf(Promise); // the local entry was removed by the broadcast
  status = "maintenance";
  expect((await other.loadPlacement("abc")).status).toBe("maintenance");
  expect(fake.store.has("t:{abc}:placement")).toBe(false); // a non-active placement is not written
  expect(reads).toBe(2);

  fake.store.set("t:{abc}:placement", JSON.stringify({ ...active, tenantId: "xyz" }));
  expect(await createPlacementCache({ redis: fake.other().redis, db })("abc")).toBeUndefined(); // an invalid record is rejected
});

test("tenant generations learned from pub/sub stay bounded by max: the oldest is evicted and re-read from Redis", async () => {
  const one = fakeRedis();
  const two = one.other();
  const listener = createCache({ redis: one.redis, max: 2 });
  const publisher = createCache({ redis: two.redis, max: 2 });
  for (const tenant of ["tenant-a", "tenant-b", "tenant-c"]) await publisher.invalidateTenant(tenant); // the listener learns generations from the broadcast
  const before = one.calls.get;
  await listener.forTenant("tenant-c").get("x"); // newest: the generation is local, the counter is not read (only the value is read)
  const newest = one.calls.get - before;
  await listener.forTenant("tenant-a").get("x"); // evicted: the generation counter is re-read from Redis
  expect(one.calls.get - before - newest).toBe(newest + 1);
  listener.close();
  publisher.close();
});
