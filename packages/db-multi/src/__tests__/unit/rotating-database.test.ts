import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createRotatingDatabase } from "../../core/runtime";
import { fakeDriver } from "../fixtures/fake-driver";

const old = "postgres://app:old-pw@host:6432/one";
const fresh = "postgres://app:new-pw@host:6432/one";

function fixture(healthy: (url: string) => boolean = () => true) {
  const fake = fakeDriver((text, _params, pool) => {
    if (!healthy(pool.url)) throw new Error("password authentication failed");
    if (text.includes("pg_backend_pid")) return [{ pid: 7 }];
    if (text.includes("node_identity") || text.includes("platform.nodes")) return [{ database_id: "db0" }];
    return [];
  });
  return fake;
}

test("rotate() swaps in a new Database built from freshly resolved config and closes the old one", async () => {
  const fake = fixture();
  let url = old;
  const db = await createRotatingDatabase(() => createConfig([url]), { driver: fake.driver });
  await db.ready();
  expect(db.config.nodes[0]?.url).toBe(old);
  url = fresh;
  await db.rotate();
  expect(db.config.nodes[0]?.url).toBe(fresh);
  expect(fake.pools.filter((pool) => pool.url === old).every((pool) => pool.closed)).toBe(true);
  expect(fake.pools.filter((pool) => pool.url === fresh).some((pool) => !pool.closed)).toBe(true); // the probe pools are closed, the Database pool is not
  await db.close();
});

test("a failed readiness check keeps the current Database and closes the candidate", async () => {
  const fake = fixture((url) => url !== fresh);
  let url = old;
  const db = await createRotatingDatabase(() => createConfig([url]), { driver: fake.driver });
  url = fresh;
  await expect(db.rotate()).rejects.toThrow();
  expect(db.config.nodes[0]?.url).toBe(old);
  expect(fake.pools.filter((pool) => pool.url === old).some((pool) => !pool.closed)).toBe(true);
  expect(fake.pools.filter((pool) => pool.url === fresh).every((pool) => pool.closed)).toBe(true);
  await db.close();
});

test("a resolver failure keeps the current Database and the next rotate() can succeed", async () => {
  const fake = fixture();
  let step = 0;
  const db = await createRotatingDatabase(
    () => {
      if (step++ === 1) throw new Error("vault unavailable");
      return createConfig([step > 2 ? fresh : old]);
    },
    { driver: fake.driver },
  );
  await expect(db.rotate()).rejects.toThrow("vault unavailable");
  expect(db.config.nodes[0]?.url).toBe(old);
  await db.rotate();
  expect(db.config.nodes[0]?.url).toBe(fresh);
  await db.close();
});

test("concurrent rotate() calls share one rotation", async () => {
  const fake = fixture();
  let calls = 0;
  const db = await createRotatingDatabase(async () => {
    calls++;
    return createConfig([old]);
  }, { driver: fake.driver });
  await Promise.all([db.rotate(), db.rotate(), db.rotate()]);
  expect(calls).toBe(2); // the first open + one shared rotation
  await db.close();
});

test("after close(), rotate() is refused with DATABASE_CLOSED", async () => {
  const fake = fixture();
  const db = await createRotatingDatabase(() => createConfig([old]), { driver: fake.driver });
  await db.close();
  await expect(db.rotate()).rejects.toMatchObject({ code: "DATABASE_CLOSED" });
});

test("the readiness error never contains the credentials", async () => {
  const fake = fixture((url) => url !== fresh);
  let url = old;
  const db = await createRotatingDatabase(() => createConfig([url]), { driver: fake.driver, pooler: "assumed" });
  url = fresh;
  const error = await db.rotate().then(() => "", (reason: unknown) => String(reason));
  expect(error).not.toContain("new-pw");
  await db.close();
});
