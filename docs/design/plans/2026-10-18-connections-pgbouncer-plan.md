# Bağlantı yönetimi ve PgBouncer planı

> **Uygulama notu (2026-10-19): C1–C10 uygulandı, C11 hesap bekliyor; plandan sapmalar:**
> - C1: bütçe sınırları `(max_connections − superuser_reserved) × 0.9` ve `max_client_conn × pooler × 0.5`; kılavuzdaki örnek bir birim testiyle kilitli. `doctor --connection-budget` yerine `--instances --pool-max --poolers` bayrakları.
> - C2: `pooler generate` DB'ye bağlanmaz, `DATABASE_URLS`/`DATABASE_REPLICA_URLS`'ten üretir; gerçek bir PgBouncer'a yüklenir ve `ready()` + sorgularla sınanır.
> - C4: `tenantMaxInflight` deyim değil **bağlam** (`withTenant`, `withTenantRead`, istek kapsamı) sayar.
> - C5: sürücü havuzları boşta bağlantı sayısını vermediği için `idle` yok; OpenTelemetry göstergeleri (`poolGauges`), Sentry için bağdaştırıcı yok.
> - C7: sınıflar `failoverClass` ile; hazırlanmadan zaman aşımı (`DeadlineError.workStarted === false`) yeniden denenebilir sayılır.
> - C8: senaryolar `faults.test.ts`; her tenant `statementTimeoutMs + 1,5 sn` sınırı ölçüldü ve `connections.md`'ye yazıldı.
> - C9: matris PgBouncer 1.21.0, 1.23.1, 1.24.0 × `max_prepared_statements` 0/100 (CI işi `pgbouncer-matrix`).
> - C10: isimli prepared statement **reddedildi** (20.000 farklı deyimle kazanç yok, istemci belleği büyüyor).
> - C11: gerçek sağlayıcı hesabı gerektirir; sahip işi.

Tarih: 2026-10-18 · Tasarım: [`2026-10-18-pgcells-oss-regions-design.md`](../specs/2026-10-18-pgcells-oss-regions-design.md) §6, D20 · Kılavuz: [`docs/guides/connections.md`](../../guides/connections.md) · Ana yol: [roadmap](2026-10-18-roadmap-remaining.md) F3 → **v0.2**

Bu proje için bağlantı yönetimi ürünün yarısıdır. Hedef: bir operatörün, kendi ortamı için üç bağlantı bütçesini hesaplayabilmesi, paketin bunu **denetlemesi**, PgBouncer'ın üretim ayarını şablondan üretebilmesi ve hata/failover davranışının ölçülmüş olması. Kilometre taşı düzeyindedir.

Mevcut temel (değişmez): tek deyim tek ayrılmış bağlantı + deadline, atılan süresi dolmuş bağlantı, 64 bekleyen iş sınırı (`DATABASE_BUSY`), `ready()` pooler sınaması, yönetimin doğrudan bağlantı zorunluluğu, DB varsayılan timeout'ları.

## C1 — Bağlantı bütçesi hesabı ve `doctor` denetimi
- **Ne:** Saf fonksiyon `connectionBudget({ appInstances, poolMax, replicasPerNode, poolers, defaultPoolSize, maxClientConn, maxConnections, managementConcurrency, rps?, latencyMs? })` → `{ clientLoad, serverLoad, flow, violations[] }` (kılavuzdaki (1)–(3) eşitsizlikleri). CLI: `tools pooler plan --instances 40 --pool-max 5 --poolers 2 …` JSON çıktısı, ihlalde çıkış kodu 1. `doctor --connection-budget` (değer almayan bayrak; girdiler gizli giriş değil, düz sayılar olduğundan `--instances` vb. bayraklar) PgBouncer `SHOW CONFIG` / PostgreSQL `max_connections` değerlerini kendisi okur (bilgi varsa), eksik girdiyi ister.
- **Dosyalar:** `core/tools/pooler-plan.ts` (yeni, saf), `core/tools/doctor.ts`, `core/cli.ts`; belge `cli.md`, `operations.md`.
- **Testler:** birim: formüller, sınır değerler, replika çarpanı, 0 bölme; doctor: ok/ihlal; CLI çıktısı.
- **Kabul:** kılavuzdaki çalışılmış örnek birebir aynı sayıları üretir (birim testi olarak kilitlenir).

## C2 — PgBouncer yapılandırma üretici
- **Ne:** `tools pooler generate --region eu-west [--poolers 2] [--default-pool-size 20]`: `platform.nodes`'tan (ve R4 sonrası `region` süzgecinden) `[databases]` bölümünü, kılavuzdaki üretim `[pgbouncer]` şablonunu ve `userlist` iskeletini (gizli değer yok) çıktılar. Replika alias'ları (`db1_ro` …). Çıktı deterministik (sıralı), `--check <dosya>` ile mevcut dosya farkını denetler.
- **Dosyalar:** `core/tools/pooler-generate.ts`, test fixture'ları; `src/core/local/pgbouncer/` geliştirme dosyaları ayrı kalır.
- **Kabul:** üretilen dosya Docker'daki PgBouncer'a yüklenir ve `ready()` + e2e smoke geçer; golden-file testi.

