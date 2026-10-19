# Alt proje B: Neon ve Supabase desteği

Tarih: 2026-10-03 · Üst belge: [`2026-10-03-db-roadmap-design.md`](2026-10-03-db-roadmap-design.md) · Önceki: [`2026-10-03-connection-topology-design.md`](2026-10-03-connection-topology-design.md) (A, `feat/connection-topology`) · Durum: tasarım sahibi tarafından bölüm bölüm onaylandı, yazılı spec incelemede.

## Amaç

`@repo/db`'yi iki yönetilen sağlayıcıda (Neon, Supabase) üç düzeyde kullanılabilir yapmak:

1. **Uyumluluk (B1):** yönetilen Postgres üzerinde runtime, `bootstrap`, advisory lock ve `doctor` davranışını gerçek hesaplarla ölçmek; ölçüleni belgelemek, yetersiz kalan yeri düzeltmek.
2. **Neon serverless sürücüsü (B2):** WebSocket `Pool` ile `@repo/db/drivers/neon` (Workers/edge).
3. **Sağlayıcı araçları (B3):** Neon branching ile tenant'ın geçmiş anının export'u, `migrate-all` öncesi güvenlik noktası, migrasyon denemesi için staging kopyası; Supabase için PITR zaman damgası kaydı.

Başarı ölçütü: Neon ve Supabase ücretsiz hesaplarında `verify:provider` çıktısı `docs/providers.md`'deki matrisi doldurur; runtime `neonDriver` ile Workers paketine girer; üç araç gerçek Neon projesinde çalışır; hiçbir yeni ortam değişkeni eklenmez.

## Kapsam

**Kapsamda:** doğrulama betiği, `docs/providers.md`, doğrulamanın gösterdiği düzeltmeler, `neonDriver`, `createPgDriver` ortak fabrikası, üç Neon aracı (CLI + tools), Supabase PITR kaydı, testler, belgeler.

**Kapsam dışı:**

- Neon HTTP `neon()` fonksiyonu: etkileşimli oturum ve ayrılmış bağlantı sunmaz, yalnızca toplu `transaction()` yapar. Motor her deyim için `BEGIN; SET LOCAL …` ister, uyumsuzdur.
- Neon sürücüsüyle yönetim (advisory lock) işi. Yönetim yine pg/postgres/bun sürücüsü ve doğrudan veya session-pooled URL ile çalışır.
- Supabase için tenant bazında geri yükleme aracı (PITR tüm projeyi yerinde ve kesintiyle geri yükler) ve Supabase API çağrısı.
- Hyperdrive'ın gerçek hesapla doğrulanması (A'da `pooler: "assumed"` yolu belgelidir).
- Branch silme: araçlar hiçbir branch silmez (geri alınamaz).
- Replica kullanımı (C), SQL genişletmeleri (E), ölçek (D), kullanıcı kılavuzu (F).

## Kararlar

