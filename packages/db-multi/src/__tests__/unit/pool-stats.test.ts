import { expect, test } from "bun:test";
import { connect } from "../../core/database";
import type { Pool, Reserved } from "../../core/driver";

/** A pool whose reservations and statement answers are released by hand. */
function manualPool(options: { reserveDelayMs?: number } = {}) {
  const grants: ((reserved: Reserved) => void)[] = [];
  const answers: (() => void)[] = [];
  let discarded = 0;
  const reserved: Reserved = {
    query: () => new Promise((resolve) => answers.push(() => resolve([]))) as never,
    exec: () => new Promise((resolve) => answers.push(() => resolve())),
    release: (discard) => void (discard && discarded++),
    cancel: () => {},
  };
  const pool: Pool = {
    ...reserved,
    reserve: () =>
      options.reserveDelayMs === undefined
        ? new Promise((resolve) => grants.push(resolve))
        : new Promise((resolve) => setTimeout(() => resolve(reserved), options.reserveDelayMs)),
    close: async () => {},
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    pool,
    reserved,
    grant: async () => (grants.shift()?.(reserved), tick()),
    answer: async () => (answers.shift()?.(), tick()),
    discarded: () => discarded,
    tick,
  };
}

const settings = { deadlineMs: 5000, maxPending: 3 };

test("a fresh client reports zeros and no acquisition percentiles", () => {
  const db = connect(manualPool().pool, settings);
  expect(db.stats()).toEqual({ inUse: 0, waiting: 0, maxPending: 3, acquireP50Ms: null, acquireP99Ms: null, expiredDiscarded: 0, busyRejected: 0 });
});

test("waiting jobs, jobs in use and the pending limit are visible while work is in flight", async () => {
  const fake = manualPool();
  const db = connect(fake.pool, settings);
  const first = db.query("SELECT 1");
  const second = db.query("SELECT 2");
  await fake.tick();
  expect(db.stats()).toMatchObject({ inUse: 0, waiting: 2 });
  await fake.grant();
  expect(db.stats()).toMatchObject({ inUse: 1, waiting: 1 });
  await fake.answer();
  await first;
  expect(db.stats()).toMatchObject({ inUse: 0, waiting: 1 });
  await fake.grant();
  await fake.answer();
  await second;
  expect(db.stats()).toMatchObject({ inUse: 0, waiting: 0 });
});

test("a job refused for lack of room is counted as busyRejected, in both the statement and the transaction path", async () => {
  const fake = manualPool();
  const db = connect(fake.pool, { ...settings, maxPending: 1 });
  const held = db.query("SELECT 1");
  await expect(db.query("SELECT 2")).rejects.toMatchObject({ code: "DATABASE_BUSY" });
  await expect(db.transaction(async () => 1)).rejects.toMatchObject({ code: "DATABASE_BUSY" });
  expect(db.stats().busyRejected).toBe(2);
  await fake.grant();
  await fake.answer();
  await held;
});

test("acquisition times feed p50 and p99 over a bounded window", async () => {
  const fake = manualPool({ reserveDelayMs: 10 });
  const db = connect(fake.pool, { ...settings, maxPending: 100 });
  for (let i = 0; i < 5; i++) {
    const query = db.query("SELECT 1");
    await new Promise((resolve) => setTimeout(resolve, 25)); // the reservation takes 10 ms, then the statement waits for its answer
    await fake.answer();
    await query;
  }
  const { acquireP50Ms, acquireP99Ms } = db.stats();
  expect(acquireP50Ms).toBeGreaterThanOrEqual(8);
  expect(acquireP99Ms).toBeGreaterThanOrEqual(acquireP50Ms as number);
});

test("a connection discarded after an expired deadline is counted", async () => {
  const fake = manualPool();
  const db = connect(fake.pool, { ...settings, deadlineMs: 20 });
  const slow = db.query("SELECT pg_sleep(60)");
  await fake.grant(); // reserved, but the answer never comes
  await expect(slow).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  expect(db.stats()).toMatchObject({ inUse: 0, expiredDiscarded: 1 });
  expect(fake.discarded()).toBe(1);
});
