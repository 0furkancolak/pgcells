/** Better Auth options (without the database): the `bun run db:generate:auth src/__tests__/fixtures/auth-options.ts` migration is generated from them;
 * the integration test and the CI drift check use the same object. An application supplies its own options module. */
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { authTables, rateLimitTable, twoFactorTables } from "../../core/auth-schema";

export default {
  emailAndPassword: { enabled: true },
  ...authTables(),
  // Enabled only in production unless given explicitly; the table is in the base migration.
  rateLimit: { storage: "database", ...rateLimitTable() },
  plugins: [twoFactor({ schema: twoFactorTables() })],
} satisfies BetterAuthOptions;
