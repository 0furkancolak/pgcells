# Better Auth

`@0furkancolak/pgcells/auth` runs Better Auth in each tenant's own schema. The tables are multi-type (per auth type `users`/`students`/`teachers` and session, account, verification and 2FA tables) and are an ordinary tenant migration ([Tables](#tables)); the same email is independent across tenants and the organization plugin is not needed. A platform-scoped login (e.g. an admin panel) runs in db0's `platform` schema. Database access is the package's own Better Auth adapter: there is no Kysely, Drizzle or separate pool.

This document covers: setting up the tenant and platform instances, the auth types and tables (`authTables`, `twoFactorTables`, `rateLimitTable`), choosing the secret and the mandatory checks, the adapter's behavior, passwords imported from another application, schema changes, and Workers notes.

The dependency is an optional peer: add `better-auth` to the application at exactly version **1.7.5** (without `^`; the `@better-auth/*` packages at the same version too). The `@0furkancolak/pgcells` runtime entry point does not load this module.

## Setup

```ts
import { betterAuth } from "better-auth";
import { createDatabase, tenantFromHost } from "@0furkancolak/pgcells";
import { authTables, createTenantAuth, importedPasswords } from "@0furkancolak/pgcells/auth";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createAuthStorage, createRedis } from "@0furkancolak/pgcells-redis";

const db = createDatabase({ driver: bunDriver });
const redis = createRedis();
const authFor = createTenantAuth(
  db,
  (tenant) =>
    betterAuth({
      ...tenant.options,
      ...authTables("user"), // users, session, account, verification (snake_case columns)
      // Sessions and rate-limit counters are in Redis, prefixed by tenant and auth type
      secondaryStorage: createAuthStorage(redis, { authType: "user", tenantId: tenant.tenantId }),
      verification: { storeInDatabase: true },
      emailAndPassword: { enabled: true, password: importedPasswords },
    }),
  {
    secret: process.env.BETTER_AUTH_SECRET ?? "", // ≥ 32 characters; shared across all tenants by default
    rootDomain: "example.com",                 // baseURL = https://<tenant>.example.com
    authType: "user",                              // path /api/auth/user, cookie prefix user-<tenant>
  },
);

Bun.serve({
  async fetch(req) {
    const tenantId = tenantFromHost(req.headers.get("host"), "example.com");
    const auth = await authFor(tenantId); // TENANT_UNAVAILABLE if not active
    if (new URL(req.url).pathname.startsWith("/api/auth/user/")) return auth.handler(req);
    const session = await auth.api.getSession({ headers: req.headers });
    return session ? Response.json(session.user) : new Response("Unauthorized", { status: 401 });
  },
});
```

If you use `dbMiddleware` with Hono, take the tenant ID from `c.get("db").tenantId` and return `(await authFor(tenantId)).handler(c.req.raw)` in the `/api/auth/<authType>/*` route. For multiple auth types, each type gets its own `createTenantAuth`; an instance is built once per tenant per type and stored.

## Tables

`src/migrations/tenant/20260915155444_auth.sql` sets up the Better Auth 1.7.5 tables in a multi-type layout: separate tables per auth type, snake_case columns, `uuid` identifiers (`DEFAULT gen_random_uuid()`), `timestamptz` dates.

| `authType` | user | session | account | verification | twoFactor | rateLimit | `emailVerified` column |
|---|---|---|---|---|---|---|---|
| `user` | `users` | `session` | `account` | `verification` | `two_factor` | `rate_limit` | `email_verified` |
| `student` | `students` | `student_sessions` | `student_accounts` | `student_verifications` | `student_two_factors` | `student_rate_limits` | `is_email_verified` |
| `teacher` | `teachers` | `teacher_sessions` | `teacher_accounts` | `teacher_verifications` | `teacher_two_factors` | `teacher_rate_limits` | `is_email_verified` |

