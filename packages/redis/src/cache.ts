/** Two-layer cache: in-process LRU (`max` entries, `localTtlMs`) → Redis (`ttlSeconds`), values are JSON.
 *
 * - `wrap(key, loader)`: local → Redis → `loader`; concurrent misses in the same process call `loader` once (single-flight).
 *   `undefined` is not cached (no negative caching); `null` is.
 * - Invalidation race: `set`/`del` (in this process or arriving via pub/sub) advance the key's local counter and, in Redis, its version key.
 *   A Redis read that started before is not written to the local layer; the result of a `loader` that started before is written to neither layer
 *   (to Redis with a single version-comparing Lua script, to the local layer only once that is accepted). A caller arriving later does not join the old flight.
 * - `forTenant(id)`: keys are `t:{id}:c:<generation>:<key>`. `invalidateTenant(id)` advances the generation counter (a single `INCR`, no SCAN);
 *   old entries become unreachable and expire via TTL.
 * - `set`/`del`/`invalidateTenant` clear the local layer of other processes over a single pub/sub channel. For missed messages
 *   staleness lasts at most `localTtlMs`. `close()` removes this cache's pub/sub listener.
 * - A Redis error does not fail the request (fail-open): a read counts as a miss, a write is skipped, the error goes to `onError`.
 * - `onSpan`: `cache.get` (detail `hit-local` | `hit-redis` | `miss`), `cache.set`, `cache.invalidate` (detail `key` | `tenant`);
 *   a fail-open Redis error shows up as `error` in the span.
 *
 * Values are shared as the same object in the local layer: do not mutate them. Non-JSON types such as Date come back from Redis as strings. */
import { type SpanHandler, validateTenantId } from "@0furkancolak/pgcells";
import type { RedisClient } from "./client";
import { publishInvalidation, subscribeInvalidations } from "./invalidation";
import { createKeys, type Keys } from "./keys";
import { createEpochs, createLocalLru } from "./lru";
import { type EndSpan, startSpan } from "./span";

type CacheRedis = Pick<RedisClient, "command" | "subscriber">;

export interface CacheOptions {
  /** If omitted, only the local layer is used (tests, development). */
  redis?: CacheRedis;
  max?: number;
  localTtlMs?: number;
  ttlSeconds?: number;
  /** Application key prefix; applications sharing the same Redis stay separate. */
  prefix?: string;
  onError?: (error: unknown) => void;
  onSpan?: SpanHandler;
}

/** `accept` validates the value read from Redis and decides which value is written; the default accepts every value that is not `undefined`. */
type Accept = (value: unknown) => boolean;
const defined: Accept = (value) => value !== undefined;

/** A cache view that is either global or bound to a single tenant. */
interface CacheScope {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  wrap<T>(key: string, loader: () => T | Promise<T>): Promise<T>;
}

/** A single `wrap` miss; all waiters on the same key share the result and its source (the span detail). */
interface Flight {
  promise: Promise<unknown>;
  detail: "hit-redis" | "miss";
  error?: unknown;
}

/** Lifetime of the version key in Redis. The result of a load that takes longer than half of it is not written: the version key could
 * expire in the meantime and mislead the comparison. */
const VERSION_TTL_SECONDS = 600;
const MAX_LOAD_MS = (VERSION_TTL_SECONDS * 1000) / 2;

/** `set`/`del`: advances the version, writes or deletes the value. KEYS: value, version. ARGV: JSON ('' = delete), ttl, version ttl. */
const WRITE_SCRIPT = `redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
if ARGV[1] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) end
return 1`;
/** `wrap` result: writes if the version is the same as the one read before the load started. ARGV: JSON, ttl, version read ('' = there was none). */
const STORE_SCRIPT = `if (redis.call('GET', KEYS[2]) or '') ~= ARGV[3] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`;

/** The version key lives in the same Redis Cluster slot as the value: `v:<key>` for a key with a hash tag, `v:{<key>}` for a key without one. */
function versionKey(key: string) {
  const open = key.indexOf("{");
  const close = open < 0 ? -1 : key.indexOf("}", open + 1);
  return close > open + 1 ? `v:${key}` : `v:{${key}}`;
}

/** Tenant generation counters: kept locally for `ttlMs` (at most `max` tenants, the oldest is evicted), in Redis as `t:{id}:gen`. If Redis is down, the generation
 * changes only in this process. */
