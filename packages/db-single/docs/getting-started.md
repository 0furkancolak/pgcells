# Getting started

Takes the package into an empty monorepo and gets a working application running locally: copying, local PostgreSQL + PgBouncer, a migration, a first query and a small Hono application.

## Requirements

- **Bun 1.3.14+.** On older versions, Bun SQL fails behind PgBouncer with “unnamed prepared statement does not exist”.
- **Docker Compose** (for local PostgreSQL and PgBouncer).

## 1. Copy it

```sh
cp -R <source>/packages/db-single packages/db-single   # root package.json: "workspaces": ["packages/*"]
bun install
```

Add `"@0furkancolak/pgcells-single": "workspace:*"` to the application package (depending on the driver, `postgres`, `pg` or `@neondatabase/serverless`; for [auth](auth.md), exactly `better-auth@1.7.5`). From here on the folder is yours: work under `src/queries`, `src/repositories`, `src/migrations`, `src/seeds`, and do not touch `src/core` unless you must.

## 2. Local database

```sh
cd packages/db-single
cp .env.example .env                      # DATABASE_URLS = a single direct URL (local demo password)
docker compose -p dbsingle up -d --wait   # postgres :5560 (direct), pgbouncer :5563 (transaction pooling)
```

Commands run inside `packages/db-single` (from the root, `bun run single <script>`); Bun reads `.env` automatically. The CLI uses the direct port and the application uses PgBouncer ([configuration.md](configuration.md#direct-and-pooler-url)).

## 3. Migration

```sh
bun run db:migrate   # progress events, then {"dryRun": false, "migrations": ["<time>_auth"]}
bun run db:status    # {"schema": "public", "applied": 1, "pending": []}
```

`migrate` creates the schema if it does not exist, opens the `_migrations` ledger, applies pending migrations and writes the runtime timeouts as DB defaults; this **requires DB ownership** ([operations.md](operations.md#what-migrate-writes-to-the-database)). It can be run on every deploy.

## 4. First migration and query

```sh
bun run db:generate add_user_phone   # src/migrations/<UTC time>_add_user_phone.sql
```

Fill in the file (until the empty template is filled in, `codegen` and the DB commands fail; deleting the file and running `bun run db:codegen` also works):

```sql
--up
ALTER TABLE users ADD COLUMN phone text;
--down
ALTER TABLE users DROP COLUMN phone;
```

Add a query to `src/queries/users.sql` and compile:

```sql
-- name: setUserPhone
UPDATE users SET phone = $2::text, updated_at = now() WHERE id = $1::uuid RETURNING *
```

```sh
bun run db:codegen      # users.gen.ts, the migration list, zod table types (no DB needed)
bun run db:migrate
```

`SELECT *` / `RETURNING *` expand to an explicit column list in codegen; the new `phone` column appears automatically in the rows of the `users` queries. To make Better Auth aware of it, see [auth.md](auth.md#tables-and-mappings). Details: [queries.md](queries.md), [migrations-and-seeds.md](migrations-and-seeds.md).

## 5. Application

In the application package, `src/server.ts` (with the `hono` dependency):

```ts
import { Hono } from "hono";
import { createDb } from "@0furkancolak/pgcells-single";
import { bunDriver } from "@0furkancolak/pgcells-single/drivers/bun";
import { dbMiddleware, type RequestDb } from "@0furkancolak/pgcells-single/middleware";
import { findUserByEmail, findUsers } from "@0furkancolak/pgcells-single/repositories/users";

const db = createDb({ driver: bunDriver }); // reads DATABASE_URLS
await db.ready();                           // does not start if the URL is direct (no pooler)

const app = new Hono<{ Variables: { db: RequestDb } }>();
app.use(dbMiddleware({ database: db }));
app.get("/users", async (c) => c.json(await findUsers(c.get("db").read, 20)));
app.get("/users/:email", async (c) => c.json(await findUserByEmail(c.get("db").read, c.req.param("email"))));

export default { port: 3000, fetch: app.fetch };
```

Run it connected to PgBouncer (`:5563`, same user/password/DB as `.env`):

```sh
export DATABASE_URLS=postgres://user:password@127.0.0.1:5563/app
bun src/server.ts
curl http://127.0.0.1:3000/users
```

Next steps: HTTP status mapping, `/ready`, shutdown ([middleware-and-jobs.md](middleware-and-jobs.md)); monitoring ([telemetry.md](telemetry.md)). Cleanup: `docker compose -p dbsingle down -v` (all data is deleted).

## Common mistakes

- **`POOLER_REQUIRED`** — the application’s `DATABASE_URLS` goes to the direct port (5560); use the PgBouncer address (`:5563`). In environments that cannot be probed, `pooler: "assumed"` on purpose.
- **`DIRECT_CONNECTION_REQUIRED`** — the CLI was run with the PgBouncer address; management holds a session advisory lock, so use the direct URL from `.env`.
- **Import not found / `codegen --check` fails** — SQL or a migration changed and `bun run db:codegen` was not run.
- **CLI in the wrong directory** — `.env` and `src/migrations` are relative to the working directory; run it inside `packages/db-single`.
