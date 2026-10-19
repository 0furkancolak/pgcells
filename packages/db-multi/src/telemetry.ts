/** Telemetry entry point (`@0furkancolak/pgcells/telemetry`): converts `onSpan` events into OpenTelemetry or Sentry spans. It has no dependencies;
 * the application provides the tracer or the Sentry object. When the work finishes, the span is attached to the currently active context (e.g. the HTTP request's span).
 *
 *   import { trace } from "@opentelemetry/api";
 *   createDatabase({ driver: bunDriver, onSpan: openTelemetry(trace.getTracer("app")) });
 *
 *   import * as Sentry from "@sentry/bun";
 *   createDatabase({ driver: bunDriver, onSpan: sentry(Sentry) });
 *
 * In Sentry, the `db.query` span matches Sentry's query view: the op is plain `db`, and the name is the bound SQL text (not the parameter
 * values — the query is always reported with placeholders such as `$1`, `$2`), it appears in the trace view as `db - select …`
 * and is listed nested under the HTTP request's span.
 */
import type { PoolStats, Span, SpanHandler } from "./core/database";
import type { ContextStats } from "./core/runtime";

export type { Span, SpanHandler };

type Attributes = Record<string, string | number>;
/** The part shared by OpenTelemetry and Sentry spans. */
interface TelemetrySpan {
  setStatus(status: { code: number; message?: string }): unknown;
  end(endTime: Date): void;
}
/** The smallest interface compatible with the `@opentelemetry/api` `Tracer`. */
export interface OpenTelemetryTracer {
  startSpan(name: string, options: { startTime: Date; attributes: Attributes }): TelemetrySpan;
}
/** The smallest interface compatible with `startInactiveSpan` in `@sentry/*` (v8+). */
export interface SentryClient {
  startInactiveSpan(options: { name: string; op: string; startTime: Date; attributes: Attributes }): TelemetrySpan;
}

/** OpenTelemetry `SpanStatusCode.ERROR` (also 2 in Sentry). */
const STATUS_ERROR = 2;

/** Attributes with OpenTelemetry semantic names: `db.system.name`, `db.namespace` (DB id), `tenant.id`, `error.type`. */
export function spanAttributes(span: Span): Attributes {
  const attributes: Attributes = { "db.system.name": "postgresql", "repo_db.duration_ms": span.ms };
  if (span.databaseId) attributes["db.namespace"] = span.databaseId;
  if (span.tenantId) attributes["tenant.id"] = span.tenantId;
  if (span.detail) attributes["repo_db.detail"] = span.detail;
  if (span.error) attributes["error.type"] = span.error;
  return attributes;
}

function finish(target: TelemetrySpan, span: Span) {
  if (span.error) target.setStatus({ code: STATUS_ERROR, message: span.error });
  target.end(new Date(span.startTime + span.ms));
}

export function openTelemetry(tracer: OpenTelemetryTracer): SpanHandler {
  return (span) => finish(tracer.startSpan(span.name, { startTime: new Date(span.startTime), attributes: spanAttributes(span) }), span);
}

/** For a query span, the name that matches Sentry's query view: the SQL text (`span.detail`); otherwise the span name. */
const sentryName = (span: Span) => (span.name === "db.query" && span.detail ? span.detail : span.name);

/** Sentry `op`: a query span is plain `db` (Sentry's SQL view expects this; the name is already the query text), others are
 * `db.<group>` (`tenant.lock` → `db.tenant`). */
const sentryOp = (name: string) => (name === "db.query" ? "db" : name.startsWith("db.") ? name : `db.${name.split(".")[0]}`);

export function sentry(client: SentryClient): SpanHandler {
  return (span) =>
    finish(client.startInactiveSpan({ name: sentryName(span), op: sentryOp(span.name), startTime: new Date(span.startTime), attributes: spanAttributes(span) }), span);
}

/** The smallest interface compatible with the `@opentelemetry/api` `Meter` that `poolGauges` needs. */
export interface OpenTelemetryMeter {
  createObservableGauge(
    name: string,
    options?: { description?: string; unit?: string },
  ): { addCallback(callback: (result: { observe(value: number, attributes?: Attributes): void }) => void): void };
}
/** What `poolGauges` reads: a `Database` (or `RotatingDatabase`). */
export interface StatsSource {
  stats(): { databases: Record<string, PoolStats>; contexts: ContextStats };
}

/** Registers observable gauges for the pool counters of `db.stats()`; the OpenTelemetry SDK calls them on its own export interval, so the package starts no timer.
 * Gauges per database (`db.namespace`): in use, waiting, p50/p99 acquisition time, discarded connections, refused jobs; per process: running contexts. */
export function poolGauges(source: StatsSource, meter: OpenTelemetryMeter): void {
  const perDatabase: [string, string, keyof PoolStats][] = [
    ["pgcells.pool.in_use", "Connections reserved right now", "inUse"],
    ["pgcells.pool.waiting", "Jobs waiting for a connection", "waiting"],
    ["pgcells.pool.acquire_p50_ms", "Median time to obtain a connection over the last 256 acquisitions", "acquireP50Ms"],
    ["pgcells.pool.acquire_p99_ms", "99th percentile time to obtain a connection over the last 256 acquisitions", "acquireP99Ms"],
    ["pgcells.pool.expired_discarded", "Connections discarded after a deadline expired (cumulative)", "expiredDiscarded"],
    ["pgcells.pool.busy_rejected", "Jobs refused with DATABASE_BUSY (cumulative)", "busyRejected"],
  ];
  for (const [name, description, key] of perDatabase)
    meter.createObservableGauge(name, { description }).addCallback((result) => {
      for (const [id, stats] of Object.entries(source.stats().databases)) {
        const value = stats[key];
        if (value !== null) result.observe(value, { "db.namespace": id });
      }
    });
  meter.createObservableGauge("pgcells.contexts.active", { description: "Tenant, node and platform contexts running in this process" }).addCallback((result) => {
    result.observe(source.stats().contexts.active);
  });
}
