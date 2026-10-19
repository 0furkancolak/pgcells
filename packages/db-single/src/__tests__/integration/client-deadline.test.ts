import { afterAll, beforeAll, expect } from "bun:test";
import { connect, type Database } from "../../core/database";
import { driver, enabled, integration, pooledConfig, q, raw, testSchema } from "./helpers";

const schema = testSchema();
const admin = enabled ? raw() : undefined;
let db: Database | undefined;
beforeAll(async () => {
  if (!admin) return;
  await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "writes")} (id integer PRIMARY KEY)`);
  db = connect(driver(pooledConfig().url, { max: 1, idleTimeoutSeconds: 10, maxLifetimeSeconds: 60, connectTimeoutSeconds: 2 }), {
    deadlineMs: 250,
    maxPending: 64,
  });
  await db.query("SELECT 1");
});
afterAll(async () => {
  await db?.close();
  await admin?.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
  await admin?.close();
});

integration("max=1 expired queued writes and transactions never run after the blocker releases", async () => {
  if (!db) throw new Error("Missing integration client");
  const client = db;
  let ready!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  let callbackRan = false;
  const blocker = client.transaction(async (tx) => {
    await tx.query("SELECT 1");
    ready();
    await held;
  });
  try {
    await started;
    const writes = Array.from({ length: 20 }, (_, id) =>
      client.query(`INSERT INTO ${q(schema, "writes")} (id) VALUES ($1)`, [id]),
    );
    const transaction = client.transaction(async () => {
      callbackRan = true;
    });
    const begin = performance.now();
    const outcomes = await Promise.allSettled([...writes, transaction]);
    expect(performance.now() - begin).toBeLessThan(2000);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "DATABASE_TIMEOUT" });
    }
  } finally {
    release();
    await blocker;
  }
  // This barrier also proves that no expired work takes the connection afterwards.
  expect(await client.query(`SELECT id FROM ${q(schema, "writes")}`)).toHaveLength(0);
  expect(callbackRan).toBe(false);
});

integration("a transaction queues parallel statements on its one connection and the pool is reused", async () => {
  if (!db) throw new Error("Missing integration client");
  await db.transaction(async (tx) => {
    const [, , rows] = await Promise.all([
      tx.query("SELECT pg_catalog.pg_sleep(0.1)"),
      tx.query(`INSERT INTO ${q(schema, "writes")} (id) VALUES (100)`),
      tx.query<{ ok: number }>("SELECT 1 AS ok"),
    ]);
    expect(rows[0]?.ok).toBe(1);
  });
  expect(await db.query(`SELECT id FROM ${q(schema, "writes")} WHERE id = 100`)).toHaveLength(1);
});
