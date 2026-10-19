/** Better Auth `secondaryStorage` (1.7.4 interface): sessions, verifications and rate-limit counters live in Redis, prefixed by auth type and tenant.
 *
 * - Prefix: `tenant:<tenantId>:<authType>:` with a `tenantId`, `tenant:<authType>:app:` without one (platform/panel). Both are
 *   byte-for-byte identical to the format of the previous application's `createTenantSecondaryStorage`; `prefix` replaces the prefix
 *   entirely. `authType: "app"` is rejected for tenant storage (`INVALID_CONFIG`): tenant `foo` + the `app` prefix is the same as the prefix of platform auth type `foo`.
 * - `getAndDelete` is a single `GETDEL`; `increment(key, ttl)` is a single Lua script: `INCR`, and `EXPIRE ttl` if the counter was just created (the window does not extend).
 * - A Redis error is handled per operation; in every case the error goes to `onError` and to the span:
 *   - `get`/`getAndDelete` return `null` (the session is not visible, the verification token counts as invalid), `set` is skipped.
 *   - `delete` (session revocation, sign-out) throws `AUTH_STORAGE_UNAVAILABLE`: the revocation does not appear to succeed. The key is
 *     treated as revoked in this process (it is not read), and the delete is retried when it is read or on the next successful command.
 *   - `increment` falls back to an in-process fixed-window counter: the rate limit still applies during an outage. The counter (like the mask) is per
 *     Redis client; if the fallback is full, a new key counts as having exceeded the limit.
 * - `onSpan`: `auth.storage.get` (detail `hit` | `miss`), `auth.storage.getAndDelete` (same), `auth.storage.set`,
 *   `auth.storage.delete`, `auth.storage.increment` (detail `local`: the in-process counter was used). */
import { AppError, type SpanHandler, validateTenantId } from "@0furkancolak/pgcells";
import type { RedisClient } from "./client";
import { startSpan } from "./span";

export interface AuthStorageOptions {
  /** `user`, `student`, `teacher`, `panel` …; same rule as `createTenantAuth({ authType })`. Cannot be `app` in tenant storage. */
  authType: string;
  /** If omitted, the platform-scoped (panel) prefix. */
  tenantId?: string;
  /** Full key prefix (instead of the default). */
  prefix?: string;
  onError?: (error: unknown) => void;
  onSpan?: SpanHandler;
}

export interface AuthStorage {
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  increment(key: string, ttl: number): Promise<number>;
}

const AUTH_TYPE = /^[a-z][a-z0-9]{0,31}$/;
/** The platform prefix has the form `tenant:<authType>:app:`; in tenant storage this name would collide. */
const PLATFORM_SEGMENT = "app";

