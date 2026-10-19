/** Better Auth entry point (`@0furkancolak/pgcells/auth`): our own Better Auth adapter (`auth-adapter.ts`) on the engine's DB pools, a database
 * bound to the tenant or platform schema, path and cookie name by auth type, an optional tenant secret (HKDF) and an in-process LRU.
 * The `@0furkancolak/pgcells` runtime entry point does not load this module. */
import type { DBAdapterInstance } from "better-auth";
import { engineAdapter } from "./auth-adapter";
import { boundedInteger, PLATFORM_DATABASE_ID } from "./config";
import type { Pools } from "./database";
import { AppError } from "./errors";
import { PLATFORM_SCHEMA } from "./sql/query";
import { type Placement, requireActive, validateSchema, validateTenantId } from "./tenants/model";

export type { Queryable } from "./auth-adapter";
/** The result of `createDatabase`: the cached `placement` is used if present, otherwise `platform.get`. */
export type AuthRuntime = {
  placement?(tenantId: string): Placement | Promise<Placement>;
  platform: { get(tenantId: string): Promise<Placement> };
  pools: Pick<Pools, "node">;
};
const readPlacement = async (runtime: AuthRuntime, tenantId: string) => (runtime.placement ? runtime.placement(tenantId) : runtime.platform.get(tenantId));

/** Safe defaults passed to `make`; spread into the Better Auth options as they are. `basePath` is present only with `authType`.
 * The database generates the ids (`uuid DEFAULT gen_random_uuid()`), hence `generateId: false`. */
export interface AuthOptions {
  database: DBAdapterInstance;
  secret: string;
  baseURL: string;
  basePath?: `/api/auth/${string}`;
  advanced: { cookiePrefix: string; database: { generateId: false } };
}
const DATABASE_IDS = { generateId: false } as const;
/** The tenant passed to `make`; `options` is spread into the Better Auth options as it is. */
export interface AuthTenant {
  tenantId: string;
  placement: Placement;
  options: AuthOptions;
}

/** bcrypt (`$2a$`, `$2b$`, `$2y$`) and argon2 (`$argon2id$`, `$argon2i$`, `$argon2d$`) hashes: those imported from other applications. */
const FOREIGN_HASH = /^\$(?:2[aby]|argon2(?:id|i|d))\$/;

/**
 * Better Auth `emailAndPassword.password`: new passwords are hashed with Better Auth scrypt; bcrypt and argon2 hashes imported with
 * `import-users` are verified with `Bun.password`, so users sign in with their old passwords. Outside Bun (Workers, Node) bcrypt is verified with
 * `bcryptjs`; argon2 works only on Bun (`importUsers({ authRuntime: "workers" })` does not write argon2 hashes and reports them).
 */
export const importedPasswords = {
  hash: async (password: string) => (await import("better-auth/crypto")).hashPassword(password),
  verify: async ({ hash, password }: { hash: string; password: string }) => {
    if (!FOREIGN_HASH.test(hash)) return (await import("better-auth/crypto")).verifyPassword({ hash, password });
    if (typeof Bun !== "undefined") return Bun.password.verify(password, hash);
    if (hash.startsWith("$argon2")) throw new AppError("UNSUPPORTED_PASSWORD_HASH", "Imported argon2 hashes need the Bun runtime");
    // $2y$ (PHP) and $2b$ are the same algorithm.
    return (await import("bcryptjs")).compare(password, hash.replace(/^\$2y\$/, "$2b$"));
  },
};

const authDatabase = (runtime: AuthRuntime, { databaseId, schemaName }: Placement) =>
  engineAdapter(runtime.pools.node(databaseId), validateSchema(schemaName));

/** The tenant's Better Auth database (placement must be `active`): tables are qualified as `"<schema>"."user"` ... */
export async function tenantAuthDatabase(runtime: AuthRuntime, tenantId: string): Promise<DBAdapterInstance> {
  return authDatabase(runtime, requireActive(await readPlacement(runtime, tenantId)));
}

