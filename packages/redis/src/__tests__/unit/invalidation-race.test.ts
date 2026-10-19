/** Geçersiz kılma yarışları (Redis'siz, kontrollü Promise): uçuştaki Redis okuması ya da yükleyici, geçersiz kılmadan sonra yerel
 * katmanı ve Redis'i yeniden dolduramaz; pub/sub dinleyicileri kapatılınca birikmez. */
import { expect, test } from "bun:test";
import { createCache } from "../../cache";
import type { RedisClient } from "../../client";
import { createPlacementCache } from "../../placement";

type Gate = { open: () => void; wait: Promise<void> };
const gate = (): Gate => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
};

/** Süreçler arası paylaşılan sahte Redis. `holdNextRead` sonraki okumanın cevabını (okuma anındaki değer) kapıda tutar; `manual`
 * yayınları `deliver` çağrılana kadar bekletir. `eval` önbelleğin iki betiğini taklit eder. */
function fakeRedis() {
  const store = new Map<string, string>();
  const listeners = new Set<(channel: string, message: string) => void>();
  const queued: [string, string][] = [];
  const counts = { subscribe: 0, unsubscribe: 0 };
  let held: Gate | undefined;
  let manual = false;
  let readStarted = 0;
  const read = async <T>(value: T) => {
    readStarted++;
    const current = held;
    held = undefined;
    if (current) await current.wait;
    return value;
  };
  const publish = (channel: string, message: string) => {
    if (manual) queued.push([channel, message]);
    else for (const listen of listeners) listen(channel, message);
  };
  const command = {
    get: (key: string) => read(store.get(key) ?? null),
    mget: (...keys: string[]) => read(keys.map((key) => store.get(key) ?? null)),
    set: async (key: string, value: string) => (store.set(key, value), "OK"),
    del: async (key: string) => Number(store.delete(key)),
    incr: async (key: string) => (store.set(key, String(Number(store.get(key) ?? 0) + 1)), Number(store.get(key))),
    eval: async (script: string, _count: number, key: string, versionKey: string, value: string, _ttl: number, arg: string) => {
      if (script.includes("INCR")) {
        store.set(versionKey, String(Number(store.get(versionKey) ?? 0) + 1));
        if (value === "") store.delete(key);
        else store.set(key, value);
        return 1;
      }
      if ((store.get(versionKey) ?? "") !== arg) return 0;
      store.set(key, value);
      return 1;
    },
    publish: async (channel: string, message: string) => (publish(channel, message), listeners.size),
  };
  const subscriber = {
    subscribe: async () => (counts.subscribe++, 1),
    unsubscribe: async () => (counts.unsubscribe++, 0),
    on: (_event: string, listen: (channel: string, message: string) => void) => listeners.add(listen),
    off: (_event: string, listen: (channel: string, message: string) => void) => listeners.delete(listen),
    listenerCount: () => listeners.size,
  };
  const redis = { command, subscriber } as unknown as Pick<RedisClient, "command" | "subscriber">;
  return {
    redis,
    other: () => ({ command, subscriber: { ...subscriber } }) as unknown as Pick<RedisClient, "command" | "subscriber">,
    store,
    counts,
    listeners,
    holdNextRead: () => (held = gate()),
    readsStarted: () => readStarted,
    manualDelivery: () => (manual = true),
    deliver: () => {
      for (const [channel, message] of queued.splice(0)) for (const listen of listeners) listen(channel, message);
    },
  };
}

const flush = async (until: () => boolean = () => false) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((resolve) => setImmediate(resolve));
};

const active = { tenantId: "abc", databaseId: "db1", kind: "tenant", schemaName: "tenant_abc", status: "active", schemaVersion: 1, placementVersion: 1 } as const;
const KEY = "t:{abc}:placement";

