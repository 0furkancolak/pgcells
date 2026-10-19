/** Telemetri span'leri (Redis'siz): önbellek kaynakları, senkron placement isabeti, bozuk handler ve kuyruk işi hata kodu. */
import { expect, test } from "bun:test";
import type { Span } from "@0furkancolak/pgcells";
import { createCache } from "../../cache";
import { createPlacementCache } from "../../placement";
import { endWith, startSpan } from "../../span";

const recorder = () => {
  const spans: Span[] = [];
  return { spans, onSpan: (span: Span) => void spans.push(span), details: () => spans.map((s) => `${s.name}:${s.detail ?? ""}`) };
};

test("cache spans: hit-local, miss, set and tenant invalidation", async () => {
  const { spans, onSpan, details } = recorder();
  const cache = createCache({ onSpan });
  const tenant = cache.forTenant("abc");
  expect(await tenant.wrap("k", () => 1)).toBe(1);
  expect(await tenant.get<number>("k")).toBe(1);
  await cache.set("g", 2);
  await cache.invalidateTenant("abc");
  expect(details()).toEqual(["cache.get:miss", "cache.get:hit-local", "cache.set:", "cache.invalidate:tenant"]);
  expect(spans[0]).toMatchObject({ tenantId: "abc" });
  expect(spans[2]?.tenantId).toBeUndefined();
  expect(spans.every((s) => s.startTime > 0 && s.ms >= 0 && s.error === undefined)).toBe(true);
});

test("placement span: sync local hit stays sync, db load is reported", async () => {
  const { spans, onSpan, details } = recorder();
  const active = { tenantId: "abc", databaseId: "db1", kind: "tenant", schemaName: "tenant_abc", status: "active", schemaVersion: 1, placementVersion: 1 } as const;
  const db = { platform: { get: async () => active } } as never;
  const placements = createPlacementCache({ db, onSpan });
  await placements.loadPlacement("abc");
  expect(placements("abc")).toEqual(active); // Promise değil
  expect(await createPlacementCache({ db, onSpan })("abc")).toBeUndefined();
  expect(details()).toEqual(["placement.cache:db", "placement.cache:hit-local", "placement.cache:miss"]);
  expect(spans[1]?.tenantId).toBe("abc");
});

test("a throwing span handler never breaks the operation", async () => {
  const cache = createCache({
    onSpan: () => {
      throw new Error("telemetry down");
    },
  });
  expect(await cache.wrap("k", async () => "v")).toBe("v");
  expect(await cache.get<string>("k")).toBe("v");
  await cache.del("k");
});

test("job span carries the error code on failure", async () => {
  const { spans, onSpan } = recorder();
  const failing = Promise.reject(Object.assign(new Error("dup"), { code: "23505" }));
  await expect(endWith(startSpan(onSpan, "queue.job", "abc"), failing, "create-student")).rejects.toThrow("dup");
  expect(await endWith(startSpan(onSpan, "queue.job", "abc"), Promise.resolve(7), "count")).toBe(7);
  expect(spans.map(({ name, tenantId, detail, error }) => ({ name, tenantId, detail, error }))).toEqual([
    { name: "queue.job", tenantId: "abc", detail: "create-student", error: "23505" },
    { name: "queue.job", tenantId: "abc", detail: "count", error: undefined },
  ]);
  expect(startSpan(undefined, "queue.job")).toBeUndefined();
});
