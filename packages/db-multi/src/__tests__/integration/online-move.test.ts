/** `move --online` against two PostgreSQL servers with wal_level=logical (compose: postgres-lr-a = db0, postgres-lr-b = db1). */
import { afterAll, beforeAll, expect } from "bun:test";
import { createConfig } from "../../core/config";
import { createDatabase } from "../../index";
import { bootstrap, type Management, provisionTenant } from "../../management";
import { getMove, resumeMove, rollbackMove, startMove } from "../../core/tools/move";
import { errorCode } from "../../core/errors";
import { movedSchemaName } from "../../core/tenants/model";
import { schemaExists } from "../../core/tenants/nodes";
import { bunDriver } from "../../core/drivers/bun";
import { connect } from "../../core/database";
import { createTestManagement, createUser, driver, enabled, failure, integration, q, removeTenants, uniqueEmail } from "./helpers";

const A = "postgres://admin:local_admin_password@127.0.0.1:5601/app";
const B = "postgres://admin:local_admin_password@127.0.0.1:5602/app";
/** The source as the target server reaches it: by compose service name. */
const SOURCE_FOR_TARGET = "postgres://admin:local_admin_password@postgres-lr-a:5432/app";
const config = () => createConfig([A, B]);
const prefix = `om-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const spans: { name: string; ms: number; detail?: string }[] = [];
let app: Management;
let runtime: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  if (!enabled) return;
  runtime = createDatabase(config(), { driver, pooler: "assumed", placementCacheMs: 5000 });
  app = createTestManagement({ onPlacementChange: (id: string) => runtime.invalidatePlacement(id), onSpan: (span: { name: string; ms: number; detail?: string }) => void spans.push(span) } as never, config());
  await bootstrap(app);
});
afterAll(async () => {
  if (!app) return;
  try {
    await removeTenants(app, prefix);
    for (const node of ["db0", "db1"]) {
      const db = app.pools.node(node);
      for (const { subname } of await db.query<{ subname: string }>("SELECT subname FROM pg_subscription WHERE subname LIKE 'pgcells\\_%'")) {
        await db.pool.exec(`ALTER SUBSCRIPTION "${subname}" DISABLE`).catch(() => {});
        await db.pool.exec(`ALTER SUBSCRIPTION "${subname}" SET (slot_name = NONE)`).catch(() => {});
        await db.pool.exec(`DROP SUBSCRIPTION "${subname}"`).catch(() => {});
      }
      await db.query("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE 'pgcells\\_%' AND NOT active").catch(() => {});
      for (const { pubname } of await db.query<{ pubname: string }>("SELECT pubname FROM pg_publication WHERE pubname LIKE 'pgcells\\_%'")) await db.pool.exec(`DROP PUBLICATION "${pubname}"`).catch(() => {});
    }
  } finally {
    await runtime.close();
    await app.close();
  }
});

const online = (extra = {}) => ({ online: { sourceUrlForTarget: SOURCE_FOR_TARGET, ...extra } });
const add = (tenant: string, name: string) => runtime.withTenant(tenant, (t) => t.query(createUser, [crypto.randomUUID(), name, uniqueEmail()]));
const count = (databaseId: string, schema: string) => app.pools.node(databaseId).query<{ n: string }>(`SELECT count(*)::text AS n FROM ${q(schema, "users")}`).then((rows) => Number(rows[0]?.n));
/** A move-record trigger that fails the checkpoint of `phase` for this tenant, like a crash right after that phase. */
async function failAt(tenant: string, phase: string) {
  const db = app.pools.platform;
  const name = `fault_${prefix.replaceAll("-", "_")}_${phase}`;
  await db.exec(
    `CREATE FUNCTION platform.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${tenant}' AND NEW.phase='${phase}' THEN RAISE EXCEPTION 'injected checkpoint crash'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE UPDATE ON platform.moves FOR EACH ROW EXECUTE FUNCTION platform.${name}()`,
  );
  return () => db.exec(`DROP TRIGGER ${name} ON platform.moves; DROP FUNCTION platform.${name}()`);
}
const moveOf = async (tenant: string) => (await app.pools.platform.query<{ id: string }>("SELECT id FROM platform.moves WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1", [tenant]))[0]?.id as string;
const schemaOf = (tenant: string) => `tenant_${tenant.replaceAll("-", "_")}`;

const replicationObjects = async () => ({
  subscriptions: (await app.pools.node("db1").query<{ n: string }>("SELECT count(*)::text AS n FROM pg_subscription WHERE subname LIKE 'pgcells\\_%'"))[0]?.n,
  publications: (await app.pools.node("db0").query<{ n: string }>("SELECT count(*)::text AS n FROM pg_publication WHERE pubname LIKE 'pgcells\\_%'"))[0]?.n,
  slots: (await app.pools.node("db0").query<{ n: string }>("SELECT count(*)::text AS n FROM pg_replication_slots WHERE slot_name LIKE 'pgcells\\_%'"))[0]?.n,
});

