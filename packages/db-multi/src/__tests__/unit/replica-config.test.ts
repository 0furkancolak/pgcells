import { expect, test } from "bun:test";
import { createConfig, replicaPolicy, runtimeSettings } from "../../core/config";
import { createDatabase } from "../../core/runtime";
import { fakeDriver } from "../fixtures/fake-driver";

const config = createConfig(["postgres://a@h/d"]);

test("replica settings default to 5000 and are bounded integers", () => {
  expect(runtimeSettings(config)).toMatchObject({ replicaMaxLagMs: 5000, replicaStatusMs: 5000 });
  for (const bad of [0, -1, 1.5, "x", 3_600_001])
    expect(() => runtimeSettings(config, { replicaMaxLagMs: bad as number })).toThrow("replicaMaxLagMs must be an integer from 1 to 3600000");
  expect(() => runtimeSettings(config, { replicaStatusMs: 60_001 })).toThrow("replicaStatusMs must be an integer from 1 to 60000");
  expect(runtimeSettings(config, { replicaMaxLagMs: 200, replicaStatusMs: 1 })).toMatchObject({ replicaMaxLagMs: 200, replicaStatusMs: 1 });
});

test("replicaPolicy accepts primary and error only and defaults to primary", () => {
  expect(replicaPolicy()).toBe("primary");
  expect(replicaPolicy("error")).toBe("error");
  expect(() => replicaPolicy("fallback")).toThrow('replicaOnUnavailable must be "primary" or "error"');
});

test("createDatabase rejects an invalid replicaOnUnavailable with INVALID_CONFIG", () => {
  const { driver } = fakeDriver();
  expect(() => createDatabase(config, { driver, replicaOnUnavailable: "nope" as never })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
