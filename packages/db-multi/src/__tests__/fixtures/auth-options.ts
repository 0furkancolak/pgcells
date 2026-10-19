/** Better Auth options (excluding the database), the `user` auth type: `bun run db:generate:auth src/__tests__/fixtures/auth-options.ts` generates the tenant
 * migration from them; the integration test and the CI drift check use the same object. The application supplies its own options module. */
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { authTables, type AuthType, rateLimitTable, twoFactorTables } from "../../core/auth-schema";

export const authTypeOptions = (authType: AuthType) =>
  ({
    emailAndPassword: { enabled: true },
    ...authTables(authType),
    // Unless given explicitly it is on only in production; the table is in the migration for every auth type.
    rateLimit: { storage: "database", ...rateLimitTable(authType) },
    plugins: [twoFactor({ schema: twoFactorTables(authType) })],
  }) satisfies BetterAuthOptions;

export default authTypeOptions("user");