function createGenerations(redis: CacheRedis | undefined, keys: Keys, ttlMs: number, max: number, report: (error: unknown) => void) {
  const generations = new Map<string, { gen: string; expires: number }>();
  // Generations that arrive by broadcast are kept here too: without a limit, tenants that are never read would pile up.
  const remember = (tenantId: string, gen: string) => {
    generations.delete(tenantId);
    generations.set(tenantId, { gen, expires: Date.now() + ttlMs });
    if (generations.size > max) generations.delete(generations.keys().next().value as string);
  };
  const counterKey = (tenantId: string) => keys.tenant(tenantId, "gen");

  async function current(tenantId: string) {
    const hit = generations.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.gen;
    let gen = hit?.gen ?? "0";
    try {
      if (redis) gen = (await redis.command.get(counterKey(tenantId))) ?? "0";
    } catch (error) {
      report(error);
    }
    remember(tenantId, gen);
    return gen;
  }

  /** O(1): advances the counter and broadcasts it with `publish`. */
  async function bump(tenantId: string, publish: (gen: string) => Promise<void>) {
    const key = counterKey(tenantId); // an invalid tenant ID is not fail-open, it throws
    let gen = `local-${Date.now()}`;
    try {
      if (redis) {
        gen = String(await redis.command.incr(key));
        await publish(gen);
      }
    } catch (error) {
      report(error);
    }
    remember(tenantId, gen);
  }

  return { current, bump, remember };
}

