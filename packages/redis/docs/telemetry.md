# Telemetry

`createCache`, `createPlacementCache`, `createTenantQueue` and `createTenantWorker` take an `onSpan` option. The span format is the same as in `@0furkancolak/pgcells`, so the `@0furkancolak/pgcells/telemetry` adapters (`openTelemetry(tracer)`, `sentry(Sentry)`) can be passed directly.

- If `onSpan` is not given, no extra work is done; a local placement hit is still synchronous.
- If the handler throws, the operation does not fail.

```ts
import * as Sentry from "@sentry/bun"; // @sentry/node in the worker process
import { sentry } from "@0furkancolak/pgcells/telemetry";

const onSpan = sentry(Sentry);
const placements = createPlacementCache({ redis, db, onSpan });
const cache = createCache({ redis, onSpan });
const worker = createTenantWorker("emails", handler, { connection: redis.queue, db, onSpan });
```

| Span | tenantId | detail | error |
| --- | --- | --- | --- |
| `cache.get` (`get`, `wrap`) | in the tenant view | `hit-local` \| `hit-redis` \| `miss` | a fail-open Redis error or a `loader` error |
| `cache.set` | in the tenant view | — | a fail-open Redis error |
| `cache.invalidate` (`del`, `invalidateTenant`) | in the tenant view | `key` \| `tenant` | a fail-open Redis error |
| `placement.cache` | ✓ | `hit-local` \| `hit-redis` \| `miss` \| `db` | — |
| `queue.add` | ✓ | job name | an add error |
| `queue.job` | ✓ | job name | a handler error (`errorCode`) |

Give the same `onSpan` to `createDatabase(…, { onSpan })` too. That way the cache, placement and query steps of a request appear in the same trace. For database spans: [packages/db-multi/docs/telemetry.md](https://github.com/0furkancolak/pgcells/blob/main/packages/db-multi/docs/telemetry.md).
