/** Telemetry entry point (`@0furkancolak/pgcells-single/telemetry`): converts `onSpan` events into OpenTelemetry or Sentry spans. It has no dependency;
 * the application supplies the tracer or the Sentry object. When the work finishes, the span is attached to the currently active context (e.g. the HTTP request's span).
 *
 *   import { trace } from "@opentelemetry/api";
 *   createDb({ driver: bunDriver, onSpan: openTelemetry(trace.getTracer("app")) });
 *
 *   import * as Sentry from "@sentry/bun";
 *   createDb({ driver: bunDriver, onSpan: sentry(Sentry) });
 *
 * In Sentry the `db.query` span matches Sentry's query view: the op is plain `db`, the name is the bound SQL text (not the parameter
 * values — the query is always reported with placeholders such as `$1`, `$2`), it appears as `db - select …` in the trace view
 * and is listed nested under the HTTP request's span.
 */
import type { Span, SpanHandler } from "./core/database";

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
/** The smallest interface compatible with `@sentry/*` (v8+) `startInactiveSpan`. */
export interface SentryClient {
  startInactiveSpan(options: { name: string; op: string; startTime: Date; attributes: Attributes }): TelemetrySpan;
}

/** OpenTelemetry `SpanStatusCode.ERROR` (also 2 in Sentry). */
const STATUS_ERROR = 2;

/** Attributes with OpenTelemetry semantic names: `db.system.name`, `error.type` and the package-specific `repo_db.*`. */
export function spanAttributes(span: Span): Attributes {
  const attributes: Attributes = { "db.system.name": "postgresql", "repo_db.duration_ms": span.ms };
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

/** The name matching Sentry's query view for a query span: the SQL text (`span.detail`); otherwise the span name. */
const sentryName = (span: Span) => (span.name === "db.query" && span.detail ? span.detail : span.name);

/** Sentry `op`: the query span is plain `db` (Sentry's SQL view expects this, and the name is already the query text), the others are
 * `db.<group>` (`migration` → `db.migration`). */
const sentryOp = (name: string) => (name === "db.query" ? "db" : name.startsWith("db.") ? name : `db.${name.split(".")[0]}`);

export function sentry(client: SentryClient): SpanHandler {
  return (span) =>
    finish(client.startInactiveSpan({ name: sentryName(span), op: sentryOp(span.name), startTime: new Date(span.startTime), attributes: spanAttributes(span) }), span);
}
