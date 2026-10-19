# Better Auth

`@0furkancolak/pgcells-single/auth` runs Better Auth in the application schema: a single user set and a single table set (`users`, `session`, `account`, `verification`, `two_factor`, `rate_limit`) — the base migration shipped with the package creates them. DB access is the package’s own Better Auth adapter (the engine’s pool; no Kysely, no Drizzle, no separate pool).

The dependency is an optional peer: add `better-auth` to the application at exactly **1.7.5** (without `^`; `@better-auth/*` at the same version). The runtime entry point does not load this module.

## Setup

```ts
import { betterAuth } from "better-auth";
import { authTables, createAuth, importedPasswords } from "@0furkancolak/pgcells-single/auth";

const auth = createAuth(
  db,
  ({ options }) =>
    betterAuth({
      ...options,       // adapter, secret, baseURL, basePath, advanced (cookie prefix, generateId: false)
      ...authTables(),  // users, session, account, verification (snake_case columns)
      emailAndPassword: { enabled: true, password: importedPasswords },
    }),
  { secret: process.env.BETTER_AUTH_SECRET ?? "", baseURL: "https://api.example.com", basePath: "/api/auth" },
);

Bun.serve({ fetch: (request) => auth().handler(request) });
```

`createAuth(db, make, config)` returns `() => Auth`; the instance is created on the first call and kept (in Workers, create one per request). `config`: `secret` (at least 32 characters, `INVALID_CONFIG`; the package does not read the environment, the application supplies `BETTER_AUTH_SECRET`), `baseURL`, `basePath` (optional, starts with `/`), `cookiePrefix` (default `auth`; `a-z0-9-`, starts with a letter, at most 32). The `options` passed to `make` are safe defaults: spread them inside `make`; when you change `advanced`, merge `...options.advanced`, otherwise the cookie prefix and `generateId: false` are lost and Better Auth generates text ids that cannot be written to a `uuid` column.

## Tables and mappings

`src/migrations/<time>_auth.sql` creates the Better Auth 1.7.5 tables: snake_case columns, `uuid` ids (`DEFAULT gen_random_uuid()`), `timestamptz` dates, and the indexes Better Auth marks. Email is unique; session, account and 2FA rows are deleted with the user (`ON DELETE CASCADE`). The mapping functions take no arguments: `authTables()` (`user`, `session`, `account`, `verification`; model name `users`), `twoFactorTables()` (the `schema` of the `twoFactor` plugin), `rateLimitTable()` (`rateLimit: { enabled: true, storage: "database", ...rateLimitTable() }`; Better Auth’s default in-memory store is per process, so use the table when you run multiple processes).

```ts
plugins: [twoFactor({ schema: twoFactorTables() })],
rateLimit: { enabled: true, storage: "database", ...rateLimitTable() },
```

- **Extra field:** first add the column with a migration, then spread the mapping and extend it: `user: { ...authTables().user, additionalFields: { phone: { type: "string", required: false } } }`; without the spread, `modelName` and `fields` are lost.
- The database generates ids. The `users` queries and repository functions in the package write only the `users` row; create a user with a password through Better Auth (`auth.api.signUpEmail`). There is no user import command.

## Adapter

A small SQL generator built on Better Auth’s `createAdapterFactory` (1.7.5) (`src/core/auth-adapter.ts`). The table is qualified as `"<schema>"."<modelName>"` and every value is a `$n` parameter. A malformed (non-UUID) id never reaches the column: `eq` matches no row, `ne` matches every non-null row, and `in`/`not_in` drop it from the list; so a malformed id from the client becomes “not found” instead of a 500. `consumeOne` and `incrementOne` are single statements (atomic); the Better Auth transaction is `db.transaction`; there are no joins; no introspection happens at startup (check compatibility in CI with `auth generate`). An unknown `where` operator or a negative/non-integer limit-offset is `UNSUPPORTED`.

## Imported passwords: `importedPasswords`

Passed to `emailAndPassword.password`: new passwords are hashed with Better Auth’s scrypt; bcrypt (`$2a$`, `$2b$`, `$2y$`) and argon2 (`$argon2id$`, `$argon2i$`, `$argon2d$`) hashes from another application are verified on Bun with `Bun.password`. Outside Bun (Workers, Node), bcrypt is verified with `bcryptjs`, argon2 cannot be verified and `UNSUPPORTED_PASSWORD_HASH` is thrown; for other formats (MD5, PBKDF2…) send the user through a password reset.

## Schema change: `auth generate`

When you add a plugin or a field, generate the difference of the Better Auth tables as a migration. It needs a direct connection and a role that can create schemas.

```ts
// auth-options.ts — Better Auth options without database, default export
export default {
  ...authTables(),
  emailAndPassword: { enabled: true },
  plugins: [twoFactor({ schema: twoFactorTables() })],
} satisfies Omit<BetterAuthOptions, "database">;
```

```sh
bun run db:generate:auth ./auth-options.ts [--name better_auth]
# if there is a difference: {"created": true, "id": "...", "path": "src/migrations/<time>_better_auth.sql"}   otherwise: {"created": false}
```

- The command creates a **temporary schema** (`auth_generate_<12 hex>`) in the configured DB, applies the package’s migrations to it, compares the Better Auth tables (`getSchema`) with that schema’s `information_schema`/`pg_index` data, and drops the schema (the role needs `CREATE` on the DB). Ctrl-C takes no new work; the command exits with `MIGRATION_CANCELLED` without writing a file, and the schema is still dropped (it can remain if the process is killed or the connection drops: drop leftover `auth_generate_*` schemas).
- Missing tables, columns, indexes, and missing single-column index/unique constraints on existing columns are written to `--up`, and the statements that undo them to `--down`; the id of new tables is `uuid` + default.
- It writes the file to **`./src/migrations` in the working directory**: run it inside `packages/db-single`. If an existing column’s type does not match the field, or the index name to be generated is held by an invalid, partial, mismatching or other-table index (index names are unique across the schema), it writes no file and throws `INVALID_CONFIG` (repair or drop the index); if the module has no default export, `USAGE`.
- Review the SQL and `--down` (type changes and data moves are not generated), then run `bun run db:codegen` and `bun run db:migrate`. In CI, run it with the same module and expect `"created": false` and an unchanged `src/migrations` (drift check).

## Workers and caveats

- In Workers, create `createDb(..., { poolMax: 1, pooler: "assumed" })` + `createAuth(...)()` per request and close with `ctx.waitUntil(db.close())` after the response ([configuration.md](configuration.md#deploy)); Hyperdrive caching must be off.
- Do not call another instance’s `auth.api` from inside one instance’s hook or transaction: the Better Auth transaction context lives in a process-wide `AsyncLocalStorage`, so the inner call may use the outer transaction.
