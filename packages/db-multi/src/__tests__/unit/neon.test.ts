import { Pool, types } from "@neondatabase/serverless";
import { expect, test } from "bun:test";
import { neonDriver } from "../../core/drivers/neon";

test("the Neon module offers the surface createPgDriver relies on", () => {
  expect(typeof Pool).toBe("function");
  expect(typeof types.getTypeParser).toBe("function");
  for (const method of ["connect", "query", "end", "on"]) expect(typeof (Pool.prototype as unknown as Record<string, unknown>)[method], method).toBe("function");
});

test("neonDriver builds a lazy pool: nothing connects until it is used and close returns", async () => {
  const pool = neonDriver("postgres://app:pw@ep-cool-1.eu-central-1.aws.neon.tech/neondb?sslmode=require", {
    max: 1,
    idleTimeoutSeconds: 1,
    maxLifetimeSeconds: 0,
    connectTimeoutSeconds: 5,
  });
  await pool.close(1000);
});
