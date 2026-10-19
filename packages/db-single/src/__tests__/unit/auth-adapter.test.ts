/** `@0furkancolak/pgcells-single/auth` adapter: the Better Auth SQL on top of the engine (operators, writes, mapping, uuid keys, transaction). */
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { expect, test } from "bun:test";
import { engineAdapter } from "../../core/auth-adapter";
import { authTables, twoFactorTables } from "../../core/auth-schema";
import { connect } from "../../core/database";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

/** With `generateId: false`, `id` and the referencing fields are `uuid` columns. */
const UUID = "0f8b2f5e-8c1d-4a55-9d61-2d6c1f0b7a10";
const POOL = { max: 2, idleTimeoutSeconds: 1, maxLifetimeSeconds: 1, connectTimeoutSeconds: 1 };

/** Fake database responses: count, affected rows and `RETURNING` rows. */
const rows: Handler = (text) => {
  if (text.startsWith("SELECT count")) return [{ count: "7" }];
  if (/^(UPDATE|DELETE)/.test(text) && !text.includes("RETURNING")) return Object.assign([], { count: text.startsWith("UPDATE") ? 2 : 3 });
  if (text.startsWith("INSERT")) return [{ id: "u1", name: "A", email: "a@x", email_verified: false, image: null, created_at: new Date(0), updated_at: new Date(0) }];
  if (text.includes("two_factor")) return [{ id: "t1", secret: "s", backup_codes: "b", user_id: "u1", verified: true, failed_verification_count: "3" }];
  return [];
};

const adapterFor = async (options: BetterAuthOptions = {}) => {
  const fake = fakeDriver(rows);
  const db = connect(fake.driver("db", POOL), { deadlineMs: 5000, maxPending: 8 });
  const adapter = engineAdapter(db, "app_x")(options);
  return { adapter, sql: () => fake.commands.map((command) => command.text), params: () => fake.commands.map((command) => command.params) };
};

test("adapter where: operators, insensitive mode, escaped LIKE, AND with one OR group, sort/limit/offset; empty IN", async () => {
  const { adapter, sql, params } = await adapterFor();
  await adapter.findMany({
    model: "user",
    where: [
      { field: "email", value: "A@X", mode: "insensitive" },
      { field: "name", operator: "in", value: ["a", "b"] },
      { field: "name", operator: "contains", value: "50%_" },
      { field: "emailVerified", value: true, connector: "OR" },
      { field: "image", operator: "ne", value: null, connector: "OR" },
    ],
    sortBy: { field: "createdAt", direction: "desc" },
    limit: 5,
    offset: 10,
  });
  await adapter.findMany({ model: "session", where: [{ field: "expiresAt", operator: "lte", value: new Date(0) }, { field: "token", operator: "not_in", value: [] }], limit: 1 });
  await adapter.findOne({ model: "user", where: [{ field: "email", operator: "starts_with", value: "Ab", mode: "insensitive" }], select: ["email"] });
  expect(sql()).toEqual([
    'SELECT * FROM "app_x"."user" WHERE lower("email") = $1 AND "name" IN ($2, $3) AND "name" LIKE $4 AND ("emailVerified" = $5 OR "image" IS NOT NULL) ORDER BY "createdAt" DESC LIMIT 5 OFFSET 10',
    'SELECT * FROM "app_x"."session" WHERE "expiresAt" <= $1 AND true LIMIT 1',
    'SELECT "email" FROM "app_x"."user" WHERE "email" ILIKE $1 LIMIT 1',
  ]);
  expect(params()[0]).toEqual(["a@x", "a", "b", "%50\\%\\_%", true]);
  expect(params()[2]).toEqual(["Ab%"]);
});

test("adapter writes: count, updateMany/deleteMany counts, atomic consumeOne, schema-qualified and parameterized", async () => {
  const { adapter, sql, params } = await adapterFor();
  expect(await adapter.count({ model: "session", where: [{ field: "userId", value: "u1" }] })).toBe(7);
  expect(await adapter.updateMany({ model: "session", where: [{ field: "userId", value: "u1" }], update: { ipAddress: "1.1.1.1" } })).toBe(2);
  expect(await adapter.deleteMany({ model: "session", where: [{ field: "userId", value: "u1" }] })).toBe(3);
  expect(await adapter.consumeOne({ model: "verification", where: [{ field: "identifier", value: "reset-x" }] })).toBeNull();
  const [count, update, remove, consume] = sql();
  expect(count).toBe('SELECT count(*) AS count FROM "app_x"."session" WHERE "userId" = $1');
  expect(update).toMatch(/^UPDATE "app_x"\."session" SET (?:"\w+" = \$\d, )*"ipAddress" = \$\d(?:, "\w+" = \$\d)* WHERE "userId" = \$\d$/);
  expect(remove).toBe('DELETE FROM "app_x"."session" WHERE "userId" = $1');
  expect(consume).toBe('DELETE FROM "app_x"."verification" WHERE "id" IN (SELECT "id" FROM "app_x"."verification" WHERE "identifier" = $1 LIMIT 1) RETURNING *');
  expect(params()[1]).toContain("1.1.1.1");
});

