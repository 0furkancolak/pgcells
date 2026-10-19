/** Better Auth seçenekleri (veritabanı hariç): `bun run db:generate:auth src/__tests__/fixtures/auth-options.ts` migration'ı bunlardan
 * üretir; entegrasyon testi ve CI drift denetimi aynı nesneyi kullanır. Uygulama kendi seçenek modülünü verir. */
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { authTables, rateLimitTable, twoFactorTables } from "../../core/auth-schema";

export default {
  emailAndPassword: { enabled: true },
  ...authTables(),
  // Açıkça verilmezse yalnızca production'da açık; tablo temel migration'dadır.
  rateLimit: { storage: "database", ...rateLimitTable() },
  plugins: [twoFactor({ schema: twoFactorTables() })],
} satisfies BetterAuthOptions;
