# Alt proje C: Replica desteği

Tarih: 2026-10-03 · Üst belge: [`2026-10-03-db-roadmap-design.md`](2026-10-03-db-roadmap-design.md) · Önceki: [`2026-10-03-connection-topology-design.md`](2026-10-03-connection-topology-design.md) (A: `DATABASE_REPLICA_URLS` yapılandırması), [`2026-10-03-neon-supabase-design.md`](2026-10-03-neon-supabase-design.md) (B) · Durum: tasarım sahibi tarafından bölüm bölüm onaylandı, yazılı spec incelemede.

## Amaç

A'da yalnızca doğrulanan `DATABASE_REPLICA_URLS`'i kullanılır hale getirmek: salt okunur sorgular açık bir okuma bağlamıyla replica'dan okunur; replica düşünce ya da geride kalınca davranış seçilebilir; operatör replica durumunu görür ve replica'dan yedek alabilir.

Başarı ölçütü: gerçek akış replikasyonlu izole compose'ta (a) okuma replica'dan gelir, (b) replica düşünce ve lag eşiği aşılınca seçilen politika çalışır, (c) aynı istekte yazıdan sonra okuma primary'de kalır, (d) `replicas`, `doctor` ve `--from-replica` yedeği çalışır, (e) hiçbir yeni ortam değişkeni eklenmez.

## Kapsam

**Kapsamda:** sorguların derleme zamanı `readOnly` sınıflaması, okuma bağlamı (`db.withTenantRead`, `RequestDb.tenantRead`), replica havuzları, sağlık/lag durumu, düşme politikası, yazıdan sonra okuma takibi, `replicas` komutu, `doctor` replica denetimleri, `--from-replica` yedek/export, testler, belgeler.

**Kapsam dışı (belgelenir):**

- Başka isteğe taşan okuma-yazma tutarlılığı (yalnızca aynı istek kapsamı korunur).
- Replica'ya sorgu başına gizli yeniden deneme.
- `node` ve `platform` bağlamlarında replica okuması (küçük, tutarlılığı kritik; primary'de kalır).
- Replica'da transaction (okuma bağlamında `transaction` yoktur).
- Otomatik yönlendirme (açık hedef ilkesine aykırı, roadmap kararı).
- Replica'dan artımlı yedek, replica'dan geri yükleme, replica'ya yazma/yönetim işi (yönetim `DATABASE_REPLICA_URLS`'i yok sayar).
- Neon HTTP sürücüsü; sağlayıcı lag davranışının otomatik doğrulanması (sahip çalıştırmasıdır).

## Kararlar

