# Alt proje A: bağlantı topolojisi ve pooler zorunluluğu

Tarih: 2026-10-03 · Üst belge: [`2026-10-03-db-roadmap-design.md`](2026-10-03-db-roadmap-design.md) · Durum: tasarım sahibi tarafından onaylandı, yazılı spec incelemede.

## Amaç

1. Runtime'ın bir **transaction-mode pooler** arkasında çalıştığını açılışta kanıtlamak; doğrudan bağlantıyı reddetmek.
2. Düğüm başına **replica URL'lerini** yapılandırmak ve doğrulamak (kullanımı C alt projesindedir).

Başarı ölçütü: runtime'ı doğrudan PostgreSQL URL'siyle açan bir uygulama `db.ready()`'de `POOLER_REQUIRED` alır; PgBouncer (yerel compose) arkasında aynı kod geçer; replica tanımsızken hiçbir davranış değişmez.

## Kapsam

**Kapsamda:** `DATABASE_REPLICA_URLS` ayrıştırma ve doğrulama, pooler sınaması, `POOLER_REQUIRED` hata kodu, `pooler` seçeneği, `doctor` denetimi, testler, belgeler.

**Kapsam dışı:**

- Replica'ya bağlanmak, havuz açmak, replica'ya sorgu yönlendirmek veya replica sağlığını izlemek (C). A yalnızca yapılandırmayı okur ve doğrular.
- Sınamanın Neon, Supabase ve Hyperdrive'da gerçek hesapla doğrulanması (B). A'da bu ortamlar için `pooler: "assumed"` yolu belgelenir.
- Yönetim (CLI, tools) davranışı: doğrudan bağlantı zorunluluğu (`DIRECT_CONNECTION_REQUIRED`) değişmez.

## Kararlar

| Karar | Gerekçe |
|---|---|
| Zorunlu olan, **herhangi bir transaction-mode pooler** | Supabase varsayılanı Supavisor, Workers'ta Hyperdrive PgBouncer değildir. |
| Sınama **davranışa** bakar, pooler adına değil | Pooler adı SQL'den güvenilir okunmaz (`SHOW pool_mode` yalnızca PgBouncer konsolunda var). |
| Replica için ikinci değişken `DATABASE_REPLICA_URLS` | `DATABASE_URLS` aynen kalır (geriye uyumlu, sıra = kimlik değişmezi korunur). Tipli fabrika seçeneği asıl kaynaktır, env yalnızca yükleyicidir. |
| `pooler: "verified"` (varsayılan) ve `pooler: "assumed"` | Sınama sezgiseldir; yanlış negatifte açık, adlandırılmış bir kaçış gerekir. "Zorunlu" böylece bilinçli karar olmadan atlanamaz. |
| Sınama `ready()`'de, `checkDatabases`'te değil | `checkDatabases` yönetimde de çağrılır; yönetim doğrudan bağlantı ister, orada pooler denetimi ters olurdu. |

## Tasarım

### 1. Yapılandırma (`src/core/config.ts`)

`DatabaseNode` genişler:

```ts
export interface DatabaseNode {
  id: string;
  url: string;
  /** Salt okunur replica URL'leri; A yalnızca doğrular, kullanmaz (C). Yönetim yok sayar. */
  replicas: readonly string[];
}
```

- `createConfig(value)` imzası ve `DATABASE_URLS` kuralları değişmez; her düğümün `replicas` alanı `[]` olur.
- Yeni `createConfig(value, replicas?)` ikinci argümanı: `string | readonly string[]` — `db0=url` biçimli girdiler (virgüllü metin veya dizi). Aynı anahtar birden çok kez yazılarak düğüme birden çok replica eklenir: `db0=urlA,db0=urlB,db1=urlC`.
- `loadConfig(env)` `DATABASE_URLS` ile birlikte `DATABASE_REPLICA_URLS`'i (yoksa boş) okur.
- Doğrulama (hepsi `INVALID_CONFIG`; mesajlar değer içermez, yalnızca kural ve düğüm kimliği):
  - girdi `db<N>=<url>` biçiminde olmalı; anahtar mevcut bir düğüm kimliği olmalı;
  - replica URL'si `isDatabaseUrl` kurallarına uymalı (`postgres:`/`postgresql:` şeması, `options`/`search_path` parametresi yok);
  - bütün URL'ler (primary ve replica) listeler arasında tekil olmalı;
  - düğüm başına en çok **8** replica.
- Yönetim (`managementSettings`) replica'ları taşır ama kullanmaz.

### 2. Pooler sınaması (`src/core/tenants/pooler.ts`, yeni)

Tek amaç: bir düğümün URL'sinin transaction pooler'a gittiğini kanıtlamak.

