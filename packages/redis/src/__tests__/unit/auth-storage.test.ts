/** Redis'siz `createAuthStorage`: geriye uyumlu önekler, TTL, atomik `getAndDelete` / `increment` sözleşmesi, fail-open ve span'ler. */
import { expect, test } from "bun:test";
import type { Span } from "@0furkancolak/pgcells";
import { createAuthStorage } from "../../auth-storage";
import type { RedisClient } from "../../client";

/** Yalnızca auth deposunun kullandığı komutlar; `eval` artırma betiğinin davranışını taklit eder. */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const calls: unknown[][] = [];
  let down = false;
  const guard = (...call: unknown[]) => {
    calls.push(call);
    if (down) throw new Error("redis down");
  };
  const command = {
    get: async (key: string) => (guard("get", key), store.get(key) ?? null),
    getdel: async (key: string) => {
      guard("getdel", key);
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    set: async (key: string, value: string, ...rest: unknown[]) => (guard("set", key, value, ...rest), store.set(key, value), "OK"),
    del: async (key: string) => (guard("del", key), Number(store.delete(key))),
    eval: async (_script: string, _keys: number, key: string, ttl: number) => {
      guard("eval", key, ttl);
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      if (next === 1) ttls.set(key, ttl);
      return next;
    },
  };
  return { redis: { command } as unknown as Pick<RedisClient, "command">, store, ttls, calls, setDown: (value: boolean) => (down = value) };
}

test("key prefixes match the previous application format: tenant:<tenantId>:<authType>: and tenant:<authType>:app: for the platform; prefix overrides", async () => {
  const { redis, store } = fakeRedis();
  await createAuthStorage(redis, { authType: "student", tenantId: "chitchat" }).set("token-1", "{}");
  await createAuthStorage(redis, { authType: "panel" }).set("token-2", "{}");
  await createAuthStorage(redis, { authType: "user", prefix: "custom:" }).set("token-3", "{}");
  expect([...store.keys()]).toEqual(["tenant:chitchat:student:token-1", "tenant:panel:app:token-2", "custom:token-3"]);
  expect(() => createAuthStorage(redis, { authType: "Student", tenantId: "chitchat" })).toThrow("authType");
  expect(() => createAuthStorage(redis, { authType: "user", tenantId: "Bad_Id" })).toThrow();
});

test("get/set/delete/getAndDelete round-trip with TTL in seconds; increment sets the TTL only on creation", async () => {
  const { redis, calls, ttls } = fakeRedis();
  const storage = createAuthStorage(redis, { authType: "user", tenantId: "acme" });
  await storage.set("s", "v", 60);
  await storage.set("p", "v");
  expect(calls.slice(0, 2)).toEqual([
    ["set", "tenant:acme:user:s", "v", "EX", 60],
    ["set", "tenant:acme:user:p", "v"],
  ]);
  expect(await storage.get("s")).toBe("v");
  expect(await storage.getAndDelete("s")).toBe("v");
  expect(await storage.getAndDelete("s")).toBeNull();
  await storage.delete("p");
  expect(await storage.get("p")).toBeNull();
  expect([await storage.increment("rl", 10), await storage.increment("rl", 99), await storage.increment("rl", 99)]).toEqual([1, 2, 3]);
  expect(ttls.get("tenant:acme:user:rl")).toBe(10);
});

test("Redis down: reads miss and writes are skipped, a revocation fails loudly, increment counts locally; errors go to onError and spans", async () => {
  const { redis, setDown } = fakeRedis();
  const errors: unknown[] = [];
  const spans: Span[] = [];
  const storage = createAuthStorage(redis, { authType: "teacher", tenantId: "acme", onError: (error) => errors.push(error), onSpan: (span) => void spans.push(span) });
  await storage.set("k", "v");
  expect(await storage.get("k")).toBe("v");
  setDown(true);
  expect(await storage.get("k")).toBeNull();
  expect(await storage.getAndDelete("k")).toBeNull();
  expect(await storage.set("k", "w", 5)).toBeUndefined();
  await expect(storage.delete("k")).rejects.toMatchObject({ code: "AUTH_STORAGE_UNAVAILABLE" });
  expect(await storage.increment("rl", 10)).toBe(1);
  expect(errors).toHaveLength(5);
  expect(spans.map((span) => `${span.name}:${span.detail ?? ""}:${span.error ?? ""}`)).toEqual([
    "auth.storage.set::",
    "auth.storage.get:hit:",
    "auth.storage.get:miss:OPERATION_FAILED",
    "auth.storage.getAndDelete:miss:OPERATION_FAILED",
    "auth.storage.set::OPERATION_FAILED",
    "auth.storage.delete::OPERATION_FAILED",
    "auth.storage.increment:local:OPERATION_FAILED",
  ]);
  expect(spans.every((span) => span.tenantId === "acme")).toBe(true);
  const throwing = createAuthStorage(redis, { authType: "user", onError: () => { throw new Error("handler"); } });
  expect(await throwing.get("k")).toBeNull();
});

