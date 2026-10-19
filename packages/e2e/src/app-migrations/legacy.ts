/** fixtures/legacy.sql (pg_dump backup of the old application) → tenant `users` table. Filled in by hand from the `dump scaffold` skeleton.
 * `uyeler` become Better Auth users with their password hash (`users` step: the mapping is kept in `user_imports`); `ogrenciler` are old
 * records without an email, written directly to `users` with a deterministic ID and an email derived from the old ID. `dersler` and
 * `kayitlar` have no counterpart in this application and are not migrated.
 *
 *   bun run tools app-migrate <tenant> /work/legacy --file /repo/packages/e2e/src/app-migrations/legacy.ts [--dry-run]
 */
import { defineAppMigration } from "@0furkancolak/pgcells/tools";

type Rows = {
  uyeler: { id: number; email: string | null; ad_soyad: string | null; sifre: string | null };
  ogrenciler: { id: number; ad: string };
};

export default defineAppMigration<Rows>({
  source: "legacy",
  steps: [
    { table: "uyeler", users: (row) => (row.email ? { externalId: row.id, email: row.email, name: row.ad_soyad, passwordHash: row.sifre } : null) },
    { table: "ogrenciler", into: "users", map: (row, ctx) => ({ id: ctx.uuid("ogrenciler", row.id), name: row.ad, email: `ogrenci-${row.id}@eski.example` }) },
  ],
});
