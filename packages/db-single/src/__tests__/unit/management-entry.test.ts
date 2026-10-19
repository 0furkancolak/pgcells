import { expect, test } from "bun:test";
import * as management from "../../management";

test("the management entry exposes the context factory, the runner functions and the registry-aware prepareQuery", () => {
  expect(Object.keys(management).sort()).toEqual(["baseline", "createManagement", "migrate", "migrationStatus", "prepareQuery", "rollback", "seed"]);
});

test("prepareQuery compiles with the package's own migration tables (none registered yet)", () => {
  expect(management.prepareQuery("SELECT 1").readOnly).toBe(true);
});