test("a tenant auth type named app is refused: tenant foo + app would share the platform prefix of auth type foo", () => {
  const { redis } = fakeRedis();
  expect(() => createAuthStorage(redis, { authType: "foo" })).not.toThrow(); // tenant:foo:app:
  expect(() => createAuthStorage(redis, { authType: "app", tenantId: "foo" })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" })); // tenant:foo:app:
  expect(() => createAuthStorage(redis, { authType: "app" })).not.toThrow(); // platform: tenant:app:app:
  expect(() => createAuthStorage(redis, { authType: "app", tenantId: "foo", prefix: "custom:" })).not.toThrow(); // tam önek çağıranındır
});

test("a session delete that fails is reported, and the session never silently becomes valid again in this process", async () => {
  const { redis, store, setDown } = fakeRedis();
  const errors: unknown[] = [];
  const storage = createAuthStorage(redis, { authType: "user", tenantId: "revoke", onError: (error) => errors.push(error) });
  await storage.set("session-1", '{"userId":"u1"}', 3600);
  setDown(true);
  await expect(storage.delete("session-1")).rejects.toMatchObject({ code: "AUTH_STORAGE_UNAVAILABLE" }); // çıkış başarılı görünmez
  setDown(false); // Redis geri geldi; kayıt Redis'te hâlâ duruyor
  expect(store.has("tenant:revoke:user:session-1")).toBe(true);
  expect(await createAuthStorage(redis, { authType: "user", tenantId: "revoke" }).get("session-1")).toBeNull(); // süreçteki başka örnek de
  expect(await storage.getAndDelete("session-1")).toBeNull();
  expect(store.has("tenant:revoke:user:session-1")).toBe(false); // silme yeniden denendi
  expect(errors).toHaveLength(1);
  // Aynı anahtar yeniden yazılırsa (yeni oturum) maske kalkar.
  await storage.set("session-1", '{"userId":"u2"}', 60);
  expect(await storage.get("session-1")).toBe('{"userId":"u2"}');
});

test("a revocation that failed while Redis was down is retried by the next successful command, even for another key", async () => {
  const { redis, store, setDown } = fakeRedis();
  const storage = createAuthStorage(redis, { authType: "student", tenantId: "retry", onError: () => {} });
  await storage.set("old-session", "{}", 3600);
  setDown(true);
  await expect(storage.delete("old-session")).rejects.toBeDefined();
  setDown(false);
  await storage.set("other", "{}", 60);
  for (let i = 0; i < 20 && store.has("tenant:retry:student:old-session"); i++) await new Promise((resolve) => setImmediate(resolve));
  expect(store.has("tenant:retry:student:old-session")).toBe(false);
});

test("the local rate-limit fallback is per Redis client, like the revocation mask: two clients count the same key separately", async () => {
  const first = fakeRedis();
  const second = fakeRedis();
  first.setDown(true);
  second.setDown(true);
  const options = { authType: "user", tenantId: "twoclients", onError: () => {} };
  const migrating = createAuthStorage(first.redis, options);
  const target = createAuthStorage(second.redis, options);
  const key = "sign-in:203.0.113.9";
  expect([await migrating.increment(key, 60), await migrating.increment(key, 60)]).toEqual([1, 2]);
  // İkinci istemci aynı anahtarı sıfırdan sayar: çift yazımda kullanıcı yapılandırılan denemenin yarısında kilitlenmez.
  expect([await target.increment(key, 60), await target.increment(key, 60)]).toEqual([1, 2]);
  expect(await migrating.increment(key, 60)).toBe(3);
  // Aynı istemcinin ikinci deposu sayacı paylaşır (süreç içi pencere istemci başınadır).
  expect(await createAuthStorage(first.redis, options).increment(key, 60)).toBe(4);
});

test("while Redis is down the rate limit keeps counting locally (bounded) instead of allowing every request", async () => {
  const { redis, setDown } = fakeRedis();
  const storage = createAuthStorage(redis, { authType: "user", tenantId: "limits", onError: () => {} });
  setDown(true);
  const counts: number[] = [];
  for (let i = 0; i < 5; i++) counts.push(await storage.increment("sign-in:203.0.113.7", 60));
  expect(counts).toEqual([1, 2, 3, 4, 5]); // yapılandırılmış sınır (ör. 3) kesintide de aşılır ve istek reddedilir
  setDown(false);
  expect(await storage.increment("sign-in:203.0.113.7", 60)).toBe(1); // Redis dönünce normal Redis sayacı
  setDown(true);
  for (let i = 0; i < 10_000; i++) await storage.increment(`flood-${i}`, 60);
  expect(await storage.increment("sign-in:198.51.100.9", 60)).toBe(Number.MAX_SAFE_INTEGER); // yedek dolu: yeni anahtar sınırı aşmış sayılır
  expect(await storage.increment("flood-1", 60)).toBe(2); // mevcut sayaçlar sayılmaya devam eder
});
