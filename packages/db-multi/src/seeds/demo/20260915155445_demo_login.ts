/** Demo girişi: `demo@<tenant>.example.com` / `DEMO_PASSWORD` — yalnızca demo tenant'lar, gerçek parola değildir. Kullanıcı ve parola hesabı
 * Better Auth'un hasher'ıyla seed transaction'ında yazılır (ayrı bağlantı yok); `better-auth` yalnızca seed çalışınca yüklenir. */
import type { SeedContext } from "../../management";
import { createPasswordUser } from "../../queries/tenant/auth.gen";

export const DEMO_PASSWORD = "demo-password";

export default async function demoLogin({ tenantId, query }: SeedContext): Promise<void> {
  const { hashPassword } = await import("better-auth/crypto");
  await query(createPasswordUser, ["Demo", `demo@${tenantId}.example.com`, await hashPassword(DEMO_PASSWORD)]);
}
