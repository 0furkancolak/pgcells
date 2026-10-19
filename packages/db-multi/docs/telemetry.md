# Telemetry

`@0furkancolak/pgcells/telemetry` turns the package's measurement events (`onSpan`) into OpenTelemetry or Sentry spans: placement reads, connection waits, query and transaction durations, and the provision, migration, move and backup steps appear in your application's traces. The entry point has no dependencies; the application supplies the tracer or the Sentry object. This document covers the setup for a Bun server and Cloudflare Workers, the span names and the attributes.

## In short

```ts
import { trace } from "@opentelemetry/api";
import { openTelemetry } from "@0furkancolak/pgcells/telemetry";

const db = createDatabase({ driver: bunDriver, onSpan: openTelemetry(trace.getTracer("app")) });
```

```ts
import * as Sentry from "@sentry/bun";
import { sentry } from "@0furkancolak/pgcells/telemetry";

const db = createDatabase({ driver: bunDriver, onSpan: sentry(Sentry) });
```

The same handler can be given to the management context too: `createManagement({ driver: bunDriver, onSpan: sentry(Sentry) })`. The CLI produces no spans.

## How it works

- `openTelemetry(tracer)` and `sentry(client)` return an `onSpan` handler. The handler starts a span on each event (`startTime` = the start of the work), writes the attributes and ends the span at `startTime + ms`.
- The span is attached to the **context that is active at the moment the work finishes**. If a query is awaited inside an HTTP request's span, the database spans appear under that request. For this, the tracer's async context propagation must be on (the OpenTelemetry SDK or the Sentry setup does this).
- If the work fails, the span status becomes error (code 2) and its message is the package's stable error code (`DATABASE_TIMEOUT`, `23505` …).
- If the handler or the exporter throws, it is ignored; database work never fails because of telemetry.
- If `onSpan` is not given there is no extra cost.

The event given to `onSpan` (the `Span` type, `@0furkancolak/pgcells`):

```ts
{ name: string; startTime: number /* epoch ms */; ms: number; error?: string; databaseId?: string; tenantId?: string; detail?: string }
```

## Attributes

| Attribute | Value |
|---|---|
| `db.system.name` | `postgresql` |
| `db.namespace` | The database identity (`db0`, `db1` …), if any |
| `tenant.id` | The tenant ID, if any |
| `repo_db.detail` | Extra information: the migration/seed ID, `written`/`unchanged` in a backup |
| `repo_db.duration_ms` | Duration (ms) |
| `error.type` | The error code, if the work failed |

**Pool gauges (OpenTelemetry).** `poolGauges(db, meter)` registers observable gauges that read `db.stats()` when the SDK collects (no timer of ours): `pgcells.pool.in_use`, `waiting`, `acquire_p50_ms`, `acquire_p99_ms`, `expired_discarded`, `busy_rejected` (attribute `db.namespace`) and `pgcells.contexts.active`.

```ts
import { metrics } from "@opentelemetry/api";
import { poolGauges } from "@0furkancolak/pgcells/telemetry";
poolGauges(db, metrics.getMeter("app"));
```

For another metrics system, poll `db.stats()` from your own schedule. Sentry has no adapter for these counters.

In Sentry the `op` is: names starting with `db.` as they are (`db.query`), the others `db.<first segment>` (`tenant.lock` → `db.tenant`, `move.copying` → `db.move`, `placement.read` → `db.placement`).

## Span names

| Span | Where | Meaning | Sentry `op` |
|---|---|---|---|
| `placement.read` | runtime | The placement was read from the platform database | `db.placement` |
| `placement.cache` | runtime | An in-process cache hit (`ms` = 0) | `db.placement` |
| `placement.stale` | runtime | The directory was unreachable and an expired `active` placement was served (`staleIfErrorMs`); `error` carries the code when the read just failed | `db.placement` |
| `db.acquire` | runtime, management | Waiting for a connection from the pool | `db.acquire` |
| `db.query` | runtime | A single query outside a transaction | `db.query` |
| `db.transaction` | runtime, management | `BEGIN … COMMIT` | `db.transaction` |
| `tenant.lock` | management | The tenant lock in the platform database | `db.tenant` |
| `tenant.session` | management | The management session and lock in the tenant database | `db.tenant` |
| `provision.pick` / `.claim` / `.schema` / `.activate` | management | Placement selection, placement record, schema, activation | `db.provision` |
| `migration` | management | A migration (`repo_db.detail` = ID) | `db.migration` |
| `seed` | management | A seed (`repo_db.detail` = ID) | `db.seed` |
| `move.maintenance` / `.copying` / `.validated` / `.cutover` | management | Move phases (`move.maintenance` includes the cache wait) | `db.move` |
| `backup.tenant` | management | A tenant's backup | `db.backup` |

