import { expect, test } from "bun:test";
import { usesTransactionPooler } from "../../core/tenants/pooler";
import { fakeDriver } from "../fixtures/fake-driver";

const url = "postgres://app:secret-pw@localhost:6432/one";
const pidQueries = (fake: ReturnType<typeof fakeDriver>) => fake.commands.filter((command) => command.text.includes("pg_backend_pid")).length;

test("one server session seen by two held connections proves a pooler on the first round", async () => {
  const fake = fakeDriver(() => [{ pid: 7 }]);
  expect(await usesTransactionPooler(fake.driver, url, { deadlineMs: 1000 })).toBe(true);
  expect(pidQueries(fake)).toBe(2);
  const [pool] = fake.pools;
  expect(fake.pools).toHaveLength(1);
  expect(pool?.options.max).toBe(2);
  expect(pool?.released).toBe(2);
  expect(pool?.closed).toBe(true);
});

test("a pooler that only repeats a session on a later round is still found", async () => {
  let calls = 0;
  // 1-4. sorgu farklı oturumlar; 5. ve 6. (üçüncü turun çifti) aynı oturum.
  const fake = fakeDriver(() => [{ pid: ++calls <= 4 ? calls : 99 }]);
  expect(await usesTransactionPooler(fake.driver, url, { deadlineMs: 1000 })).toBe(true);
  expect(pidQueries(fake)).toBe(6);
  expect(fake.pools[0]?.released).toBe(6);
});

test("two distinct sessions in every round mean a direct connection", async () => {
  let pid = 0;
  const fake = fakeDriver(() => [{ pid: ++pid }]);
  expect(await usesTransactionPooler(fake.driver, url, { deadlineMs: 1000 })).toBe(false);
  expect(pidQueries(fake)).toBe(20); // varsayılan 10 tur × 2
  expect(fake.pools[0]?.released).toBe(20);
  expect(fake.pools[0]?.closed).toBe(true);

  let other = 0;
  const few = fakeDriver(() => [{ pid: ++other }]);
  expect(await usesTransactionPooler(few.driver, url, { deadlineMs: 1000, rounds: 3 })).toBe(false);
  expect(pidQueries(few)).toBe(6);
});

test("a probe that never gets an answer ends at the deadline, closes its pool and leaves no unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const fake = fakeDriver(() => new Promise<unknown[]>(() => {}));
    await expect(usesTransactionPooler(fake.driver, url, { deadlineMs: 20 })).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
    expect(fake.pools[0]?.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("a query failure is passed through unchanged and still closes the pool", async () => {
  const fake = fakeDriver(() => {
    throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
  });
  await expect(usesTransactionPooler(fake.driver, url, { deadlineMs: 1000 })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  expect(fake.pools[0]?.released).toBe(2);
  expect(fake.pools[0]?.closed).toBe(true);
});
