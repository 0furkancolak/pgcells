import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import type { Driver } from "../../core/driver";
import { createDb } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import { createDbScope, dbMiddleware, type RequestDb } from "../../middleware";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@primary.example/app";
const REPLICA = "postgres://app:secret-pw@replica.example/app";
const select = prepareQuery("SELECT id FROM users WHERE id = $1::integer");
const insert = prepareQuery("INSERT INTO users (id) VALUES ($1::integer)");
const handler: Handler = (text) =>
  text.includes("pg_current_wal_lsn") ? [{ lsn: "0/1" }] : text.includes("pg_is_in_recovery") ? [{ in_recovery: true, caught_up: true, lag_ms: 0 }] : [];

test("the middleware puts a request scope with query, transaction and read on the context", async () => {
  const fake = fakeDriver(handler);
  let scope: RequestDb | undefined;
  const middleware = dbMiddleware({ driver: fake.driver, config: createConfig(PRIMARY), pooler: "assumed" });
  await middleware({ set: (_key, value) => void (scope = value) }, async () => {
    await scope?.query(select, [1]);
  });
  expect(Object.keys(scope ?? {}).sort()).toEqual(["query", "read", "transaction"]);
  expect(fake.commands.some((command) => command.text.includes('"public".users'))).toBe(true);
});

test("a shared database is opened once for many requests", async () => {
  const fake = fakeDriver(handler);
  const middleware = dbMiddleware({ driver: fake.driver, config: createConfig(PRIMARY), pooler: "assumed" });
  for (let i = 0; i < 3; i++) await middleware({ set: () => {} }, async () => {});
  expect(fake.pools).toHaveLength(1);
});

test("perRequest opens a one-connection pool per request and closes it after the response, also when the handler throws", async () => {
  const fake = fakeDriver(handler);
  const middleware = dbMiddleware({ driver: fake.driver, config: createConfig(PRIMARY), pooler: "assumed", perRequest: true });
  await middleware({ set: () => {} }, async () => {});
  await expect(middleware({ set: () => {} }, () => Promise.reject(new Error("handler failed")))).rejects.toThrow("handler failed");
  expect(fake.pools).toHaveLength(2);
  expect(fake.pools.every((pool) => pool.options.max === 1 && pool.closed)).toBe(true);
});

/** Havuz kapanışı `release()` çağrılana kadar bekleyen sürücü; `fail`: kapanış hata verir. */
function slowClose(fail = false) {
  const fake = fakeDriver(handler);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const driver: Driver = (url, options) => {
    const pool = fake.driver(url, options);
    return {
      ...pool,
      close: async (ms) => {
        await gate;
        await pool.close(ms);
        if (fail) throw new Error("close failed");
      },
    };
  };
  const middleware = dbMiddleware({ driver, config: createConfig(PRIMARY), pooler: "assumed", perRequest: true });
  return { fake, middleware, release };
}
const settled = (work: Promise<unknown>) => Promise.race([work.then(() => "returned"), Bun.sleep(25).then(() => "waiting")]);

test("perRequest hands the pool close to executionCtx.waitUntil: the response does not wait for it, the close still runs", async () => {
  const { fake, middleware, release } = slowClose();
  const waiting: Promise<unknown>[] = [];
  const c = { set: () => {}, executionCtx: { waitUntil: (work: Promise<unknown>) => void waiting.push(work) } };
  expect(await settled(middleware(c, async () => {}))).toBe("returned");
  expect(waiting).toHaveLength(1);
  expect(fake.pools[0]?.closed).toBe(false);
  release();
  await waiting[0];
  expect(fake.pools[0]?.closed).toBe(true);
});

test("a failing close behind waitUntil neither changes the response nor leaves an unhandled rejection", async () => {
  const { middleware, release } = slowClose(true);
  const waiting: Promise<unknown>[] = [];
  const c = { set: () => {}, executionCtx: { waitUntil: (work: Promise<unknown>) => void waiting.push(work) } };
  await middleware(c, async () => {});
  release();
  await expect(waiting[0]).resolves.toBeUndefined();
  // Hata gövdeden gelirse o olduğu gibi çıkar.
  const failing = slowClose();
  const again = { set: () => {}, executionCtx: { waitUntil: () => {} } };
  await expect(failing.middleware(again, async () => Promise.reject(new Error("handler failed")))).rejects.toThrow("handler failed");
});

test("without a usable execution context (none, or Hono's throwing getter) the response awaits the close", async () => {
  for (const c of [{ set: () => {} }, { set: () => {}, get executionCtx(): never { throw new Error("This context has no ExecutionContext"); } }]) {
    const { fake, middleware, release } = slowClose(true);
    const response = middleware(c, async () => {});
    expect(await settled(response)).toBe("waiting");
    release();
    await response;
    expect(fake.pools[0]?.closed).toBe(true);
  }
});

test("option combinations that make no sense are INVALID_CONFIG", () => {
  const fake = fakeDriver();
  const db = createDb(createConfig(PRIMARY), { driver: fake.driver, pooler: "assumed" });
  for (const options of [{}, { driver: fake.driver, database: db }, { database: db, perRequest: true }])
    expect(() => dbMiddleware(options as never)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

test("reads go to the replica until the same request writes, then stay on the primary", async () => {
  const fake = fakeDriver(handler);
  const db = createDb(createConfig(PRIMARY, [REPLICA]), { driver: fake.driver, pooler: "assumed", replicaStatusMs: 1 });
  const scope = createDbScope(db);
  await scope.read.query(select, [1]);
  await scope.query(insert, [1]);
  await scope.read.query(select, [1]);
  // Transaction içindeki yazı da sayılır.
  const tx = createDbScope(db);
  await tx.transaction(async (inner) => void (await inner.query(insert, [2])));
  await tx.read.query(select, [2]);
  const reads = fake.commands.filter((command) => command.text.startsWith("SELECT id FROM"));
  expect(reads.map((command) => command.url)).toEqual([REPLICA, PRIMARY, PRIMARY]);
  await db.close();
});

test("reads in one scope stay on the first replica; a fresh scope picks again", async () => {
  const second = "postgres://app:secret-pw@replica2.example/app";
  const fake = fakeDriver(handler);
  const db = createDb(createConfig(PRIMARY, [REPLICA, second]), { driver: fake.driver, pooler: "assumed", replicaStatusMs: 1 });
  const scope = createDbScope(db);
  await scope.read.query(select, [1]);
  await scope.read.query(select, [1]);
  await createDbScope(db).read.query(select, [1]);
  const urls = fake.commands.filter((command) => command.text.startsWith("SELECT id FROM")).map((command) => command.url);
  expect([urls[0] === urls[1], urls[2] === urls[0]]).toEqual([true, false]);
  await db.close();
});
