/** Telemetri: span'ler başlangıç zamanı ve hata koduyla bildirilir, bağdaştırıcı hatası işi düşürmez, OpenTelemetry/Sentry eşlemesi. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { connect, type Span } from "../../core/database";
import type { Pool, Reserved } from "../../core/driver";
import { AppError } from "../../core/errors";
import { createDb } from "../../core/runtime";
import { openTelemetry, sentry, spanAttributes } from "../../telemetry";

const pool = (fail = false): Pool => {
  const query = async () => {
    if (fail) throw new AppError("DATABASE_BUSY", "x");
    return Object.assign([{ ok: 1 }], { count: 1 });
  };
  const connection: Reserved = { query: query as never, exec: async () => {}, release: () => {} };
  return { query: query as never, exec: async () => {}, reserve: async () => connection, close: async () => {} };
};

test("spans carry start time and error code; a throwing handler never breaks the query", async () => {
  const spans: Span[] = [];
  const before = Date.now();
  const ok = connect(pool(), { deadlineMs: 1000, maxPending: 4, onSpan: (span) => void spans.push(span) });
  await ok.query("SELECT 1");
  const failing = connect(pool(true), { deadlineMs: 1000, maxPending: 4, onSpan: (span) => void spans.push(span) });
  await expect(failing.query("SELECT 1")).rejects.toMatchObject({ code: "DATABASE_BUSY" });
  // Her sorgu ayrılmış bağlantıda çalışır (deadline'ı dolarsa bağlantı atılabilsin): önce bağlantı bekleme span'i.
  expect(spans.map((s) => [s.name, s.error, s.detail])).toEqual([
    ["db.acquire", undefined, undefined],
    ["db.query", undefined, "SELECT 1"],
    ["db.acquire", undefined, undefined],
    ["db.query", "DATABASE_BUSY", "SELECT 1"],
  ]);
  expect(spans[0]!.startTime).toBeGreaterThanOrEqual(before);
  const throwing = connect(pool(), { deadlineMs: 1000, maxPending: 4, onSpan: () => { throw new Error("exporter down"); } });
  expect(await throwing.query("SELECT 1")).toHaveLength(1);
});

test("OpenTelemetry and Sentry adapters map name, times, attributes and error status", () => {
  const span: Span = { name: "migration", startTime: 1_700_000_000_000, ms: 12.5, detail: "20260901083015_initial", error: "23505" };
  expect(spanAttributes(span)).toEqual({
    "db.system.name": "postgresql", "repo_db.duration_ms": 12.5, "repo_db.detail": "20260901083015_initial", "error.type": "23505",
  });
  const recorded: unknown[] = [];
  const fakeSpan = { setStatus: (status: unknown) => recorded.push(["status", status]), end: (end: Date) => recorded.push(["end", end.getTime()]) };
  openTelemetry({ startSpan: (name, options) => (recorded.push(["otel", name, options.startTime.getTime()]), fakeSpan) })(span);
  sentry({ startInactiveSpan: (options) => (recorded.push(["sentry", options.name, options.op]), fakeSpan) })({ ...span, name: "db.query", error: undefined });
  sentry({ startInactiveSpan: (options) => (recorded.push(["sentry", options.name, options.op]), fakeSpan) })({ ...span, error: undefined });
  expect(recorded).toEqual([
    ["otel", "migration", 1_700_000_000_000],
    ["status", { code: 2, message: "23505" }],
    ["end", 1_700_000_000_012],
    // db.query span'inde Sentry adı bağlı SQL metnidir (`detail`), op düz `db`.
    ["sentry", "20260901083015_initial", "db"],
    ["end", 1_700_000_000_012],
    // Diğer span'ler adını korur, op `db.<grup>` olur (`migration` → `db.migration`).
    ["sentry", "migration", "db.migration"],
    ["end", 1_700_000_000_012],
  ]);
});

test("Sentry adapter falls back to the span name when a query has no captured SQL text", () => {
  const recorded: unknown[] = [];
  const fakeSpan = { setStatus: () => {}, end: () => {} };
  const span: Span = { name: "db.query", startTime: 0, ms: 1 };
  sentry({ startInactiveSpan: (options) => (recorded.push([options.name, options.op]), fakeSpan) })(span);
  expect(recorded).toEqual([["db.query", "db"]]);
});

test("createDb reads DATABASE_URLS when no config is given", async () => {
  const previous = process.env.DATABASE_URLS;
  process.env.DATABASE_URLS = "postgres://u:p@127.0.0.1:1/a";
  try {
    const db = createDb({ driver: () => pool() });
    expect(db.config.url).toBe("postgres://u:p@127.0.0.1:1/a");
    await db.close();
    const explicit = createDb(createConfig("postgres://u:p@127.0.0.1:1/c"), { driver: () => pool() });
    expect(explicit.config.url).toBe("postgres://u:p@127.0.0.1:1/c");
    await explicit.close();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URLS;
    else process.env.DATABASE_URLS = previous;
  }
});
