import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { connect, createPools } from "../../core/database";
import type { Pool, Reserved } from "../../core/driver";
import { databaseUnavailable, errorCode } from "../../core/errors";
import { fakeDriver } from "../fixtures/fake-driver";

const settings = { deadlineMs: 150, maxPending: 4 };
const timeouts = { statementTimeoutMs: 150, lockTimeoutMs: 100 };
const poolOptions = { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 1, connectTimeoutSeconds: 1 };

test("runtime: a single query is one round trip on a reserved connection; transactions only BEGIN; values stay parameters", async () => {
  const fake = fakeDriver(() => [{ ok: 1 }]);
  const db = connect(fake.driver("postgres://h/one", poolOptions), settings);
  expect(await db.query("SELECT $1::text AS ok", ["'); DROP TABLE x; --"])).toEqual([{ ok: 1 }]);
  expect(fake.commands.map((c) => [c.text, c.params])).toEqual([["SELECT $1::text AS ok", ["'); DROP TABLE x; --"]]]);
  expect(fake.pools[0]?.released).toBe(1);
  await db.transaction((tx) => tx.exec("SELECT 1"));
  await db.transaction((tx) => tx.exec("SELECT 2"), { mode: " ISOLATION LEVEL REPEATABLE READ", statementTimeoutMs: 9 });
  expect(fake.commands.slice(1).map((c) => c.text)).toEqual([
    "BEGIN",
    "SELECT 1",
    "COMMIT",
    "BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL statement_timeout = 9",
    "SELECT 2",
    "COMMIT",
  ]);
});

test("deadlines share one timer: a burst of queries and transactions does not arm a timer per statement", async () => {
  const fake = fakeDriver(() => [{ ok: 1 }]);
  const db = connect(fake.driver("postgres://h/one", poolOptions), { ...settings, maxPending: 64 });
  await db.query("SELECT 0");
  const original = globalThis.setTimeout;
  let armed = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    armed++;
    return original(...args);
  }) as typeof setTimeout;
  try {
    for (let i = 0; i < 50; i++) await db.query("SELECT 1");
    await Promise.all(Array.from({ length: 50 }, () => db.transaction((tx) => tx.query("SELECT 2"))));
  } finally {
    globalThis.setTimeout = original;
  }
  expect(armed).toBeLessThanOrEqual(1);
  expect(fake.pools[0]?.released).toBe(101);
  await db.close();
});

test("management: every unit of work is one transaction with SET LOCAL timeouts", async () => {
  const fake = fakeDriver(() => [{ ok: 1 }]);
  const db = connect(fake.driver("postgres://h/one", poolOptions), { ...settings, timeouts });
  await db.query("SELECT 1");
  expect(fake.commands.map((c) => c.text)).toEqual([
    "BEGIN; SET LOCAL statement_timeout = 150; SET LOCAL lock_timeout = 100",
    "SELECT 1",
    "COMMIT",
  ]);
});

test("an expired acquisition never runs its work and returns the late connection unused", async () => {
  const fake = fakeDriver();
  const inner = fake.driver("postgres://h/one", poolOptions);
  let released = 0;
  const pool: Pool = {
    ...inner,
    reserve: async (): Promise<Reserved> => {
      await Bun.sleep(60);
      return { ...(await inner.reserve()), release: () => void released++ };
    },
  };
  const db = connect(pool, { ...settings, deadlineMs: 10 });
  await expect(db.query("INSERT INTO t VALUES (1)")).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  await Bun.sleep(100);
  expect(fake.commands).toEqual([]);
  expect(released).toBe(1);
});

test("server statement timeouts become DATABASE_TIMEOUT after rollback; other errors stay visible", async () => {
  const failure = Object.assign(new Error("duplicate key: Key (email)=(a@b.c) at 127.0.0.1"), { code: "23505" });
  const fake = fakeDriver((text) => {
    if (text.includes("sleep")) throw Object.assign(new Error("canceling statement"), { errno: "57014" });
    throw failure;
  });
  const db = connect(fake.driver("postgres://h/one", poolOptions), settings);
  await expect(db.query("SELECT pg_sleep(1)")).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  await expect(db.transaction((tx) => tx.query("SELECT pg_sleep(1)"))).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  expect(fake.commands.at(-1)?.text).toBe("ROLLBACK");
  const error = (await db.query("INSERT").catch((e: unknown) => e)) as Error;
  expect(error).toMatchObject({ code: "23505" });
  for (const secret of ["a@b.c", "127.0.0.1"]) expect(error.message).not.toContain(secret);
  expect(fake.pools[0]?.released).toBe(3);
});

/** Cevap deadline'ı + iptal beklemesi + zamanlayıcı ve olay döngüsü payı. */
const ANSWER_BOUND_MS = (deadlineMs: number) => deadlineMs + 1000 + 500 + 550;
const never = () => new Promise<never>(() => {});
/** `until` doğru olana kadar (en çok 5 sn) olay döngüsünü döndürür; sabit bekleme yok. */
const drain = async (until: () => boolean) => {
  const end = performance.now() + 5000;
  while (!until() && performance.now() < end) await new Promise((resolve) => setImmediate(resolve));
};
/** `BEGIN` sunucu bekleyen (PgBouncer arkasında DB kapalı) bağlantılar veren havuz. */
function beginWaitsPool() {
  const fake = fakeDriver();
  const inner = fake.driver("postgres://h/one", poolOptions);
  const pool: Pool = {
    ...inner,
    reserve: async () => {
      const connection = await inner.reserve();
      return { ...connection, exec: (text: string) => (text.startsWith("BEGIN") ? never() : connection.exec(text)) };
    },
  };
  return { fake, pool };
}

