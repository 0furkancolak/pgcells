# Bölge modeli, fencing ve dayanıklılık planı

> **Uygulama notu (2026-10-19): R1–R12 uygulandı; plandan sapmalar:**
> - R1: `tools fence-legacy-moves` yazılmadı; eski kopyaları `doctor` (`unfenced_moved_copies`) bulur, düzeltme el ile `ALTER SCHEMA … RENAME` (komut `doctor` çıktısında).
> - R2: ihlal yalnızca `createManagement` anında `INVALID_CONFIG`; `unsafePlacementCacheWait` seçeneği geçici ortamlar için kapı.
> - R3: `fencing: true` bayrağı gerekmedi (fencing her zaman açık); dizin replikasından okuma `replicaOnUnavailable: "error"` politikasından bağımsızdır (dizin okuması küçük ve önbellekli); `staleIfErrorMs` yeni tipli seçenek.
> - R4–R6: `Placement` `residencyZone` ve `region` alanlarını taşır; `regionGuard` `RequestDb.placement()` üzerinden çalışır.
> - R7: replika yerelliği yalnızca **bölge** birimiyle; "aynı zon" kademesi yazılmadı.
> - R9: replika gecikmesi senaryosu iki bölgeli yığında tekrarlanmadı; tek bölgeli replika testleri (`replica.test.ts`) kapsar. Gecikme proxy ile simüle; gerçek ağ doğrulanmadı.
> - R10–R11: spike 113 MB ve 1,1 GB ile koşuldu (10–50 GB ölçülmedi). Algoritma plandan farklıdır: önce tablo kilidi, sonra heartbeat ile uygulama kanıtı, en son schema yeniden adlandırma (önce yeniden adlandırmak çoğaltmayı bozuyor). Sağlayıcı matrisi yalnız düz PostgreSQL için doğrulandı.
> - R12: `cell promote` yalnızca plan üretir; nedensel okuma `lastWriteToken()` + `{ after }`.

Tarih: 2026-10-18 · Tasarım: [`2026-10-18-pgcells-oss-regions-design.md`](../specs/2026-10-18-pgcells-oss-regions-design.md) D8–D10, D13, D16–D18, D20–D21 · Kılavuz: [`docs/guides/regions.md`](../../guides/regions.md) · Ana yol: [roadmap](2026-10-18-roadmap-remaining.md)

Kilometre taşı düzeyindedir; görev düzeyinde plan her faz onaylandığında yazılır. Hepsi **eklemeli ileri migration** (D15) ve **donmuş kalıcı tanımlayıcılar** (D14) kurallarına uyar. Yeni ortam değişkeni yok (D3 anti-hedef): bölge bilgisi `platform.nodes`'ta, uygulamanın bölgesi tipli seçenekte.

## R1 — Fencing (F2.1) · v0.1
- **Ne:** `cutover` adımından sonra, `completed`'tan önce yeni `fenced` fazı: kaynak DB'de `ALTER SCHEMA tenant_x RENAME TO tenant_x__moved_<kısa-işlem-id>`, tek transaction, `moves` kaydına yeni ad yazılır. `rollback-move` zaten cutover sonrası yasak; `resume-move` `fenced` fazını idempotent tamamlar (ad zaten yeniyse atla).
- **Dosyalar:** `core/tools/move.ts` (faz makinesi, `activate` öncesi), `core/tenants/model.ts` (schema adı yardımcıları), `core/tools/doctor.ts` (`retained_moved_copies` bilgi denetimi), `core/tools/adopt.ts` (taşınmış kopyaları yok say), `core/tools/backup.ts` (taşınmış kopyaları yedekleme dışı bırak), belge `operations.md`.
- **Testler (önce yaz):** birim: faz sırası ve idempotentlik; entegrasyon: (a) cutover sonrası eski DB'ye `tenant_x` ile yazan ham bağlantı `42P01` alır, (b) kaynak veri `__moved_` adında duruyor, (c) crash/resume her fazda, (d) geri taşıma (hedef = eski DB) `TARGET_EXISTS` vermez. e2e `move` senaryosuna "bayat yazıcı" adımı eklenir (placement önbelleği elle eski değere kilitlenmiş süreç).
- **Kabul:** yukarıdaki testler yeşil; `operations.md` "Kaynak schema otomatik silinmez" satırı güncel; `moves.phase` değer listesi belgeli.
- **Risk:** mevcut `completed` taşımalar yeniden adlandırılmamış kopya taşır → `doctor` bunları "yeniden adlandırılmamış eski kopya" diye uyarır, `tools fence-legacy-moves <id>` ile elle çalıştırılabilir (isteğe bağlı küçük araç).