test("adapter mapping: authTables/twoFactorTables with generateId false, twoFactor plugin table with native incrementOne", async () => {
  const { adapter, sql, params } = await adapterFor({
    ...authTables(),
    advanced: { database: { generateId: false } },
    plugins: [twoFactor({ schema: twoFactorTables() })],
  });
  const user = await adapter.create({ model: "user", data: { name: "A", email: "a@x", emailVerified: false } });
  expect(user).toMatchObject({ id: "u1", name: "A", email: "a@x", emailVerified: false, createdAt: new Date(0) });
  const counter = await adapter.incrementOne<{ failedVerificationCount: number }>({
    model: "twoFactor",
    where: [{ field: "userId", value: UUID }],
    increment: { failedVerificationCount: 1 },
    set: { lockedUntil: new Date(0) },
  });
  expect(counter?.failedVerificationCount).toBe(3);
  const [insert, increment] = sql();
  expect(insert).toMatch(/^INSERT INTO "app_x"\."users" \((?:"\w+", )*"email_verified"(?:, "\w+")*\) VALUES \((?:\$\d, )*\$\d\) RETURNING \*$/);
  expect(insert).not.toContain('"id"');
  expect(increment).toBe(
    'UPDATE "app_x"."two_factor" SET "failed_verification_count" = COALESCE("failed_verification_count", 0) + $1, "locked_until" = $2 WHERE "user_id" = $3 AND "id" IN (SELECT "id" FROM "app_x"."two_factor" WHERE "user_id" = $4 LIMIT 1) RETURNING *',
  );
  expect(params()[1]).toMatchObject([1, expect.anything(), UUID, UUID]);
});

test("adapter transaction: one reserved connection, BEGIN … COMMIT, ROLLBACK on error", async () => {
  const { adapter, sql } = await adapterFor();
  await adapter.transaction(async (trx) => {
    await trx.findOne({ model: "user", where: [{ field: "id", value: "1" }] });
    await trx.delete({ model: "user", where: [{ field: "id", value: "1" }] });
  });
  await expect(adapter.transaction(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(sql()).toEqual(["BEGIN", 'SELECT * FROM "app_x"."user" WHERE "id" = $1 LIMIT 1', 'DELETE FROM "app_x"."user" WHERE "id" = $1', "COMMIT", "BEGIN", "ROLLBACK"]);
});

test("adapter uuid keys (generateId false): a malformed id or reference matches nothing instead of failing on the uuid column", async () => {
  const { adapter, sql, params } = await adapterFor({ ...authTables(), advanced: { database: { generateId: false } } });
  expect(await adapter.findOne({ model: "user", where: [{ field: "id", value: "not-a-uuid" }] })).toBeNull();
  await adapter.findMany({ model: "session", where: [{ field: "userId", operator: "in", value: ["x", UUID] }, { field: "id", operator: "not_in", value: ["y"] }], limit: 1 });
  await adapter.count({ model: "session", where: [{ field: "userId", operator: "ne", value: "x" }] });
  await adapter.deleteMany({ model: "session", where: [{ field: "userId", value: "' OR 1=1" }] });
  await adapter.findOne({ model: "user", where: [{ field: "id", value: UUID.toUpperCase() }] });
  await adapter.findOne({ model: "user", where: [{ field: "id", value: `{${UUID}}` }] });
  await adapter.findOne({ model: "user", where: [{ field: "email", value: "not-a-uuid" }] });
  expect(sql()).toEqual([
    'SELECT * FROM "app_x"."users" WHERE false LIMIT 1',
    'SELECT * FROM "app_x"."session" WHERE "user_id" IN ($1) AND true LIMIT 1',
    'SELECT count(*) AS count FROM "app_x"."session" WHERE "user_id" IS NOT NULL',
    'DELETE FROM "app_x"."session" WHERE false',
    'SELECT * FROM "app_x"."users" WHERE "id" = $1 LIMIT 1',
    'SELECT * FROM "app_x"."users" WHERE "id" = $1 LIMIT 1',
    'SELECT * FROM "app_x"."users" WHERE "email" = $1 LIMIT 1',
  ]);
  expect(params()[1]).toEqual([UUID]);
  // If the application generates the id (Better Auth default), the column is text: the value goes through as is.
  const text = await adapterFor();
  await text.adapter.findOne({ model: "user", where: [{ field: "id", value: "not-a-uuid" }] });
  expect(text.sql()).toEqual(['SELECT * FROM "app_x"."user" WHERE "id" = $1 LIMIT 1']);
});
