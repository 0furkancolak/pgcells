/** Directory (db0) resilience: placement reads served by a db0 replica, and stale-if-error when the directory is unreachable. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDatabase } from "../../core/runtime";
import type { Span } from "../../core/database";
import { fakeDriver } from "../fixtures/fake-driver";

const row = (status: string) => ({ tenantId: "abc", databaseId: "db0", kind: "tenant", schemaName: "tenant_abc", status, schemaVersion: 1, placementVersion: 1 });
const refused = () => Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Platform-directory behaviour of a fake db0 (and optionally one replica of it). Every test gets its own URLs: replica status is cached per URL. */
let serial = 0;
function directory(options: { replica?: { rows?: unknown[]; lagMs?: number; fail?: boolean } } & Record<string, unknown> = {}) {
  const n = ++serial;
  const primaryUrl = `postgres://u:p@primary${n}.example/app`;
  const replicaUrl = `postgres://u:p@replica${n}.example/app`;
  const state = { primary: [row("active")] as unknown[] | Error, replica: options.replica };
  const spans: Span[] = [];
  const fake = fakeDriver((text, _params, pool) => {
    const onReplica = pool.url === replicaUrl;
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/1" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: true, caught_up: (state.replica?.lagMs ?? 0) === 0, lag_ms: state.replica?.lagMs ?? 0 }];
    if (text.includes("platform.placements")) {
      if (onReplica) {
        if (state.replica?.fail) throw refused();
        return state.replica?.rows ?? [row("active")];
      }
      if (state.primary instanceof Error) throw state.primary;
      return state.primary;
    }
    return [];
  });
  const db = createDatabase(createConfig([primaryUrl], options.replica ? `db0=${replicaUrl}` : []), {
    driver: fake.driver,
    onSpan: (span) => spans.push(span),
    ...options,
  });
  const reads = (url: string) => fake.commands.filter((command) => command.url === url && command.text.includes("platform.placements")).length;
  return { db, state, spans, primaryUrl, replicaUrl, reads };
}

test("with a db0 replica, an active placement is read from the replica and the primary is not asked", async () => {
  const { db, primaryUrl, replicaUrl, reads } = directory({ replica: {} });
  expect(await db.placement("abc")).toMatchObject({ status: "active", databaseId: "db0" });
  expect(reads(replicaUrl)).toBe(1);
  expect(reads(primaryUrl)).toBe(0);
  await db.close();
});

test("a replica record that is not active is verified on the primary, whose answer wins", async () => {
  const { db, state, primaryUrl, replicaUrl, reads } = directory({ replica: { rows: [row("migrating")] } });
  state.primary = [row("maintenance")];
  expect(await db.placement("abc")).toMatchObject({ status: "maintenance" });
  expect(reads(replicaUrl)).toBe(1);
  expect(reads(primaryUrl)).toBe(1);
  await db.close();
});

test("a tenant missing on the replica (not replicated yet) is verified on the primary", async () => {
  const { db, primaryUrl, reads } = directory({ replica: { rows: [] } });
  expect(await db.placement("abc")).toMatchObject({ status: "active" });
  expect(reads(primaryUrl)).toBe(1);
  await db.close();
});

test("a replica over the lag threshold or a failing replica read falls back to the primary without surfacing an error", async () => {
  const lagging = directory({ replica: { lagMs: 60_000 } });
  expect(await lagging.db.placement("abc")).toMatchObject({ status: "active" });
  expect(lagging.reads(lagging.replicaUrl)).toBe(0);
  expect(lagging.reads(lagging.primaryUrl)).toBe(1);
  await lagging.db.close();

  const failing = directory({ replica: { fail: true } });
  expect(await failing.db.placement("abc")).toMatchObject({ status: "active" });
  expect(failing.reads(failing.primaryUrl)).toBe(1);
  await failing.db.close();
});

test("a missing tenant is still TENANT_NOT_FOUND when the replica has no row and neither has the primary", async () => {
  const { db, state } = directory({ replica: { rows: [] } });
  state.primary = [];
  await expect(db.placement("abc")).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  await db.close();
});

test("without staleIfErrorMs an unreachable directory fails the placement read even though an expired entry exists", async () => {
  const { db, state } = directory({ placementCacheMs: 1 });
  await db.placement("abc");
  await sleep(10);
  state.primary = refused();
  await expect(db.placement("abc")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  await db.close();
});

test("with staleIfErrorMs an expired active entry is served while the directory is unreachable, for a bounded time", async () => {
  const { db, state, spans } = directory({ placementCacheMs: 1, staleIfErrorMs: 300 });
  await db.placement("abc");
  await sleep(10);
  state.primary = refused();
  expect(await db.placement("abc")).toMatchObject({ status: "active", databaseId: "db0" });
  expect(spans.some((span) => span.name === "placement.stale" && span.tenantId === "abc")).toBe(true);
  await sleep(350);
  await expect(db.placement("abc")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  await db.close();
});

test("stale entries are not used for other failures, after invalidation, or for a tenant that was never cached", async () => {
  const wrong = directory({ placementCacheMs: 1, staleIfErrorMs: 5_000 });
  await wrong.db.placement("abc");
  await sleep(10);
  wrong.state.primary = Object.assign(new Error("relation does not exist"), { errno: "42P01" });
  await expect(wrong.db.placement("abc")).rejects.toMatchObject({ errno: "42P01" });
  await wrong.db.close();

  const invalidated = directory({ placementCacheMs: 1, staleIfErrorMs: 5_000 });
  await invalidated.db.placement("abc");
  await sleep(10);
  invalidated.db.invalidatePlacement("abc"); // a move told this process
  invalidated.state.primary = refused();
  await expect(invalidated.db.placement("abc")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  await invalidated.db.close();

  const cold = directory({ staleIfErrorMs: 5_000 });
  cold.state.primary = refused();
  await expect(cold.db.placement("abc")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  await cold.db.close();
});

test("a migrating placement is never cached, so it is never served stale", async () => {
  const { db, state } = directory({ placementCacheMs: 1, staleIfErrorMs: 5_000 });
  await db.placement("abc");
  await sleep(10);
  state.primary = [row("migrating")];
  expect(await db.placement("abc")).toMatchObject({ status: "migrating" });
  state.primary = refused();
  await expect(db.placement("abc")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  await db.close();
});

test("while the directory is down, repeated lookups reuse the stale entry without hammering it on every request", async () => {
  const { db, state, primaryUrl, reads } = directory({ placementCacheMs: 1, staleIfErrorMs: 5_000 });
  await db.placement("abc");
  await sleep(10);
  state.primary = refused();
  const before = reads(primaryUrl);
  for (let i = 0; i < 5; i++) expect(await db.placement("abc")).toMatchObject({ status: "active" });
  expect(reads(primaryUrl) - before).toBe(1);
  await db.close();
});

test("staleIfErrorMs above five minutes is rejected", () => {
  expect(() => directory({ staleIfErrorMs: 300_001 })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
