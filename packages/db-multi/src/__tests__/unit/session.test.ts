import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { openSession } from "../../core/operations/locks";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

let port = 7000;
/** Direct-connection results are cached per URL, so every test uses a fresh one. */
function management(handler: Handler) {
  const fake = fakeDriver(handler);
  const app = createManagement(createConfig([`postgres://admin@127.0.0.1:${port++}/app`]), { driver: fake.driver });
  return { app, fake };
}

test("a management session behind a transaction pooler fails fast before any session setting", async () => {
  const { app, fake } = management((text) => (text.includes("pg_backend_pid") ? [{ pid: 7 }] : []));
  await expect(openSession(app, "db0")).rejects.toMatchObject({ code: "DIRECT_CONNECTION_REQUIRED" });
  expect(fake.commands.some((c) => c.text.includes("set_config"))).toBe(false);
  expect(fake.pools.slice(1).every((p) => p.closed)).toBe(true);
  await app.close();
});

test("a direct session applies its own timeouts and application name once proven direct", async () => {
  const { app, fake } = management((text, _params, pool) =>
    text.includes("pg_backend_pid") ? [{ pid: 100 + pool.index }] : [],
  );
  const session = await openSession(app, "db0", { applicationName: "tenant-migration:x" });
  expect(session.pid).toBe(101);
  expect(fake.commands.find((c) => c.text.includes("set_config"))?.params).toEqual([
    "30000ms",
    "1000ms",
    "tenant-migration:x",
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
  const session = await openSession(app, "db0");
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