function requireSecret(secret: string): string {
  if (secret.length < 32) throw new AppError("INVALID_CONFIG", "Better Auth secret must have at least 32 characters");
  return secret;
}

/** The auth type is part of the path and the cookie/Redis name: `user`, `student`, `panel` ... */
const AUTH_TYPE = /^[a-z][a-z0-9]{0,31}$/;
function validateAuthType(authType: string): string {
  if (!AUTH_TYPE.test(authType)) throw new AppError("INVALID_CONFIG", "authType must be 1-32 characters of a-z and 0-9, starting with a letter (e.g. student)");
  return authType;
}

/** HKDF-SHA256(`BETTER_AUTH_SECRET`, tenant ID) → 64 hex. Used with `perTenantSecret: true`. */
export async function tenantAuthSecret(masterSecret: string, tenantId: string): Promise<string> {
  const text = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", text.encode(requireSecret(masterSecret)), "HKDF", false, ["deriveBits"]);
  const info = text.encode(validateTenantId(tenantId));
  // The KDF salt is fixed data: if it changes with the package name, derived secrets and sessions become invalid.
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: text.encode("@repo/db/auth"), info }, key, 256);
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `/api/auth/<authType>` if `authType` is given; otherwise the Better Auth default (`/api/auth`) stays and no field is added. */
const routeOptions = (authType?: string): Pick<AuthOptions, "basePath"> => (authType ? { basePath: `/api/auth/${authType}` } : {});

/** The cookie prefix depends on the tenant ID (not the schema name): `<authType>-<tenantId>` or `<tenantId>`. */
const tenantCookiePrefix = (tenantId: string, authType?: string) => (authType ? `${authType}-${tenantId}` : tenantId);

/** The fields of the Better Auth instance (`auth.options`) that are inspected. */
type InstanceOptions = {
  session?: { cookieCache?: { enabled?: boolean } };
  rateLimit?: { enabled?: boolean; storage?: string; customStorage?: unknown; modelName?: string };
  secondaryStorage?: unknown;
};
const instanceOptions = (auth: unknown) => (auth as { options?: InstanceOptions } | null)?.options;

/** Same rule as Better Auth: if `rateLimit.enabled` is not given, it is on only when `NODE_ENV=production`. */
const isProduction = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === "production";

/** A `cookieCache` cookie signed with a shared secret is accepted on another tenant once renamed: this setup is rejected. */
function assertCookieCacheIsolated(options: InstanceOptions | undefined, perTenantSecret: boolean) {
  if (perTenantSecret || !options?.session?.cookieCache?.enabled) return;
  throw new AppError("INVALID_CONFIG", "session.cookieCache with a shared secret lets one tenant's cache cookie sign in on another; set perTenantSecret: true or disable cookieCache");
}

/** The in-memory rate-limit store is a single process-wide `Map` (key: IP + path without `basePath`): all tenants and auth types share the same
 * counter. An enabled rate limit requires `secondary-storage` (e.g. `createAuthStorage`), `database` or `customStorage`. The `database` store
 * requires the auth type's table (`rateLimitTable`): the default `rateLimit` table is not in the migration, and auth types in the same schema
 * would share a counter in a single table. */
function assertRateLimitIsolated(options: InstanceOptions | undefined) {
  const rateLimit = options?.rateLimit;
  const storage = rateLimit?.storage ?? (options?.secondaryStorage ? "secondary-storage" : "memory");
  if (storage === "database" && !rateLimit?.customStorage && !rateLimit?.modelName)
    throw new AppError("INVALID_CONFIG", 'rateLimit storage "database" needs the auth type\'s table: rateLimit: { ...rateLimitTable(authType), storage: "database" }');
  if (!(rateLimit?.enabled ?? isProduction()) || storage !== "memory" || rateLimit?.customStorage) return;
  throw new AppError("INVALID_CONFIG", "rateLimit with the memory store shares one counter across tenants and auth types; use secondaryStorage (rateLimit.storage \"secondary-storage\") or \"database\"");
}

