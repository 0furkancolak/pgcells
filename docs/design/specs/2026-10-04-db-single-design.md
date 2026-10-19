# `db-multi` yeniden adı ve tenant'sız `db-single` paketi

Tarih: 2026-10-04 · Durum: uygulandı (G1–G3) · Alt proje G (yol haritası: [`2026-10-03-db-roadmap-design.md`](2026-10-03-db-roadmap-design.md)).

## Amaç

Çok-tenant paketi (`packages/db`, `@repo/db`) `db-multi` adını alır. Aynı çekirdeği tenant'sız, **tek DB ve tek schema** ile kullanmak isteyenler (klasik yönetilen Postgres: Neon, Supabase, RDS) için ikinci bir paket, `db-single`, mevcut paketten **kopyalanarak** ve tenant kavramları silinerek oluşturulur.

## Değişmeyen kısıtlar

Yol haritasındaki kısıtlar geçerlidir: `search_path` yok; yeni ortam değişkeni yok; daha az, daha anlaşılır kod; uyarılar zorunlu denetime dönüşür; çalışma anında SQL ayrıştırılmaz (`pgsql-ast-parser` yalnızca derleme zamanı); yorumlar Türkçe, hata mesajları İngilizce ve URL/host/kullanıcı/parola içermez; push/PR/merge yalnızca istenirse.

## Kararlar (sahip)

| Konu | Karar |
|---|---|
| Yeniden ad | **Klasör + paket adı:** `packages/db` → `packages/db-multi`, `@repo/db` → `@repo/db-multi`. `git mv` ile geçmiş korunur. |
| Yeni paket | `packages/db-single`, `@repo/db-single` (adı ben verdim: tenant'sız tek DB'yi söyler, `db-multi` ile eşleşir). |
| Kapsam | Çekirdeğe ek olarak dördü de: replica okuma (C), Neon/Supabase (B), yedek ve doctor araçları, Better Auth adaptörü. |
| Schema | `createDb({ schema })` seçeneği (env değil); verilmezse `public`. Derleyici tabloyu her zaman `"<schema>"."tablo"` niteler. |
| Kod paylaşımı | **Tam kopya.** Ortak paket yok; `db-single` `db-multi`'ye bağımlı değildir, tek başına kopyalanabilir. Bedeli: derleyici/sürücü düzeltmeleri iki yerde yapılır. |

## `db-multi`: yalnızca yeniden ad

- `git mv packages/db packages/db-multi`; `package.json` adı `@repo/db-multi`.
- Kök `package.json`'daki `db:*` betikleri `--cwd packages/db-multi`; `README`, `docs/` ve paket içi mutlak yollar güncellenir.
- Geçmiş spec ve planlar tarihî kayıttır: içlerindeki `packages/db` yolları **değiştirilmez**.
- Davranış değişmez. Kabul: yeniden adın hemen ardından birim (367) ve tam entegrasyon (147) paketleri değişmeden geçer.
- jamaster-api'nin `@repo/db` importları bu repoda yoktur; yalnızca belgede (`docs/jamaster-api.md`) tek seferlik ad değişikliği olarak not düşülür.

## `db-single`

### Kopya tabanı ve silinenler

Taban: `db-multi`'nin yeniden adlandırılmış, E sonrası hâli (`feat/advanced-sql` ucu). Önce silinir, sonra sadeleştirilir.

