import { expect, test } from "bun:test";
import { createConfig, managementSettings, PLACEMENT_CACHE_MAX_MS } from "../../core/config";

const single = createConfig(["postgres://u:p@h/a"]);
const withDirectoryReplica = createConfig(["postgres://u:p@h/a"], "db0=postgres://u:p@r/a");

test("the default wait covers the longest placement cache, with or without a directory replica", () => {
  expect(managementSettings(single).placementCacheWaitMs).toBeGreaterThanOrEqual(PLACEMENT_CACHE_MAX_MS);
  expect(managementSettings(withDirectoryReplica).placementCacheWaitMs).toBeGreaterThanOrEqual(PLACEMENT_CACHE_MAX_MS + managementSettings(withDirectoryReplica).replicaMaxLagMs);
});

test("a wait shorter than the longest placement cache is INVALID_CONFIG", () => {
  expect(() => managementSettings(single, { placementCacheWaitMs: PLACEMENT_CACHE_MAX_MS - 1 })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(managementSettings(single, { placementCacheWaitMs: PLACEMENT_CACHE_MAX_MS }).placementCacheWaitMs).toBe(PLACEMENT_CACHE_MAX_MS);
});

test("with replicas of db0 the wait must also cover replicaMaxLagMs", () => {
  const lag = 20_000;
  expect(() => managementSettings(withDirectoryReplica, { replicaMaxLagMs: lag, placementCacheWaitMs: PLACEMENT_CACHE_MAX_MS + lag - 1 })).toThrow(
    expect.objectContaining({ code: "INVALID_CONFIG" }),
  );
  expect(managementSettings(withDirectoryReplica, { replicaMaxLagMs: lag, placementCacheWaitMs: PLACEMENT_CACHE_MAX_MS + lag }).placementCacheWaitMs).toBe(PLACEMENT_CACHE_MAX_MS + lag);
  // Replicas of other nodes do not serve the directory.
  const otherReplica = createConfig(["postgres://u:p@h/a", "postgres://u:p@h2/a"], "db1=postgres://u:p@r/a");
  expect(managementSettings(otherReplica, { replicaMaxLagMs: lag, placementCacheWaitMs: PLACEMENT_CACHE_MAX_MS }).placementCacheWaitMs).toBe(PLACEMENT_CACHE_MAX_MS);
});

test("the error names the minimum and how to opt out for throwaway environments", () => {
  expect(() => managementSettings(single, { placementCacheWaitMs: 1 })).toThrow(/at least 25000/);
  expect(managementSettings(single, { placementCacheWaitMs: 1, unsafePlacementCacheWait: true }).placementCacheWaitMs).toBe(1);
});