| Karar | Gerekçe |
|---|---|
| Doğrulamayı sahip ücretsiz hesaplarla çalıştırır, çıktıyı yapıştırır; şifre sohbete girmez | Sağlayıcı davranışı varsayılmaz, ölçülür. |
| Neon ve Supabase eşit öncelik | Sahip kararı: genel yetenek. |
| **Yeni ortam değişkeni yok** | Sahip kararı. Doğrulama yönetim URL'lerini mevcut `DATABASE_URLS`'ten, runtime URL'lerini `doctor --pooled-urls` gibi gizli girişten alır. |
| Sağlayıcı URL'den tahmin edilmez; bağlantı türü davranışla anlaşılır | A'nın sınaması ve `assertDirect` zaten davranışa bakar. Sağlayıcı araçlarında sağlayıcıyı komut adı belirler. |
| Neon API anahtarı gizli girdiyle alınır (`--pgbouncer-url` gibi), argv ve env'e girmez | Sır sızıntısı yok, yeni env yok. |
| Neon projesi API'den bulunur: projelerin endpoint listesi çekilir, her düğümün host'u eşleştirilir; eşleşme yoksa hata | Düğümler farklı projelerde olabilir; proje kimliği env gerektirmez. |
| Geçmişe dönüş aracı **export klasörü** üretir; canlı veriye dokunmaz, yeni id'ye kurma yok | `copySchema` şemayı aynı adla kopyalar, `restoreTenant` yalnızca eksik tenant'ı yedekteki aynı id ile kurar (`TENANT_EXISTS`); yeni id desteği çekirdek aracı değiştirirdi. Uygulamak mevcut `restore` ile olur. Sahip kararı (kod okunduktan sonra). |
| `neonDriver` `cancel` tanımlamaz | Neon istemcisinin `cancel`'ı yeni TCP bağlantısı açar, Workers'ta TCP yok. `Reserved.cancel?` zaten isteğe bağlı; deadline sonrası bağlantı atılır (Bun SQL ile aynı sözleşme). Sunucu tarafı kesme garantisi B1'de ölçülür. |
| `neonDriver` ayrı motor değil, `pg.ts` ile ortak fabrikadan türer | Tekrar yok; `pgDriver` ve `neonDriver` aynı `createPgDriver(PoolClass)` fabrikasının iki çağrısı. |

## Tasarım

### B1. Uyumluluk ve doğrulama

**Betik** `src/__tests__/provider/verify.ts`, çalıştırma `bun run verify:provider`. Girdisi yalnızca mevcut `DATABASE_URLS` (yönetim: direct veya session-pooled) ve gizli girişle sorulan runtime URL'leridir (transaction pooler); sürücü `--driver bun|postgres|pg` ile seçilir. Bağlantı denetimlerini (`pooled_runtime`, `direct_connection`, `runtime_timeouts`) yeniden yazmaz; `doctor --pooled-urls` bunları zaten ölçer. Betik yalnızca doctor'ın ölçmediği şeyleri ölçer:

- A'nın `usesTransactionPooler` sonucu iki URL türünde (runtime URL'si `true`, yönetim URL'si `false` beklenir; sapma kayıt altına alınır);
- `ALTER DATABASE … SET` turu: mevcut değeri `pg_db_role_setting`'ten oku, geçici bir değer ayarla, **yeni oturumda** göründüğünü doğrula (pooler üzerinden de), özgün değeri geri yaz;
- `bootstrap`'ın gerektirdiği extension ve şema yetkileri (`has_database_privilege`, `CREATE EXTENSION` denemesi, yalnızca yetki yoksa hata metni kaydedilir);
- ayrılmış bağlantıda deadline: uzun bir `pg_sleep` deadline sonrası atılır, sunucudaki backend'in süresi içinde bittiği doğrulanır (B2'nin `cancel`'sız garantisinin ölçüsü).

Çıktı yalnızca JSON'dur: URL, host ve şifre içermez. Betik **yalnızca geçici/ücretsiz test veritabanlarında** çalıştırılmak üzere yazılır; özgün ayarı geri yazar, başka veriye dokunmaz.

**`docs/providers.md`**: URL türü → rol matrisi (Neon direct, Neon `-pooler`, Supabase direct, Supabase Supavisor session :5432, transaction :6543, Supabase PgBouncer :6543; Hyperdrive için belgelenmiş `assumed` yolu), her satırda doğrulama tarihi ve durumu (`verified` / `documented, not verified`).

**Karar tablosu** (sonuca göre kod değişir, yalnızca ölçülen sapma düzeltilir):

| Ölçüm | Sonuç | Eylem |
|---|---|---|
| Gerçek pooler'da sınama `false` | yanlış negatif | O sağlayıcı için `pooler: "assumed"` önerisi belgelenir; sınama iyileştirilebilirse plan'da ayrı görev. |
| `ALTER DATABASE … SET` reddedilir | yetki yok | `bootstrap` bunu `PROVIDER_PRIVILEGE` olarak, sağlayıcı yetkisini adlandıran mesajla verir. Doğrulama göstermezse kod eklenmez. |
| Supabase direct IPv6'da bağlanamaz | ağ | `DATABASE_UNAVAILABLE` (A'da var); belgede yönetim URL'si olarak session pooler önerilir. |
| Pooler üzerinden deadline sonrası backend sürer | sunucu iptali yok | B2'de `neonDriver` belgesine sınır yazılır. |