```ts
/** `true`: aynı sunucu oturumunu iki ayrı istemci görmüş, yani pooler kesin. `false`: hiç görülmedi. */
export async function usesTransactionPooler(driver: Driver, url: string, options: { deadlineMs: number; rounds?: number }): Promise<boolean>;
```

Algoritma:

1. Sürücüden **geçici, ayrı bir havuz** aç (`max: 2`). Böylece `poolMax: 1` (Workers) ve çalışan havuz etkilenmez.
2. En çok `rounds` (varsayılan 10) tur: havuzdan iki bağlantı ayır (`a`, `b`); sırayla (aynı anda değil) `SELECT pg_backend_pid()` çalıştır; ikisini bırak.
3. Bir turda iki pid eşitse **hemen `true`** döner.
4. Hiçbir turda eşit çıkmazsa `false`.
5. Havuzu her durumda kapat; bütün sınama `deadlineMs` ile sınırlıdır (süre dolunca `DATABASE_TIMEOUT`); `ready()` bunu `statementTimeoutMs + 1 sn` olarak verir.

Neden güvenilir:

- Doğrudan bağlantıda iki ayrı istemci ayrı backend alır; **aynı pid görülemez**. Bu yüzden `true` yanlış pozitif vermez.
- Pooler'da ardışık deyimler çoğunlukla aynı sunucu bağlantısına düşer (yerel PgBouncer 1.24'te 50/50 tur aynı pid; doğrudan bağlantıda 50/50 tur farklı pid — 2026-10-03 spike'ı).
- `false` ya "doğrudan" ya da "çok yoğun / dairesel dağıtan pooler" demektir; yanlış negatif mümkündür, bu yüzden `assumed` kaçışı vardır.
- Advisory lock kullanılmaz: transaction modunda kilit sunucu bağlantısında sızabilir.

### 3. `ready()` entegrasyonu (`src/core/runtime.ts`, `src/core/errors.ts`)

- `RuntimeOptions.pooler?: "verified" | "assumed"` (varsayılan `"verified"`).
- `ready()` mevcut `checkDatabases(...)` başarılı olduktan sonra, `verified` iken her düğümde `usesTransactionPooler` çalıştırır; `false` ise
  `AppError("POOLER_REQUIRED", "Database <id> is reachable without a transaction pooler; use a transaction-mode pooler URL or set pooler: \"assumed\"")` fırlatır. Mesaj yalnızca düğüm kimliğini içerir, URL içermez.