integration("an online move keeps the tenant writable: no acknowledged write is lost, the pause is short, the source is fenced and the replication objects are gone", async () => {
  const tenant = `${prefix}-live`;
  await provisionTenant(app, tenant, "db0");
  for (let i = 0; i < 200; i++) await add(tenant, `seed ${i}`);

  const acknowledged: string[] = [];
  const errors = new Map<string, number>();
  let writing = true;
  const writer = (async () => {
    while (writing) {
      const name = `live ${acknowledged.length}-${crypto.randomUUID()}`;
      try {
        await add(tenant, name);
        acknowledged.push(name);
      } catch (error) {
        const code = errorCode(error);
        errors.set(code, (errors.get(code) ?? 0) + 1);
        await Bun.sleep(20);
      }
      await Bun.sleep(5);
    }
  })();
  await Bun.sleep(300);
  const move = await startMove(app, tenant, "db1", undefined, undefined, online());
  await Bun.sleep(300);
  writing = false;
  await writer;

  expect(move).toMatchObject({ status: "completed", phase: "completed", online: true });
  expect(await app.platform.get(tenant)).toMatchObject({ databaseId: "db1", status: "active" });
  // Every write the application was told succeeded is on the target; nothing was written to the abandoned copy after the pause.
  const names = new Set((await app.pools.node("db1").query<{ name: string }>(`SELECT name FROM ${q("tenant_" + tenant.replaceAll("-", "_"), "users")}`)).map((row) => row.name));
  expect(acknowledged.length).toBeGreaterThan(20);
  expect(acknowledged.filter((name) => !names.has(name))).toEqual([]);
  // Errors during the move are explicit and expected kinds only (the placement was refused while paused, or a statement met the renamed schema).
  expect([...errors.keys()].filter((code) => !["TENANT_UNAVAILABLE", "42P01"].includes(code))).toEqual([]);
  const pause = spans.find((span) => span.name === "move.pause");
  expect(pause).toBeDefined();
  expect(pause?.ms).toBeLessThan(5000);
  console.log(`online move: pause ${Math.round(pause?.ms ?? 0)} ms, ${acknowledged.length} acknowledged writes, errors ${JSON.stringify(Object.fromEntries(errors))}`);

  const schema = `tenant_${tenant.replaceAll("-", "_")}`;
  expect(await schemaExists(app.pools.node("db0"), schema)).toBe(false);
  expect(await schemaExists(app.pools.node("db0"), movedSchemaName(schema, move.id))).toBe(true);
  expect(await replicationObjects()).toEqual({ subscriptions: "0", publications: "0", slots: "0" });
  // The source keeps the rows from the moment of the pause and a raw writer can not add to it.
  const retained = new Set((await app.pools.node("db0").query<{ name: string }>(`SELECT name FROM ${q(movedSchemaName(schema, move.id), "users")}`)).map((row) => row.name));
  expect([...retained].filter((name) => !names.has(name))).toEqual([]); // nothing is only in the abandoned copy
  const acknowledgedSet = new Set(acknowledged);
  expect([...names].filter((name) => !retained.has(name) && !acknowledgedSet.has(name))).toEqual([]); // what only the target has was written after the cutover
  await expect(app.pools.node("db0").exec(`INSERT INTO ${q(schema, "users")} (name,email) VALUES ('late','late@example.com')`)).rejects.toThrow();
});

integration("online prerequisites are checked before anything is recorded: a source without wal_level=logical is UNSUPPORTED_MOVE", async () => {
  const plain = createTestManagement({}); // the default servers run wal_level=replica
  try {
    await bootstrap(plain);
    const tenant = `${prefix}-plain`;
    await provisionTenant(plain, tenant, "db0");
    expect(await failure(startMove(plain, tenant, "db1", undefined, undefined, online()))).toBe("UNSUPPORTED_MOVE");
    expect(await plain.pools.platform.query("SELECT 1 FROM platform.moves WHERE tenant_id=$1", [tenant])).toHaveLength(0);
    expect(await plain.platform.get(tenant)).toMatchObject({ databaseId: "db0", status: "active" });
    await removeTenants(plain, `${prefix}-plain`);
  } finally {
    await plain.close();
  }
});