test("an in-flight Redis GET answered after invalidation is not remembered (same process and pub/sub)", async () => {
  const fake = fakeRedis();
  for (const invalidateFrom of ["self", "other"] as const) {
    const reader = createPlacementCache({ redis: fake.redis, db: { platform: { get: async () => active } } as never });
    const writer = invalidateFrom === "self" ? reader : createPlacementCache({ redis: fake.other(), db: { platform: { get: async () => active } } as never });
    fake.store.set(KEY, JSON.stringify(active));
    const held = fake.holdNextRead();
    const before = fake.readsStarted();
    const pending = reader("abc");
    await flush(() => fake.readsStarted() > before);
    await writer.invalidatePlacement("abc"); // pub/sub ile okuyucunun nesli de ilerler
    held.open();
    expect(await pending).toBeUndefined();
    expect(reader("abc")).toBeInstanceOf(Promise); // yerel katmanda eski kayıt yok
    reader.close();
    writer.close();
  }
});

test("a wrap loader that resolves an old active placement after invalidation repopulates neither layer", async () => {
  const fake = fakeRedis();
  for (const invalidateFrom of ["self", "other", "other-late-pubsub"] as const) {
    fake.store.clear();
    let finishLoad!: (placement: typeof active) => void;
    let loads = 0;
    const db = { platform: { get: () => (loads++, new Promise<typeof active>((resolve) => (finishLoad = resolve))) } } as never;
    const loader = createPlacementCache({ redis: fake.redis, db });
    const writer = invalidateFrom === "self" ? loader : createPlacementCache({ redis: fake.other(), db });
    const loading = loader.loadPlacement("abc");
    await flush(() => loads === 1);
    if (invalidateFrom === "other-late-pubsub") fake.manualDelivery();
    await writer.invalidatePlacement("abc");
    finishLoad(active);
    expect(await loading).toEqual(active);
    await flush();
    expect(fake.store.has(KEY)).toBe(false); // Redis'e eski placement yazılmadı
    expect(loader("abc")).toBeInstanceOf(Promise); // yerel katman da boş (yayın henüz gelmemiş olsa bile)
    fake.deliver();
    // Geçersiz kılmadan sonra başlayan yükleme normal yazar.
    const fresh = loader.loadPlacement("abc");
    await flush(() => loads === 2);
    finishLoad(active);
    await fresh;
    await flush(() => fake.store.has(KEY));
    expect(fake.store.has(KEY)).toBe(true);
    expect(loader("abc")).toEqual(active);
    loader.close();
    writer.close();
  }
});

test("callers arriving after invalidation do not join the stale single flight", async () => {
  const fake = fakeRedis();
  const cache = createCache({ redis: fake.redis });
  const finish: ((value: string) => void)[] = [];
  const loader = () => new Promise<string>((resolve) => finish.push(resolve));
  const stale = cache.wrap("k", loader);
  await flush(() => finish.length === 1);
  await cache.del("k");
  const fresh = cache.wrap("k", loader);
  await flush(() => finish.length === 2);
  finish[0]?.("old");
  finish[1]?.("new");
  expect(await stale).toBe("old");
  expect(await fresh).toBe("new");
  await flush();
  expect(await cache.get<string>("k")).toBe("new");
  cache.close();
});

test("closing caches removes their message listeners and unsubscribes only with the last user of the channel", async () => {
  const fake = fakeRedis();
  const keeper = createCache({ redis: fake.redis });
  const baseline = fake.listeners.size;
  for (let i = 0; i < 50; i++) createCache({ redis: fake.redis }).close();
  expect(fake.listeners.size).toBe(baseline);
  expect(fake.counts.unsubscribe).toBe(0); // keeper hâlâ abone

  await keeper.set("g", 1);
  const other = createCache({ redis: fake.other() });
  expect(await other.get<number>("g")).toBe(1);
  await other.set("g", 2); // keeper'ın yerel kaydı yayınla silinmeli
  expect(await keeper.get<number>("g")).toBe(2);

  other.close(); // ayrı abone bağlantısı: kendi son kullanıcısı
  expect(fake.counts.unsubscribe).toBe(1);
  keeper.close();
  keeper.close(); // iki kez kapatmak güvenli
  expect(fake.listeners.size).toBe(0);
  expect(fake.counts.unsubscribe).toBe(2);
});
