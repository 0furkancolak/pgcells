# pgcells: açık kaynak, bölge-farkında tenant veri katmanı

Tarih: 2026-10-18 · Durum: **onay bekliyor** · Üst belge: [`2026-10-03-db-roadmap-design.md`](2026-10-03-db-roadmap-design.md)

Bu belge sahibin şu isteğini tasarıma çevirir: repo açık kaynak yapılacak, paketlenecek ve yeniden adlandırılacak; mimari çizilip README'ye konacak; bağlantı yönetimi ve PgBouncer birinci sınıf konu olacak; ilişkisel veritabanının dağıtık, bölgelere ayrılmış sistemlerde nasıl kullanılacağı bu işin merkezinde olacak; ileride bir Go sürümü yapılacak. Sahip "bunu sen belirle" dediği için aşağıdaki kararların çoğu **benim kararımdır** ve öyle işaretlidir; itiraz edilen karar ilgili planı değiştirir, yönü değiştirmez.

## 1. Amaç ve neden

Elimizdeki şey bugün bir "jamaster-api için veri katmanı": tenant başına schema, tenant'ın yerini tutan platform DB'si, derleme zamanında derlenen SQL, transaction-mode pooler zorunluluğu, replica okuması, taşıma/yedek araçları. Mühendislik olarak olgun (508 dosya, geniş birim/entegrasyon/e2e testi), ama üç şey onu başkasının kullanabileceği bir proje yapmıyor:

