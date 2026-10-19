import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDatabase } from "../../index";
import { fakeDriver } from "../fixtures/fake-driver";
import { workerConfig } from "../fixtures/worker";

test("runtime options reject unbounded connection pools", async () => {
  const config = createConfig("postgres://db");
  const { driver } = fakeDriver();
  const db = createDatabase(config, { driver });
  expect(db.config.poolMax).toBe(5);
  await db.close();
  expect(() => createDatabase(config, { driver, poolMax: 999999 })).toThrow();
});
test("Workers fixture reads Hyperdrive bindings in DATABASE_URLS order", () => {
  expect(
    workerConfig({
      DB0: { connectionString: "postgres://platform" },
      DB1: "postgres://second",
      DB3: "postgres://ignored-after-gap",
    }).nodes.map((node) => node.url),
  ).toEqual(["postgres://platform", "postgres://second"]);
  expect(() => workerConfig({})).toThrow();
});