### B2. Neon serverless sürücüsü

- `src/core/drivers/pg.ts`'teki `connection()` ve `reserve()` mantığı `createPgDriver(PoolClass)` fabrikasına çıkarılır; `pgDriver = createPgDriver(pg.Pool)`. `cancel`, fabrikaya verilen bir seçenekle yalnızca `pg` için tanımlanır.
- Yeni `src/core/drivers/neon.ts`: `neonDriver = createPgDriver(Pool from "@neondatabase/serverless")`, `cancel` yok. Paket `pg` gibi isteğe bağlı peer bağımlılıktır; `package.json` `exports` zaten `./drivers/*`'ı karşılar, `build` betiğine giriş ve `--external @neondatabase/serverless` eklenir.
- Yalnızca runtime sürücüsüdür. Yönetim motoru sürücüyü fabrika başına aldığı için bu bir kısıt değil, belge notudur.
- Ömür: Neon `Pool`'u istek içinde açılıp kapanır (`poolMax: 1`, istek sonunda kapat); bu zaten Workers modelidir.
- WebSocket: Bun ve Node ≥ 22'de global `WebSocket`; ek paket yok. Bu B1/B2 doğrulamasında Bun'da denenir.
- Tür ayrıştırıcıları: `pg.ts`'teki `types` geçersiz kılmaları (date, interval) Neon `Pool`'unda da uygulanır; Neon `Pool` bu seçeneği kabul etmezse istemci başına uygulanır (B2 plan'ı gerçek paketle doğrular).
- Workers paketleme: `build:workers` fixture'ı `neonDriver`'ı da kapsar.

### B3. Sağlayıcı araçları

Üçü de `fetch` ile Neon API'sini çağırır; bağımlılık eklenmez. Kodu `src/core/tools/neon.ts`. Anahtar gizli girdiyle alınır. API yol ve gövde ayrıntıları (branch oluşturma, `parent_timestamp`, endpoint listesi, bağlantı URI'si) B3 plan'ında güncel belgeyle ve gerçek çağrıyla doğrulanır; spec bunları varsaymaz.

