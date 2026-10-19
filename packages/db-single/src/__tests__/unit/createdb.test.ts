import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDb, type DbOptions } from "../../core/runtime";
import { createDbScope } from "../../middleware";
import { prepareQuery } from "../../core/sql/compiler";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@localhost:6432/one";
const REPLICA = "postgres://app:secret-pw@localhost:6433/one";
const select = prepareQuery("SELECT id FROM users WHERE id = $1::integer");
const insert = prepareQuery("INSERT INTO users (id) VALUES ($1::integer)");

function open(options: Partial<Omit<DbOptions, "driver">> = {}, replicas: string[] = [], handler: Handler = () => []) {
  const fake = fakeDriver(handler);
  const db = createDb(createConfig(PRIMARY, replicas), { driver: fake.driver, pooler: "assumed", ...options });
  return { db, fake };
}
const texts = (fake: ReturnType<typeof fakeDriver>) => fake.commands.map((command) => command.text);
const replicaHandler: Handler = (text) =>
  text.includes("pg_current_wal_lsn") ? [{ lsn: "0/1" }] : text.includes("pg_is_in_recovery") ? [{ in_recovery: true, caught_up: true, lag_ms: 0 }] : [];

test("queries bind to public by default and to the given schema otherwise", async () => {
  const a = open();
  await a.db.query(select, [1]);
  expect(texts(a.fake).at(-1)).toContain('"public".users');
  const b = open({ schema: "app_x" });
  await b.db.query(select, [1]);
  expect(texts(b.fake).at(-1)).toContain('"app_x".users');
  expect(b.db.schema).toBe("app_x");
});

test("a bad schema or option is refused before any pool opens", () => {
  const fake = fakeDriver();
  for (const options of [{ schema: 'x"; DROP' }, { schema: "Public" }, { schema: "pg_catalog" }, { schema: "information_schema" }])
    expect(() => createDb(createConfig(PRIMARY), { driver: fake.driver, ...options })).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
  expect(() => createDb(createConfig(PRIMARY), { driver: fake.driver, replicaOnUnavailable: "sometimes" as never })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(fake.pools).toHaveLength(0);
});

test("a query that is not prepared is rejected", async () => {
  const { db, fake } = open();
  await expect(db.query({} as never)).rejects.toMatchObject({ code: "INVALID_QUERY" });
  expect(fake.commands).toHaveLength(0);
});

test("a transaction wraps its queries in BEGIN and COMMIT, and a failure rolls back", async () => {
  const ok = open();
  await ok.db.transaction(async (tx) => void (await tx.query(insert, [1])));
  expect(texts(ok.fake)).toEqual(["BEGIN", expect.stringContaining('INSERT INTO "public".users'), "COMMIT"]);

  const failing = open({}, [], (text) => {
    if (text.startsWith("INSERT")) throw Object.assign(new Error("duplicate"), { code: "23505" });
    return [];
  });
  await expect(failing.db.transaction((tx) => tx.query(insert, [1]))).rejects.toMatchObject({ code: "23505" });
  expect(texts(failing.fake).at(-1)).toBe("ROLLBACK");
});

test("read.query without a configured replica is one plain statement on the primary, or fails under the error policy without leaking the URL", async () => {
  const primary = open();
  await primary.db.read.query(select, [1]);
  expect(texts(primary.fake)).toEqual([expect.stringContaining("SELECT id FROM")]);
  const strict = open({ replicaOnUnavailable: "error" });
  const error = (await strict.db.read.query(select, [1]).catch((e: unknown) => e)) as Error & { code: string };
  expect(error.code).toBe("REPLICA_UNAVAILABLE");
  expect(error.message).not.toContain("secret-pw");
  expect(error.message).not.toContain("localhost");
  expect(strict.fake.commands).toHaveLength(0);
  await expect(primary.db.read.query(insert as never, [1])).rejects.toMatchObject({ code: "QUERY_NOT_READ_ONLY" });
  expect(primary.fake.commands).toHaveLength(1);
});

test("read.query after a write in the same scope is one plain statement on the primary, also under the error policy", async () => {
  for (const replicaOnUnavailable of ["primary", "error"] as const) {
    const { db, fake } = open({ replicaOnUnavailable }, [REPLICA], replicaHandler);
    const scope = createDbScope(db);
    await scope.query(insert, [1]);
    fake.commands.length = 0;
    await scope.read.query(select, [1]);
    expect(fake.commands.map((command) => [command.url, command.text])).toEqual([[PRIMARY, expect.stringContaining("SELECT id FROM")]]);
  }
});

test("read.query falls back to a READ ONLY transaction on the primary only while configured replicas are unusable", async () => {
  // Replica state is cached at module level: a separate URL so it does not collide with other tests.
  const DOWN = "postgres://app:secret-pw@localhost:6434/one";
  const { db, fake } = open({ replicaStatusMs: 60_000 }, [DOWN], (text, params, pool) => {
    if (pool.url === DOWN) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    return replicaHandler(text, params, pool);
  });
  await db.read.query(select, [1]);
  expect(fake.commands.filter((command) => command.url === PRIMARY).map((command) => command.text)).toEqual([
    expect.stringContaining("pg_current_wal_lsn"),
    "BEGIN READ ONLY",
    expect.stringContaining("SELECT id FROM"),
    "COMMIT",
  ]);
});

test("a healthy replica serves read.query and replicas() reports it without its URL", async () => {
  const { db, fake } = open({ replicaStatusMs: 1 }, [REPLICA], replicaHandler);
  await db.read.query(select, [1]);
  expect(fake.commands.filter((command) => command.text.startsWith("SELECT id FROM")).map((command) => command.url)).toEqual([REPLICA]);
  const report = await db.replicas();
  expect(report).toEqual([{ replica: 1, up: true, inRecovery: true, lagMs: 0, usable: true }]);
  expect(JSON.stringify(report)).not.toContain("secret-pw");
});

test("close closes every pool", async () => {
  const { db, fake } = open({}, [REPLICA], replicaHandler);
  await db.read.query(select, [1]);
  await db.close();
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
});