- **Kalan çekirdek:** üç sürücü + `neon`; SQL derleyici/codegen/casing/tables/parser-gaps (E'nin tamamı dahil); pooler zorunluluğu ve probu; deadline/timeout; telemetri; replica okuma (C); Neon/Supabase doğrulama ve araçları (B); yedek/restore/export/doctor/pull/replicas araçları; Better Auth adaptörü.
- **Silinenler:** `tenants/` (placement, nodes, fields, model), `operations/provision`, platform ve node kapsamları, `withTenant`/`withNode`/`withPlatform`, `createDbScope`, taşıma/kopyalama/adopt/platform-merge/platform-move/tenancy araçları, `import-users`, ve jamaster'a özgü legacy dump araçları (`fetch-dump`, `sql-dump`, `app-migration`).
- **Env:** yalnızca `DATABASE_URLS`; bu pakette tek URL içerir. Replica için mevcut isteğe bağlı `DATABASE_REPLICA_URLS` korunur (tek DB'ye karşılık gelen tek girdi).

### Çalışma anı API'si

Tek hedef DB olduğundan "hedef her çağrıda açık" ilkesi kendiliğinden sağlanır; kök `db.query` güvenlidir.

- `createDb({ schema?, driver, … })` → `query(prepared, values?)`, `transaction(fn)`, `read.query(prepared, values?)` (replica; yalnızca `readOnly` sorgular), `replicas()`, `ready()`, `close()`.
- Replica politikaları (lag eşiği, primary'ye düşme ya da `REPLICA_UNAVAILABLE`) ve istek kapsamında yazıdan sonra okumanın primary'de kalması C'deki gibidir.
- `@repo/db-single/middleware`: aynı Hono tarzı `(c, next)` imzası; `db`'yi istek bağlamına koyar. Tenant çözümleme ve placement önbelleği yoktur. Cron/kuyruk/Workers'ta `createDb` doğrudan kullanılır.

### SQL ve dosya düzeni

- Sorgu kapsamı üçten (`tenant|node|platform`) tek `app` kapsamına iner.
- Dosyalar düzleşir: `src/queries/*.sql`, `src/migrations/*.sql`, `src/seeds/*.sql`, `src/tables/*.gen.ts`.
- Derleyici schema'yı bağlama anında NUL işaretçisiyle verir; schema `createDb`'de bir kez bağlanır. `search_path` kullanılmaz.

### Yönetim tabloları

Ayrı `platform` schema'sı yoktur. Migration geçmişi uygulama schema'sında tek tabloda (`_migrations`) tutulur; migration'lar `.sql` dosyalarıdır (`--up`/`--down` bölümleri, dosya adı UTC `yyyyMMddHHmmss`). Tek advisory lock aynı anda iki `migrate`'i önler. `db-multi`'deki "DB kimliği" (yanlış DB'ye bağlanmaya karşı koruma) tek DB'de gereksizdir ve yoktur.

### CLI

Kalan: `migrate`, `migrate-down`, `migration-status`, `seed`, `pull`, `codegen`, `doctor`, `backup`/`restore`/`export`, `replicas`, `neon`, `verify:provider`. Kalkan: `provision`, `move`, `copy`, `adopt`, `migrate-all`, tenant komutları. Paket betikleri: `db:migrate`, `db:seed`, `db:generate`, `db:pull`, `db:codegen`.

### Better Auth

Kimlik tabloları uygulama schema'sında, sabit `cookiePrefix`; Kysely `WithSchemaPlugin` aynıdır.

## Sınırlar (kapsam dışı)

- `db-multi` ↔ `db-single` arasında otomatik geçiş aracı.
- Ortak bir `@repo/db-sql` paketi (sapma riski kabul edildi; tam kopya seçildi).
- jamaster-api tarafındaki import değişiklikleri.
- `db-single` için ölçek/kapasite çalışmaları (D) ve kılavuz (F): ayrı alt projelerdir, `db-single`'ı da kapsayıp kapsamayacakları kendi tasarım turlarında netleşir.

## Testler

- Kopyalanan birim testlerinden tenant'a ait olanlar silinir, kalanlar tek schema'ya uyarlanır; E'nin SQL testleri (`sql-advanced`, `sql-extensions` …) olduğu gibi taşınır.
- Entegrasyon: `db-single/compose.yaml` jamaster yığınıyla (5540/5541/5543) ve `db-multi`'nin yığınıyla çakışmayan portlar kullanır; proje adı `dbsingle`; çalıştırmadan önce portların boş olduğu doğrulanır, doluysa durulur. Dört sürücüde (bun, postgres, pg, neon) tam paket.
- Kabul: (1) `db-multi` davranışı değişmez; (2) `db-single` birim ve entegrasyon testleri dört sürücüde geçer; (3) `grep -ri "tenant\|placement\|platform"` yalnızca belgede nedeni açıklayan notlarda eşleşir; (4) `db-single`'ın `@repo/db-multi`'ye bağımlılığı yoktur; (5) kaynak satır sayısı `db-multi` ile karşılaştırılıp raporlanır (hedef sayısı sözü yok; ulaşılmazsa neden yazılır).

## Plan bölümü

Üç plan, dal `feat/db-single` (`feat/advanced-sql` ucundan), her görev bir yerel commit:

- **G1 — yeniden ad:** `db-multi`; kabul: birim ve entegrasyon değişmeden geçer.
- **G2 — `db-single` çekirdeği:** kopya, silme, tek `app` kapsamı, `createDb`, `_migrations`, derleyici/sürücü kopyası.
- **G3 — araçlar, auth, belge, entegrasyon:** kalan araçların tek DB'ye uyarlanması, Better Auth, `README` ve `docs/`, `compose.yaml`, dört sürücüde entegrasyon.

## Yazım sırasında netleşecek ayrıntılar

Bunlar bilinçli olarak plan aşamasına bırakıldı çünkü kopya silindikçe gerçek bağımlılık ölçülür: hangi `tools/` dosyalarının tenant import'u gerçekten taşıdığı (örn. `doctor.ts`, `backup.ts`), `runtime.ts`/`database.ts` içindeki `node` kavramının sürücü havuzu dışında nerede kullanıldığı, `_migrations` tablosunun mevcut migration kayıt biçiminden (`runner.ts`/`registry.ts`) nasıl türetileceği.
