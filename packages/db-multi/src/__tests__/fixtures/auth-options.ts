/** Better Auth seçenekleri (veritabanı hariç), `user` auth türü: `bun run db:generate:auth src/__tests__/fixtures/auth-options.ts` tenant
 * migration'ını bunlardan üretir; entegrasyon testi ve CI drift denetimi aynı nesneyi kullanır. Uygulama kendi seçenek modülünü verir. */
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { authTables, type AuthType, rateLimitTable, twoFactorTables } from "../../core/auth-schema";

export const authTypeOptions = (authType: AuthType) =>
  ({
    emailAndPassword: { enabled: true },
    ...authTables(authType),
    // Açıkça verilmezse yalnızca production'da açık; tablo her auth türünde migration'dadır.
    rateLimit: { storage: "database", ...rateLimitTable(authType) },
    plugins: [twoFactor({ schema: twoFactorTables(authType) })],
  }) satisfies BetterAuthOptions;

export default authTypeOptions("user");