- The other columns are the same for every type (`created_at`, `updated_at`, `two_factor_enabled`, `expires_at`, `ip_address`, `user_agent`, `user_id`, `account_id`, `provider_id`, `access_token_expires_at` …). The email is unique per table; session, account and 2FA rows are deleted with the user (`ON DELETE CASCADE`).
- `src/migrations/tenant/20260915155445_user_imports.sql` sets up the `user_imports` mapping tied to `users` ([data-import.md](data-import.md#user-import-users-import)).
- `src/migrations/tenant/20260916092603_auth_rate_limits.sql` sets up the database rate limit tables (`key` unique, `count`, `last_request` as epoch milliseconds). The rate limit key is IP + path and does not include the auth type; that is why each type has its own table.
- `src/migrations/platform/20260916092603_panel_auth.sql` sets up the same `user` layout (rate limit included) in db0's `platform` schema ([`createPlatformAuth`](#createplatformauthdb-make--secret-baseurl-authtype-)).
- The Better Auth mapping comes from `@0furkancolak/pgcells/auth`. `authTables(authType)` gives the `user`, `session`, `account`, `verification` options (`modelName` + `fields`), `twoFactorTables(authType)` gives the `schema` of the `twoFactor` plugin, and `rateLimitTable(authType)` gives the table mapping of the `rateLimit` option (`rateLimit: { enabled: true, storage: "database", ...rateLimitTable("student") }`). `AuthType` = `"user" | "student" | "teacher"`; any other value is `INVALID_CONFIG`.

```ts
import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { authTables, createTenantAuth, twoFactorTables } from "@0furkancolak/pgcells/auth";

const studentAuthFor = createTenantAuth(
  db,
  (tenant) =>
    betterAuth({
      ...tenant.options,
      ...authTables("student"),
      emailAndPassword: { enabled: true },
      plugins: [twoFactor({ schema: twoFactorTables("student") })],
    }),
  { secret: process.env.BETTER_AUTH_SECRET ?? "", rootDomain: "example.com", authType: "student" },
);
```

- **Extra fields:** first add the column with a migration, then spread the mapping and extend it: `user: { ...authTables("student").user, additionalFields: { phone: { type: "string", required: false } } }`. For another option of the same model, also spread the mapping first (`verification: { ...authTables("student").verification, storeInDatabase: true }`); otherwise `modelName` and `fields` are lost.
- **IDs:** the database generates them. `tenant.options.advanced.database.generateId` (`options.advanced.database.generateId` on the platform) is `false`; Better Auth does not send an id. If `make` provides `advanced`, it must spread `...tenant.options.advanced`; otherwise Better Auth generates a text id, which cannot be written to a `uuid` column.

## `createTenantAuth(db, make, { secret, rootDomain, authType, perTenantSecret, max })`

The function it returns is `(tenantId) => Promise<Auth>`.

| Option | Meaning |
|---|---|
| `db` | A `createDatabase` instance. The Better Auth instance does not close the pool; `db.close()` does. |
| `make(tenant)` | Builds the Better Auth instance. `tenant` = `{ tenantId, placement, options }`. |
| `secret` | The Better Auth secret, at least 32 characters (`INVALID_CONFIG`). By default it is used as is in every tenant. |
| `rootDomain` | A lowercase host name (`INVALID_CONFIG`). |
| `authType` | Optional; `^[a-z][a-z0-9]{0,31}$` (`INVALID_CONFIG`). Determines the path and the cookie prefix. |
| `perTenantSecret` | If `true`, the secret is derived with the tenant ID (HKDF-SHA256, Web Crypto; 64 hex). Default `false`. |
| `max` | The LRU size in which per-tenant instances are kept (default 100, at most 100000). When a tenant's database or schema changes, the instance is rebuilt. |

The placement is read from the runtime's in-process cache (`db.placement`, `active` only, `placementCacheMs`); if it is not in the cache, from the platform database. If the tenant is not `active`, `TENANT_UNAVAILABLE`.

`tenant.options` are safe defaults. Spread them inside `make`; when changing `advanced`, merge it (`advanced: { ...tenant.options.advanced, … }`), otherwise `cookiePrefix` and `generateId: false` are lost:

| Field | Value | Why |
|---|---|---|
| `database` | the adapter bound to the tenant schema | The engine's per-database pool (the same in all three drivers). Each query outside a transaction is one round trip, a Better Auth transaction is `BEGIN … COMMIT`. Safe with PgBouncer and Hyperdrive. |
| `secret` | `secret` (or the key derived with `perTenantSecret: true`) | A shared secret keeps existing session cookies and 2FA secrets valid. |
| `baseURL` | `https://<tenant>.<rootDomain>` | If the API is on another host (e.g. `api-v2.example.com`), change it in `make`. |
| `basePath` | `/api/auth/<authType>` (only with `authType`) | Multiple auth types in the same process run on separate paths. |
| `advanced.cookiePrefix` | `<authType>-<tenantId>`, `<tenantId>` if there is no `authType` | Cookies are named specific to the tenant and type (`student-kadikoy.session_token`). The name depends on the tenant ID, not the schema, and does not change when the tenant is moved to another database. |
| `advanced.database.generateId` | `false` | IDs are generated in the database with `uuid DEFAULT gen_random_uuid()` ([Tables](#tables)). |

The type of the object passed to `make` is exported from the same entry point as `AuthTenant`.

### Secret: a shared default, a per-tenant secret as an option

The default secret is the same across all tenants. The session cookie signature and the 2FA secret encryption depend on this secret; when migrating from an existing application (e.g. another application), users do not have to log in again. The separation of tenants rests on three things:

- **Cookie name:** each instance reads only its own prefixed cookie.
- **Session record:** the token is looked up only in the tenant's own table or Redis prefix.
- **Redis prefix:** if you use `secondaryStorage`, `createAuthStorage` must be built with `tenantId`. A store with a shared prefix, together with the shared secret, lets a session pass between tenants.

`perTenantSecret: true` gives each tenant a separate secret with HKDF. On a fresh installation it is stricter, but it invalidates existing cookies and 2FA secrets.

### Mandatory checks

After `make` returns, the instance's `auth.options` is checked; a setup that breaks the rules throws `INVALID_CONFIG` (the instance is not stored):

- **`session.cookieCache` only with `perTenantSecret: true`.** The cache cookie (`session_data`) carries the session itself signed and is accepted without looking at the database. With a shared secret, one tenant's cookie is accepted when renamed to another tenant's name.
- **An enabled rate limit does not work in the memory store.** Better Auth's memory store is a single `Map` across the process, and its key is IP + the path without `basePath`: all tenants and auth types share the same counter. If the rate limit is enabled (`rateLimit.enabled`, and if not given it is enabled when `NODE_ENV=production`), `secondaryStorage` (the default store becomes `"secondary-storage"`), `rateLimit.storage: "database"` or `customStorage` is required.
- **The database rate limit uses the auth type's table.** `rateLimit.storage: "database"` requires `modelName` (`...rateLimitTable(authType)`). Better Auth's default `rateLimit` table is not in the migration; also, types in the same schema would have used the same counter in a single table.

Giving `secondaryStorage` without `verification.storeInDatabase` is not an error: verification records (password reset, email verification, OTP) are kept only in Redis and are lost when Redis is emptied. When migrating from an existing application, pass `verification: { storeInDatabase: true }` so that pending tokens stay valid.

## `createPlatformAuth(db, make, { secret, baseURL, authType })`

A single Better Auth instance not tied to a tenant (e.g. an admin panel). The function it returns is `() => Auth`; the instance is built on the first call and stored.

| Option | Meaning |
|---|---|
| `make({ options })` | `options` = `{ database, secret, baseURL, basePath, advanced: { cookiePrefix, database: { generateId: false } } }`. |
| `database` | The adapter bound to db0's `platform` schema. The tables are in the `20260916092603_panel_auth.sql` platform migration: the `authTables("user")`, `twoFactorTables("user")` and `rateLimitTable("user")` layout, `uuid` identifiers. |
| `secret` | At least 32 characters; may be the same secret as the tenant instances. |
| `authType` | Default `panel`: path `/api/auth/panel`, cookie prefix `panel`. |

The rate limit check applies here too. `cookieCache` is allowed on the platform instance: tenant instances sharing the same secret cannot produce a cache cookie with a shared secret (the check above).

```ts
const panelAuth = createPlatformAuth(db, ({ options }) => betterAuth({ ...options, ...authTables("user"), secondaryStorage: createAuthStorage(redis, { authType: "panel" }) }), {
  secret: process.env.BETTER_AUTH_SECRET ?? "",
  baseURL: "https://api-v2.example.com",
});
app.all("/api/auth/panel/*", (c) => panelAuth().handler(c.req.raw));
```

## Redis: `createAuthStorage`

The Better Auth 1.7.5 `secondaryStorage` interface (`get`, `getAndDelete`, `set`, `delete`, `increment`) comes from `@0furkancolak/pgcells-redis`. Keys are prefixed `tenant:<tenantId>:<authType>:` (`tenant:<authType>:app:` on the platform) and fail-open: [`@0furkancolak/pgcells-redis` auth-storage.md](https://github.com/0furkancolak/pgcells/blob/main/packages/redis/docs/auth-storage.md).

## Adapter

Built on Better Auth `createAdapterFactory` (1.7.5); the package produces the SQL.

- **Names:** the table is `"<schema>"."<modelName>"`, and the column is the Better Auth `fields` / `fieldName` mapping. The schema name comes from the placement and is a qualifier in every query; `search_path` is not used in any form. For the package's tables the mapping is `authTables` / `twoFactorTables` ([Tables](#tables)); for other table and column names, the standard Better Auth options (`modelName`, `fields`, `schema` in plugins) are enough.
- **Values:** every value is a `$n` parameter. Dates go and come as `Date`, booleans are native. `json` and array fields are written as JSON text, and jsonb comes back as an object when read. int8 is converted to a number.
- **Operators:** `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`, `contains`, `starts_with`, `ends_with`. A single `OR` group is built with `AND` conditions. `mode: "insensitive"` uses `lower()` / `ILIKE`. `%` and `_` in a LIKE pattern are matched literally. An empty `in` matches no rows.
- **Malformed IDs:** if the database generates the IDs (`generateId: false`, the package's default, or `"uuid"`), `id` and the fields that refer to `id` (`userId` …) are `uuid` columns. A text that is not a UUID is not sent to the column: `eq` matches no rows, `ne` matches every non-empty row, and it is removed from the `in` / `not_in` list. So a malformed id from the client becomes "not found" instead of `invalid input syntax for type uuid` (500). If Better Auth generates the id (a text column), the value goes as is.
- **Atomic operations:** `consumeOne` (consuming a verification token) is a single `DELETE … RETURNING` statement. `incrementOne` (the 2FA lock counter) is a single `UPDATE … SET c = COALESCE(c, 0) + $n … RETURNING` statement. Better Auth's fallback path (read, then conditional write) is not used.
- **Transaction:** the Better Auth transaction is the engine's `db.transaction`; `BEGIN … COMMIT` runs on the same dedicated connection, and `ROLLBACK` on error.
- **Join:** the adapter does not do joins; Better Auth fetches related records (e.g. the session's user) with a separate query. `advanced.database.joins` changes nothing.
- **Row mapping:** SQL returns the real column names, and no `AS` alias is used. The Better Auth factory already reads each row through the field list (`row[fieldName]`) and completes the joins in that step. An alias breaks that read; turning off the factory's transform breaks the joins and the `id`/`transform.output` transforms. The adapter does no extra per-row name transformation.
- **Schema check:** the adapter runs no introspection query at startup. Check compatibility in CI with `auth generate` / `authSchemaDiff` (below).

### Caveats

- Do not call another instance's (another tenant or auth type) `auth.api` from within one instance's hook or transaction. The Better Auth transaction context is in a process-wide `AsyncLocalStorage`; the inner call may use the outer transaction and adapter (the wrong schema).
- If `crossSubDomainCookies` is on, cookies go to all subdomains. Because the names are specific to the tenant and type, no other tenant reads them; the `cookieCache` rule still applies.
- Of the environment, Better Auth needs only `BETTER_AUTH_SECRET`, and the application reads and passes it; `BETTER_AUTH_URL` is not needed. The package reads only `DATABASE_URLS`.

## Imported passwords: `importedPasswords`

It is passed to the Better Auth `emailAndPassword.password` option:

- **New passwords:** hashed by Better Auth with scrypt; scrypt hashes are verified with Better Auth.
- **bcrypt and argon2:** bcrypt (`$2a$`, `$2b$`, `$2y$`) and argon2 (`$argon2id$`, `$argon2i$`, `$argon2d$`) hashes are verified on Bun with `Bun.password`.
- **Outside Bun (Workers, Node):** bcrypt is verified with `bcryptjs`; argon2 cannot be verified and `UNSUPPORTED_PASSWORD_HASH` is thrown.
- **Other formats** (MD5, PBKDF2 …) cannot be verified: direct these users to a password reset.

Importing the users: [data-import.md](data-import.md#user-import-users-import).

## Schema change

When you add a plugin or field, produce the difference of the Better Auth tables as a tenant migration. The command requires a direct connection.

1. Write an options module: it exports the Better Auth options except `database` as the default.

   ```ts
   // auth-options.ts
   import type { BetterAuthOptions } from "better-auth";
   import { twoFactor } from "better-auth/plugins";
   import { authTables, twoFactorTables } from "@0furkancolak/pgcells/auth";

   export default {
     ...authTables("user"),
     emailAndPassword: { enabled: true },
     plugins: [twoFactor({ schema: twoFactorTables("user") })],
   } satisfies Omit<BetterAuthOptions, "database">;
   ```

2. Produce the difference:

   ```sh
   bun run cli auth generate ./auth-options.ts [--name better_auth]
   # if there is a difference: {"created": true, "id": "…_better_auth", "path": "src/migrations/tenant/…_better_auth.sql"}
   # if there is none: {"created": false}
   ```

   The command does the following:
   - Applies the existing tenant migrations to a temporary schema in db0.
   - Compares the Better Auth tables (`getSchema`) with that schema's `information_schema` / `pg_index` information; the schema name is a bound parameter.
   - Writes the missing tables, columns and indexes in Better Auth's PostgreSQL form as `--up`, and the statements that undo them as `--down`, into a new migration.
   - If the type of an existing column does not match the field (e.g. a boolean field mapped to a timestamp column), it writes no file and throws `INVALID_CONFIG`.
3. Review and fix the SQL and the `--down`: type changes and data moves are not produced.
4. `bun run codegen` (zod: `@0furkancolak/pgcells/tables/tenant/users` …) → `bun run cli migrate-all`.

Because each auth type (`user`, `student`, `teacher`) uses its own tables, run it with a separate options module per type. In CI, run `auth generate` with the same module and check that the output is `"created": false` and that `src/migrations` is unchanged (the drift check). `authSchemaDiff(db, options, { databaseId, schema })` returns the same difference (`schema` is a tenant schema, or `platform` in db0 for the panel): `toBeCreated`, `toBeAdded`, `toBeAddedIndexes`, `typeMismatches`, `sql`.

## Demo login

The demo seed (`src/seeds/demo/20260915155445_demo_login.ts`) writes the user `demo@<tenant>.example.com` / `demo-password` to every demo tenant with the `createPasswordUser` query (`src/queries/tenant/auth.sql`: `users` + a `credential` account). The password is hashed with Better Auth's hasher, in the seed transaction. It is only for demo tenants; it is not a real password. Delete or change it in your own installation.

## Workers

- **Per-request setup:** `createDatabase(workerConfig(env), { driver: postgresDriver, poolMax: 1 })`, then `createTenantAuth(db, make, { secret: env.BETTER_AUTH_SECRET, rootDomain: "example.com" })(tenantId)`. After the response, `ctx.waitUntil(db.close())`. `workerConfig`: [configuration.md](configuration.md#cloudflare-workers--hyperdrive).
- **Imported passwords:** bcrypt hashes are verified with `bcryptjs`. Because argon2 can be verified only on Bun, for tenants that will log in on Workers run the user import with `--auth-runtime workers`. argon2 hashes are not written, they are counted and reported; these users sign in through a password reset.
- **Hyperdrive:** caching must be off.

## Verified behavior

The end-to-end tests ([`@0furkancolak/pgcells-e2e` scenarios](https://github.com/0furkancolak/pgcells/blob/main/packages/e2e/docs/scenarios.md)) show:

- Sign-up and login work per tenant; the cookie is prefixed `kadikoy.`.
- A kadikoy session returns 401 on moda.
- The same email/password returns 401 on another tenant.
- Login works with an imported bcrypt hash.

The integration tests additionally show:

- In the same tenant, the user/student/teacher types use their own tables and snake_case columns.
- Each type's cookie is separate and one type's session is not valid in another.
- With the database rate limit, when one type's limit is reached (429), a login of another type from the same IP keeps being counted; the counters are in the type's table.
- The panel instance runs sign-up, login, 2FA and the database rate limit in the `platform` schema; `authSchemaDiff` finds no difference in the platform tables.
- A malformed `id` / `userId` gives an empty result, not an error, on real `uuid` columns.