| Karar | Gerekçe |
|---|---|
| Okuma/yazma ayrımı **derleme zamanında**: codegen her sorguya `readOnly` bayrağı verir, `PreparedQuery` bunu taşır | Çalışma zamanında SQL ayrıştırılmaz (sıcak yol); yanlış sınıflama yalnızca bir yönde güvensizdir (yazı sorgusunu `readOnly` saymak) ve codegen bunu kurallarla engeller. Sahip kararı. |
| `readOnly` = üst düzey `SELECT` (küme işlemleri dahil), kilitsiz (`FOR UPDATE/SHARE` yok), veri değiştiren CTE yok | Kilit alan sorgu replica'da çalışmaz; yazan CTE yazıdır. Yan etkili fonksiyonlar (`nextval` vb.) statik ayrılamaz: replica salt okunurdur (hata verir) ve primary'ye düşmede sorgu `READ ONLY` transaction'da çalışır. |
| Düşme politikası **global ayar**, varsayılan `primary` | Sorgu başına seçenek API'yi şişirir. Sahip kararı. |
| Yazıdan sonra okuma takibi `RequestDb`'de (istek kapsamı), `runContext`'te `onWrite` geri çağrısı | Roadmap kararı (read-your-writes). Kapsam zaten istek başına tek ve değişmez context kurar. |
| Replica durumu **tembel yoklama + süreli önbellek**; arka plan zamanlayıcısı yok | Workers'ta zamanlayıcı yaşamaz; süreç ayakta tutulmaz. Sorgu yolunda ek gidiş-dönüş yalnızca `replicaStatusMs`'te bir. |
| Lag yöntemi: replay LSN primary'nin LSN'ine ulaştıysa 0, aksi halde `now() − pg_last_xact_replay_timestamp()` | Boşta primary'de yapay lag görünmez; kopmuş replikasyon yakalanır. Sınır: commit'siz WAL akarken lag kısa süre fazla görünebilir (hata yönü güvenlidir: primary'ye düşer). |
| Her `withTenantRead` çağrısı **bir replica'ya sabitlenir** | Bağlam içindeki sorgular tutarlı görüntü görür. |
| Bağlantı hatasında replica `up = false` işaretlenir, hata yüzeye çıkar; gizli yeniden deneme yok | YAGNI; hedef açık ilkesi. Sonraki çağrı başka replica ya da primary seçer. |
| `ready()` replica'yı beklemez, ondan hata vermez | Replica düşünce uygulama hazır olmaktan çıkmamalı. |
| Replica havuzu başına `poolMax` bağlantı; toplam `poolMax × (1 + replica sayısı)` | Her replica ayrı sunucudur; formül belgelenir. |
| Durum önbelleği modül düzeyinde, replica URL'si anahtarlı, yalnızca sayılar | Workers `perRequest` havuzları kapanır, durum kapanmamalı; soket tutulmaz. |
| `--from-replica` için doğrudan replica URL'si **gizli girişle** alınır (`askSecret`, `db0=url,…`) | Yedek çok adımlı REPEATABLE READ transaction ve cursor kullanır; `DATABASE_REPLICA_URLS` runtime (pooled) URL'dir. Yeni env yok. |
| Replica'dan yedek her zaman **tam**; manifest `source: "replica"` | Artımlı yedeğin `MARKER`'ı `pg_stat_user_tables` sayaçlarına dayanır; bunlar örnek başınadır, replike edilmez. |
| Replica'dan yedekte platform kayıtları (placement, `platform.tenants`) primary'den okunur | Küçük ve tutarlılığı kritik. |
| Replica yedeği/export lag eşiği aşılırsa hiçbir şey yazmadan `REPLICA_LAG_EXCEEDED` verir; çakışmada `REPLICA_CONFLICT`; sessizce primary'ye düşmez | Hedef DB her çağrıda açık; sessiz kaynak değişimi yedeğin anlamını değiştirir. |

## Tasarım

### C1. Sorgu bayrağı ve okuma bağlamı

**Codegen / `defineQuery`.** `compile` sonucuna `readOnly` eklenir (compiler `lock` ziyaretçisi zaten `requiresTransaction`'ı işaretler; AST'den üst düzey deyim türü ve CTE içeriği okunur). `defineQuery(parts, requiresTransaction, scope, readOnly)`; `codegen` bayrağı üretilmiş dosyaya yazar, `codegen --check` eski dosyayı reddeder; `src/queries/*.gen.ts` yeniden üretilir.

**Bağlam.** `ReadContext { query(query, values?) }` — `transaction` yok. `readOnly` olmayan sorgu DB'ye gitmeden `QUERY_NOT_READ_ONLY`; kapsam denetimi (`QUERY_SCOPE`) aynen geçerli (okuma yalnızca `tenant` kapsamı). `createWithTenant`'ın `forPlacement` kalıbı tekrarlanır; çekirdek `runContext` paylaşılır, tek fark bağlantı kaynağıdır.

**API.**
- `db.withTenantRead(id, work)` ve `db.withTenantRead.forPlacement(placement, work)` (`withTenant` ile aynı biçim).
- `RequestDb.tenantRead` (`createDbScope`): placement kapsam başına bir kez çözülür.
- `RequestDb.tenant`'ta `readOnly` olmayan bir sorgu çalışınca kapsam "yazdı" işaretlenir (`onWrite`); işaretlendikten sonra aynı kapsamın `tenantRead` çağrıları primary'ye yönelir. `readOnly` sorgular ve yalnızca okuma yapan transaction'lar işaret koymaz.

### C2. Replica havuzları, sağlık, seçim

- `createPools` düğüm başına `replicas(id)` döndürür: URL başına tembel açılan havuz, aynı `connect()` sarmalayıcısı (deadline, `DATABASE_BUSY`), `close()` hepsini kapatır.
- **Durum kaydı** `{up, lagMs, at}`. `replicaStatusMs`'ten eskiyse yoklanır; aynı replica için tek eşzamanlı yoklama, bekleyenler paylaşır. Yoklama primary'de `pg_current_wal_lsn()`, replica'da `pg_is_in_recovery()`, `pg_last_wal_replay_lsn()`, `pg_last_xact_replay_timestamp()` okur. `in_recovery` false → `up = false`. Hata → `up = false`. Hiç yoklanmamış replica ilk kullanımda yoklanır (deadline'la sınırlı).
- **Seçim:** `up` ve `lagMs ≤ replicaMaxLagMs` olan replica'lar arasında round-robin; `withTenantRead` boyunca sabit.
- **Sağlıklı replica yok:** `onUnavailable: "primary"` → her sorgu primary'de `READ ONLY` transaction içinde (`transaction(…, { mode: " READ ONLY" })`) çalışır; `"error"` → `REPLICA_UNAVAILABLE`.
- **Ayarlar** (`DatabaseOptions`, düz seçenek, sınırlı tamsayı/sabit küme, geçersiz → `INVALID_CONFIG`): `replicaMaxLagMs` (varsayılan 5000), `replicaOnUnavailable` (`"primary"` | `"error"`, varsayılan `"primary"`), `replicaStatusMs` (varsayılan 5000). Replica yoksa (boş `replicas`) bağlam doğrudan düşme yoluna girer; ek yoklama yok.
- `db.replicas()` anlık durum listesi döndürür (CLI ve `doctor` kaynağı): `{ databaseId, replica, up, inRecovery, lagMs, error? }`. `replica` 1–8 sıra numarasıdır; URL, host, kullanıcı hiçbir çıktıda yer almaz.