1. **Bölge kavramı yok.** Bölgelere ayrılmış bir sistemde "bu tenant AB'de yaşasın, verisi oradan çıkmasın" denemiyor ([mimari inceleme](#ek-a-mimari-incelemenin-özeti), bulgu 1, 4, 5).
2. **Taşıma ve kesinti güvenceleri operatör disiplinine dayanıyor.** Taşıma sonrası eski DB'ye yazan bayat bir süreç sessizce veri kaybettirebilir (bulgu 2).
3. **Paket değil, monorepo içi kaynak.** `private`, `@repo/*` kapsamı, ham TS dışa aktarımı, LICENSE yok, jamaster'a özgü şema/araç/belgeler içinde, belgeler ve kod yorumları Türkçe.

Hedef: dağıtık, çok bölgeli SaaS sistemlerinde PostgreSQL'i **doğru** kullanmanın referans uygulaması olmak: tenant'ı bir hücreye (bölgedeki bir PostgreSQL kümesine) yerleştirmek, bağlantıları pooler'larla sınırlı tutmak, taşımayı güvenli yapmak. Aynı sözleşmeyi bir gün Go'da da sunmak.

## 2. Kimler için (benim kararım)

"Yüzlerce ile birkaç bin arası tenant'ı olan, birden çok bölgede çalışan (veya çalışacak) bir SaaS ekibi; veri ikameti (KVKK/GDPR) ve noisy-neighbor izolasyonu istiyor, ama tenant başına veritabanı işletmeyi göze alamıyor, paylaşılan tablo + RLS'in taşıma ve yedek kısıtlarından kaçınmak istiyor." PostgreSQL (yönetilen veya kendi kurulumu), Bun/Node/Workers.

Hedef kitle **değil**: tek tablo takımlı klasik uygulama (bunun için `db-single` var, ama o ikincil), dağıtık SQL (CockroachDB/Spanner/Yugabyte) arayanlar, tenant başına milyonlarca küçük tenant (schema-per-tenant bunun için yanlış araç; kılavuz bunu açıkça söyler).

## 3. Hedefler, hedef-dışılar, anti-hedefler

**Hedefler**
- G1. Bölge-farkında yerleşim: node'a `region` ve etiketler, tenant'a `home_region`, yer seçiminde bölge/etiket süzgeci.
- G2. Güvenli taşıma: fencing (bayat yazıcı sessizce yazamaz), ardından kesintisiz (mantıksal replikasyonlu) taşıma.
- G3. Bağlantı yönetimi birinci sınıf: bağlantı bütçesi hesabı ve denetimi, PgBouncer üretim şablonları, kuyruk/adillik, failover ve boşaltma davranışı, ölçülmüş kılavuz.
- G4. Kontrol düzlemi (`db0`) tek hata noktası olmaktan çıkar: stale-if-error (fencing sonrası), bölgesel dizin replikası.
- G5. Açık kaynak: ad, lisans, İngilizce belge, yayınlanabilir (derlenmiş) paketler, CI/yayın hattı, katkı ve güvenlik süreçleri.
- G6. Mimarinin çizimli, doğru ve güncel anlatımı (README + kılavuzlar).
- ~~G7. Go sürümü için sözleşme (şema, kilit anahtarları, hata kodları, uyum testleri) TS'den çıkarılır; Go çalışma zamanı bunun üstüne kurulur.~~ **Yapılmayacak** (sahip kararı, 2026-10-19).

**Hedef-dışı**
- Aynı tenant için aktif-aktif çok bölgeli yazma (tek yazıcı ilkesi bilerek korunur).
- Tenantlar arası sorgu/join, global sequence, bölgeler arası senkron yazma.
- Kendi pooler'ımızı yazmak (PgBouncer/Supavisor/PgCat kullanılır; paket onları **doğru** kullanmayı öğretir ve denetler).
- Go'da Better Auth karşılığı (auth JS ekosistemine ait; Go servisleri oturumu paylaşılan tablolardan/JWT'den doğrular).

**Anti-hedefler** (teknik olarak çalışsa bile başarısızlık sayılır)
- Çalışma anında SQL ayrıştırmak, `search_path` kullanmak, hedefi örtük yapmak (mevcut ilkeler aynen kalır).
- Yeni ortam değişkeni eklemek: bölge/etiket bilgisi `platform.nodes`'ta, uygulamanın kendi bölgesi tipli `createDatabase({ region })` seçeneğindedir.
- Sorgu başına gizli yeniden deneme.
- "Dağıtık" iddiasını belgeleyip doğrulamamak: her bölge/failover iddiası bir testle (Docker'da simüle) sınanır veya "doğrulanmadı" diye işaretlenir.

## 4. Kararlar

| # | Karar | Gerekçe | Durum |
|---|---|---|---|
| D1 | **Ad: `pgcells`** (GitHub: `pgcells`, npm: `pgcells`, kapsam `@pgcells/*`). Alternatifler: `tenantcell`, `cellpg` | Mimarinin özü "hücre" (bölgedeki PG kümesi); dilden bağımsız (Go'ya taşınır). 2026-10-18'de npm'de `pgcells`, `@pgcells/*`, `tenantcell`, `cellpg` boş; GitHub'da `pgcells`, `tenantcell`, `cellpg` kullanıcı/org adları boş (`tenantry` alınmış) | benim kararım |
| D2 | **Lisans: Apache-2.0** | Patent hibesi var; altyapı kütüphaneleri için yaygın. Bağımlılık lisansları CI'da denetlenir | benim kararım |
| D3 | **Belge dili: İngilizce kanonik**, `README.tr.md` Türkçe. Kod yorumları İngilizceye çevrilir; mevcut Türkçe belgeler çevrilince tek kaynak olur (çift bakım yok) | Açık kaynak için zorunlu; hata mesajları zaten İngilizce | benim kararım |
| D4 | **Paketler:** `@pgcells/multi` (şimdiki `db-multi`), `@pgcells/single` (`db-single`), `@pgcells/redis`. Auth bu sürümde alt yol olarak kalır (`@pgcells/multi/auth`) | Önceki "kopyala ve devam et" kararı geçerli; ayrılma en erken v0.5'te yeniden değerlendirilir | benim kararım (önceki sahip kararına uyar) |
| D5 | **Yayın biçimi:** derlenmiş ESM + `.d.ts`; migration/sorgu/seed SQL'i codegen ile TS dizgesine gömülür (`with { type: "text" }` yayına girmez). Çalışma ortamları: Bun ≥ 1.3.14, Node ≥ 22, Cloudflare Workers | Bugünkü ham TS ve Bun'a özgü SQL import'u Node/Workers tüketicilerini dışarıda bırakır | benim kararım |
| D6 | **Sürümleme:** Changesets, semver; `0.x` bölge ve bağlantı özellikleri bitene kadar, `1.0` bir üretim soak'undan (jamaster) sonra. npm provenance (GitHub OIDC) | | benim kararım |
| D7 | **Go: yapılmayacak** (sahip kararı, 2026-10-19). İlk karar: aynı repoda `go/` + paylaşılan `spec/` sözleşmesi, Go işi `0.3` sözleşme dondurmasından sonra | Kapsam dışı | **iptal** |
| D8 | **Bölge modeli:** hücre = node; `platform.nodes.region` + `labels jsonb`; `placements.home_region` node'dan türer; bölgeler arası taşıma `--allow-cross-region` ve açık bir ikamet politikası ister | Tek yazıcı + yerel okuma; ikamet ihlali varsayılan olarak imkânsız | benim kararım |
| D9 | **Fencing önce, kesintisiz taşıma sonra.** Cutover'da kaynak schema fiziksel olarak kilitlenir (yeniden adlandırma veya yetki geri alma) | En ucuz, en yüksek değerli güvence | benim kararım |
| D10 | **Dizin (`platform.*`) asgari veri tutar:** `tenant_id`, `region`, `database_id`, durum. Kişisel veri (ör. `owner_email`) tenant'ın kendi hücresine taşınır; dizin tenant sütunları uygulama alanı olarak kalabilir ama belge ve `doctor` ikamet uyarısı verir | İkamet: dizin tek bölgede olabilir, tenant verisi olmamalı | benim kararım |
| D11 | **Redis bölge başınadır** (placement önbelleği, oturum, kuyruk). Bölgeler arası Redis paylaşımı desteklenmez | İkamet ve gecikme | benim kararım |
| D12 | **Jamaster'a özgü araç ve belgeler** (`adopt`, `platform-merge`, `platform-move`, `import-users`, `app-migration`, `jamaster-*.md`, jamaster varsayılanlı yardımcılar) açık kaynak çekirdekten çıkar. **Migration ve seed dosyaları v0.1'de çekirdekte kalır:** jamaster biçimli `students/teachers` auth tabloları (`…_auth.sql`), panel auth platform migration'ı ve demo seed'i paketle gelen, uygulanmış dosyalardır; ledger özetleri nedeniyle çıkarmak veya bölmek mevcut kurulumlarda `MIGRATION_DRIFT`/`SEED_DRIFT` üretir (D14). Bunlar "örnek, kendi kurulumunuzda kullanmayın/silin" notuyla belgelenir; isteğe bağlı hâle getirilmeleri ileri bir migration ve D15 uyumluluk penceresiyle v0.2 sonrasında ele alınır | Genel amaçlı proje tek müşteriye bağlı olamaz; ama uygulanmış migration'ı bozmak daha kötüdür | **varsayılan; sahibin onayı gerekiyor** (bkz. §10) |

### 4a. Bağımsız okuyucu kontrolünden çıkan kararlar (hepsi benim kararım)

Belgeyi planlamadan önce bağımsız bir yazılım mühendisi okudu; sorduğu sorulardan cevabı sahibe bağlı olmayanları aşağıdaki gibi ben kapattım. Sahibe kalan tek şey §10'dadır.

| # | Soru | Karar |
|---|---|---|
| D13 | Fencing tam olarak neyi garanti eder? | Cutover tamamlandığında kaynak schema `tenant_x` adından `tenant_x__moved_<işlem-kısa-id>` adına **yeniden adlandırılır**. Garanti: cutover sonrası bayat yazıcı sessizce yazamaz, `undefined_table` (42P01) hatası alır. Yeniden adlandırma seçildi çünkü uygulama ve yönetim aynı kimlik bilgisini kullanır (`REVOKE` onu durdurmaz) ve sağlayıcıdan bağımsızdır. Cutover öncesi pencere mevcut `migrating` durumu + `placementCacheWaitMs` ile korunur. Sıcak yolda sorgu/transaction başına sürüm denetimi **yoktur** (gizli per-query iş ilkesi). Eski kopya incelenebilir kalır; geri taşıma yeni bir `move`'dur (ad serbest kaldığı için `TARGET_EXISTS` engeli de ortadan kalkar). `doctor` taşınmış kopyaları "tutulan kopya" olarak listeler; `adopt` onları yok sayar. |
| D14 | Kalıcı tanımlayıcılar | **Donmuştur:** advisory lock anahtar metinleri, ledger tablo adları (`_migrations`, `_seeds` …), `platform.*` sütun adları, hata kodları ve **paketle gelen uygulanmış migration/seed dosyalarının bayt içeriği**: ledger her dosyanın SHA-256 özetini saklar (`registry.ts`), içerik değişirse `MIGRATION_DRIFT`/`SEED_DRIFT` olur. Bu yüzden çeviri, bölme veya yeniden biçimlendirme bu dosyalara dokunmaz (içlerindeki Türkçe SQL yorumları kalır). Yeniden adlandırma yalnızca repo, npm paketi ve belge adlarını değiştirir; kalıcı hiçbir dizgeyi değiştirmez. Eski ve yeni kod yan yana çalışabilir. Jamaster'ın canlı olup olmadığına bakılmaksızın geçerlidir. |
| D15 | `v0.x` şema uyumluluğu | `platform.*` değişiklikleri yalnızca **eklemeli ileri migration**dır (`bootstrap` uygular); v0.1'den sonra geçmiş migration'lar birleştirilmez veya yeniden yazılmaz. Bir minör sürüm uyumluluk penceresi: N ve N+1 aynı `platform.*` ile çalışır. |
| D16 | `db0` bölgeler arası dayanıklılığı | Fiziksel standby (yönetilen sağlayıcının okuma replikası) bölge başına; mevcut `DATABASE_REPLICA_URLS` mekanizmasıyla `db0`'ın replikaları olarak tanımlanır. Dizin okumaları replikadan yapılabilir (yalnızca `active` kayıtlar; `active` olmayan veya bulunamayan primary'den doğrulanır). **Taşıma güvenliği için** `placementCacheWaitMs ≥ PLACEMENT_CACHE_MAX_MS + replicaMaxLagMs` zorunlu olur. Yazmalar (provision, move, node kaydı) yalnızca `db0` primary'ye gider; `db0` kapalıyken uzak bölge tenant açamaz/taşıyamaz (kabul). `db0` yük devri sağlayıcının işidir, paket otomatik terfi yazmaz. Workers'ta replika da bir URL'dir (Hyperdrive), standby'a doğrudan erişim gerekmez. Stale-if-error yalnızca fencing (D13) sonrası açılır. |
| D17 | Kesintisiz taşıma (F6) hedefleri | Başarı ölçütü: düz PostgreSQL 16, Docker'da, 50 GB'a kadar tenant, yazma duraklaması ≤ 5 sn. Önce bir spike (mantıksal replikasyon: `wal_level=logical`, DDL ve sequence çoğaltılmaz, birincil anahtarsız tabloda `REPLICA IDENTITY FULL`). Sağlayıcı matrisi (RDS, Cloud SQL, Neon, Supabase) belgelenmiş "destekleniyor / kısıtlı / desteklenmiyor" tablosudur; her satır doğrulama durumunu taşır. |
| D18 | İkamet politikası | Node'da `region` ve `residency_zone` (ör. `eu`); `placements.residency_zone` (boş = kısıtsız). `provision`, `restore`, `move`, `adopt` hedef node'un bölgesi tenant'ın bölgesine uymuyorsa `RESIDENCY_VIOLATION` ile reddeder; bu denetim aynı SQL işleminde yapılır. **Garanti kapsamı:** paket tenant verisini bölge dışına yerleştirmez/taşımaz. Dizin satırındaki uygulama alanlarını (`owner_email` gibi) ve yedeğin yazıldığı dizini denetleyemez; `doctor` uyarır, belge açıkça söyler. "İkamet ihlali imkânsız" iddiası yalnızca bu kapsam için yapılır. |
| D19 | Çalışma ortamı çıtası (v0.1) | Kütüphane çalışma zamanı: Bun, Node 22, Workers (`pg`/`postgres.js` sürücüsü); Workers için derleme + duman testi (Hyperdrive "doğrulanmadı" kalır). **Düzeltme (2026-10-18, F1 planı sırasında bulundu):** CLI, codegen, `fetch-dump` ve Bun sürücüsü Bun API'lerini (`Bun.file/write/spawn`, `Glob`, `bun:SQL`) kullanır; bu yüzden v0.1'de yönetim girişi, araçlar, CLI ve codegen **Bun ister** (belgede ve `engines`'te açık); Node'da çalışan CLI v0.2 işidir. Entegrasyon/e2e paketleri Bun'da tam, Node'da yalnızca duman; Workers'ta yalnızca duman. |
| D20 | Test çıtası (anti-hedef 4) | F3: compose'a toxiproxy (gecikme, bölünme, bağlantı sıfırlama) eklenir. F4: iki "bölge"li compose (toxiproxy ile bölgeler arası gecikme). Gerçek bölge gecikmesi ve yönetilen sağlayıcı yük devri "doğrulanmadı" etiketiyle kalır; etiket yeterlidir, ama etiketsiz iddia yoktur. |
| D21 | Yönlendirme sözleşmesi | Kütüphane `onWrongRegion` kancası + `regionGuard` ara katmanını (421 veya 307, seçenekle) sağlar; yönlendirici/vekil sağlamaz (kenar/DNS işi). `createDatabase({ region })` verilmezse tek-bölge kipi: denetim kapalı, davranış değişmez (geriye uyumlu, `db-single` etkilenmez). Node'larda bölge tanımlı ama uygulama `region` vermemişse `doctor` uyarır, hata değil. |
| D22 | Go bu planda | **İptal** (D7). `spec/` çıkarımı ve uyum fikstürleri de yapılmayacaktır | iptal |

## 5. Bölge-farkında mimari (özet)

Ayrıntı ve "bugün var / planlı" tablosu: [`docs/guides/regions.md`](../../guides/regions.md).

- **Hücre.** Bir bölgedeki bir PostgreSQL kümesi (primary + yerel replika'lar + bir DR replikası) ve önündeki pooler filosu. Bir tenant tam olarak bir hücrede yaşar; tek yazıcı.
- **Dizin (kontrol düzlemi).** `platform.*` (`db0`): tenant → hücre eşlemesi. Küçük, nadiren değişir, sıcak yolda **değildir** (süreç içi + bölgesel Redis önbelleği). Okunabilir bölgesel replikalar ve stale-if-error ile bölgeler arası kesintiye dayanır.
- **Yönlendirme.** Coğrafi DNS/kenar, `tenant.example.com` isteğini tenant'ın `home_region`'ındaki uygulamaya götürür. Yanlış bölgeye düşen istek için `onWrongRegion` kancası (yönlendir/vekille); varsayılan: hata (`WRONG_REGION`), sessizce bölgeler arası DB'ye gitmez.
- **Tutarlılık.** İstek içi: okuma-yazdığını-görür (var). İstekler arası, aynı bölge: replika gecikmesi kadar bayat (var) veya LSN belirteci ile nedensel okuma (planlı). Bölgeler arası: tenant tek bölgede olduğundan yok.
- **Hata kipleri.** `db0` kesintisi, hücre kesintisi, bölge kesintisi, pooler, Redis, bayat placement: her biri kılavuzda "bugün ne olur / hedef ne" tablosuyla.
- **Taşıma.** Fencing (G2) → kesintisiz taşıma (mantıksal replikasyon + kısa yazma duraklaması) → bölgeler arası taşıma politikası.

## 6. Bağlantı yönetimi ve PgBouncer (özet)

Ayrıntı: [`docs/guides/connections.md`](../../guides/connections.md). Bu proje için ürünün yarısı budur:

- **Bağlantı bütçesi** üç katmanda hesaplanır ve denetlenir: uygulama havuzları (`poolMax × örnek × DB`) ≤ pooler `max_client_conn`; pooler sunucu havuzları (`default_pool_size × pooler sayısı × (db,kullanıcı)`) + yönetim ≤ PostgreSQL `max_connections`. `doctor` bu bütçeyi (örnek sayısı verildiğinde) hesaplar ve aşımı hata sayar.
- **Topoloji kararı:** uygulamanın yakınında bölge başına PgBouncer filosu (L4 yük dengeleyici arkasında, her node için, PgBouncer tek iş parçacıklı olduğundan `so_reuseport` ile çok süreç); sidecar-başına-uygulama **önerilmez** (sunucu bağlantısı çarpılır).
- **Yasaklar** (transaction pooling): oturum düzeyi advisory lock, `LISTEN/NOTIFY`, oturum `SET`, geçici tablo, `WITH HOLD` imleç, isimli prepared statement (PgBouncer ≥ 1.21 `max_prepared_statements` ile istisna). Paket zaten çoğunu zorlar (`POOLER_REQUIRED`, `DIRECT_CONNECTION_REQUIRED`).
- **Timeout uyumu:** uygulama deadline'ı (`statementTimeoutMs + 1 sn`) ↔ PostgreSQL `statement_timeout` ↔ PgBouncer `query_wait_timeout`; üçü tek tabloda, önerilen ilişki ve doğrulayan e2e senaryosu.
- **Özellikler (planlı):** `tools pooler plan` (bütçe/ayar önerisi), `tools pooler generate` (`platform.nodes`'tan bölge başına `pgbouncer.ini`), `doctor connection_budget`, tenant başına eşzamanlılık sınırı (adillik), `db.stats()` havuz metrikleri, `close({ drain })` ile zarif boşaltma, failover sınıflandırması (`retryable(error)` yardımcısı; gizli yeniden deneme yok).

## 7. Açık kaynak paketleme (özet)

Ayrıntı: [`2026-10-18-oss-packaging-plan.md`](../plans/2026-10-18-oss-packaging-plan.md).

Yeniden adlandırma (`multi-tenant-example` → `pgcells`, `@repo/*` → `@pgcells/*`), LICENSE/NOTICE, jamaster ayrımı (D12), derleme hattı (D5), İngilizce çeviri (D3), `docs/design` → `docs/design`, tarih ve gizli bilgi denetimi (ön denetim: `.env` geçmişte hiç commit edilmemiş, gizli bilgi desenleri yok), CI'ya `npm pack` + temiz proje kurulum testi (Bun, Node, Workers), Changesets yayın hattı, SECURITY/CONTRIBUTING/CODE_OF_CONDUCT/şablonlar, README (çizimli).

## 8. Go sürümü: yapılmayacak

Sahip kararı (2026-10-19): Go sürümü kapsam dışıdır. [Go planı](../plans/2026-10-18-go-port-plan.md) tarihsel kayıt olarak kalır. `spec/` dizini ve uyum fikstürleri üretilmeyecektir; `platform.*` sözleşmesi (tablolar, kilit anahtarı metinleri, hata kodları) D14 uyarınca yine donmuş sayılır.

## 9. Çalışma sırası

[Ana yol haritası](../plans/2026-10-18-roadmap-remaining.md) fazları: **F0** kararlar ve hijyen → **F1** yeniden adlandırma ve paketleme (sonraki işlerin son adlarla inmesi için erken) → **F2** fencing ve kontrol düzlemi dayanıklılığı → **F3** bağlantı/PgBouncer özellikleri → **F4** bölge modeli → **F5** orijinal yol haritasının kalanı (kapasite modeli D, kılavuz F, sağlayıcı doğrulamaları) → **F6** kesintisiz taşıma ve DR → ~~**F7** Go~~ (iptal). Sürüm kapıları: `v0.1` (F0–F2: tek bölgede eksiksiz, yayınlanabilir), `v0.2` (F3), `v0.3` (F4), `v0.4` (F6), `v1.0` (soak).

## 10. Sahibe kalanlar

Yalnızca sahibin verebileceği, cevabı işi değiştiren sorular (varsayılanım parantezde):

1. **Jamaster'a özgü araç, belge ve seed'ler (D12)** açık kaynaktan çıksın mı? (Evet: özel bir `jamaster-api` ön ayar katmanına taşınır; jamaster yayınlanmış paketi + yerel ön ayarı tüketir. `students/teachers` tabloları v0.1'de çekirdekte kalır, çünkü migration bayt içeriği donmuştur.) Hayır derseniz araçlar `presets/jamaster/` altında genel bir "örnek ön ayar" olarak kalır ve paketleme işi küçülür.
2. **GitHub sahipliği:** repo `0furkancolak/pgcells` mi kalsın, yoksa `pgcells` organizasyonu mu açılsın? (Organizasyon; npm `@pgcells` kapsamı için de organizasyon gerekir.) Bu sizin hesaplarınızdaki bir işlemdir, ben yapamam.
3. **Güvenlik bildirim adresi** (SECURITY.md için e-posta). (GitHub private vulnerability reporting.)

Ayrıca bilgi olarak: jamaster'ın canlıda `platform.*` şemasını kullanıp kullanmadığını bilmiyorum. Cevabınız planı değiştirmez, çünkü kalıcı tanımlayıcılar her durumda donmuştur (D14); canlıysa yalnızca v0.1'den önce bir uyumluluk provası eklenir.

## Ek A: mimari incelemenin özeti

Bulgular (ayrıntı konuşmada): (1) bölge kavramı yok; (2) taşımada fencing yok, `placement_version` veri yoluna inmiyor; (3) taşıma çevrimdışı ve büyük tenant için ölçüm yok; (4) `db0` tek hata noktası ve tek bölge, önbellek TTL'i ≤ 25 sn; (5) replika seçimi bölge bilmiyor; (6) Redis/Hyperdrive/çok bölgeli gecikme doğrulanmamış. Plan dosyaları bu bulguları F2–F6'ya eşler.

## Ek B: ortaya çıkan, belgelenmemiş durum notları

- `docs/design/plans/*` içindeki 398 onay kutusunun hiçbiri işaretli değil; planların çoğu uygulanmış. F1'de planlar "uygulandı" olarak arşivlenir veya kutular düzeltilir.
- Kök README "paketler birbirine bağımlı değildir" der; `@repo/redis` `@repo/db-multi`'ye bağımlıdır (`workspace:*`). Düzeltilecek.
- Orijinal yol haritasının D (kapasite modeli) ve F (baştan sona kılavuz) alt projeleri teslim edilmedi; F5'e alındı.
