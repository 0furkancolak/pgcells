import { afterAll, beforeAll, expect } from "bun:test";
import { bootstrap, provisionTenant } from "../../management";
import { prepareQuery } from "../../core/sql/compiler";
import type { TenantContext } from "../../index";
import { createTestRuntime, createUser, enabled, integration, listUsers, removeTenants, uniqueEmail } from "./helpers";

type Row = { id: string; name: string };
const addUser = async (db: TenantContext, name: string, id?: string) =>
  (await db.query<Row[]>(createUser, [id ?? crypto.randomUUID(), name, uniqueEmail()]))[0] as Row;
/** `account.user_id` → `users(id)` foreign key: an intra-tenant relation. */
const addAccount = (db: TenantContext, userId: string) =>
  db.query(prepareQuery("INSERT INTO account (account_id, provider_id, user_id) VALUES ($1, 'test', $2::uuid)"), [crypto.randomUUID(), userId]);
const users = (db: TenantContext, limit = 100, offset = 0) => db.query<Row[]>(listUsers, [limit, offset]);
const accounts = (db: TenantContext) => db.query<unknown[]>(prepareQuery("SELECT id FROM account"));

/** Runtime queries go through PgBouncer transaction pooling; provisioning uses direct management URLs. */
let app: ReturnType<typeof createTestRuntime>;
const prefix = `isolation-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const a = `${prefix}-a`,
  b = `${prefix}-b`;
beforeAll(async () => {
  if (!enabled) return;
  app = createTestRuntime();
  await bootstrap(app.management);
  for (const id of [a, b]) await provisionTenant(app.management, id, "db0");
});
afterAll(async () => {
  if (!app) return;
  try {
    await removeTenants(app.management, prefix);
  } finally {
    await app.close();
  }
});
integration("same IDs in concurrent tenants never mix rows", async () => {
  const id = crypto.randomUUID();
  await Promise.all([
    app.withTenant(a, (db) => addUser(db, "Only A", id)),
    app.withTenant(b, (db) => addUser(db, "Only B", id)),
  ]);
  const results = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => ({
      expected: i % 2 ? "Only A" : "Only B",
      rows: await app.withTenant(i % 2 ? a : b, users),
    })),
  );
  for (const result of results) expect(result.rows.find((s) => s.id === id)?.name).toBe(result.expected);
});
integration("cross-domain transaction is atomic and connections remain reusable", async () => {
  const id = crypto.randomUUID();
  await expect(
    app.withTenant(a, (context) =>
      context.transaction(async (db) => {
        const user = await addUser(db, "Rollback", id);
        await addAccount(db, user.id);
        throw new Error("abort");
      }),
    ),
  ).rejects.toThrow("abort");
  expect((await app.withTenant(a, users)).some((s) => s.id === id)).toBe(false);
  expect(await app.withTenant(a, accounts)).toHaveLength(0);
  expect((await app.withTenant(b, users)).every((s) => s.name !== "Rollback")).toBe(true);
});
integration("transaction context cannot be reused after callback", async () => {
  let escaped!: TenantContext;
  await app.withTenant(a, async (db) => {
    escaped = db;
  });
  expect(() => users(escaped)).toThrow("context is closed");
});
integration("unknown tenants fail closed; inactive tenants fail once invalidated or within placementCacheMs", async () => {
  await expect(app.withTenant(`${prefix}-missing`, users)).rejects.toThrow();
  const platform = app.management.platform;
  await app.withTenant(a, users);
  await platform.setStatus(await platform.get(a), "maintenance");
  // Invalidation (e.g. onPlacementChange) takes effect at once.
  app.invalidatePlacement(a);
  await expect(app.withTenant(a, users)).rejects.toThrow("not active");
  await platform.setStatus(await platform.get(a), "active");
  expect(await app.withTenant(a, users)).toHaveLength(1);

  // Without invalidation the cached active placement expires after placementCacheMs; inactive placements are never cached.
  const short = createTestRuntime({ placementCacheMs: 200 });
  try {
    expect(await short.withTenant(a, users)).toHaveLength(1);
    await platform.setStatus(await platform.get(a), "maintenance");
    await Bun.sleep(250);
    await expect(short.withTenant(a, users)).rejects.toThrow("not active");
    await expect(short.withTenant(a, users)).rejects.toThrow("not active");
  } finally {
    await platform.setStatus(await platform.get(a), "active");
    await short.close();
  }
});
integration("foreign keys cannot cross tenant schemas", async () => {
  const foreign = await app.withTenant(b, (db) => addUser(db, "Foreign"));
  await expect(app.withTenant(a, (db) => addAccount(db, foreign.id))).rejects.toThrow();
  expect(await app.withTenant(a, accounts)).toHaveLength(0);
});
integration("bound values paginate and invalid values are rejected by PostgreSQL", async () => {
  await app.withTenant(a, (db) => addUser(db, "Page one"));
  await app.withTenant(a, (db) => addUser(db, "Page two"));
  await expect(app.withTenant(a, (db) => addAccount(db, "bad"))).rejects.toThrow();
  const first = await app.withTenant(a, (db) => users(db, 1));
  const second = await app.withTenant(a, (db) => users(db, 1, 1));
  expect(first).toHaveLength(1);
  expect(second).toHaveLength(1);
  expect(first[0]?.id).not.toBe(second[0]?.id);
});

integration("unawaited queries drain before transaction closes and rollback remains atomic", async () => {
  const insert = prepareQuery("INSERT INTO users(id,name,email) VALUES($1::uuid,$2,$3)");
  let escaped!: TenantContext;
  const id = crypto.randomUUID();
  await app.withTenant(a, (context) =>
    context.transaction(async (db) => {
      escaped = db;
      void db.query(insert, [id, "Started inside", uniqueEmail()]);
    }),
  );
  expect((await app.withTenant(a, users)).some((user) => user.id === id)).toBe(true);
  expect(() => escaped.query(insert, [id, "late", uniqueEmail()])).toThrow("closed");
  const rollbackId = crypto.randomUUID();
  await expect(
    app.withTenant(a, (context) =>
      context.transaction(async (db) => {
        void db.query(insert, [rollbackId, "Rollback", uniqueEmail()]);
        throw new Error("abort");
      }),
    ),
  ).rejects.toThrow("abort");
  expect((await app.withTenant(a, users)).some((user) => user.id === rollbackId)).toBe(false);
});
