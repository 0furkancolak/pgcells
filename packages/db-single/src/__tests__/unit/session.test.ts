import { expect, jest, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { MIGRATION_KEY, openSession } from "../../core/locks";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

let port = 7000;
/** Doğrudan bağlantı sonucu URL başına önbelleğe alınır: her test yeni bir URL kullanır. */
function management(handler: Handler) {
  const fake = fakeDriver(handler);
  const app = createManagement(createConfig(`postgres://admin@127.0.0.1:${port++}/app`), { driver: fake.driver });
  return { app, fake };
}

test("a management session behind a transaction pooler fails fast before any session setting", async () => {
  const { app, fake } = management((text) => (text.includes("pg_backend_pid") ? [{ pid: 7 }] : []));
  await expect(openSession(app)).rejects.toMatchObject({ code: "DIRECT_CONNECTION_REQUIRED" });
  expect(fake.commands.some((c) => c.text.includes("set_config"))).toBe(false);
  expect(fake.pools.slice(1).every((p) => p.closed)).toBe(true);
  await app.close();
});

test("a direct session applies its own timeouts and application name once proven direct", async () => {
  const { app, fake } = management((text, _params, pool) =>
    text.includes("pg_backend_pid") ? [{ pid: 100 + pool.index }] : [],
  );
  const session = await openSession(app, { applicationName: "migration:x" });
  expect(session.pid).toBe(101);
  expect(fake.commands.find((c) => c.text.includes("set_config"))?.params).toEqual([
    "30000ms",
    "1000ms",
    "migration:x",
  ]);
  await session.close();
  expect(fake.pools.slice(1).every((p) => p.closed)).toBe(true);
  await app.close();
});

test("a driver-reported close rejects pending and later queries and never reconnects", async () => {
  let hang = false;
  const { app, fake } = management((text, _params, pool) => {
    if (text.includes("pg_backend_pid")) return [{ pid: 200 + pool.index }];
    return hang ? new Promise<never>(() => {}) : [];
  });
  const session = await openSession(app);
  hang = true;
  const pending = Array.from({ length: 16 }, () => session.db.query("SELECT pg_sleep(10)"));
  fake.pools[1]?.options.onClose?.();
  for (const outcome of await Promise.allSettled(pending)) expect(outcome.status).toBe("rejected");
  expect(session.signal.aborted).toBe(true);
  await expect(session.db.query("SELECT 1")).rejects.toMatchObject({ code: "LOCK_LOST" });
  expect(fake.pools[1]?.closed).toBe(true);
  expect(fake.pools).toHaveLength(3);
  await session.close();
  await app.close();
});

test("the migration lock is exclusive per connection and busy for a second holder, and release frees it", async () => {
  // `pg_locks` sorgusu da `pg_backend_pid()` içerir: önce o denetlenir.
  const { app } = management((text, _params, pool) => {
    if (text.includes("pg_locks")) return [{ pid: 301, held: true }];
    if (text.includes("pg_try_advisory_lock")) return [{ locked: true }];
    if (text.includes("pg_advisory_unlock")) return [{ unlocked: true }];
    if (text.includes("pg_backend_pid")) return [{ pid: 300 + pool.index }];
    return [];
  });
  const session = await openSession(app);
  const lock = await session.acquire(MIGRATION_KEY);
  await expect(session.acquire(MIGRATION_KEY)).rejects.toMatchObject({ code: "MIGRATION_RUNNER_BUSY" });
  await lock.release();
  await session.acquire(MIGRATION_KEY);
  await session.close();
  await app.close();
});

/** bun-types `advanceTimersByTime`'ı bildirmez; çalışma zamanında vardır. */
const advance = (ms: number) => (jest as unknown as { advanceTimersByTime(ms: number): void }).advanceTimersByTime(ms);

/** Sahte zamanlayıcı altında mikro görevleri boşaltır. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** `SELECT slow` 40 sn sonra cevap veren oturum; `watchdogMs` verilirse watchdog genişler. */
async function slowSession(watchdogMs?: number) {
  const { app } = management((text, _params, pool) => {
    if (text.includes("pg_backend_pid")) return [{ pid: 400 + pool.index }];
    return text === "SELECT slow" ? new Promise<{ ok: boolean }[]>((resolve) => setTimeout(() => resolve([{ ok: true }]), 40_000)) : [];
  });
  return { app, session: await openSession(app, { watchdogMs }) };
}

test("the default watchdog (statement timeout + 5 s) declares a statement slower than 35 s lost", async () => {
  jest.useFakeTimers();
  try {
    const { app, session } = await slowSession();
    const outcome = session.db.query("SELECT slow").then(() => "answered", (error: { code: string }) => error.code);
    advance(36_000);
    await flush();
    expect(await outcome).toBe("LOCK_LOST");
    await session.close();
    await app.close();
  } finally {
    jest.useRealTimers();
  }
});

test("watchdogMs widens the watchdog for one session so a long statement completes", async () => {
  jest.useFakeTimers();
  try {
    const { app, session } = await slowSession(3_605_000);
    const outcome = session.db.query("SELECT slow").then(() => "answered", (error: { code: string }) => error.code);
    advance(40_001);
    await flush();
    expect(await outcome).toBe("answered");
    expect(session.signal.aborted).toBe(false);
    await session.close();
    await app.close();
  } finally {
    jest.useRealTimers();
  }
});

const REFUSED = Object.assign(new Error("connect ECONNREFUSED db.internal.example:5432 for user admin"), { code: "ECONNREFUSED" });

test("an unreachable database surfaces the driver's own code even when the driver reports the close before the reserve rejects", async () => {
  const fake = fakeDriver();
  let opened = 0;
  const app = createManagement(createConfig(`postgres://admin@127.0.0.1:${port++}/app`), {
    driver: (url, options) => {
      const pool = fake.driver(url, options);
      // İlk havuz yönetim bağlamının birincilidir; ikincisi oturumun ayrılmış bağlantısıdır (Bun: onclose, reserve reddinden önce gelir).
      if (++opened < 2) return pool;
      return {
        ...pool,
        reserve: async () => {
          options.onClose?.();
          throw REFUSED;
        },
      };
    },
  });
  const error = await openSession(app).then(
    () => undefined,
    (caught: Error & { code?: string }) => caught,
  );
  expect(error).toMatchObject({ code: "ECONNREFUSED", message: "Database operation failed (ECONNREFUSED)" });
  await app.close();
});

test("a failing direct-connection probe surfaces only the driver code, never its message", async () => {
  const { app } = management((text, _params, pool) => {
    if (!text.includes("pg_backend_pid")) return [];
    if (pool.index === 2) throw REFUSED;
    return [{ pid: 500 }];
  });
  const error = await openSession(app).then(
    () => undefined,
    (caught: Error & { code?: string }) => caught,
  );
  expect(error).toMatchObject({ code: "ECONNREFUSED", message: "Database operation failed (ECONNREFUSED)" });
  await app.close();
});

/** Kapanışı host/kullanıcı içeren ham bir mesajla reddeden havuzlar (`only` ile seçilir); `handler` verilmezse doğrudan bağlantı. */
function failingClose(only: (options: { idleTimeoutSeconds?: number }) => boolean, handler: Handler = (text, _params, pool) => (text.includes("pg_backend_pid") ? [{ pid: 100 + pool.index }] : [])) {
  const fake = fakeDriver(handler);
  const driver: typeof fake.driver = (url, options) => ({
    ...fake.driver(url, options),
    close: () => (only(options) ? Promise.reject(Object.assign(new Error("connection to postgres://admin:secret@db.internal failed"), { code: "ECONNRESET" })) : Promise.resolve()),
  });
  return createManagement(createConfig(`postgres://admin@127.0.0.1:${port++}/app`), { driver });
}

test("a probe pool that fails to close never replaces the probe's own outcome", async () => {
  const pooled = failingClose((options) => options.idleTimeoutSeconds === 1, (text) => (text.includes("pg_backend_pid") ? [{ pid: 7 }] : []));
  await expect(openSession(pooled)).rejects.toMatchObject({ code: "DIRECT_CONNECTION_REQUIRED" });
  await pooled.close();
  const direct = failingClose((options) => options.idleTimeoutSeconds === 1);
  await (await openSession(direct)).close();
  await direct.close();
});

test("a session pool that fails to close still closes the session without an error", async () => {
  const app = failingClose((options) => options.idleTimeoutSeconds === 0);
  const session = await openSession(app);
  await session.close();
  await expect(session.db.query("SELECT 1")).rejects.toMatchObject({ code: "LOCK_LOST" });
  await app.close();
});
