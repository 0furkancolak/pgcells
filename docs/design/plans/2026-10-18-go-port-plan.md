# Go sürümü planı

Tarih: 2026-10-18 · Tasarım: [`2026-10-18-pgcells-oss-regions-design.md`](../specs/2026-10-18-pgcells-oss-regions-design.md) §8, D7, D22 · Ana yol: [roadmap](2026-10-18-roadmap-remaining.md) F7

**Amaç:** TypeScript ile **aynı platform sözleşmesini** konuşan, karışık filoda (TS + Go servisleri aynı `platform.*` tablolarını paylaşarak) güvenle çalışabilen bir Go kütüphanesi ve CLI. Go'nun TS'in satır satır çevirisi olması hedef **değil**; davranış sözleşmesi aynı, API Go'ya özgüdür.

Başlangıç koşulu: TS `v0.3` ile sözleşme dondu (F4). Daha erken başlamak sözleşmeyi hareketli bir hedefe karşı yazmak demektir; yalnızca **G0** (sözleşme çıkarımı) F4 ile paralel yürür.

## Kapsam

| | Go v0.1 | Sonra |
|---|---|---|
| Çalışma zamanı: placement okuma+önbellek, tenant/node/platform bağlamları, deadline'lı havuz, replika yönlendirici, span'ler | ✅ | |
| Derleme zamanı SQL üreteci (tablo adlarına schema bağlama, `readOnly` bayrağı, tipli fonksiyonlar) | ✅ | |
| `net/http` ve `chi` ara katmanı, OpenTelemetry | ✅ | Gin/Echo/Fiber örnekleri |
| Yönetim: bootstrap, provision, migrate-all, doctor, databases | ◐ (G3) | move, backup/restore (G4) |
| CLI (`pgcells`) | ◐ salt okunur komutlar önce | tamamı |
| Redis placement önbelleği | ✅ (`go-redis`) | kuyruk (Asynq/River uyarlaması) |
| Better Auth karşılığı | ❌ (hedef dışı) | oturumu paylaşılan tablolardan/JWT'den doğrulayan küçük okuyucu isteğe bağlı |
| `db-single` karşılığı | ❌ | gerekirse |

## G0 — Sözleşme çıkarımı (`spec/`) · TS v0.3 ile paralel
Tek doğruluk kaynağı, her iki dilin de tükettiği dosyalar:

