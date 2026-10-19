# pgcells

**TypeScript için bölge-farkında, çok tenant’lı PostgreSQL** — tenant’lar *hücrelerde* (PostgreSQL kümeleri) yaşar, küçük bir dizin nerede olduklarını söyler, her bağlantı bir transaction pooler’dan geçer ve her deyimin deadline’ı vardır.

[English](README.md) · [Mimari](#mimari) · [Bağlantı yönetimi](docs/guides/connections.md) · [Bölgeler](docs/guides/regions.md) · [Kapasite](docs/guides/capacity.md) · [Baştan sona anlatım](docs/guides/walkthrough.md) · [Yol haritası](docs/design/plans/2026-10-18-roadmap-remaining.md)

> **Durum: yayın öncesi.** Motor tek bölge için tamamlanmış ve yoğun test edilmiş durumda. Depo açık kaynağa hazırlanıyor (eski adı `multi-tenant-example`, paketler `@repo/*`); bölge-farkında yerleşim, fencing ve bağlantı araçları planlı. Ayrıntı: [tasarım](docs/design/specs/2026-10-18-pgcells-oss-regions-design.md), [yol haritası](docs/design/plans/2026-10-18-roadmap-remaining.md).

## Neden

Binlerce tenant’ı birkaç bölgeden ilişkisel bir veritabanıyla sunmak birkaç zor seçim gerektirir. pgcells bunları bir kez ve açıkça yapar:

- **Tenant başına tek yazıcı.** Tenant, tam olarak bir hücredeki bir schema’dır. Bölgeler arası yazma ve dağıtık transaction yoktur.
- **Sihir yerine harita.** `platform.placements` hangi tenant’ın hangi hücrede olduğunu söyler; süreç içi ve Redis’te önbelleklenir, istek başına okunmaz.
- **Bağlantı bir bütçedir.** Uygulama yalnızca transaction-mode pooler’a (PgBouncer, Supavisor, Neon, Hyperdrive) bağlanır; `db.ready()` bunu açılışta kanıtlar. Havuz DB başınadır, tenant başına değil.
- **Açık hedef.** Her çağrı hedefini söyler (`withTenant`, `withTenantRead`, `withNode`, `withPlatform`). Örtük okuma yönlendirmesi, gizli yeniden deneme ve `search_path` yoktur.
- **SQL derleme zamanında derlenir.** Çalışma anında SQL ayrıştırılmaz.
- **Operasyon birinci sınıftır.** Tüm tenant’larda migration, provision, hücreler arası taşıma, kademeli yedek, `doctor`; hepsi tekrar çalıştırılabilir.

## Paketler

| Paket | Kimin için | Yapı |
|---|---|---|
| [`@0furkancolak/pgcells`](packages/db-multi/README.md) | çok tenant’lı uygulamalar | birden çok DB (hücre), tenant başına schema, dizin (`db0`) |
| [`@0furkancolak/pgcells-single`](packages/db-single/README.md) | tek DB, tek schema | tenant yok; aynı motor, CLI ve auth bağdaştırıcısı |
| [`@0furkancolak/pgcells-redis`](packages/redis/README.md) | isteğe bağlı | placement önbelleği, auth deposu, önbellek, tenant’lı kuyruk |

## Mimari

Diyagramlar İngilizce README’dedir ve birebir geçerlidir: [topoloji](README.md#topology) · [bir istek](README.md#one-request) · [bağlantılar](README.md#connections) · [tenant taşıma](README.md#moving-a-tenant-between-cells).

Özet: bir **hücre**, önünde pooler filosu olan bir PostgreSQL kümesidir (primary, yerel okuma replikası, DR replikası). Bir **tenant** tek hücredeki bir schema’dır. **Dizin** (`db0`) tenant→hücre eşlemesini tutar ve sıcak yolda değildir. Bugün ✅ hücreler, placement, önbellek, replika, fencing’li çevrimdışı ve kesintisiz taşıma, bölge etiketi, ikamet bölgeleri, bölgeli uygulama (`WRONG_REGION`, `regionGuard`), replika yerelliği, dizin replikaları ve stale-if-error, yazma belirteciyle kendi yazdığını okuma ve bağlantı araç takımı var. Doğrulanmadı: gerçek çok bölgeli ağ, yönetilen sağlayıcıda failover, çevrimiçi taşımada 10–50 GB’lık tenant ([bölge kılavuzu](docs/guides/regions.md)).

Bağlantılarda üç katman, üç bütçe vardır: istemci bağlantıları, pooler sunucu havuzları ve PostgreSQL `max_connections`. Çalışma anı yalnızca pooler’ı kullanır; yönetim (migration, provision, taşıma) oturum kilitleri tuttuğu için doğrudan bağlanır. Boyutlandırma formülleri, üretim PgBouncer ayarı, timeout uyumu ve failover: **[Bağlantı yönetimi ve PgBouncer](docs/guides/connections.md)**.

## Hızlı başlangıç

```sh
bun install
cd packages/db-multi
cp .env.example .env && docker compose up -d --wait
bun run cli bootstrap
bun run cli provision acme
```

Kod örneği ve tam anlatım için İngilizce README’deki [Quick start](README.md#quick-start) ve [başlangıç belgesi](packages/db-multi/docs/getting-started.md).

## Belgeler

Mevcut paket belgeleri şimdilik Türkçedir ve İngilizceye çevrilecektir ([paketleme planı](docs/design/plans/2026-10-18-oss-packaging-plan.md)). Yeni kılavuzlar İngilizcedir: [bağlantılar](docs/guides/connections.md), [bölgeler](docs/guides/regions.md), [kapasite](docs/guides/capacity.md), [baştan sona anlatım](docs/guides/walkthrough.md).

## Geliştirme

```sh
bun run db test              # packages/db-multi birim testleri
bun run single test          # packages/db-single birim testleri
```

## Lisans

Apache-2.0, bkz. [LICENSE](LICENSE). Katkı: [CONTRIBUTING.md](CONTRIBUTING.md), güvenlik: [SECURITY.md](SECURITY.md).