## R2 — Taşıma/önbellek bayatlık invariantı (F2.2) · v0.1
- **Ne:** `managementSettings` ve `startMove` doğrulaması: `placementCacheWaitMs ≥ PLACEMENT_CACHE_MAX_MS + (dizin replikası yapılandırıldıysa replicaMaxLagMs)`. İhlal `INVALID_CONFIG`.
- **Kabul:** birim testi; `configuration.md` "Dikkat" bölümü formülü söyler.

## R3 — Dizin replikaları ve stale-if-error (F2.3–F2.4) · v0.1
- **Ne:** (a) `createPlatform(...).get` için `platformRead` yolu: db0 replikası varsa ve `replicaOnUnavailable` politikası izin veriyorsa `active` kayıt replikadan; replikada `active` olmayan/yok → primary'de doğrula. (b) Stale-if-error: `activePlacementCache` süresi dolmuş `active` kaydı, yalnızca dizin hatası `databaseUnavailable(error)` iken ve `staleIfErrorMs` (yeni seçenek, varsayılan **0 = kapalı**, üst sınır 300 000) içinde sunar; `migrating`/`maintenance` gören süreç stale kullanmaz; fencing (R1) olmadan seçenek `INVALID_CONFIG` verir (özellik bayrağı: `fencing: true` yalnızca R1 sonrası sürümlerde varsayılan).
- **Testler:** replika fixture'ı (`replica-fixture.ts`) ile entegrasyon; `db0` durdurma e2e senaryosu (yeni senaryo 12): warm tenant'lar `staleIfErrorMs` boyunca 200, sonra 503; provision/move `db0` olmadan başarısız (beklenen); `db0` dönünce toparlanma.
- **Kabul:** kılavuz `regions.md` tablo satırları "🔜 → ✅"; yeni seçenekler `configuration.md`'de; span `placement.stale` eklendi.

## R4 — Node bölge metadata'sı (F4) · v0.3
- **Migration (platform, eklemeli):** `ALTER TABLE nodes ADD COLUMN region text, ADD COLUMN residency_zone text, ADD COLUMN labels jsonb NOT NULL DEFAULT '{}'`; `placements ADD COLUMN residency_zone text`. Hepsi nullable/varsayılanlı: mevcut kurulumlar değişmeden çalışır.
- **CLI/API:** `tools database set db1 --region eu-west --zone eu --label tier=dedicated`; `databases` çıktısı bu alanları gösterir. URL'ler env'de kalır (D3).
- **Kabul:** migration `bootstrap` ile iki kez çalıştırılabilir; eski kod yeni şemada çalışır (uyumluluk penceresi testi: önceki sürümün entegrasyon testleri yeni şemaya karşı).