1. `spec/sql/platform/*.sql`, `spec/sql/node/*.sql`: `platform.*` ve node şeması. TS bunlardan **üretilir veya bunlarla bayt karşılaştırılır** (CI: TS migration'ları ile `spec/` aynı mı).
2. `spec/locks.md` + `spec/locks.json`: advisory lock anahtar dizgeleri ve hash fonksiyonu (`hashtextextended(key, 0)`): `tenant-placement`, `migration-runner`, `tenant-operation:<id>`, `tenant-management:<id>`, `platform-bootstrap`. **Karışık filoda karşılıklı dışlama için anahtarlar birebir aynı olmalı.**
3. `spec/errors.json`: hata kodu → anlam → HTTP eşlemesi (TS `errors.md`'den üretilir).
4. `spec/placement.md`: durum makinesi (`provisioning|active|maintenance|migrating|failed`), CAS kuralları, `placement_version`, önbellek TTL sınırı (25 sn), taşıma bekleme formülü, fencing adlandırması (`__moved_`).
5. `spec/fixtures/`: JSON uyum fikstürleri:
   - `tenant-id.json`: geçerli/geçersiz tenant ID ve host ayrıştırma vakaları,
   - `schema-name.json`: ID→schema eşlemesi,
   - `sql-bind.json`: girdi SQL → beklenen bağlı SQL (+`readOnly`, `requiresTransaction`, tablo referansları),
   - `placement-choice.json`: düğüm yükleri → seçilen düğüm,
   - `config.json`: `DATABASE_URLS`/`DATABASE_REPLICA_URLS` geçerli/geçersiz vakalar,
   - `connection-budget.json`: bütçe hesabı vakaları (bağlantı planı C1).
6. **Fikstür üretimi:** TS birim testleri aynı JSON'u okur (bugünkü testlerin bir kısmı fikstüre taşınır); fikstür TS'den üretilir ve gözden geçirilip commit edilir. Go testleri aynı dosyaları tüketir.
- **Kabul:** `spec/` mevcut ve TS tarafı bunu tüketiyor (D22'nin dondurma ölçütü); Go'ya bağımlı değil.

## G1 — Go iskeleti ve havuz
- **Yerleşim:** `go/` (modül `github.com/pgcells/pgcells/go`; alt dizin modülü için etiketler `go/v0.1.0`). Paketler: `placement`, `tenant`, `pool`, `replica`, `sqlgen`, `httpmw`, `otel`, `mgmt`, `cmd/pgcells`.
- **Sürücü:** `pgx/v5` + `pgxpool`. PgBouncer transaction modu için **isimli statement yok**: `pgx.QueryExecModeExec` (parametreleri sunucuya basit protokol benzeri tek turda) veya `QueryExecModeSimpleProtocol`; karar G1 spike'ında ölçülür (güvenlik: SQL enjeksiyonu yüzeyi bağlı parametrelerle kalır; `SimpleProtocol` istemci tarafı yerleştirmesi kullandığından **seçilmez**, `Exec` modu tercih).
- **Deadline:** `context.Context` ile; süresi dolan bağlantı iptal edilir (`pgconn.CancelRequest`, Go'da gerçek sunucu iptali var), bağlantı atılır (`pgxpool` `Conn.Hijack`/`Destroy`). 64 bekleyen iş sınırı ve `DATABASE_BUSY` eşdeğeri (`ErrBusy`).
- **Havuz:** DB başına bir `pgxpool.Pool` (tenant başına değil); `MaxConns` = `poolMax`; `MaxConnIdleTime`/`MaxConnLifetime` TS varsayılanlarıyla aynı (20 sn / 300 sn).
- **`Ready()`:** `pg_backend_pid` pooler sınaması (TS ile aynı algoritma ve `ErrPoolerRequired`).
- **Kabul:** `go test` birim; entegrasyon (Docker compose'taki PgBouncer) deadline/iptal/bağlantı atma senaryoları TS testlerinin eşdeğeri; hot path benchmark (`go test -bench`) ham `pgx`'e oranı raporlanır (hedef ≥ %90).

## G2 — Placement, bağlam, replika
- Placement önbelleği: süreç içi `otter`/küçük LRU + TTL (`PlacementCacheMs`≤25 sn), `activePlacementCache` epoch/invalidation semantiği birebir (TS `runtime.ts`), isteğe bağlı Redis katmanı.
- `WithTenant(ctx, id, func(ctx, TenantCtx) error)`, `WithTenantRead`, `WithNode`, `WithPlatform`; iç içe transaction yasağı; `QueryNotReadOnly`, `QueryScope` denetimleri; istek kapsamlı okuma-yazdığını-görür ve replika sabitleme (`net/http` ara katmanı).
- Replika yönlendirici: LSN tabanlı lag (TS ile aynı SQL), durum önbelleği, round-robin + bölge tercihi (R7 sonrası).
- **Kabul:** `spec/fixtures` vakalarının tamamı geçer; `placement` durum/CAS testleri TS entegrasyon testlerinin eşdeğeri; **birlikte çalışma testi**: aynı compose'ta TS yönetim `move` çalıştırırken Go servisi `WithTenant` ile okur/yazar (bayat yazıcı yok; fencing sonrası `42P01`).

## G3 — SQL üreteci (derleme zamanı)
- **Karar:** kendi üretecimiz (`go/cmd/pgcells-gen`), `pg_query_go` (libpg_query, cgo) yalnızca **derleme zamanı** aracında; çalışma zamanı kütüphanesi cgo'suz ve ayrıştırıcısızdır. sqlc'nin schema'sız tek-schema modeli tenant başına schema niteleme ihtiyacımızı karşılamadığı için sqlc doğrudan kullanılmaz; ancak sqlc tipi eşleme tablolarından ilham alınır. (Alternatif: saf Go ayrıştırıcı değerlendirmesi; olgun biri varsa cgo kaldırılır.)
- Girdi: `queries/{tenant,node,platform}/*.sql` (TS ile aynı dizin kuralı), şema: migration'lardan veya canlı DB `pull`'dan. Çıktı: tipli fonksiyonlar + `Prepared` değerleri (`Scope`, `ReadOnly`, `RequiresTransaction`, `Bind(schema) string`).
- **Kabul:** `sql-bind.json` fikstürleri TS ile **aynı** bağlı SQL ve bayrakları üretir (bayt düzeyinde veya normalize edilmiş); uyuşmayan vakalar listelenip kapsam dışı ilan edilir (ör. TS'in desteklediği ileri SQL yapıları: önce E1–E3 dilimleri değerlendirilir, desteklenmeyen yapı **derleme hatası** verir, sessizce yanlış üretmez).

## G4 — Yönetim ve CLI
- Sırayla: `bootstrap`, `doctor` (salt okunur denetimler), `databases`, `provision`, `migrate`/`migrate-all`, `status`; sonra `seed`; en son `move`, `backup`/`restore`, `adopt` benzeri (TS ile aynı **sahiplik/kilit/CAS** kuralları, `spec/locks.json`).
- Yönetim bağlantısı doğrudan; `DIRECT_CONNECTION_REQUIRED` denetimi.
- Migration biçimi **aynı** `--up/--down` SQL dosyaları ve ledger tabloları; Go ve TS aynı tenant'ı migrate edebilir (ledger içerik özeti uyumu fikstürle sabitlenir).
- CLI: `cobra`; JSON çıktısı TS CLI ile aynı alan adları (`cli.md`).
- **Kabul:** karışık filo testi: TS `migrate-all` ve Go `migrate-all` eşzamanlı → biri `MIGRATION_RUNNER_BUSY`; aynı kilit; sonuçlar eşdeğer.

## G5 — Dağıtım ve belge
- GoReleaser (Linux/macOS, amd64/arm64) ile CLI ikilileri; Go modülü etiket önekiyle yayın; `go/README.md`, `docs/guides/go.md` (kuruluş, `pgx` + PgBouncer notları, TS ile birlikte çalışma).
- CI: `go vet`, `staticcheck`, `go test -race`, entegrasyon (compose), `govulncheck`, `spec/` uyum işi (TS ve Go aynı fikstürü geçer).
- Sürüm: `go/v0.1.0` ancak G1–G3 + karışık filo testi (G2) yeşil olunca; G4 parça parça `v0.x`.

## Riskler ve açık kararlar
| Risk/karar | Not |
|---|---|
| `pg_query_go` cgo bağımlılığı | Yalnızca üreteç aracı; tüketici cgo istemez. Saf Go ayrıştırıcı olgunlaşırsa değerlendirilir |
| SQL üreteç eşdeğerliği | Fikstür bütçesi büyük olabilir; kapsam bilinçli daraltılır (derleme hatası > yanlış çıktı) |
| Ayrı repo mu, monorepo mu | Başlangıç monorepo (sözleşme paylaşımı kolay); Go ekosistem alışkanlığı için `pgcells-go` yansısı sonradan |
| Better Auth yok | Belgelenir; Go servisleri oturumu çözmez, kimlik doğrulamayı TS/auth servisi yapar veya JWT |
| Bölge özellikleri (R4–R7) | Go G2 bölge tercihini R7 sonrası alır; `spec/` bunları içerir |
| Zaman | G0 ≈ TS ile paralel; G1–G3 çekirdek ≈ en büyük iş; G4 uzun kuyruk |

## Kabul ölçütleri (Go v0.1)
- Aynı `platform.*` veritabanında bir TS ve bir Go servisi trafik altında çalışırken TS `move` tenant'ı taşır; iki servis de doğru DB'ye yazar, veri kaybı yok.
- `spec/fixtures` tamamı Go'da yeşil.
- Hot path ham `pgx`'in ≥ %90'ı.
- `ready()` PgBouncer'da doğru, doğrudan bağlantıda `ErrPoolerRequired`.
