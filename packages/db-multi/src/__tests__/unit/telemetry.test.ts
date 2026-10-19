/** Telemetri: span'ler başlangıç zamanı ve hata koduyla bildirilir, bağdaştırıcı hatası işi düşürmez, OpenTelemetry/Sentry eşlemesi. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { connect, type Span } from "../../core/database";
import type { Pool, Reserved } from "../../core/driver";
import { AppError } from "../../core/errors";
import { createDatabase } from "../../core/runtime";
import { openTelemetry, sentry, spanAttributes } from "../../telemetry";

const pool = (fail = false): Pool => {
  const query = async () => {
    if (fail) throw new AppError("TENANT_NOT_FOUND", "x");
    return Object.assign([{ ok: 1 }], { count: 1 });
  };
  const connection: Reserved = { query: query as never, exec: async () => {}, release: () => {} };
  return { query: query as never, exec: async () => {}, reserve: async () => connection, close: async () => {} };
};

test("spans carry start time and error code; a throwing handler never breaks the query", async () => {
  const spans: Span[] = [];
  const before = Date.now();
  const ok = connect(pool(), { deadlineMs: 1000, maxPending: 4, databaseId: "db1", onSpan: (span) => void spans.push(span) });
  await ok.query("SELECT 1");
  const failing = connect(pool(true), { deadlineMs: 1000, maxPending: 4, databaseId: "db1", onSpan: (span) => void spans.push(span) });
  await expect(failing.query("SELECT 1")).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  // Her sorgu ayrılmış bağlantıda çalışır (deadline'ı dolarsa bağlantı atılabilsin): önce bağlantı bekleme span'i.
  expect(spans.map((s) => [s.name, s.databaseId, s.error, s.detail])).toEqual([
    ["db.acquire", "db1", undefined, undefined],
    ["db.query", "db1", undefined, "SELECT 1"],
    ["db.acquire", "db1", undefined, undefined],
    ["db.query", "db1", "TENANT_NOT_FOUND", "SELECT 1"],
  ]);
  expect(spans[0]!.startTime).toBeGreaterThanOrEqual(before);
  const throwing = connect(pool(), { deadlineMs: 1000, maxPending: 4, onSpan: () => { throw new Error("exporter down"); } });
  expect(await throwing.query("SELECT 1")).toHaveLength(1);
});

test("a query's tenantId is carried on both its acquire and query spans", async () => {
  const spans: Span[] = [];
  const db = connect(pool(), { deadlineMs: 1000, maxPending: 4, databaseId: "db1", onSpan: (span) => void spans.push(span) });
  await db.query("SELECT 1", [], "acme-corp");
  expect(spans.map((s) => [s.name, s.tenantId])).toEqual([
    ["db.acquire", "acme-corp"],
    ["db.query", "acme-corp"],
  ]);
});

test("OpenTelemetry and Sentry adapters map name, times, attributes and error status", () => {
  const span: Span = { name: "migration", startTime: 1_700_000_000_000, ms: 12.5, databaseId: "db0", tenantId: "abc", detail: "20260901083015_initial", error: "23505" };
  expect(spanAttributes(span)).toEqual({
    "db.system.name": "postgresql", "repo_db.duration_ms": 12.5, "db.namespace": "db0", "tenant.id": "abc", "repo_db.detail": "20260901083015_initial", "error.type": "23505",
  });
  const recorded: unknown[] = [];
  const fakeSpan = { setStatus: (status: unknown) => recorded.push(["status", status]), end: (end: Date) => recorded.push(["end", end.getTime()]) };
  openTelemetry({ startSpan: (name, options) => (recorded.push(["otel", name, options.startTime.getTime()]), fakeSpan) })(span);
  sentry({ startInactiveSpan: (options) => (recorded.push(["sentry", options.name, options.op]), fakeSpan) })({ ...span, name: "db.query", error: undefined });
  expect(recorded).toEqual([
    ["otel", "migration", 1_700_000_000_000],
    ["status", { code: 2, message: "23505" }],
    ["end", 1_700_000_000_012],
    // db.query span'inde Sentry adı bağlı SQL metnidir (`detail`), op düz `db`.
    ["sentry", "20260901083015_initial", "db"],
    ["end", 1_700_000_000_012],
  ]);
});

test("Sentry adapter falls back to the span name when a query has no captured SQL text", () => {
  const recorded: unknown[] = [];
  const fakeSpan = { setStatus: () => {}, end: () => {} };
  const span: Span = { name: "db.query", startTime: 0, ms: 1, databaseId: "db0" };
  sentry({ startInactiveSpan: (options) => (recorded.push([options.name, options.op]), fakeSpan) })(span);
  expect(recorded).toEqual([["db.query", "db"]]);
});

test("createDatabase reads DATABASE_URLS when no config is given", async () => {
  const previous = process.env.DATABASE_URLS;
  process.env.DATABASE_URLS = "postgres://u:p@127.0.0.1:1/a,postgres://u:p@127.0.0.1:1/b";
  try {
    const db = createDatabase({ driver: () => pool() });
    expect(db.config.nodes.map((node) => node.id)).toEqual(["db0", "db1"]);
    await db.close();
    const explicit = createDatabase(createConfig(["postgres://u:p@127.0.0.1:1/c"]), { driver: () => pool() });
    expect(explicit.config.nodes).toHaveLength(1);
    await explicit.close();
  } finally {
    process.env.DATABASE_URLS = previous;
  }
});

test("poolGauges registers observable gauges that read db.stats() when the SDK collects", async () => {
  const { poolGauges } = await import("../../telemetry");
  const callbacks = new Map<string, (result: { observe(value: number, attributes?: Record<string, string | number>): void }) => void>();
  const meter = {
    createObservableGauge: (name: string) => ({ addCallback: (callback: never) => void callbacks.set(name, callback) }),
  };
  const pool = { inUse: 2, waiting: 1, maxPending: 64, acquireP50Ms: 0.4, acquireP99Ms: null, expiredDiscarded: 3, busyRejected: 5 };
  poolGauges({ stats: () => ({ databases: { db0: pool, "db0#1": { ...pool, inUse: 0 } }, contexts: { active: 7, tenantBusyRejected: 0, draining: false } }) }, meter);
  expect([...callbacks.keys()]).toEqual(
    expect.arrayContaining(["pgcells.pool.in_use", "pgcells.pool.waiting", "pgcells.pool.acquire_p99_ms", "pgcells.pool.busy_rejected", "pgcells.contexts.active"]),
  );
  const observed = (name: string) => {
    const seen: [number, Record<string, string | number> | undefined][] = [];
    callbacks.get(name)?.({ observe: (value, attributes) => void seen.push([value, attributes]) });
    return seen;
  };
  expect(observed("pgcells.pool.in_use")).toEqual([[2, { "db.namespace": "db0" }], [0, { "db.namespace": "db0#1" }]]);
  expect(observed("pgcells.pool.acquire_p99_ms")).toEqual([]); // no samples yet: nothing is observed rather than a fake zero
  expect(observed("pgcells.contexts.active")).toEqual([[7, undefined]]);
});
