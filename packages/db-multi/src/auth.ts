/** Better Auth entry point (`@0furkancolak/pgcells/auth`): Better Auth tables live in the tenant's own schema (`createTenantAuth`) or in db0's
 * `platform` schema (`createPlatformAuth`); table mapping per auth type; verification of password hashes imported from another application. */
export { type AuthTenant, createPlatformAuth, createTenantAuth, importedPasswords } from "./core/auth";
export { type AuthType, authTables, rateLimitTable, twoFactorTables } from "./core/auth-schema";
