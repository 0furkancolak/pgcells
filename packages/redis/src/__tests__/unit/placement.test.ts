/** Placement önbelleği süresi, taşımanın beklediği sınırı (`PLACEMENT_CACHE_MAX_MS`) aşamaz. */
import { expect, test } from "bun:test";
import { PLACEMENT_CACHE_MAX_MS } from "@0furkancolak/pgcells";
import { createPlacementCache } from "../../placement";

const db = { platform: { get: async () => ({}) as never } } as unknown as Parameters<typeof createPlacementCache>[0]["db"];

test("placement cache lifetimes above the move wait bound are refused", () => {
  expect(() => createPlacementCache({ db })).not.toThrow();
  expect(() => createPlacementCache({ db, ttlSeconds: PLACEMENT_CACHE_MAX_MS / 1000, localTtlMs: 0 })).not.toThrow();
  expect(() => createPlacementCache({ db, ttlSeconds: 60 })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(() => createPlacementCache({ db, ttlSeconds: 20, localTtlMs: 6_000 })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