**Proje çözümü:** projelerin endpoint listesi çekilir, her düğümün host'u listedeki `host` ile eşleştirilir. Eşleşmeyen düğüm için araç başlamadan hata verir. Aynı kaynak branch'e düşen düğümler tek branch ile örtülür (branch bir veritabanının tüm şemalarını, yani tüm tenant'larını kapsar).

**1. `neon export-tenant <tenant> <dir> --at <zaman>` (tek tenant'ın geçmiş anı).**
1. Her kaynak branch'ten (tüm düğümler, sıra korunur) `parent_timestamp` ile geçici branch açılır; `platform` kayıtları da o ana döner.
2. Branch bağlantı bilgileri bellekte tutulur (yazdırılmaz, günlüğe girmez); bunlarla geçici bir `Management` kurulur.
3. Mevcut `exportTenant`, tenant'ı `<dir>`'e (`tenant.json` + tablo dosyaları) yazar. Canlı veriye hiçbir yazma olmaz.
4. Geçici branch'ler silinmez (silmek kullanıcıdadır). Sınır, planın geçmiş saklama süresidir; Neon'un hatası aynen gösterilir.
5. Uygulamak mevcut `restore <tenant> <dir>` ile olur; `TENANT_EXISTS` koruması aynen geçerlidir (tenant'ın önce eksik olması gerekir).

**2. `migrate-all --safety-point neon|supabase` (güvenlik noktası).** Sağlayıcı açıkça yazılır.
- `neon`: her kaynak branch için o anki başlangıçtan `pre-migrate-<UTC zaman>` branch'i açılır. **Hepsi açılmadan migrasyon başlamaz**; biri başarısız olursa `migrate-all` hiç çalışmaz.
- `supabase`: yalnızca UTC zaman damgası kaydedilir ve `restore-pitr` komutu yazdırılır (`recovery_time_target_unix` ile). API çağrısı yapılmaz, anahtar istenmez.

**3. `neon stage-copy` (migrasyon denemesi için staging).** Her kaynak branch'ten (güvenlik noktasıyla aynı çekirdek) bir branch açılır; yalnızca branch id'si ve host yazdırılır, şifreli URI yazdırılmaz (şifreyi konsoldan alırsınız).

Ortak: branch limiti dolarsa Neon hatası olduğu gibi gösterilir. `docs/providers.md` Supabase'in tenant bazında geri yükleme sunmadığını ve PITR'ın tüm projeyi yerinde, kesintiyle geri yüklediğini söyler.

### Hata ve güvenlik

- Yeni hata kodları: `PROVIDER_API_ERROR` (Neon API durum kodu ve Neon'un mesajıyla, ağ hatası dahil) ve `PROVIDER_NODE_NOT_FOUND` (bir düğümün host'u hesaptaki hiçbir endpoint'le eşleşmedi; yalnızca düğüm kimlikleri yazılır). `PROVIDER_PRIVILEGE` yalnızca B1 doğrulaması gerektirirse eklenir. Anahtar, URI ve şifre hiçbir mesajda yer almaz. Neon aracı kimliği bir organizasyona bağlıysa isteğe bağlı `--org <id>` (gizli değil) projeleri o organizasyonda listeler.
- API anahtarı yalnızca bellekte tutulur; argv, env, dosya ve günlükte bulunmaz.
- Yeni ortam değişkeni yok: tek değişken ilkesi (`DATABASE_URLS`, A'nın isteğe bağlı `DATABASE_REPLICA_URLS`) bozulmaz.

### Test

- **Birim:** `createPgDriver` fabrikası sahte `Pool` ile (`neonDriver`'da `cancel` tanımsız, `pgDriver`'da tanımlı); Neon API istemcisi sahte `fetch` ile (endpoint eşleşmesi, eşleşmeme hatası, branch gövdesi, hata eşleme, sırların sızmaması); `migrate-all --safety-point` sırası (tüm branch'ler açılmadan migrasyon başlamaz); doğrulama betiğinin çıktı şeması ve URL içermemesi.
- **Entegrasyon (yerel compose):** doğrulama betiği yerel PgBouncer/Postgres'e karşı beklenen sonucu verir; mevcut 111 test üç sürücüde yeşil kalır (`createPgDriver` refaktörü).
- **Gerçek sağlayıcı (sahip koşusu):** `verify:provider` ve üç araç ücretsiz Neon/Supabase hesaplarında; sonuçlar `docs/providers.md`'ye işlenir. Bu koşu CI'ya girmez.

## Planlar

Bir spec, sırayla üç plan:

1. **B1** uyumluluk ve doğrulama: betik, yerel doğrulama, sahip koşusu (çıktı yapıştırma), `docs/providers.md`, karar tablosuna bağlı düzeltmeler.
2. **B2** `neonDriver`: fabrika çıkarma, sürücü, build girişi, Workers fixture, belge.
3. **B3** üç araç ve Supabase PITR kaydı.

B2 ve B3, B1'in ölçtüğü gerçeklere (iptal davranışı, yetkiler) dayandığı için B1 önce gelir.

## Doğrulanmamış varsayımlar (gerçek hesapla kapanır)

- `ALTER DATABASE … SET` ve extension yetkisi Neon ve Supabase `postgres` rolünde.
- A'nın sınamasının Supavisor, Neon pooler ve Hyperdrive'ı algılaması.
- Neon `Pool`'unun `types` seçeneğini kabul etmesi ve Bun'da global `WebSocket` ile çalışması.
- Neon API'nin endpoint listesinde düğüm host'unu eşleştirebilecek `host` alanı ve tenant branch'inin bağlantı bilgisini döndürme biçimi.
