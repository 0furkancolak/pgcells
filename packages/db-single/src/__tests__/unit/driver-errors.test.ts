/** Sürücü hataları çağırana yalnızca kararlı koduyla ulaşır: mesajda host, kullanıcı, DB adı ya da satır değeri yoktur. Uygulamanın kendi
 * hatası (`transaction(work)` içinde atılan) olduğu gibi geçer. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import type { Driver } from "../../core/driver";
import { databaseUnavailable, DriverError } from "../../core/errors";
import { openSession } from "../../core/locks";
import { createManagement } from "../../core/management";
import { createDb } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import { createDbScope } from "../../middleware";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@primary.example/one";
const REPLICA = "postgres://app:secret-pw@replica.example/one";
const select = prepareQuery("SELECT id FROM users WHERE id = $1::integer");
/** `constraint` adı bilinçli olarak taşınır (tanımlayıcı, sır değil); mesaj yine yalnızca koddur. */
const SECRETS = ["127.0.0.1", "5599", '"app"', "a@b.c", "secret-pw", "example"];

const failures = {
  refused: () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5599"), { code: "ECONNREFUSED" }),
  auth: () => Object.assign(new Error('password authentication failed for user "app"'), { errno: "28P01" }),
  unique: () =>
    Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: "23505",
      detail: "Key (email)=(a@b.c) already exists.",
      constraint: "users_email_key",
    }),
};
const codes = { refused: "ECONNREFUSED", auth: "28P01", unique: "23505" } as const;

/** Replica durum sorguları sağlıklı döner; uygulama sorgusu verilen hatayla düşer. */
const failingDriver = (fail: () => Error) =>
  fakeDriver((text) => {
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/1" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: true, caught_up: true, lag_ms: 0 }];
    throw fail();
  });

function expectSanitized(error: unknown, code: string) {
  expect(error).toMatchObject({ code, message: `Database operation failed (${code})` });
  for (const secret of SECRETS) expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toContain(secret);
  expect((error as { cause?: unknown }).cause).toBeUndefined();
  expect((error as { detail?: unknown }).detail).toBeUndefined();
}

test("driver errors keep their code but lose host, user and row values on query, read.query and the request scope", async () => {
  for (const [name, fail] of Object.entries(failures)) {
    const fake = failingDriver(fail);
    const db = createDb(createConfig(PRIMARY, [REPLICA]), { driver: fake.driver, pooler: "assumed", replicaStatusMs: 1 });
    const scope = createDbScope(db);
    for (const run of [() => db.query(select, [1]), () => db.read.query(select, [1]), () => scope.query(select, [1]), () => scope.read.query(select, [1])]) {
      const error = await run().catch((e: unknown) => e);
      expectSanitized(error, codes[name as keyof typeof codes]);
    }
    await db.close();
  }
});

test("a refused connection keeps a code the replica router recognises; a unique violation keeps its constraint name", async () => {
  const refusing = fakeDriver();
  const driver: Driver = (url, options) => ({ ...refusing.driver(url, options), reserve: () => Promise.reject(failures.refused()) });
  const db = createDb(createConfig(PRIMARY), { driver, pooler: "assumed" });
  const error = await db.query(select, [1]).catch((e: unknown) => e);
  expectSanitized(error, "ECONNREFUSED");
  expect(databaseUnavailable(error)).toBe(true);
  await db.close();

  const unique = createDb(createConfig(PRIMARY), { driver: failingDriver(failures.unique).driver, pooler: "assumed" });
  expect(await unique.query(select, [1]).catch((e: unknown) => e)).toMatchObject({ code: "23505", constraint: "users_email_key" });
  await unique.close();
  expect(new DriverError({ code: "23505", constraint_name: "x" }).constraint).toBe("x"); // postgres.js
});

test("a code read from the message survives, and a server timeout is still the engine's own DATABASE_TIMEOUT", async () => {
  const closed = createDb(createConfig(PRIMARY), { driver: failingDriver(() => new Error("Connection terminated unexpectedly at 127.0.0.1")).driver, pooler: "assumed" });
  const lost = await closed.query(select, [1]).catch((e: unknown) => e);
  expectSanitized(lost, "CONNECTION_CLOSED");
  expect(databaseUnavailable(lost)).toBe(true);
  await closed.close();

  const timeout = () => Object.assign(new Error("canceling statement due to statement timeout"), { errno: "57014" });
  const slow = createDb(createConfig(PRIMARY), { driver: failingDriver(timeout).driver, pooler: "assumed" });
  for (const run of [() => slow.query(select, [1]), () => slow.transaction((tx) => tx.query(select, [1])), () => slow.ready()]) {
    const error = await run().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "DATABASE_TIMEOUT", message: "Database query deadline exceeded" });
    expect(error).not.toBeInstanceOf(DriverError);
  }
  await slow.close();
});

test("the migration lock session (its own pool, outside connect) also surfaces only the code", async () => {
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_backend_pid")) return [{ pid: 100 + pool.index }];
    if (text.includes("set_config")) throw failures.auth();
    return [];
  });
  const app = createManagement(createConfig("postgres://admin@127.0.0.1:7900/app"), { driver: fake.driver });
  expectSanitized(await openSession(app).catch((e: unknown) => e), "28P01");
  await app.close();
});

test("an application error thrown inside transaction or run passes through unchanged", async () => {
  const db = createDb(createConfig(PRIMARY), { driver: fakeDriver().driver, pooler: "assumed" });
  const scope = createDbScope(db);
  const mine = Object.assign(new Error('user "app" at 127.0.0.1'), { code: "MY_CODE" });
  await expect(db.transaction(async () => { throw mine; })).rejects.toBe(mine);
  await expect(scope.transaction(async () => { throw mine; })).rejects.toBe(mine);
  await expect(db.run(async () => { throw mine; })).rejects.toBe(mine);
  await db.close();
});
