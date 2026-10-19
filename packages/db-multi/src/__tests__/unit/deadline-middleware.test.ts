/** Client response deadline (when PgBouncer is left without a server) and handing the application's database to middleware. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { connect } from "../../core/database";
import type { Pool, Reserved } from "../../core/driver";
import { createDatabase } from "../../core/runtime";
import { dbMiddleware } from "../../middleware";

const never = () => new Promise<never>(() => {});
const hangingPool = (): Pool => {
  const connection: Reserved = { query: never, exec: never, release: () => {} };
  return { query: never, exec: never, reserve: async () => connection, close: async () => {} };
};

test("a query that never gets an answer fails with DATABASE_TIMEOUT after statementTimeoutMs + 1 s (+ cancel wait), for every waiting query", async () => {
  const db = connect(hangingPool(), { deadlineMs: 100, maxPending: 8 });
  const started = performance.now();
  const outcomes = await Promise.allSettled([db.query("SELECT 1"), db.query("SELECT 2")]);
  const elapsed = performance.now() - started;
  expect(outcomes.map((o) => (o.status === "rejected" ? (o.reason as { code?: string }).code : "resolved"))).toEqual(["DATABASE_TIMEOUT", "DATABASE_TIMEOUT"]);
  expect(elapsed).toBeGreaterThanOrEqual(1000);
  expect(elapsed).toBeLessThan(2500);
  await db.close();
});

test("dbMiddleware uses the application's database when given one and rejects ambiguous options", async () => {
  const database = createDatabase(createConfig(["postgres://u:p@127.0.0.1:1/app"]), { driver: () => hangingPool() });
  let seen: unknown;
  const middleware = dbMiddleware({ database, rootDomain: "example.test" });
  await middleware({ req: { header: () => "abc.example.test" }, set: (_key, value) => void (seen = value) }, async () => {});
  expect((seen as { tenantId: string }).tenantId).toBe("abc");
  expect(() => dbMiddleware({ rootDomain: "example.test" })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(() => dbMiddleware({ database, driver: () => hangingPool(), rootDomain: "example.test" })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(() => dbMiddleware({ database, perRequest: true, rootDomain: "example.test" })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  await database.close();
});
