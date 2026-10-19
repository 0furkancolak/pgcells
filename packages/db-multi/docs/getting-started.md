# Getting started

This document takes the package from scratch into a monorepo and then to a locally running application: copying, local PostgreSQL + PgBouncer, `bootstrap`, the first migration and query, the first tenants, and a small Hono application that picks the tenant from the `Host` header. Each step is short and can be copied and run.

## Requirements

- **Bun 1.3.14+.** On older versions (e.g. 1.3.6) Bun SQL fails behind PgBouncer with "unnamed prepared statement does not exist".
- **Docker Compose** (for local PostgreSQL and PgBouncer).

## 1. Copy it

```sh
cp -R <source>/packages/db-multi packages/db-multi   # root package.json: "workspaces": ["packages/*"]
bun install
```

Add `"@0furkancolak/pgcells": "workspace:*"` to the application package (`postgres`/`pg` if you use postgres.js/pg; `better-auth` for Better Auth). The tenant migrations that ship with the package are the Better Auth tables (`20260915155444_auth.sql`), `user_imports` (`20260915155445_user_imports.sql`) and the database rate limit tables per auth type (`20260916092603_auth_rate_limits.sql`); at platform scope the panel Better Auth tables are included (`20260916092603_panel_auth.sql`); the only query module is `src/queries/tenant/auth.sql` and the only seed is the demo login (`demo_login`). Add your application tables after these with your own migrations. If you are starting from an existing database, read the note in step 4. The `*.gen.ts` files are produced by `bun run codegen`; do not edit them by hand, and commit them together with the source.

## 2. Local databases

```sh
cd packages/db-multi
cp .env.example .env          # DATABASE_URLS = two direct PostgreSQL URLs (local passwords only)
docker compose up -d --wait   # postgres-0 :5540 (db0), postgres-1 :5541 (db1), pgbouncer :5543 (/db0, /db1, /pgbouncer)
```

Commands run inside `packages/db-multi` (from the root: `bun run db <script>`); Bun reads `.env` by itself. The CLI uses the direct ports, the application uses PgBouncer ([configuration.md](configuration.md#direct-connection-and-pooler)).

## 3. Bootstrap

```sh
bun run cli bootstrap   # {"ready": true, "applied": {...}} — can run on every deploy
bun run tools doctor --pgbouncer-url   # the URL is asked through hidden input: postgres://admin:local_admin_password@127.0.0.1:5543/pgbouncer → {"ok": true, ...}
```

## 4. First migration and query

```sh
bun run db:generate:tenant add_user_phone   # src/migrations/tenant/<timestamp>_add_user_phone.sql
```

Fill in the file:

```sql
--up
ALTER TABLE users ADD COLUMN phone text;
--down
ALTER TABLE users DROP COLUMN phone;
```

Create `src/queries/tenant/users.sql` and compile it:

```sql
-- name: listUsers
SELECT id::text AS id, name, email, phone FROM users ORDER BY users.created_at DESC LIMIT $1 OFFSET $2

-- name: findUserByEmail
SELECT id::text AS id, name, email, phone FROM users WHERE email = $1
```

```sh
bun run db:codegen   # query module (@0furkancolak/pgcells/queries/tenant/users), migration list and zod table types
```

To tell Better Auth about the new column: `user: { ...authTables("user").user, additionalFields: { phone: { type: "string", required: false } } }` ([auth.md](auth.md#tables)).

The scripts (`db:generate:platform`, `db:generate:seed`, `db:migrate:all`, `db:seed:all` …) run the CLI commands and can also be called from the root: [cli.md](cli.md#package-scripts-db). If you are starting from a database built with another tool, `bun run db:pull <schema>` produces the first migration; in that case the package's tenant migrations must not stay before `init` ([migrations-and-seeds.md](migrations-and-seeds.md#initial-migration-from-an-existing-database-pull)). Details: [queries.md](queries.md), [migrations-and-seeds.md](migrations-and-seeds.md).

## 5. First tenants

```sh
bun run cli provision kadikoy --size 10   # least loaded database; migrations + install seeds
bun run cli provision vitrin --demo       # demo_vitrin; the demo seed adds the user demo@vitrin.example.com
bun run cli databases                     # tenant count and load per database
```

If you add a new migration while tenants exist: `bun run db:migrate:all`.

## 6. The application

In the application package (with the `hono` dependency), `src/server.ts`:

```ts
import { Hono } from "hono";
import { createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { dbMiddleware, type RequestDb } from "@0furkancolak/pgcells/middleware";
import { findUserByEmail, listUsers } from "@0furkancolak/pgcells/queries/tenant/users";

const db = createDatabase({ driver: bunDriver }); // reads DATABASE_URLS
await db.ready();                                  // does not start if a database is missing, down or reordered, or a URL has no pooler (direct)

const app = new Hono<{ Variables: { db: RequestDb } }>();
app.use(dbMiddleware({ database: db, rootDomain: ["example.com", "localhost"] }));
app.get("/users", async (c) => c.json(await c.get("db").tenant.query(listUsers, [20, 0])));
app.get("/users/:email", async (c) => c.json(await c.get("db").tenant.query(findUserByEmail, [c.req.param("email")])));

export default { port: 3000, fetch: app.fetch };
```

Run it (the application connects to PgBouncer; the order is the same as the direct URLs):

```sh
export DATABASE_URLS=postgres://admin:local_admin_password@127.0.0.1:5543/db0,postgres://admin:local_admin_password@127.0.0.1:5543/db1
bun src/server.ts
curl -H 'Host: vitrin.localhost' http://127.0.0.1:3000/users    # the demo user (demo@vitrin.example.com)
curl -H 'Host: kadikoy.localhost' http://127.0.0.1:3000/users   # [] — another tenant, other data
curl -H 'Host: yok.localhost' http://127.0.0.1:3000/users       # TENANT_NOT_FOUND
```

Next steps: mapping error codes to HTTP status, `/ready` and shutdown ([middleware-and-jobs.md](middleware-and-jobs.md)); the Redis placement cache for multiple processes ([`@0furkancolak/pgcells-redis`](https://github.com/0furkancolak/pgcells/blob/main/packages/redis/docs/placement-cache.md)); monitoring ([telemetry.md](telemetry.md)).

## 7. Cleanup

```sh
docker compose down -v   # containers and volumes (all data) are deleted
```

## Common errors

- **`POOLER_REQUIRED`** — the application's `DATABASE_URLS` points at the direct PostgreSQL ports (5540/5541); the runtime requires a transaction-mode pooler. In the local stack use the PgBouncer address (`:5543/db0,…/db1`); in environments where it cannot be tested, pass `pooler: "assumed"` deliberately.
- **`DIRECT_CONNECTION_REQUIRED`** — you ran the CLI with PgBouncer (5543) addresses; management holds a session advisory lock. Use the direct ports in `.env`.
- **`DATABASE_NOT_REGISTERED`** — connected to a database that `bootstrap` has not been run on.
- **`INVALID_TENANT_ID`** — the request `Host` header is not in the `<tenant>.<rootDomain>` form (e.g. `curl` without a header).
- **Import not found / `codegen --check` fails** — SQL or a migration changed but `bun run codegen` was not run.
- **Empty `migration create` template** — until SQL is written the registry does not compile and database commands fail; fill in the template, or delete the file and run `bun run codegen`.
- **"unnamed prepared statement does not exist"** — the Bun version is older than 1.3.14.