### C3. Tool'lar

**`replicas`:** `db.replicas()`'i tek satır JSON olarak yazar; replica düşükse ya da lag eşiği aştıysa çıkış kodu 1. Runtime config'i (`DATABASE_URLS` + `DATABASE_REPLICA_URLS`) kullanır; yeni env yok.

**`doctor`:** her replica için salt okunur `replica_reachable`, `replica_in_recovery`, `replica_lag`, `replica_identity` (replica'nın `platform.nodes` kimliği kendi primary'siyle aynı); A'nın pooler sınaması ve DB varsayılan timeout kontrolü replica URL'lerine de uygulanır.

**`--from-replica` (`backup`, `export-tenant`):**
- Doğrudan replica URL'leri gizli girişle sorulur (`db0=url,…`); `assertDirect` ve `pg_is_in_recovery() = true` ile doğrulanır.
- Tenant tablo verisi replica'dan, tek REPEATABLE READ READ ONLY snapshot'ında okunur; placement ve `platform.tenants` primary'den. Replica lag'i eşiği aşarsa hiçbir şey yazılmadan `REPLICA_LAG_EXCEEDED`.
- `backup --from-replica` her tenant'ı tam yedekler (artımlı atlama yok); manifest `source: "replica"` ve replay LSN taşır. Primary yedekleri artımlı kalır; replica seti sonraki primary yedeğinde "değişmiş" sayılır (marker yok).
- Çıktı klasör biçimi aynıdır; `restore` ile geri yüklenir.
- Uzun snapshot'ın recovery çakışmasıyla iptali (SQLSTATE 40001, "conflict with recovery") `REPLICA_CONFLICT`: "retry or export from the primary".

### Hatalar

Yeni kararlı kodlar (mesajlar İngilizce, değer içermez): `QUERY_NOT_READ_ONLY`, `REPLICA_UNAVAILABLE`, `REPLICA_CONFLICT`, `REPLICA_LAG_EXCEEDED`. `docs/errors.md`'ye eklenir.

## Test

**Altyapı:** `compose.yaml`'a `postgres-0-replica` (`postgres:16.15-alpine`, `127.0.0.1:5544`, `pg_basebackup -R` ile `postgres-0`'dan kurulan akış replikasyonu; `max_standby_streaming_delay` 1 sn, `hot_standby_feedback` kapalı, sabit varsayılan port/parola). Yalnızca izole compose projesi; paylaşılan jamaster stack'ine dokunulmaz.