export function createCache({ redis, max = 10_000, localTtlMs = 5_000, ttlSeconds = 60, prefix, onError = () => {}, onSpan }: CacheOptions = {}) {
  const keys = createKeys(prefix);
  const channel = keys.global("cache", "invalidate");
  const origin = crypto.randomUUID();
  const local = createLocalLru(max, localTtlMs);
  const epochs = createEpochs(max);
  const flights = new Map<string, Flight>();

  const report = (error: unknown) => {
    try {
      onError(error);
    } catch {
      // An onError failure does not fail the request.
    }
  };
  const generations = createGenerations(redis, keys, localTtlMs, max, report);
  const notify = (message: { key?: string; tenantId?: string; generation?: string }) =>
    redis ? publishInvalidation(redis, channel, { origin, ...message }) : Promise.resolve();

  /** The key changed in this process: the counter advances, and the local entry and the in-flight load are dropped (the next caller starts a new load). */
  const forget = (key: string) => {
    epochs.bump(key);
    flights.delete(key);
    local.forget(key);
  };

  const unsubscribe = redis
    ? subscribeInvalidations(redis, channel, origin, { onKey: forget, onGeneration: generations.remember, onError: report })
    : undefined;

  /** Local → Redis. `version`: the version in Redis (`''` = none); `undefined` if Redis could not be read or is absent. If the key was
   * invalidated while the read was in progress, the old answer counts as a miss and is not written to the local layer. */
  async function lookup<T>(key: string, accept: Accept, end?: EndSpan): Promise<{ value: T | undefined; version?: string }> {
    const hit = local.peek<T>(key);
    if (hit !== undefined || !redis) {
      end?.(hit === undefined ? "miss" : "hit-local");
      return { value: hit };
    }
    const started = epochs.now();
    try {
      const [raw, version] = await redis.command.mget(key, versionKey(key));
      const value: unknown = raw === null || raw === undefined ? undefined : JSON.parse(raw);
      if (value === undefined || !accept(value) || epochs.changedSince(key, started)) {
        end?.("miss");
        return { value: undefined, version: version ?? "" };
      }
      local.remember(key, value);
      end?.("hit-redis");
      return { value: value as T, version: version ?? "" };
    } catch (error) {
      report(error);
      end?.("miss", error);
      return { value: undefined };
    }
  }

  const get = async <T>(key: string, accept = defined, end?: EndSpan): Promise<T | undefined> => (await lookup<T>(key, accept, end)).value;

  async function set(key: string, value: unknown, end?: EndSpan) {
    forget(key);
    local.remember(key, value);
    try {
      await redis?.command.eval(WRITE_SCRIPT, 2, key, versionKey(key), JSON.stringify(value), ttlSeconds, VERSION_TTL_SECONDS);
      await notify({ key });
      end?.();
    } catch (error) {
      report(error);
      end?.(undefined, error);
    }
  }

  async function del(key: string, end?: EndSpan) {
    forget(key);
    try {
      await redis?.command.eval(WRITE_SCRIPT, 2, key, versionKey(key), "", ttlSeconds, VERSION_TTL_SECONDS);
      await notify({ key });
      end?.("key");
    } catch (error) {
      report(error);
      end?.("key", error);
    }
  }

  /** Load result: if the key changed after the load started (`started`), nothing is written to either layer. It is written to Redis only if the version
   * is `version`, and to the local layer after that; if Redis could not be read or written, only to the local layer. */
  async function store(key: string, value: unknown, started: number, startedAt: number, version: string | undefined) {
    if (epochs.changedSince(key, started) || performance.now() - startedAt > MAX_LOAD_MS) return;
    if (redis && version !== undefined) {
      try {
        const stored = await redis.command.eval(STORE_SCRIPT, 2, key, versionKey(key), JSON.stringify(value), ttlSeconds, version);
        if (Number(stored) !== 1) return;
      } catch (error) {
        report(error);
      }
      if (epochs.changedSince(key, started)) return;
    }
    local.remember(key, value);
  }

  function wrap<T>(key: string, loader: () => T | Promise<T>, accept = defined, end?: EndSpan): Promise<T> {
    const hit = local.peek<T>(key);
    if (hit !== undefined) {
      end?.("hit-local");
      return Promise.resolve(hit);
    }
    const flight = flights.get(key) ?? startFlight(key, loader, accept);
    if (!end) return flight.promise as Promise<T>;
    return (flight.promise as Promise<T>).then(
      (value) => (end(flight.detail, flight.error), value),
      (error: unknown) => {
        end(flight.detail, error);
        throw error;
      },
    );
  }

  function startFlight<T>(key: string, loader: () => T | Promise<T>, accept: Accept): Flight {
    const flight: Flight = { promise: Promise.resolve(), detail: "miss" };
    const started = epochs.now();
    const startedAt = performance.now();
    // A Redis read error is kept only for the span (fail-open).
    const captureError: EndSpan | undefined = onSpan && ((_detail, error) => void (flight.error = error));
    flight.promise = (async () => {
      const cached = await lookup<T>(key, accept, captureError);
      if (cached.value !== undefined) {
        flight.detail = "hit-redis";
        return cached.value;
      }
      const value = await loader();
      if (value !== undefined && accept(value)) await store(key, value, started, startedAt, cached.version);
      return value;
    })().finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
    flights.set(key, flight);
    return flight;
  }

  /** If Redis is down, only this process's local layer is invalidated. */
  async function invalidateTenant(tenantId: string) {
    const end = startSpan(onSpan, "cache.invalidate", tenantId);
    await generations.bump(tenantId, (generation) => notify({ tenantId, generation }));
    end?.("tenant");
  }

  /** The span starts before key resolution (including reading the tenant generation). */
  const scope = (key: (name: string) => string | Promise<string>, tenantId?: string): CacheScope => {
    const span = (name: string) => startSpan(onSpan, name, tenantId);
    return {
      get: async (name) => {
        const end = span("cache.get");
        return get(await key(name), defined, end);
      },
      set: async (name, value) => {
        const end = span("cache.set");
        await set(await key(name), value, end);
      },
      del: async (name) => {
        const end = span("cache.invalidate");
        await del(await key(name), end);
      },
      wrap: async (name, loader) => {
        const end = span("cache.get");
        return wrap(await key(name), loader, defined, end);
      },
    };
  };

  return {
    ...scope((name) => keys.global("c", name)),
    forTenant: (tenantId: string): CacheScope => {
      validateTenantId(tenantId);
      return scope(async (name) => keys.tenant(tenantId, "c", await generations.current(tenantId), name), tenantId);
    },
    invalidateTenant,
    /** Low-level access with full keys (no prefix/generation added), without spans (the placement cache emits its own span); `peek` is synchronous. */
    raw: { peek: local.peek, get, set, del, wrap },
    /** Removes the pub/sub listener; other caches on the shared subscriber connection are unaffected. Can be called again. */
    close: () => unsubscribe?.(),
  };
}

export type Cache = ReturnType<typeof createCache>;
