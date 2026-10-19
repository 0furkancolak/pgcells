# @0furkancolak/pgcells-single — a single-database, single-schema PostgreSQL package

Bun + zod; the driver is Bun SQL, postgres.js, pg or Neon serverless. For classic managed PostgreSQL (Neon, Supabase, RDS): **one DB, one schema** (`public` by default). Application SQL is compiled ahead of time (`bun run db:codegen`); no SQL is parsed at runtime. Migrations and seeds are `.sql` files, and their ledgers live in the same schema. The package includes the CLI, backup/restore, `doctor`, replica reads, Neon/Supabase tools and the Better Auth adapter.

This is a **copy-and-continue** template: move the `packages/db-single` folder under your own monorepo’s `packages/` and work in `src/queries`, `src/repositories`, `src/migrations` and `src/seeds`. It does not depend on `@0furkancolak/pgcells`; for a multi-DB setup where the schema is split per customer, use the sibling package `packages/db-multi` ([why separate](docs/from-multi.md)).

## Quick start

```sh
cd packages/db-single
cp .env.example .env                      # DATABASE_URLS: a single direct URL (local demo password only)
docker compose -p dbsingle up -d --wait   # PostgreSQL :5560 (direct), PgBouncer :5563 (transaction pooling)
bun run db:migrate                        # schema, ledgers and the Better Auth tables
```

The CLI uses the direct port; the application needs a transaction pooler, so connect to PgBouncer (`:5563`, same user/password/DB as `.env`). In an application package that has the `"@0furkancolak/pgcells-single": "workspace:*"` dependency:

```ts
// DATABASE_URLS=postgres://user:password@127.0.0.1:5563/app bun src/first-query.ts
import { createDb } from "@0furkancolak/pgcells-single";
import { bunDriver } from "@0furkancolak/pgcells-single/drivers/bun";
import { createUser, findUserByEmail } from "@0furkancolak/pgcells-single/repositories/users";

const db = createDb({ driver: bunDriver }); // reads DATABASE_URLS; once per process
await db.ready();                           // POOLER_REQUIRED on a URL without a pooler
await createUser(db, { name: "Ada", email: "ada@example.com" });
console.log(await findUserByEmail(db, "ada@example.com"));
await db.close();
```

Continue with [docs/getting-started.md](docs/getting-started.md).

## `src` layout

| Path | Contents |
|---|---|
| `src/queries/<area>.sql` → `<area>.gen.ts` | `-- name:` blocks and the generated queries (example: `users.sql`) |
| `src/repositories/<area>/` | one function per query (example: `users/`) — [docs/queries.md](docs/queries.md#the-queries-and-repositories-layers) |
| `src/migrations/`, `src/seeds/` | `--up`/`--down` migrations and seeds; the package ships a single migration: the Better Auth tables |
| `src/tables/<table>.gen.ts` | zod table schemas generated from the migrations |
| `src/core/` | the engine (drivers, compiler, runner, tools, CLI); rarely changes |

`*.gen.ts` files are produced by `bun run db:codegen`; do not edit them by hand, and commit them together with their source (`codegen --check` catches stale ones in CI).

## Entry points (`package.json` `exports`)

| Entry point | Contents |
|---|---|
| `@0furkancolak/pgcells-single` | `createDb`, `createConfig`, `loadConfig`, `AppError`, `errorCode`, `databaseUnavailable`, types |
| `@0furkancolak/pgcells-single/middleware` | `dbMiddleware`, `createDbScope`, `RequestDb` |
| `@0furkancolak/pgcells-single/management` | `createManagement`, `migrate`, `rollback`, `baseline`, `migrationStatus`, `seed`, `prepareQuery`, `SeedContext` |
| `@0furkancolak/pgcells-single/tools` | `exportSchema`, `backupSchema`, `restoreSchema`, `pruneBackups`, `doctor`, `replicaReport`, `pullSchema`, Neon tools, `supabaseSafetyPoint` |
| `@0furkancolak/pgcells-single/auth` | `createAuth`, `importedPasswords`, `authTables`, `twoFactorTables`, `rateLimitTable` (optional peer `better-auth`) |
| `@0furkancolak/pgcells-single/telemetry` | `openTelemetry`, `sentry` |
| `@0furkancolak/pgcells-single/drivers/bun\|postgres\|pg\|neon` | drivers; only the one you import enters the bundle |
| `@0furkancolak/pgcells-single/queries/<area>`, `repositories/<area>`, `tables/<table>` | generated queries, repository functions, zod table schemas (e.g. `@0furkancolak/pgcells-single/queries/users`) |

## Runtimes and what an npm install gives you

| Entries | Runs on |
|---|---|
| `.`, `/middleware`, `/auth`, `/telemetry`, `/drivers/pg\|postgres\|neon`, `/queries/*`, `/tables/*` | Bun >= 1.3.14, Node >= 22, Cloudflare Workers (`nodejs_compat`) |
| `/management`, `/tools`, `/drivers/bun`, the `pgcells-single` CLI, codegen | **Bun only** in v0.1: they use Bun APIs. A Node-compatible CLI is planned |

The published package ships compiled JavaScript with type declarations. **Your own migrations, seeds and queries still need the copy-the-package workflow** ([getting started](docs/getting-started.md)): in v0.1 the CLI applies only the migrations bundled with the package, and consumer-side codegen is a known gap tracked in the roadmap.

## Scripts

`cli` ([docs/cli.md](docs/cli.md)), `db:migrate`, `db:rollback`, `db:status`, `db:seed`, `db:generate`, `db:generate:seed`, `db:generate:auth`, `db:pull`, `db:codegen`, `test`, `test:integration`, `typecheck`, `lint`, `format`, `build`, `build:workers`, `verify:provider`. From the root: `bun run single <script>` and the `single:*` shortcuts.

## Documentation

[docs/README.md](docs/README.md) is the table of contents and reading order.
