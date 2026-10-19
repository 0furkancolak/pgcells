# @0furkancolak/pgcells — multi-tenant PostgreSQL package

Bun + zod; the driver is Bun SQL, postgres.js or pg. The tenant ID is the subdomain label (`abc.example.com` → `abc`); each tenant lives in its own schema derived from the ID (`tenant_abc`, `demo_abc` in the demo) in one of the PostgreSQL databases listed in `DATABASE_URLS`. The first database (`db0`) is the platform database: the `platform.*` tables record which database/schema a tenant is in. Application SQL is precompiled and schema names are added to table references (`search_path` is not used). The application runs through a transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive) and `db.ready()` checks this at startup (`POOLER_REQUIRED`); management (the CLI and the management functions) uses a direct connection. The package does no authentication: the application decides which tenants a user may access.

## Quick start

```sh
cp .env.example .env && docker compose up -d --wait   # local PostgreSQL x 2 + PgBouncer
bun run cli bootstrap                                 # platform tables and database identities
bun run cli provision kadikoy                         # tenant_kadikoy schema
```

```ts
const db = createDatabase({ driver: bunDriver });     // reads DATABASE_URLS; once per process
await db.ready();
app.use(dbMiddleware({ database: db, rootDomain: "example.com" }));
app.get("/users/:email", async (c) => c.json(await c.get("db").tenant.query(findUserByEmail, [c.req.param("email")])));
```

`findUserByEmail` is the application's own query (`src/queries/tenant/users.sql`). Imports and all the steps: [docs/getting-started.md](docs/getting-started.md).

The tenant migrations that ship with the package are only the Better Auth tables (multi-type layout: `users`, `students`, `teachers` for the `user`/`student`/`teacher` types, plus session, account, verification, 2FA and rate limit tables) and `user_imports`; at platform scope the panel Better Auth tables are included too; application tables are the application's own migrations ([docs/auth.md](docs/auth.md#tables)).

## Documentation

- [docs/README.md](docs/README.md) — table of contents and reading order
- [Getting started](docs/getting-started.md) · [Configuration](docs/configuration.md) · [Tenants](docs/tenants.md) · [Queries](docs/queries.md)
- [Middleware and background jobs](docs/middleware-and-jobs.md) · [Migrations and seeds](docs/migrations-and-seeds.md) · [Better Auth](docs/auth.md)
- [Operations](docs/operations.md) · [Providers](docs/providers.md) · [Replicas](docs/replicas.md) · [Data import](docs/data-import.md)
- [Telemetry (OpenTelemetry, Sentry)](docs/telemetry.md) · [Performance and measurement](docs/performance-and-observability.md)
- [Error codes](docs/errors.md) · [CLI reference](docs/cli.md)

## Entry points (`package.json` `exports`)

| Entry point | Contents |
|---|---|
| `@0furkancolak/pgcells` | `createDatabase`, `createConfig`, `loadConfig`, `tenantFromHost`, `normalizeTenantId`, `validateTenantId`, `AppError`, `errorCode`, `databaseUnavailable`, `placementSchema`, `PLACEMENT_CACHE_MAX_MS`, types |
| `@0furkancolak/pgcells/middleware` | `dbMiddleware`, `createDbScope`, `RequestDb` |
| `@0furkancolak/pgcells/management` | `createManagement`, `bootstrap`, `provisionTenant`, `migrateAll`, `seedAll` …, `prepareQuery` |
| `@0furkancolak/pgcells/tools` | backup, restore, move, user and application import, reserved IDs and placement |
| `@0furkancolak/pgcells/auth` | `createTenantAuth`, `createPlatformAuth`, `importedPasswords`, `authTables`, `twoFactorTables`, `rateLimitTable` (optional peer `better-auth`) |
| `@0furkancolak/pgcells/telemetry` | `openTelemetry`, `sentry` — `onSpan` handlers |
| `@0furkancolak/pgcells/drivers/bun\|postgres\|pg\|neon` | drivers; only the imported one enters the bundle |
| `@0furkancolak/pgcells/queries/<scope>/<file>`, `@0furkancolak/pgcells/tables/<scope>/<table>` | generated queries and zod table schemas |

## Runtimes and what an npm install gives you

| Entries | Runs on |
|---|---|
| `.`, `/middleware`, `/auth`, `/telemetry`, `/drivers/pg\|postgres\|neon`, `/queries/*`, `/tables/*` | Bun >= 1.3.14, Node >= 22, Cloudflare Workers (`nodejs_compat`) |
| `/management`, `/tools`, `/drivers/bun`, the `pgcells` CLI, codegen | **Bun only** in v0.1: they use Bun APIs (`Bun.file`, `Bun.spawn`, `bun:SQL`). A Node-compatible CLI is planned |

The published package ships compiled JavaScript with type declarations. The runtime, the bundled platform/node/tenant migrations (including the example `user`/`student`/`teacher` auth tables, which cannot be removed in 0.x because applied migrations are checksum-protected) and the CLI come with it. **Your own tenant migrations, seeds and queries still need the copy-the-package workflow** ([getting started](docs/getting-started.md)): in v0.1 `pgcells migrate`/`bootstrap` apply only the bundled migrations, and consumer-side codegen is a known gap tracked in the roadmap.

## Scripts

`cli` / `tools` (the same CLI, [docs/cli.md](docs/cli.md)), `codegen` (`--check`), `test`, `test:integration`, `typecheck`, `lint`, `format`, `build`, `build:workers`, `bench`, `bench:scale`, `bench:compare`, `bench:hotpath`, `bench:spans`. From the root: `bun run db <script>`.
