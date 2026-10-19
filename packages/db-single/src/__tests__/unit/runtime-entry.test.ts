import { expect, test } from "bun:test";
import { join } from "node:path";
import * as api from "../../index";

test("the runtime entry exports a small, stable surface", () => {
  expect(Object.keys(api).sort()).toEqual(["AppError", "DEFAULT_SCHEMA", "createConfig", "createDb", "databaseUnavailable", "errorCode", "loadConfig"]);
});

test("the runtime bundle never contains the SQL parser or optional peers", async () => {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../index.ts")], target: "bun", external: ["pg", "postgres", "better-auth", "@neondatabase/serverless"] });
  expect(built.success).toBe(true);
  const text = await built.outputs[0]?.text();
  expect(text).not.toContain("pgsql-ast-parser");
  expect(text).not.toContain("better-auth");
});