## C3 — Timeout uyumu denetimi
- **Ne:** `doctor timeout_alignment`: DB `statement_timeout` = uygulama `statementTimeoutMs` (mevcut `runtime_timeouts`) + PgBouncer `query_wait_timeout` > `statementTimeoutMs + 1500` (konsol URL'si verildiyse; `--pgbouncer-url`). İhlalde açıklayıcı ayrıntı.
- **Kabul:** birim + PgBouncer'lı entegrasyon; kılavuz §6 tablosuyla uyumlu.

## C4 — Adillik: tenant başına eşzamanlılık
- **Ne:** `createDatabase({ tenantMaxInflight })` (varsayılan kapalı, 1–`poolMax*N`): `runContext` seviyesinde tenant başına uçuştaki deyim/transaction sayacı; aşımda `DATABASE_BUSY` (mevcut kod, `detail: "tenant"`). Sıcak yol maliyeti: seçenek kapalıyken **sıfır** (ek await/Map yok); açıkken bir Map artış/azalış. Benchmark ile doğrula (`bench:hotpath`).
- **Kabul:** hotpath ölçümünde kapalıyken fark ölçüm gürültüsünde; açıkken kayıp raporlanır; entegrasyon: gürültücü tenant diğerinin gecikmesini bozmaz (k6 senaryosu).

## C5 — `db.stats()` havuz metrikleri
- **Ne:** `db.stats()` → DB başına `{ inUse, idle, pending, maxPending, acquireP50/P99 (halka tamponu), expiredDiscarded, busyRejected }`. Sayaçlar mevcut `connect()` içinde, `onSpan` olmadan da çalışır; telemetri bağdaştırıcıları (`openTelemetry`, `sentry`) gauge yayımlar.
- **Kabul:** birim (sahte sürücü), `telemetry.md` güncel; ek maliyet ölçülür ve ≤ %1.

## C6 — Zarif kapanış ve boşaltma
- **Ne:** `db.close({ drain: true, timeoutMs })`: yeni işi `DATABASE_CLOSED` ile reddeder, uçuştaki deyimleri bekler (üst sınır), sonra havuzları kapatır. `dbMiddleware` için `shutdown()` yardımcısı; `ready()` kapanış başlayınca hemen başarısız olur (LB boşaltsın). e2e uygulaması SIGTERM'de bunu kullanır.
- **Kabul:** entegrasyon: yük altında SIGTERM, sıfır kesilmiş deyim (yanıtsız kalan istek yok); `middleware-and-jobs.md`.

## C7 — Failover sınıflandırması
- **Ne:** `retryable(error)` ve `failoverClass(error)` (`connection-reset`, `admin-shutdown` 57P01/57P02, `read-only` 25006, `pooler-reset` 08P01, `timeout`); **hiçbir yerde otomatik yeniden deneme yok**. Hata kodları tablosu `errors.md`'de.
- **Kabul:** birim tablo testleri (PostgreSQL/PgBouncer gerçek hata örnekleriyle); toxiproxy ile üretilen bağlantı sıfırlamaları doğru sınıfa düşer.

## C8 — Fault-injection testleri (D20)
- **Ne:** compose'a toxiproxy: app↔pooler, pooler↔PG yollarında gecikme, bant, bölünme, `reset_peer`, yavaş kapanış. Senaryolar: (1) pooler yeniden başlatma (e2e 10'un genişletilmişi), (2) PG primary kesintisi ve dönüş, (3) pooler↔PG bölünmesi sırasında `DATABASE_TIMEOUT` süreleri sınır içinde, (4) bağlantı fırtınası (soğuk başlangıç, N süreç) sırasında `DATABASE_BUSY` ve pooler `cl_waiting`, (5) `RECONNECT` sonrası timeout'lar, (6) deploy örtüşmesi (iki nesil süreç).
- **Kabul:** hepsi CI'da; ölçülen sınırlar (`< statementTimeoutMs + 1,5 sn`) `connections.md`'ye "ölçülmüş" olarak yazılır.

## C9 — PgBouncer sürüm matrisi
- **Ne:** CI matrisi: PgBouncer 1.21, 1.23, güncel 1.2x (ve `max_prepared_statements` 0/>0). `ready()` sınaması, deadline, e2e smoke her sürümde.
- **Kabul:** matriste desteklenen/denenen sürümler `providers.md`'de; farklı davranış (varsa) belgelenir.

## C10 — İsimli prepared statement opt-in spike'ı
- **Ne:** Mevcut araştırma (postgres.js ~2×, bun/pg küçük kazanç) tekrarlanır ve **bounded** bir tasarımla denenir: `prepare: "pgbouncer"` seçeneği (yalnızca `ready()` `max_prepared_statements > 0` görürse), statement adı = sorgu+schema özetinin sınırlı LRU'su, istemci önbellek üst sınırı. Soru: sorgu × tenant çarpanı PgBouncer LRU'sunu ve istemci belleğini patlatır mı?
- **Kabul:** karar belgesi: uygulanır (kapalı varsayılan, sınırlı) veya reddedilir (gerekçe + ölçüm). Sıcak yol "gizli iş yok" ilkesi bozulmaz.

## C11 — Sağlayıcı pooler doğrulaması (F5.3 ile ortak)
- Hyperdrive (caching kapalı), Supavisor (transaction), Neon pooler, RDS Proxy (pinning davranışı: `SET`, prepared statement pin'i), PgCat/PgDog: `verify:provider` gerçek hesapla; `ready()` sınamasının her birinde doğru/yanlış negatif olduğu kaydedilir; yanlış negatifte `pooler: "assumed"` yönergesi.
- **Kabul:** `providers.md` her satırda `verified (tarih, sürücü)` veya `unsupported`.

## C12 — Belge ve kılavuz bakımı
- `connections.md` her özellik teslim edildikçe "🔜 → ✅" ve gerçek ölçülerle güncellenir; çalışılmış örnek testlerle kilitlidir (C1).
- Kök README bağlantı bölümü aynı sayıları taşır (tek kaynak: kılavuz).

## Sıra
C1 → C2 → C3 (bütçe/şablon/uyum, kimsenin başka işi beklemez) · C5, C6 paralel · C8 testleri C4/C7 ile birlikte · C9 · C10 spike (karardan sonra) · C11 (hesaplar gerektirir, F5.3 ile).
