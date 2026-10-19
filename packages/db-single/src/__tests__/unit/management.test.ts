import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { fakeDriver } from "../fixtures/fake-driver";

const URL_ = "postgres://admin:secret-pw@127.0.0.1:7100/app";

test("a bad schema is refused before any pool opens", () => {
  const fake = fakeDriver();
  expect(() => createManagement(createConfig(URL_), { driver: fake.driver, schema: "Bad" })).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
  expect(fake.pools).toHaveLength(0);
});

test("the management context holds one primary pool and the schema, defaulting to public", async () => {
  const fake = fakeDriver();
  const m = createManagement(createConfig(URL_), { driver: fake.driver });
  expect(m.schema).toBe("public");
  expect(m.db).toBe(m.pools.primary);
  expect(fake.pools).toHaveLength(1);
  expect(fake.pools[0]?.options.max).toBe(4);
  await m.close();
  expect(fake.pools[0]?.closed).toBe(true);
});

test("management queries run in a transaction with the migration timeouts", async () => {
  const fake = fakeDriver(() => [{ ok: 1 }]);
  const m = createManagement(createConfig(URL_), { driver: fake.driver, schema: "app_x", migrationStatementTimeoutMs: 45000, migrationLockTimeoutMs: 2000 });
  await m.db.query("SELECT 1");
  expect(fake.commands.map((command) => command.text)).toEqual(["BEGIN; SET LOCAL statement_timeout = 45000; SET LOCAL lock_timeout = 2000", "SELECT 1", "COMMIT"]);
  await m.close();
});

test("span reports the run work with its detail", async () => {
  const spans: { name: string; detail?: string }[] = [];
  const fake = fakeDriver();
  const m = createManagement(createConfig(URL_), { driver: fake.driver, onSpan: (span) => void spans.push(span) });
  await m.span("migration", async () => {}, { detail: "20260101000001_x" });
  expect(spans.map((span) => [span.name, span.detail])).toEqual([["migration", "20260101000001_x"]]);
  await m.close();
});