/** The counter gets a TTL only when it is created: fixed window, later increments do not extend it. */
const INCREMENT_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 and tonumber(ARGV[1]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/** Upper bound of the in-process fallbacks (number of keys) and how long a key that could not be deleted stays unread. */
const LOCAL_MAX = 10_000;
const REVOKED_TTL_MS = 24 * 60 * 60 * 1000;

/** Per Redis client, the keys that could not be deleted (full key → when the mask ends); keys of two separate Redis instances do not mix. */
const revokedByClient = new WeakMap<object, Map<string, number>>();
const retrying = new WeakSet<Map<string, number>>();
/** Rate-limit counters while Redis is unreachable (full key → count and window end), per client just like the mask: two clients
 * holding the same key (Redis migration, double write) do not share one counter and halve the limit. */
type LocalCounter = { count: number; expires: number };
const countersByClient = new WeakMap<object, Map<string, LocalCounter>>();

function isRevoked(revoked: Map<string, number>, key: string) {
  const until = revoked.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  revoked.delete(key);
  return false;
}

function markRevoked(revoked: Map<string, number>, key: string) {
  revoked.delete(key);
  revoked.set(key, Date.now() + REVOKED_TTL_MS);
  if (revoked.size > LOCAL_MAX) revoked.delete(revoked.keys().next().value as string);
}

/** Fixed-window counter; expired entries are cleaned from the front. If there is no room, a new key gets `Number.MAX_SAFE_INTEGER` (limit exceeded). */
function localIncrement(counters: Map<string, LocalCounter>, key: string, ttlSeconds: number) {
  const now = Date.now();
  const counter = counters.get(key);
  if (counter && counter.expires > now) return ++counter.count;
  counters.delete(key);
  for (const [oldest, { expires }] of counters) {
    if (expires > now) break;
    counters.delete(oldest);
  }
  if (counters.size >= LOCAL_MAX) return Number.MAX_SAFE_INTEGER;
  counters.set(key, { count: 1, expires: now + ttlSeconds * 1000 });
  return 1;
}

function defaultPrefix(authType: string, tenantId?: string): string {
  if (!AUTH_TYPE.test(authType)) throw new AppError("INVALID_CONFIG", "authType must be 1-32 characters of a-z and 0-9, starting with a letter (e.g. student)");
  if (tenantId === undefined) return `tenant:${authType}:${PLATFORM_SEGMENT}:`;
  if (authType === PLATFORM_SEGMENT)
    throw new AppError("INVALID_CONFIG", `authType ${PLATFORM_SEGMENT} is reserved for platform storage: tenant:<tenantId>:${PLATFORM_SEGMENT}: equals the platform prefix of auth type <tenantId>`);
  return `tenant:${validateTenantId(tenantId)}:${authType}:`;
}

const seconds = (ttl: number) => Math.max(1, Math.ceil(ttl));
const hitOrMiss = (value: string | null) => (value === null ? "miss" : "hit");

export function createAuthStorage(
  redis: Pick<RedisClient, "command">,
  { authType, tenantId, prefix, onError = () => {}, onSpan }: AuthStorageOptions,
): AuthStorage {
  const head = prefix ?? defaultPrefix(authType, tenantId);
  if (!head) throw new AppError("INVALID_CONFIG", "auth storage prefix must not be empty");
  const { command } = redis;
  const revoked = revokedByClient.get(command) ?? new Map<string, number>();
  revokedByClient.set(command, revoked);
  const counters = countersByClient.get(command) ?? new Map<string, LocalCounter>();
  countersByClient.set(command, counters);

  const report = (error: unknown) => {
    try {
      onError(error);
    } catch {
      // An onError failure does not fail the request.
    }
  };

  /** Retries the deletion of failed revocations (one in flight per client). */
  async function retryRevocations() {
    if (retrying.has(revoked)) return;
    retrying.add(revoked);
    try {
      for (const key of [...revoked.keys()]) {
        await command.del(key);
        revoked.delete(key);
      }
    } catch (error) {
      report(error);
    } finally {
      retrying.delete(revoked);
    }
  }

  /** A key whose revocation could not be written is not read: the delete is retried immediately, and the result is always `null`. */
  async function readUnlessRevoked(key: string, read: (key: string) => Promise<string | null>) {
    if (!isRevoked(revoked, key)) return read(key);
    try {
      await command.del(key);
      revoked.delete(key);
    } catch (error) {
      report(error);
    }
    return null;
  }

  /** A Redis operation. An error goes to `onError` and the `fallback` result is returned (or its error is thrown); on success, pending revocations are retried. */
  async function attempt<T>(name: string, work: () => Promise<T>, fallback: () => T, detail?: (value: T, failed: boolean) => string | undefined): Promise<T> {
    const end = startSpan(onSpan, name, tenantId);
    let value: T;
    try {
      value = await work();
    } catch (error) {
      report(error);
      try {
        value = fallback();
      } catch (failure) {
        end?.(undefined, error);
        throw failure;
      }
      end?.(detail?.(value, true), error);
      return value;
    }
    end?.(detail?.(value, false));
    if (revoked.size) void retryRevocations();
    return value;
  }

  return {
    get: (key) => attempt("auth.storage.get", () => readUnlessRevoked(head + key, (full) => command.get(full)), () => null, hitOrMiss),
    getAndDelete: (key) => attempt("auth.storage.getAndDelete", () => readUnlessRevoked(head + key, (full) => command.getdel(full)), () => null, hitOrMiss),
    set: (key, value, ttl) =>
      attempt(
        "auth.storage.set",
        async () => {
          await (ttl && ttl > 0 ? command.set(head + key, value, "EX", seconds(ttl)) : command.set(head + key, value));
          revoked.delete(head + key); // the written value is the key's new state
        },
        () => undefined,
      ),
    delete: (key) =>
      attempt(
        "auth.storage.delete",
        async () => {
          await command.del(head + key);
          revoked.delete(head + key);
        },
        () => {
          markRevoked(revoked, head + key);
          throw new AppError("AUTH_STORAGE_UNAVAILABLE", "Auth storage could not delete the key; the session is not revoked in Redis yet");
        },
      ),
    increment: (key, ttl) =>
      attempt(
        "auth.storage.increment",
        async () => Number(await command.eval(INCREMENT_SCRIPT, 1, head + key, seconds(ttl))),
        () => localIncrement(counters, head + key, seconds(ttl)),
        (_value, failed) => (failed ? "local" : undefined),
      ),
  };
}
