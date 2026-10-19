# Better Auth storage: `createAuthStorage`

`createAuthStorage(redis, options)` builds Better Auth 1.7.4’s `secondaryStorage` interface on top of Redis:

- Sessions (when `secondaryStorage` is present, session records live in Redis).
- Rate-limit counters.
- Verification records, unless `verification.storeInDatabase` is set.

Keys are prefixed by tenant and auth type; they are byte-for-byte identical to the previous application’s format. For the database side: [`@0furkancolak/pgcells` auth.md](https://github.com/0furkancolak/pgcells/blob/main/packages/db-multi/docs/auth.md).

```ts
import { betterAuth } from "better-auth";
import { createTenantAuth } from "@0furkancolak/pgcells/auth";
import { createAuthStorage, createRedis } from "@0furkancolak/pgcells-redis";

const redis = createRedis();
const studentAuth = createTenantAuth(
  db,
  (tenant) =>
    betterAuth({
      ...tenant.options,
      secondaryStorage: createAuthStorage(redis, { authType: "student", tenantId: tenant.tenantId, onError: reportError }),
      verification: { storeInDatabase: true },
    }),
  { secret: process.env.BETTER_AUTH_SECRET ?? "", rootDomain: "example.com", authType: "student" },
);
```

## Options

| Option | Meaning |
|---|---|
| `authType` | `^[a-z][a-z0-9]{0,31}$` (`INVALID_CONFIG`); the same value as `createTenantAuth({ authType })`. It cannot be `app` in a tenant storage (see **Reserved name** below). |
| `tenantId` | Tenant ID (`validateTenantId`, `INVALID_TENANT_ID`). If omitted, a platform-scoped prefix is used. |
| `prefix` | The full key prefix; replaces the default. |
| `onError` | Receives every Redis error (including those that are thrown); its own errors are ignored. |
| `onSpan` | Telemetry in the `@0furkancolak/pgcells` `Span` format ([telemetry.md](telemetry.md)). |

## Keys

| Setup | Prefix | Example |
|---|---|---|
| `{ authType: "student", tenantId: "kadikoy" }` | `tenant:<tenantId>:<authType>:` | `tenant:kadikoy:student:<token>` |
| `{ authType: "panel" }` | `tenant:<authType>:app:` | `tenant:panel:app:<token>` |
| `{ authType: "user", prefix: "app:auth:" }` | `prefix` | `app:auth:<token>` |

- **With a tenant ID:** the format is the same as `createTenantSecondaryStorage(tenantSchema, userType)` in the previous application. Sessions of tenants whose ID equals the old schema name are preserved across the migration.
- **Platform:** the `panel` prefix is the same as today’s `createTenantSecondaryStorage('panel', 'app')`.
- **Isolation:** with a shared Better Auth secret, isolation between tenants depends on this prefix. Each tenant and auth type must get its own storage; two instances that share the same prefix accept each other’s sessions.
- **Reserved name (mandatory):** the platform prefix has the form `tenant:<authType>:app:`. In a tenant storage, `authType: "app"` is rejected with `INVALID_CONFIG`: tenant `foo` + the `app` prefix (`tenant:foo:app:`) would equal the prefix of platform auth type `foo`. If `prefix` is given, the prefix is entirely the caller’s and this check is not made.

## Methods

| Method | Redis | On error |
|---|---|---|
| `get(key)` | `GET` | `null` (miss) |
| `getAndDelete(key)` | `GETDEL` (atomic) | `null` |
| `set(key, value, ttl?)` | `SET` (`EX <seconds>` if `ttl` > 0, rounded up) | skipped |
| `delete(key)` | `DEL` | throws `AUTH_STORAGE_UNAVAILABLE`; the key counts as revoked in this process, and the delete is retried |
| `increment(key, ttl)` | Lua: `INCR`; `EXPIRE ttl` if the counter was just created | an in-process fixed-window counter |

`increment` is Better Auth’s contract. It returns the value after the increment. The TTL is given only when the counter is created; later increments do not extend it (fixed window). Because it is a single command, there is no race between processes, and on Redis Cluster it touches a single key.

`GETDEL` requires Redis 6.2.

## Redis errors

In every case the error goes to `onError` and to the span (`error`). Behavior depends on the operation:

- **Session read** (`get`): counts as a miss. While Redis is down, sessions are not visible and the user is asked to sign in again.
- **Session revocation, sign-out** (`delete`): `AUTH_STORAGE_UNAVAILABLE` is thrown; the Better Auth request ends with an error, so the sign-out or revocation does not appear to succeed (the application should return 503). A session left in Redis does not silently become valid again when Redis returns:
  - the key counts as revoked in this process and is not read (`get`/`getAndDelete` return `null`);
  - the delete is retried when the key is read or on the next successful Redis command;
  - the list holds at most 10,000 keys and 24 hours per Redis client. Other processes do not see this list; for them, the guarantee is the error returned to the caller.
- **Rate limit** (`increment`): falls back to an in-process fixed-window counter, so the limit is enforced during an outage too. Counters (like the revocation mask) are per Redis client and hold at most 10,000 keys per client; expired ones are cleaned up. If no room is left, a new key gets `Number.MAX_SAFE_INTEGER`, meaning the request is treated as having exceeded the limit (fail-closed). When Redis returns, the Redis counter is used again. During an outage the effective limit is multiplied by the number of clients: with N processes (or N clients held for the same key in one process) it is at most N times.
- **Verification:** unless `verification.storeInDatabase` is given, `getAndDelete` returns `null` and the token counts as invalid. With `storeInDatabase: true`, verification does not depend on Redis; this is the recommended setting.
- **Write** (`set`): skipped; no session is created and the user is asked to sign in again.

### Migrating from the previous version

- On a Redis error, `delete` no longer returns success silently; it throws `AUTH_STORAGE_UNAVAILABLE`. Map this code to 503 in your sign-out/revocation route. The signature did not change.
- On a Redis error, `increment` returns the in-process counter instead of `0`. The rate limit is enforced during an outage; in the previous version it was not.
- `authType: "app"` is rejected in a tenant storage. The previous application’s tenant types (`user`, `student`, `teacher`) are not affected; the platform `panel` storage stays the same as the `tenant:panel:app:` prefix.

## Rate limit

When Better Auth `secondaryStorage` is given, the rate-limit storage defaults to `"secondary-storage"` and `increment` is used. The in-memory store is a single counter across tenants and auth types; `createTenantAuth` rejects an explicit rate limit with the in-memory store ([auth.md](https://github.com/0furkancolak/pgcells/blob/main/packages/db-multi/docs/auth.md#mandatory-checks)).

If Better Auth cannot resolve the client IP behind a proxy, all requests fall onto the same counter: set `advanced.ipAddress`.

## Spans

| Name | detail |
|---|---|
| `auth.storage.get` | `hit` \| `miss` |
| `auth.storage.getAndDelete` | `hit` \| `miss` |
| `auth.storage.set` | — |
| `auth.storage.delete` | — |
| `auth.storage.increment` | `local` on a Redis error (in-process counter) |

If `tenantId` was given, it is also present in the span.