## Bun server + OpenTelemetry

```sh
bun add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
```

`src/instrumentation.ts`:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

new NodeSDK({ serviceName: "api", traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT }) }).start();
```

`src/server.ts` — open a request span, and the database spans fall under it:

```ts
import { trace } from "@opentelemetry/api";
import { openTelemetry } from "@0furkancolak/pgcells/telemetry";

const tracer = trace.getTracer("api");
const db = createDatabase({ driver: bunDriver, onSpan: openTelemetry(tracer) });

app.use((c, next) => tracer.startActiveSpan(`${c.req.method} ${c.req.path}`, async (span) => {
  try { await next(); } finally { span.end(); }
}));
app.use(dbMiddleware({ database: db, rootDomain: "example.com" }));
```

```sh
bun --preload ./src/instrumentation.ts src/server.ts
```

## Bun server + Sentry

```sh
bun add @sentry/bun
```

```ts
import * as Sentry from "@sentry/bun";
import { sentry } from "@0furkancolak/pgcells/telemetry";

Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
const db = createDatabase({ driver: bunDriver, onSpan: sentry(Sentry) });

app.use((c, next) => Sentry.startSpan({ name: `${c.req.method} ${c.req.path}`, op: "http.server" }, () => next()));
app.use(dbMiddleware({ database: db, rootDomain: "example.com" }));
```

## Workers + Sentry

```sh
npm i @sentry/cloudflare   # wrangler: compatibility_flags ["nodejs_compat"]
```

```ts
import * as Sentry from "@sentry/cloudflare";
import { createConfig, createDatabase } from "@0furkancolak/pgcells";
import { postgresDriver } from "@0furkancolak/pgcells/drivers/postgres";
import { sentry } from "@0furkancolak/pgcells/telemetry";

export default Sentry.withSentry((env: Env) => ({ dsn: env.SENTRY_DSN, tracesSampleRate: 1.0 }), {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const db = createDatabase(createConfig([env.DB0.connectionString, env.DB1.connectionString]), { driver: postgresDriver, poolMax: 1, onSpan: sentry(Sentry) });
    try {
      return await handle(request, db);
    } finally {
      ctx.waitUntil(db.close());
    }
  },
});
```

## Workers + OpenTelemetry

```sh
npm i @opentelemetry/api @microlabs/otel-cf-workers   # wrangler: compatibility_flags ["nodejs_compat"]
```

```ts
import { trace } from "@opentelemetry/api";
import { instrument } from "@microlabs/otel-cf-workers";
import { openTelemetry } from "@0furkancolak/pgcells/telemetry";

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const db = createDatabase(createConfig([env.DB0.connectionString]), { driver: postgresDriver, poolMax: 1, onSpan: openTelemetry(trace.getTracer("worker")) });
    try {
      return await handle(request, db);
    } finally {
      ctx.waitUntil(db.close());
    }
  },
};

export default instrument(handler, (env: Env) => ({ exporter: { url: env.OTLP_URL }, service: { name: "worker" } }));
```

Because the pool is built per request on Workers, give the handler inside the request too. (`handle` is your own router; the `createConfig`, `createDatabase` and `postgresDriver` imports are as in the Sentry example.) If `dbMiddleware` opens its own pool, give the handler to it: `dbMiddleware({ driver: postgresDriver, perRequest: true, onSpan: sentry(Sentry), … })`; if you share the application's database (`database`), that database's `onSpan` applies.

## Caveats

- **Volume.** Every query and every cache hit is a span. On a busy service, sample (`tracesSampleRate`) or filter the handler:

  ```ts
  const toOtel = openTelemetry(tracer);
  const db = createDatabase({ driver: bunDriver, onSpan: (span) => span.name !== "placement.cache" && toOtel(span) });
  ```

- **Spans do not appear under the request.** Async context propagation was not set up (the SDK was not loaded with `--preload`), or the database work finishes after the request span has ended (an unawaited Promise).
- **Personal data.** Spans contain no SQL text or parameters; they carry only the name, duration, database identity, tenant ID and error code.

Measured span durations and benchmarks: [performance-and-observability.md](performance-and-observability.md).