test("a statement past its answer deadline is cancelled, rejects DATABASE_TIMEOUT in bounded time and its connection is discarded", async () => {
  const fake = fakeDriver((text) => (text.includes("pg_sleep") ? never() : [{ ok: 1 }]));
  const db = connect(fake.driver("postgres://h/one", poolOptions), { deadlineMs: 50, maxPending: 4 });
  const started = performance.now();
  await expect(db.query("INSERT INTO t SELECT 1 FROM pg_sleep(10)")).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  expect(performance.now() - started).toBeLessThan(ANSWER_BOUND_MS(50));
  expect(fake.pools[0]).toMatchObject({ cancels: 1, released: 1, discarded: 1 });
  await expect(db.exec("CREATE TABLE x (); SELECT pg_sleep(10)")).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  expect(fake.pools[0]).toMatchObject({ cancels: 2, released: 2, discarded: 2 });
  await db.close();
});

test("an answer that arrives while the cancellation is pending is returned, and the connection is still not reused", async () => {
  let answer!: (rows: unknown[]) => void;
  const fake = fakeDriver((text) => (text.includes("pg_sleep") ? new Promise<unknown[]>((resolve) => (answer = resolve)) : []));
  const db = connect(fake.driver("postgres://h/one", poolOptions), { deadlineMs: 50, maxPending: 4 });
  const pending = db.query("UPDATE t SET n = n + 1 FROM pg_sleep(10) RETURNING n");
  await drain(() => fake.pools[0]?.cancels === 1);
  answer([{ n: 2 }]); // deyim iptal ulaşmadan commit etti: çağıran gerçek sonucu alır, görünmez yazım yok
  expect(await pending).toEqual([{ n: 2 }]);
  expect(fake.pools[0]).toMatchObject({ released: 1, discarded: 1 });
  await db.close();
});

test("BEGIN waiting for a backend is bounded: the body never runs and the connection is discarded", async () => {
  const { fake, pool } = beginWaitsPool();
  const db = connect(pool, { deadlineMs: 50, maxPending: 4 });
  let ran = false;
  const started = performance.now();
  await expect(
    db.transaction(async (tx) => {
      ran = true;
      await tx.query("INSERT INTO t VALUES (1)");
    }),
  ).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  expect(performance.now() - started).toBeLessThan(ANSWER_BOUND_MS(50));
  expect(ran).toBe(false);
  expect(fake.commands.map((command) => command.text)).toEqual([]);
  expect(fake.pools[0]).toMatchObject({ released: 1, discarded: 1 });
  await db.close();
});

test("a transaction statement past its deadline fails the transaction: no COMMIT or ROLLBACK on that connection, which is discarded", async () => {
  const fake = fakeDriver((text) => (text.includes("pg_sleep") ? never() : []));
  const db = connect(fake.driver("postgres://h/one", poolOptions), { deadlineMs: 50, maxPending: 4 });
  await expect(
    db.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES (1)");
      await tx.query("SELECT pg_sleep(10)");
    }),
  ).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  expect(fake.commands.map((command) => command.text)).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "SELECT pg_sleep(10)"]);
  expect(fake.pools[0]).toMatchObject({ cancels: 1, released: 1, discarded: 1 });
  // Uygulama hatası: ROLLBACK sağlam bağlantıda çalışır ve bağlantı havuza döner.
  await expect(db.transaction(async () => Promise.reject(new Error("app")))).rejects.toThrow("app");
  expect(fake.commands.slice(-2).map((command) => command.text)).toEqual(["BEGIN", "ROLLBACK"]);
  expect(fake.pools[0]).toMatchObject({ released: 2, discarded: 1 });
  await db.close();
});

test("pending work is finite", async () => {
  const fake = fakeDriver();
  const inner = fake.driver("postgres://h/one", poolOptions);
  const pool: Pool = { ...inner, reserve: () => new Promise<never>(() => {}) };
  const db = connect(pool, { ...settings, maxPending: 1 });
  const first = db.query("SELECT 1").catch((error: unknown) => error);
  await expect(db.query("SELECT 2")).rejects.toMatchObject({ code: "DATABASE_BUSY" });
  expect(await first).toMatchObject({ code: "DATABASE_TIMEOUT" });
});

test("the primary pool is created with the config URL and close closes it", async () => {
  const fake = fakeDriver();
  const config = createConfig("postgres://app@localhost/one");
  const pools = createPools({ ...config, idleTimeoutSeconds: 1, maxLifetimeSeconds: 1 }, fake.driver, 1, settings);
  expect(fake.pools.map((p) => p.url)).toEqual([config.url]);
  await pools.close();
  expect(fake.pools.every((p) => p.closed)).toBe(true);
  expect(() => pools.replica(0)).toThrow();
});

test("driver errors normalize to one SQLSTATE or connection code", () => {
  expect(errorCode(Object.assign(new Error("x"), { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" }))).toBe("23505");
  expect(errorCode(Object.assign(new Error("x"), { code: "23505" }))).toBe("23505");
  expect(errorCode(new Error("Connection terminated unexpectedly"))).toBe("CONNECTION_CLOSED");
  expect(errorCode(new Error("private postgres://user:secret@host"))).toBe("OPERATION_FAILED");
  for (const code of ["ERR_POSTGRES_CONNECTION_CLOSED", "CONNECTION_CLOSED", "ECONNREFUSED", "57P01", "08006"])
    expect(databaseUnavailable(Object.assign(new Error("x"), { code }))).toBe(true);
  expect(databaseUnavailable(new Error("Connection terminated unexpectedly"))).toBe(true);
  expect(databaseUnavailable(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
});
