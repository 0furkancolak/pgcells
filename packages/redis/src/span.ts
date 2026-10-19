/** Telemetry in the same `Span` shape as `@0furkancolak/pgcells` (the `@0furkancolak/pgcells/telemetry` `openTelemetry`/`sentry` adapters are used
 * directly). If `onSpan` is not given, nothing is measured and no extra objects are created. */
import { errorCode, type Span, type SpanHandler } from "@0furkancolak/pgcells";

/** Ends the span: `detail` is the outcome (e.g. `hit-local`), and if `error` is given, the stable error code (`errorCode`). */
export type EndSpan = (detail?: string, error?: unknown) => void;

/** Returns `undefined` if there is no `onSpan`; the caller ends it with `end?.(…)`. A telemetry error never fails the work. */
export function startSpan(onSpan: SpanHandler | undefined, name: string, tenantId?: string): EndSpan | undefined {
  if (!onSpan) return undefined;
  const startTime = Date.now();
  const start = performance.now();
  return (detail, error) => {
    const span: Span = { name, startTime, ms: performance.now() - start };
    if (tenantId) span.tenantId = tenantId;
    if (detail) span.detail = detail;
    if (error !== undefined) span.error = errorCode(error);
    try {
      onSpan(span);
    } catch {
      // A telemetry error is ignored.
    }
  };
}

/** Ends the span when the promise settles (with the error code on failure); if there is no `end`, returns the work as is. */
export function endWith<T>(end: EndSpan | undefined, work: Promise<T>, detail?: string): Promise<T> {
  if (!end) return work;
  return work.then(
    (value) => (end(detail), value),
    (error: unknown) => {
      end(detail, error);
      throw error;
    },
  );
}
