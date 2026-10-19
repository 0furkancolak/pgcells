# `@repo/db` yol haritası: altı eksik, altı alt proje

Tarih: 2026-10-03 · Durum: tasarım onaylandı (alt proje A ayrıntılı spec'te), B–F kendi tasarım turlarında netleşir.

## Amaç

`@repo/db`'yi jamaster-api'de üretime hazır hale getirmek: yönetilen Postgres sağlayıcılarında (Neon, Supabase) çalışmalı, kontrollü replica okuması sunmalı, saniyede ~1M istek hedefine ölçülebilir biçimde ölçeklenebilmeli ve kullanıcıya baştan sona bir kılavuz sunmalı.

Bu belge altı maddeyi alt projelere böler, sahibin verdiği kararları kaydeder ve sırayı belirler. Her alt proje kendi spec → plan → uygulama döngüsünü alır; bu belge uygulama ayrıntısı içermez.

## Değişmeyen kısıtlar

Önceki kararlar, aksi açıkça söylenmedikçe geçerlidir (kaynak: sahibin proje notları).

- **`search_path` hiçbir biçimde kullanılmaz.** Schema, derlemede tablo adına eklenir.
- **Tek ortam değişkeni ilkesi:** `DATABASE_URLS` virgüllü liste, ilk URL platform DB'si, liste yalnızca sona eklenir. Bu belgeyle tek istisna, yalnızca replica kullananlar için isteğe bağlı `DATABASE_REPLICA_URLS` (A).
- **Hedef DB her çağrıda açıktır** (kök `db.query` yok). Replica okuması da açık bağlamdır (C).
- **Paket `packages/db`'dir.** Örnek uygulama, kimlik doğrulama sahibi ve ayrı örnek paket yok.
- **Daha az kod, daha anlaşılır kod:** kavram silmek soyutlama eklemekten iyidir.
- **Uyarılar zorunlu denetime dönüşür** (README notu olarak bırakılmaz).
- **Tüketici jamaster-api'dir:** Bun + Hono API, Node worker'ları, `pg` + PgBouncer, Better Auth, Sentry.
- **Çalışma anında SQL ayrıştırılmaz;** `pgsql-ast-parser` yalnızca derleme zamanındadır.

## Alt projeler

| # | Alt proje | Maddeler | Özet |
|---|---|---|---|
| A | Bağlantı topolojisi ve pooler zorunluluğu | 2 (ve 1, 4'ün temeli) | Runtime'da transaction-mode pooler zorunlu; replica URL'leri yapılandırması. **Ayrıntılı spec:** `2026-10-03-connection-topology-design.md` |
| B | Neon + Supabase | 1 | Yönetilen Postgres olarak çalışma (pooler/direct ayrımı, yetkiler, `bootstrap`, advisory lock), Neon serverless sürücüsü, Neon branching / Supabase PITR tool'ları |
| C | Replica desteği | 4 | Açık okuma bağlamı, gecikme (lag) koruması, replica'ya yönelik tool'lar |
| D | Ölçek | 5 | Saniyede ~1M istek için kapasite modeli, backpressure, ölçüm |
| E | Gelişmiş SQL | 6 | JSON/dizi/regex operatörleri ve fonksiyonlar, sorgu yapıları, ek tipler |
| F | Kılavuz | 3 | `docs/` altında kurgusal bir sistemle baştan sona belge içi senaryo |
| G | `db-multi` + tenant'sız `db-single` | — (sahip isteği, sonradan eklendi) | Mevcut paket `db-multi` olur; tek DB/tek schema için kopyalanarak `db-single`. Ayrıntı: [`2026-10-04-db-single-design.md`](2026-10-04-db-single-design.md). **Durum:** uygulandı (G1–G3) |

**Sıra:** A → B → C → E → D → F.

- A, B ve C bağlantı modelini paylaşır; A temeli koyar.
- E bağımsızdır, A–C ile çakışmaz (yalnızca `core/sql/`).
- D ölçüm ister: topoloji (A–C) bitmeden ölçmek yanlış sayı üretir.
- F son halin anlatısıdır; bu yüzden sona kalır.

## Sahibin kararları

### Pooler (A)

- Zorunlu olan şey sözcük anlamıyla PgBouncer değil, **herhangi bir transaction-mode pooler**dır (PgBouncer, Supavisor, Neon pooler, Hyperdrive). Nedeni: Supabase varsayılan olarak Supavisor, Workers'ta Hyperdrive kullanır; PgBouncer'a bağlamak ikisini dışarıda bırakır.
- Runtime doğrudan bağlantıyla açılmaz. Yönetim (CLI, tools) doğrudan bağlantıda kalır; mevcut `DIRECT_CONNECTION_REQUIRED` denetimi korunur.

### Neon/Supabase (B)

- Üç düzeyin üçü de kapsamdadır: (1) yönetilen Postgres olarak çalışma, (2) Neon serverless sürücüsü (HTTP/WebSocket; Workers/edge), (3) Neon branching / Supabase PITR'ye bağlanan yedek ve kopyalama tool'ları.
- Sağlayıcı davranışları (pooler uyumu, `ALTER DATABASE … SET`, yetkiler, advisory lock) kodda varsayılmaz; güncel dokümanlardan ve mümkünse gerçek hesapla doğrulanır.

### Replica (C)

- **Açık okuma bağlamı:** `withTenant` yanında okuma bağlamı; yalnızca salt okunur sorgular.
- **Gecikme koruması:** lag eşiği aşılırsa veya replica düşerse primary'ye düşme **ya da** hata (seçilebilir).
- Aynı istekte yazıdan sonraki okuma primary'de kalır (read-your-writes).
- Otomatik yönlendirme reddedildi: açık hedef ilkesine ve read-your-writes güvenliğine aykırı.

### Ölçek (D)

- Hedef: **saniyede ~1M istek.**
- Paket bunu tek başına çözmez. Paketin payı: süreç başına sıfıra yakın yük (bugün ham sürücünün %92–99'u), istekleri DB'ye gitmeden çözen placement önbelleği, replica okuması, backpressure ve ölçülmüş kapasite modeli ("süreç başına X rps; 1M için N örnek ve M replica").
- Sonuçlar küçük ölçekli, düşük RAM'li koşulardan çıkarılır; uzun soak koşuları istenmedi.

### SQL (E)

- **Kapsamda:** JSON/dizi/regex operatörleri ve fonksiyonlar (`->`, `->>`, `@>`, `?`, `~`, `IS DISTINCT FROM`; `unnest`, `generate_series`, `jsonb_set`, `jsonb_each`, `concat`, `replace`, `trim`, `regexp_*`, `array_length`); sorgu yapıları (`WITH RECURSIVE`, `INTERSECT`/`EXCEPT`, pencere çerçevesi, `GROUPING SETS`, `FROM` içinde tablo döndüren fonksiyonlar); ek tipler (`citext`, `inet`, `tsvector`, aralık tipleri, `serial`/`bigserial`).
- **Kapsam dışı:** DDL (`CREATE VIEW/FUNCTION/TRIGGER/EXTENSION`, `GENERATED … STORED`, dolar tırnaklama).
- **`citext` kapsam dışı kaldı** (E tasarım turunda sahip kararı): extension tipinin schema'sı sağlayıcıya göre değişir ve derleyici schema'yı bilemez; ayrıntı [`2026-10-04-advanced-sql-design.md`](2026-10-04-advanced-sql-design.md).
- Ek tipler tablo tipi üretimini (zod) ve üç sürücüde değer eşlemesini etkiler; E'nin tasarım turunda ele alınır.

### Kılavuz (F)

- Çıktı: `docs/` altında tek kurgusal sistemle (jamaster benzeri) baştan sona belge içi senaryo. Çalışan ayrı uygulama yok.

## Alt projelerin tasarım turlarında sorulacaklar

Bunlar bilinçli ertelenmiş kararlar; ilgili alt projenin brainstorming'inde netleşir, şimdi tahmin edilmez.

- **B:** Hangi Neon/Supabase planı ve hesapla doğrulama yapılacak; Neon serverless sürücüsünün `Driver` sözleşmesine (iptal, deadline, `reserve`) uyumu; Supabase'te `postgres` rolünün `ALTER DATABASE … SET` ve extension yetkileri; branching/PITR tool'larının platform API'sine bağımlılığı.
- **C:** Lag'in nasıl ölçüleceği (`pg_last_xact_replay_timestamp` / LSN) ve eşik varsayılanları; replica sağlık durumunun önbelleği; replica'ya yönelik tool'lar (durum, lag raporu, replica'dan yedek).
- **D:** Kapasite modelinin ölçüm yöntemi, backpressure'ın bugünkü 64 bekleyen iş sınırının ötesinde ne gerektirdiği, çok örnekte havuz paylaşımı.
- **E:** Her yeni yapının ve işlevin `search_path`'siz schema bağlamasıyla güvenliği; ek tiplerin sürücü eşlemesi.
- **F:** Senaryonun kapsamı ve kod bloklarının eskimemesi için nasıl doğrulanacağı.

## Süreç

- Her alt proje: tasarım → yazılı spec (bu klasör) → sahibin onayı → plan (`writing-plans`) → uygulama.
- Git: özellik dalı, aşama başına tek yerel commit; push/PR yalnızca istendiğinde.
- Migration ve seed dosyaları yalnızca CLI ile oluşturulur (`db:generate:*`).