integration("without the source URL for the target the subscription can not be created: ONLINE_SOURCE_URL_REQUIRED, and the move is rolled back cleanly", async () => {
  const tenant = `${prefix}-nourl`;
  await provisionTenant(app, tenant, "db0");
  let moveId = "";
  await expect(startMove(app, tenant, "db1", undefined, (move) => void (moveId = move.id), { online: {} })).rejects.toMatchObject({ code: "ONLINE_SOURCE_URL_REQUIRED" });
  expect((await getMove(app, moveId)).status).toBe("failed");
  await rollbackMove(app, moveId, undefined, { online: true });
  expect(await app.platform.get(tenant)).toMatchObject({ databaseId: "db0", status: "active" });
  expect(await replicationObjects()).toEqual({ subscriptions: "0", publications: "0", slots: "0" });
  expect(await schemaExists(app.pools.node("db1"), `tenant_${tenant.replaceAll("-", "_")}`)).toBe(false);
  await add(tenant, "still writable");
});

integration("a failure right after the pause resumes to completion: the renamed source is recognised and the move carries on to the cutover", async () => {
  const tenant = `${prefix}-resume`;
  await provisionTenant(app, tenant, "db0");
  for (let i = 0; i < 30; i++) await add(tenant, `row ${i}`);
  const clean = await failAt(tenant, "paused");
  try {
    await expect(startMove(app, tenant, "db1", undefined, undefined, online())).rejects.toThrow("injected checkpoint crash");
  } finally {
    await clean();
  }
  const id = await moveOf(tenant);
  // The pause committed: the source is renamed and the placement is held `migrating` on the source.
  expect(await schemaExists(app.pools.node("db0"), schemaOf(tenant))).toBe(false);
  expect(await app.platform.get(tenant)).toMatchObject({ databaseId: "db0", status: "migrating" });
  const done = await resumeMove(app, id, undefined, { online: true });
  expect(done).toMatchObject({ status: "completed", online: true });
  expect(await app.platform.get(tenant)).toMatchObject({ databaseId: "db1", status: "active" });
  expect(await count("db1", schemaOf(tenant))).toBe(30);
  expect(await replicationObjects()).toEqual({ subscriptions: "0", publications: "0", slots: "0" });
  await add(tenant, "after the move");
  expect(await count("db1", schemaOf(tenant))).toBe(31);
});

integration("a rollback after the pause gives the tenant its schema name back and removes the replication objects", async () => {
  const tenant = `${prefix}-back`;
  await provisionTenant(app, tenant, "db0");
  for (let i = 0; i < 12; i++) await add(tenant, `row ${i}`);
  const clean = await failAt(tenant, "paused");
  try {
    await expect(startMove(app, tenant, "db1", undefined, undefined, online())).rejects.toThrow("injected checkpoint crash");
  } finally {
    await clean();
  }
  const id = await moveOf(tenant);
  expect(await schemaExists(app.pools.node("db0"), schemaOf(tenant))).toBe(false);
  await rollbackMove(app, id, undefined, { online: true });
  expect((await getMove(app, id)).status).toBe("rolled-back");
  expect(await schemaExists(app.pools.node("db0"), schemaOf(tenant))).toBe(true);
  expect(await schemaExists(app.pools.node("db0"), movedSchemaName(schemaOf(tenant), id))).toBe(false);
  expect(await schemaExists(app.pools.node("db1"), schemaOf(tenant))).toBe(false);
  expect(await replicationObjects()).toEqual({ subscriptions: "0", publications: "0", slots: "0" });
  expect(await app.platform.get(tenant)).toMatchObject({ databaseId: "db0", status: "active" });
  await add(tenant, "writable again");
  expect(await count("db0", schemaOf(tenant))).toBe(13);
});

integration("a busy table makes the lock time out and retry; if it stays busy the move fails with the placement untouched, and it resumes once the table is free", async () => {
  const tenant = `${prefix}-busy`;
  await provisionTenant(app, tenant, "db0");
  for (let i = 0; i < 5; i++) await add(tenant, `row ${i}`);
  // A long transaction on the tenant's table, as an application might hold.
  const holder = bunDriver(A, { max: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 600, connectTimeoutSeconds: 10 });
  const connection = connect(holder, { deadlineMs: 600_000, maxPending: 4 });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const holding = connection.transaction(async (tx) => {
    await tx.exec(`LOCK TABLE ${q(schemaOf(tenant), "users")} IN ROW EXCLUSIVE MODE`);
    await hold;
  });
  await Bun.sleep(200);
  try {
    expect(await failure(startMove(app, tenant, "db1", undefined, undefined, online({ lockTimeoutMs: 200, lockAttempts: 2 })))).toBe("55P03");
    expect(await app.platform.get(tenant)).toMatchObject({ databaseId: "db0", status: "active" }); // writers were never held
  } finally {
    release();
    await holding;
    await connection.close();
  }
  const done = await resumeMove(app, await moveOf(tenant), undefined, { online: true });
  expect(done.status).toBe("completed");
  expect(await app.platform.get(tenant)).toMatchObject({ databaseId: "db1", status: "active" });
});