**Birim (DB'siz, RED önce):**
- Codegen sınıflaması: düz `SELECT` ve salt okunur CTE `readOnly`; `INSERT/UPDATE/DELETE`, `FOR UPDATE/SHARE`, veri değiştiren CTE değil; `codegen --check` eski dosyayı reddeder.
- Okuma bağlamı: `readOnly` olmayan sorgu DB'ye gitmeden `QUERY_NOT_READ_ONLY`; bağlamda `transaction` yok; `QUERY_SCOPE` korunur.
- Seçim ve lag: round-robin, önbellek süresi, tek eşzamanlı yoklama, eşiği aşan elenir, primary'yi replica diye veren `up = false`, iki düşme kipi, geçersiz ayar `INVALID_CONFIG`.
- Yazıdan sonra okuma: yazı sonrası `tenantRead` primary'ye gider; `readOnly` sorgu yazı sayılmaz.
- Workers: modül düzeyindeki durum kaydı istek havuzu kapanınca yaşar.
- Tool'lar: `replicas` çıktısında URL/host sızmaz, çıkış kodu mantığı, `--from-replica` girdisi doğrulama, replica yedeğinde artımlı atlama olmaması.

**Entegrasyon (gerçek replica):**
- Primary'ye yazı → lag sıfırlanınca replica'dan okuma.
- Replica durdurulunca `primary` kipinde `READ ONLY` transaction'da primary'ye düşme; `error` kipinde `REPLICA_UNAVAILABLE`.
- `pg_wal_replay_pause()` ile lag eşiği aşılır → primary'ye düşme.
- `replicas` komutu ve `doctor`: sağlıklı replica ve yanlış URL (primary'yi replica diye vermek).
- `backup --from-replica` / `export-tenant --from-replica`: `restore` ile birebir aynı veri, `source: "replica"`; çakışma testi `REPLICA_CONFLICT`; lag aşımında `REPLICA_LAG_EXCEEDED`.
- `ready()` replica düşükken başarılı.

**Sağlayıcı (sahip çalıştırması):** Neon/Supabase read replica'larının gerçek lag ve `pg_last_xact_replay_timestamp` davranışı için B1'deki `verify:provider`'a replica ölçümü eklenir; kod bu planda yazılır, çalıştırma sahipte (B'nin üç owner çalıştırmasının yanında).

## Belgeler

`docs/replicas.md` (yeni): kavramlar, `readOnly` bayrağı, yazıdan sonra okuma sınırı, düşme politikası, lag yöntemi ve sınırı, bağlantı sayısı formülü, replica yedeği sınırları. Güncellenir: `configuration.md` (üç ayar), `cli.md` (`replicas`, `--from-replica`), `errors.md` (dört kod), `operations.md` (replica yedeği), `providers.md` (replica satırı "documented, not verified"), `docs/README.md`, paket `README.md`.

## Plan aşamasında koddan doğrulanacaklar

- `checkDatabases`'in düğüm kimliğini nasıl okuduğu (`replica_identity` aynı mekanizmayı yeniden kullanmalı).
- `backupAll`'ın önceki setlerin marker'ını nasıl kullandığı (replica setinin marker'sız olması artımlı zinciri bozmamalı).
- Compiler'ın AST'sinde üst düzey deyim türü ve CTE gövdesi erişimi (`readOnly` kuralı için).
- `RuntimeOptions`/`DatabaseOptions` içinde yeni ayarların doğrulama noktası.

## Riskler

- Lag ölçümü commit'siz WAL altında kısa süre fazla gösterebilir; güvenli yönde (primary'ye düşer), gerçek sağlayıcılarda ölçülecek.
- Replica yedeği uzun tenant'larda recovery çakışmasıyla başarısız olabilir; kod `REPLICA_CONFLICT` verir, çözüm operatörde (yeniden dene ya da primary).
- `readOnly` sınıflaması yan etkili fonksiyonları ayıramaz; replica ve `READ ONLY` transaction ikinci güvencedir.
