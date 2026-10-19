/** Better Auth entry point (`@0furkancolak/pgcells-single/auth`): Better Auth tables in the application schema (`createAuth`); table mapping; verification of
 * password hashes imported from another application. */
export { type AuthConfig, type AuthOptions, type AuthRuntime, createAuth, importedPasswords } from "./core/auth";
export { authTables, rateLimitTable, twoFactorTables } from "./core/auth-schema";