## R5 — Bölge/etiket süzgeçli yer seçimi ve ikamet (F4) · v0.3
- **Ne:** `CHOOSE_DATABASE` süzgeci: `--region`, `--zone`, `--label k=v` (hepsi isteğe bağlı); `placements.residency_zone` tenant oluşturulurken yazılır (verilmezse `nodes.residency_zone`'dan türer). `provision`, `restore`, `move`, `adopt` hedefi aynı transaction'da denetler → `RESIDENCY_VIOLATION`. `pin`: etiketli "dedicated" node'a yalnızca etiketi isteyen tenant yerleşir (`labels.dedicated=true` → otomatik seçimde atlanır).
- **Testler:** birim (SQL seçimi, kenar durumlar: bölgesiz node, bölge verilmemiş istek), entegrasyon (yarış: iki eşzamanlı `provision` farklı bölgelerde), `move --allow-cross-region` aynı zonda izinli, farklı zonda `RESIDENCY_VIOLATION`.
- **Kabul:** `errors.md`'ye `RESIDENCY_VIOLATION`; `tenants.md` yer seçimi bölümü güncel; "ihlal imkânsız" iddiası yalnızca D18 kapsamı için belgede.

## R6 — Uygulamanın bölgesi ve `regionGuard` (F4) · v0.3
- **Ne:** `createDatabase({ region })`; placement'ın node bölgesi uygulama bölgesinden farklıysa `onWrongRegion(placement)` kancası; `@pgcells/multi/middleware` içinde `regionGuard({ mode: "421" | "redirect", locate: (placement) => url })`. `region` yoksa davranış değişmez (D21).
- **Testler:** birim ara katman (421, 307, kanca, tek-bölge kipi), `doctor` uyarısı (bölgeli node + `region`'sız uygulama yapılandırması CLI'de `--app-region`).
- **Kabul:** `middleware-and-jobs.md` bölümü; `db-single` etkilenmez (tür testi).

## R7 — Replika yerelliği (F4) · v0.3
- **Ne:** `DATABASE_REPLICA_URLS` biçimi aynı kalır (URL'ler env'de). Replika bölgesi dizinde tutulur: yeni eklemeli tablo `platform.replicas(database_id, ordinal, region)`; `ordinal` URL'nin config sırasındaki 1 tabanlı numarasıdır (`db1#2` gibi, `doctor` çıktısındaki gibi), CLI: `tools replica set db1#2 --region eu-west`. Yönlendirici uygulama bölgesindeki sağlıklı replikaları tercih eder, yoksa aynı zon, yoksa `replicaOnUnavailable`.
- **Testler:** `replica-router.test.ts` genişler (tercih sırası, düşme sırası), iki bölgeli compose entegrasyonu.
- **Kabul:** `replicas.md` güncel; bölge karışımı yapılandırması `doctor`'da uyarı.

## R8 — Dizinde kişisel veri uyarısı (F4) · v0.3
- **Ne:** `doctor directory_pii`: `platform.tenants`'ta e-posta/telefon desenli sütun adları (ad temelli sezgisel) varsa uyarı; hata değil. Belge: uygulama alanı rehberi `tenants.md`.
- **Kabul:** birim test; uyarı metni "directory region holds this" der.

## R9 — İki bölgeli test ortamı (F4) · v0.3
- **Ne:** `compose.regions.yaml`: iki "bölge" (her biri bir PG hücresi + PgBouncer), `db0` ayrı; toxiproxy bölgeler arası gecikme/bölünme enjekte eder (D20). Senaryolar: yanlış bölge isteği, `db0` bölünmesi, replika gecikmesi, iki bölgede eşzamanlı provision.
- **Kabul:** CI işi `regions`; senaryo sonuçları `packages/e2e/results/` altında; belgelerde "gerçek ağ gecikmesi ⚠️ doğrulanmadı" etiketi kalır.

## R10 — Kesintisiz taşıma spike'ı (F6) · v0.4
- **Ne:** PG 16 Docker'da: snapshot + mantıksal replikasyon (publication yalnızca tenant schema tabloları), yakalama, kısa yazma duraklaması, sequence senkronu, doğrulama. Çıktı: spike raporu (süre/bellek/ duraklama, 1, 10, 50 GB), karar: devam / sınırlı.
- **Kabul:** D17 ölçütü (50 GB, duraklama ≤ 5 sn) karşılanıyor mu? Karşılanmıyorsa kapsam daraltılır.

## R11 — `move --online` ve sağlayıcı matrisi (F6) · v0.4
- **Ne:** R10 olumluysa `move --online` (aynı faz makinesi, `copying` yerine `replicating` + `cutover` kısa duraklama); `providers.md` matrisi (RDS, Cloud SQL, Neon, Supabase: `wal_level`, rol yetkisi, PK koşulu) her satır doğrulama durumuyla.
- **Kabul:** düz PG'de e2e (trafik altında taşıma, veri kaybı yok); sağlayıcı satırları "unsupported" olabilir.

## R12 — DR ve nedensel okuma (F6) · v0.4
- **DR:** `tools cell promote <db> --to <replica#>` yalnızca **runbook ve denetim** üretir (otomatik terfi yok): terfi öncesi/sonrası `doctor` kontrolleri (`replica_identity`, kimlik, lag), pooler alias değişikliği talimatı. Terfi sonrası kimlik doğrulaması zaten `ready()`'de.
- **Nedensel okuma:** yazı sonrası `tenant.lastWriteToken()` (primary LSN); `tenantRead.query(q, v, { after: token })` replika `pg_last_wal_replay_lsn()` ≥ token olana dek `causalWaitMs` (varsayılan 200) bekler, olmazsa primary. Gizli yeniden deneme yok: bekleme sınırlı ve belgeli.
- **Testler:** replika fixture'ında gecikme enjekte ederek.
- **Kabul:** `replicas.md` "Yazıdan sonra okuma" bölümü; `regions.md` tablo satırı ✅.

## Bağımlılık özeti
R1 → R3 (stale-if-error fencing ister). R2 → R3. R4 → R5, R6, R7, R8, R9. R10 → R11. R12 bağımsız (R7'den sonra daha kolay).
