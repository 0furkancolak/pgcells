/** Better Auth entry point (`@0furkancolak/pgcells-single/auth`): our own Better Auth adapter (`auth-adapter.ts`) on the engine's DB pool, a database
 * bound to the application schema, a fixed cookie prefix and a single instance. The `@0furkancolak/pgcells-single` runtime entry does not load this module. */
import type { DBAdapterInstance } from "better-auth";
import { engineAdapter } from "./auth-adapter";
import { AppError } from "./errors";
import type { Db } from "./runtime";

/** Result of `createDb`: the primary pool and the schema are enough. */
export type AuthRuntime = Pick<Db, "pools" | "schema">;

/** Safe defaults passed to `make`; spread as-is into the Better Auth options. The database generates ids
 * (`uuid DEFAULT gen_random_uuid()`), hence `generateId: false`. */
export interface AuthOptions {
  database: DBAdapterInstance;
  secret: string;
  baseURL: string;
  basePath?: string;
  advanced: { cookiePrefix: string; database: { generateId: false } };
}

export interface AuthConfig {
  /** Better Auth secret (at least 32 characters). */
  secret: string;
  baseURL: string;
  /** Path prefix (e.g. `/api/auth`); when omitted the Better Auth default stays and the field is not added. */
  basePath?: `/${string}`;
  /** Cookie prefix; fixed. Defaults to `auth`. */
  cookiePrefix?: string;
}

const COOKIE_PREFIX = /^[a-z][a-z0-9-]{0,31}$/;

function requireSecret(secret: string): string {
  if (secret.length < 32) throw new AppError("INVALID_CONFIG", "Better Auth secret must have at least 32 characters");
  return secret;
}

/** bcrypt (`$2a$`, `$2b$`, `$2y$`) and argon2 (`$argon2id$`, `$argon2i$`, `$argon2d$`) hashes: those imported from other applications. */
const FOREIGN_HASH = /^\$(?:2[aby]|argon2(?:id|i|d))\$/;

/**
 * Better Auth `emailAndPassword.password`: new passwords are hashed with Better Auth scrypt; bcrypt and argon2 hashes imported from another
 * application are verified with `Bun.password`, so users sign in with their old passwords. Outside Bun (Workers, Node) bcrypt is verified
 * with `bcryptjs`; argon2 only on Bun.
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

/**
 * Better Auth instance: tables are qualified as `"<schema>"."users"` … (through the engine's primary pool). The single instance is created on
 * the first call and kept; `make` must spread `options`. On Workers, create it per request.
 */
export function createAuth<A>(runtime: AuthRuntime, make: (auth: { options: AuthOptions }) => A, { secret, baseURL, basePath, cookiePrefix = "auth" }: AuthConfig): () => A {
  if (!COOKIE_PREFIX.test(cookiePrefix)) throw new AppError("INVALID_CONFIG", "cookiePrefix must be 1-32 characters of a-z, 0-9 and hyphens, starting with a letter");
  if (basePath !== undefined && !basePath.startsWith("/")) throw new AppError("INVALID_CONFIG", "basePath must start with /");
  const options: AuthOptions = {
    database: engineAdapter(runtime.pools.primary, runtime.schema),
    secret: requireSecret(secret),
    baseURL,
    ...(basePath ? { basePath } : {}),
    advanced: { cookiePrefix, database: { generateId: false } },
  };
  let auth: A | undefined;
  return () => (auth ??= make({ options }));
}
