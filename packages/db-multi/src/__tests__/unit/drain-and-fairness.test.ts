/** Graceful close (`close({ drain: true })`), per-tenant concurrency limit (`tenantMaxInflight`) and `db.stats()` at the runtime level. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDatabase, type RuntimeOptions } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import { fakeDriver } from "../fixtures/fake-driver";

const select = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const placementRow = (id: string) => ({
  tenantId: id,
  databaseId: "db0",
  kind: "tenant",
  schemaName: `tenant_${id.replaceAll("-", "_")}`,
  status: "active",
  schemaVersion: 1,
  placementVersion: 1,
});

/** Statements wait for `release()`; placement reads are immediate. */
function fixture(options: Partial<RuntimeOptions> = {}) {
  const gates: (() => void)[] = [];
  const fake = fakeDriver((text, params) => {
    if (text.includes("platform.placements")) return [placementRow(String(params[0]))];
    return new Promise<unknown[]>((resolve) => gates.push(() => resolve([])));
  });
  const db = createDatabase(createConfig(["postgres://u:p@h/a"]), { driver: fake.driver, pooler: "assumed", ...options });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    db,
    fake,
    release: async () => (gates.shift()?.(), tick()),
    /** Waits until `count` statements are waiting for their answer. */
    started: async (count = 1) => {
      for (let i = 0; i < 200 && gates.length < count; i++) await tick();
      expect(gates.length).toBeGreaterThanOrEqual(count);
    },
    run: (tenant: string) => db.withTenant(tenant, (t) => t.query(select, [crypto.randomUUID()])),
  };
}

test("close({ drain: true }) refuses new work at once, lets a started context finish all its statements, then closes the pools", async () => {
  const f = fixture();
  const inFlight = f.db.withTenant("acme", async (t) => {
    await t.query(select, [crypto.randomUUID()]);
    await t.query(select, [crypto.randomUUID()]); // issued after the drain began
    return "done";
  });
  await f.started();
  const closing = f.db.close({ drain: true, timeoutMs: 5000 });
  await expect(f.run("globex")).rejects.toMatchObject({ code: "DATABASE_CLOSED" });
  await expect(f.db.ready()).rejects.toMatchObject({ code: "DATABASE_CLOSED" }); // the load balancer sees it immediately
  expect(f.fake.pools.some((pool) => pool.closed)).toBe(false);
  await f.release();
  await f.started();
  await f.release();
  expect(await inFlight).toBe("done");
  expect(await closing).toEqual({ drained: true, remaining: 0 });
  expect(f.fake.pools.every((pool) => pool.closed)).toBe(true);
});

test("a drain that runs out of time reports what was left and still closes the pools", async () => {
  const f = fixture();
  const stuck = f.run("acme");
  stuck.catch(() => {});
  await f.started();
  expect(await f.db.close({ drain: true, timeoutMs: 30 })).toEqual({ drained: false, remaining: 1 });
  expect(f.fake.pools.every((pool) => pool.closed)).toBe(true);
});

test("close() without drain closes immediately and reports nothing was waited for", async () => {
  const f = fixture();
  expect(await f.db.close()).toEqual({ drained: true, remaining: 0 });
});

test("tenantMaxInflight limits concurrent contexts per tenant with DATABASE_BUSY and leaves other tenants alone", async () => {
  const f = fixture({ tenantMaxInflight: 2 });
  const held = [f.run("acme"), f.run("acme")];
  held.forEach((p) => p.catch(() => {}));
  await f.started(2);
  await expect(f.run("acme")).rejects.toMatchObject({ code: "DATABASE_BUSY" });
  const other = f.run("globex");
  other.catch(() => {});
  await f.started(3);
  expect(f.db.stats().contexts).toMatchObject({ active: 3, tenantBusyRejected: 1 });
  await f.release();
  await f.release();
  await f.release();
  await Promise.all([...held, other]);
  expect(f.db.stats().contexts.active).toBe(0);
  // The slot is free again.
  const again = f.run("acme");
  await f.started();
  await f.release();
  await again;
});

test("a context that fails frees its tenant slot", async () => {
  const f = fixture({ tenantMaxInflight: 1 });
  await expect(f.db.withTenant("acme", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  await expect(f.db.withTenant("acme", async () => "ok")).resolves.toBe("ok");
});

test("without tenantMaxInflight there is no per-tenant limit", async () => {
  const f = fixture();
  const many = Array.from({ length: 20 }, () => f.run("acme"));
  many.forEach((p) => p.catch(() => {}));
  await f.started(20);
  expect(f.db.stats().contexts).toMatchObject({ active: 20, tenantBusyRejected: 0 });
  for (let i = 0; i < 20; i++) await f.release();
  await Promise.all(many);
});

test("tenantMaxInflight must be a whole number from 1 to 10000 (0 or absent turns it off)", () => {
  for (const bad of [-1, 1.5, 10_001])
    expect(() => createDatabase(createConfig(["postgres://u:p@h/a"]), { driver: fakeDriver().driver, tenantMaxInflight: bad })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG" }),
    );
  expect(() => createDatabase(createConfig(["postgres://u:p@h/a"]), { driver: fakeDriver().driver, tenantMaxInflight: 0 })).not.toThrow();
});

test("db.stats() lists every opened pool by id and replica number", async () => {
  const f = fixture();
  const query = f.run("acme");
  await f.started();
  const { databases } = f.db.stats();
  expect(Object.keys(databases)).toEqual(["db0"]);
  expect(databases.db0).toMatchObject({ inUse: 1, waiting: 0, maxPending: 64 });
  await f.release();
  await query;
});