export interface TenantAuthConfig {
  /** Shared Better Auth secret (≥ 32 characters); with `perTenantSecret: true` it is derived per tenant via HKDF. */
  secret: string;
  /** `baseURL` = `https://<tenant>.<rootDomain>` */
  rootDomain: string;
  /** Path `/api/auth/<authType>`, cookie prefix `<authType>-<tenantId>`. */
  authType?: string;
  perTenantSecret?: boolean;
  max?: number;
}

/**
 * Tenant ID → Better Auth instance. The placement is read on every call (`TENANT_UNAVAILABLE` if it is not active); the instance is kept
 * per tenant in an LRU of `max` entries until the DB/schema changes. `make` must spread the safe defaults (`tenant.options`: the database bound to the
 * schema, secret, `https://<domain>`, cookie prefix from the tenant ID, path from `authType`). On Workers, set it up per request.
 */
export function createTenantAuth<A>(
  runtime: AuthRuntime,
  make: (tenant: AuthTenant) => A,
  { secret, rootDomain, authType, perTenantSecret = false, max = 100 }: TenantAuthConfig,
) {
  if (!/^[a-z0-9.-]+$/.test(rootDomain)) throw new AppError("INVALID_CONFIG", "rootDomain must be a lowercase host name such as example.com");
  requireSecret(secret);
  if (authType !== undefined) validateAuthType(authType);
  const limit = boundedInteger(max, "max", 100000);
  const cache = new Map<string, { key: string; auth: A }>();

  const build = async (tenantId: string, placement: Placement): Promise<A> => {
    const options: AuthOptions = {
      database: authDatabase(runtime, placement),
      secret: perTenantSecret ? await tenantAuthSecret(secret, tenantId) : secret,
      baseURL: `https://${tenantId}.${rootDomain}`,
      ...routeOptions(authType),
      advanced: { cookiePrefix: tenantCookiePrefix(tenantId, authType), database: DATABASE_IDS },
    };
    const auth = make({ tenantId, placement, options });
    assertCookieCacheIsolated(instanceOptions(auth), perTenantSecret);
    assertRateLimitIsolated(instanceOptions(auth));
    return auth;
  };

  return async (tenantId: string): Promise<A> => {
    const placement = requireActive(await readPlacement(runtime, tenantId));
    const key = `${placement.databaseId}/${placement.schemaName}`;
    let entry = cache.get(tenantId);
    cache.delete(tenantId);
    if (entry?.key !== key) entry = { key, auth: await build(tenantId, placement) };
    cache.set(tenantId, entry);
    if (cache.size > limit) cache.delete(cache.keys().next().value as string);
    return entry.auth;
  };
}

/**
 * Platform-scoped Better Auth (e.g. a management panel): tables are in db0's `platform` schema, path `/api/auth/<authType>`, cookie
 * prefix `<authType>`. A single instance is created on the first call and kept; `make` must spread `options`.
 */
export function createPlatformAuth<A>(
  runtime: Pick<AuthRuntime, "pools">,
  make: (platform: { options: AuthOptions }) => A,
  { secret, baseURL, authType = "panel" }: { secret: string; baseURL: string; authType?: string },
): () => A {
  const options: AuthOptions = {
    database: engineAdapter(runtime.pools.node(PLATFORM_DATABASE_ID), PLATFORM_SCHEMA),
    secret: requireSecret(secret),
    baseURL,
    ...routeOptions(validateAuthType(authType)),
    advanced: { cookiePrefix: authType, database: DATABASE_IDS },
  };
  let auth: A | undefined;
  return () => {
    if (auth === undefined) {
      const made = make({ options });
      // The platform instance shares the same in-memory store with the tenant instances in the same process.
      assertRateLimitIsolated(instanceOptions(made));
      auth = made;
    }
    return auth;
  };
}