- Sınama düğümler arasında paralel çalışır. Sınama sırasında bağlantı kurulamazsa mevcut `DATABASE_UNAVAILABLE`/`DATABASE_TIMEOUT` kodları döner (`POOLER_REQUIRED` değil).
- **Önbellek:** düğüm başına başarılı sonuç `Database` örneğinde saklanır; `ready()` her çağrıda (sağlık uç noktası) yeniden sınamaz. Eşzamanlı çağrılar aynı sınamayı bekler. Başarısız sonuç saklanmaz (sonraki çağrıda yeniden denenir).
- **Sıcak yola etkisi yok:** sınama yalnızca `ready()` içinde; `withTenant`/sorgu yolu değişmez.
- **Workers:** istek başına havuz kurulur; her istekte `ready()` çağrılmamalı. Belge: `ready()` başlangıçta ve `/ready` uç noktasında çağrılır, istek yolunda değil.
- **Hyperdrive:** sınamanın orada çalışıp çalışmadığı bu projede doğrulanmadı (B'de doğrulanacak). Bu nedenle belge, doğrulanana kadar Hyperdrive için `pooler: "assumed"` önerir ve bunu açıkça "doğrulanmamış" diye işaretler.

### 4. `doctor` (`src/core/tools/doctor.ts`, `src/core/cli.ts`)

- `ready()` gerçek korumadır; `doctor` ek kanıt sağlar.
- Yeni değer almayan bayrak `--pooled-urls`: runtime URL'lerini (`DATABASE_URLS` biçimi, aynı sıra) gizli girişle sorar, argv'ye yazmaz. Mevcut `--from-url` ve `--pgbouncer-url` ile aynı deseni kullanır (script'te `printf '%s\n' "$URLS" | …`).
- Verilirse her düğüm için `pooled_runtime` denetimi eklenir: `usesTransactionPooler` sonucu; başarısızsa "runtime URL'si transaction pooler'a gitmiyor". Girilen URL sayısı `DATABASE_URLS` ile aynı değilse `INVALID_CONFIG` (runtime URL'lerinin kimlik denetimi `ready()`'nin işidir).
- Verilmezse `pooled_runtime`, `externalChecks` listesine "doğrulanmamış" olarak girer ve `ok` etkilenmez.
- Mevcut `direct_connection` (yönetim URL'si pooler'a gidiyorsa hata) olduğu gibi kalır; iki denetim birbirinin aynasıdır.
- `--pgbouncer-url` konsol denetimi (`global_pool_mode`) isteğe bağlı kalır ve belgede "PgBouncer'a özel ek bilgi" diye anılır; zorunluluğun kaynağı artık davranış sınamasıdır. `externalChecks`'teki `effective_pgbouncer_mode` metni "PgBouncer kullanılıyorsa" biçimine daraltılır.

### 5. Kırıcı etki

Runtime'ı doğrudan bağlantıyla açan her kurulum `ready()`'de `POOLER_REQUIRED` alır. jamaster-api zaten PgBouncer üzerinden çalışıyor. `createDatabase`'i `ready()` çağırmadan kullanan kod sınamayı hiç görmez (zorunluluk `ready()`'de uygulanır); belge bunu başlangıçta `ready()` çağırma zorunluluğu olarak yazar.

## Testler

**Birim (`src/__tests__/unit/`):**

- `config` — `DATABASE_REPLICA_URLS` ayrıştırma: geçerli (çok replica, birden çok düğüm); geçersiz kimlik, bilinmeyen düğüm, yinelenen URL, replica = primary, `options`/`search_path`, 9. replica; hata mesajlarının URL içermemesi.
- `pooler` (sahte sürücü): aynı pid → `true` ve ilk turda durur; hep farklı pid → `false` ve `rounds` tur sonra; sorgu hatası ve deadline → hata iletilir; havuz her durumda kapanır.
- `database`/`runtime` — `ready()`: `verified` + doğrudan sahte → `POOLER_REQUIRED` (mesajda URL yok); `assumed` → sınama yok; başarılı sonuç önbelleği (ikinci `ready()` yeniden sınamaz); başarısız sonuç önbelleğe alınmaz; bağlantı hatası `POOLER_REQUIRED` değil.
- `doctor` — `pooled_runtime` ok / hata; bayrak yokken `externalChecks`'te görünmesi.

**Entegrasyon (`RUN_INTEGRATION=1`, yerel compose):**

- Doğrudan :5540 → `usesTransactionPooler` `false`, `ready()` `POOLER_REQUIRED`.
- PgBouncer :5543 → `true`, `ready()` geçer. Üç sürücüde de (bun, postgres, pg).
- Mevcut entegrasyon testlerinde runtime'ı doğrudan URL'yle açan yerler pooled URL'ye ya da `pooler: "assumed"`'e geçer (`helpers.ts` `TEST_POOLED_URLS` zaten pooled).

**Başarısızlık modları açıkça test edilir:** hiç aynı pid çıkmayan pooler (yanlış negatif simülasyonu) `POOLER_REQUIRED` verir ve `assumed` ile geçilir.

## Dosyalar

| Dosya | Değişiklik |
|---|---|
| `packages/db/src/core/config.ts` | `DatabaseNode.replicas`, `createConfig` ikinci argüman, `loadConfig` `DATABASE_REPLICA_URLS` |
| `packages/db/src/core/tenants/pooler.ts` | yeni: `usesTransactionPooler` |
| `packages/db/src/core/runtime.ts` | `pooler` seçeneği, `ready()` sınaması ve önbelleği |
| `packages/db/src/core/errors.ts` | gerekmez (kod `AppError` ile fırlatılır); `docs/errors.md`'ye eklenir |
| `packages/db/src/core/tools/doctor.ts`, `core/cli.ts` | `--pooled-urls`, `pooled_runtime` denetimi |
| `packages/db/.env.example` | `DATABASE_REPLICA_URLS` açıklaması (yorum satırı) |
| `packages/db/docs/configuration.md`, `getting-started.md`, `operations.md`, `errors.md`, `cli.md`, `jamaster-api.md` | zorunluluk, `pooler` seçeneği, `POOLER_REQUIRED`, `doctor` tablosu, replica env |
| `packages/db/src/__tests__/…` | yukarıdaki testler |

## Riskler

- **Sezgisel sınama yanlış negatif verebilir** (ör. sunucu bağlantılarını dairesel dağıtan veya çok yoğun pooler). Hafifletme: 10 tur, açık `assumed` kaçışı, hata mesajında çıkış yolu.
- **Hyperdrive'da doğrulanmadı** — B'ye bırakıldı; geçici olarak `assumed`.
- **`ready()` çağrılmayan uygulamada zorunluluk uygulanmaz.** Belge ve `dbMiddleware` örnekleri `ready()`'yi başlangıçta çağırır.
