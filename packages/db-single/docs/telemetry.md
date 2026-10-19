# Telemetry

`@0furkancolak/pgcells-single/telemetry` converts the package’s measurement events (`onSpan`) into OpenTelemetry or Sentry spans: connection wait, query and transaction durations, and migration, rollback and seed steps show up in your traces. The entry point has no dependencies; the application supplies the tracer or the Sentry object.

```ts
import { trace } from "@opentelemetry/api";
import { openTelemetry } from "@0furkancolak/pgcells-single/telemetry";

const db = createDb({ driver: bunDriver, onSpan: openTelemetry(trace.getTracer("app")) });
```

```ts
import * as Sentry from "@sentry/bun";
import { sentry } from "@0furkancolak/pgcells-single/telemetry";

const db = createDb({ driver: bunDriver, onSpan: sentry(Sentry) });
```

The same handler can also be given to the management context: `createManagement({ driver, onSpan })`; the CLI produces no spans. `dbMiddleware` uses its own `onSpan` only when it opens the pool itself; with the `database` option, the `Db`’s `onSpan` applies.

## How it works

- On every event the handler starts a span (`startTime` = the start of the work), writes the attributes and ends it at `startTime + ms`.
- The span is attached to **the context that is active when the work finishes**: if the query is awaited inside an HTTP request’s span, the DB spans appear under that request (the tracer’s async context propagation must be on: the OpenTelemetry SDK must be loaded with `--preload`, and the DB work must finish before the request span ends).
- If the work fails, the span status becomes error (code 2), and its message is the package’s stable error code. If the handler or the exporter throws, it is ignored: DB work does not fail because of telemetry. Without `onSpan` there is no extra cost.
- The event passed to `onSpan` (`Span`, from `@0furkancolak/pgcells-single`): `{ name: string; startTime: number /* epoch ms */; ms: number; error?: string; detail?: string }`.

## Span names and attributes

| Span | Where | Meaning | Sentry `op` |
|---|---|---|---|
| `db.acquire` | runtime, management | Waiting for a connection from the pool | `db.acquire` |
| `db.query` | runtime | A single query outside a transaction (`detail` = the SQL text) | `db` |
| `db.transaction` | runtime, management | `BEGIN … COMMIT` | `db.transaction` |
| `migration` | management | One migration (`detail` = ID) | `db.migration` |
| `rollback` | management | Rolling back one migration (`detail` = ID) | `db.rollback` |
| `seed` | management | One seed (`detail` = ID) | `db.seed` |

Backup, export and restore have no spans of their own; because the management context runs every job in a transaction, they appear as `db.acquire` and `db.transaction`. Attributes: `db.system.name` (`postgresql`), `repo_db.detail` (`detail`), `repo_db.duration_ms`, `error.type` (the error code). In Sentry, the **name** of the `db.query` span is the SQL text and its `op` is plain `db` (Sentry’s query view expects this); names that start with `db.` are used as they are, and others become `db.<first segment>`.

## Setup notes

Setting up the SDK (OpenTelemetry `NodeSDK`, `Sentry.init`) is the application’s job; the only requirement related to the package is that the SDK is loaded with `bun --preload ./src/instrumentation.ts src/server.ts` and that the request span stays open until the DB work finishes (the DB spans fall under it). In Workers the pool is created per request, so pass the handler inside the request too: `createDb(createConfig(env.DB.connectionString), { driver: postgresDriver, poolMax: 1, pooler: "assumed", onSpan: sentry(Sentry) })` and `ctx.waitUntil(db.close())` after the response; in `dbMiddleware`, `{ driver, perRequest: true, onSpan }`.

## Caveats

- **Volume.** Every query and every connection wait is a span; on a busy service, sample (`tracesSampleRate`) or filter: `onSpan: (span) => span.name !== "db.acquire" && toOtel(span)`.
- **The SQL text is there, the values are not.** The `db.query` span carries the SQL text with `$1`, `$2` placeholders; parameter values are in no span. The other spans carry only the name, duration, migration/seed ID and error code.
