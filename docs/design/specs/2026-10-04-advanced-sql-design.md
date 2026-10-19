# Alt proje E: Gelişmiş SQL

Tarih: 2026-10-04 · Üst belge: [`2026-10-03-db-roadmap-design.md`](2026-10-03-db-roadmap-design.md) · Durum: tasarım sahibi tarafından bölüm bölüm onaylandı, yazılı spec incelemede.

## Amaç

Uygulama sorgularında JSON, dizi, regex, tam metin, ağ adresi ve aralık işlemlerini; özyinelemeli CTE, küme işlemleri, pencere çerçevesi ve `GROUPING SETS` yapılarını yazabilmek. Bugün bunların hepsi codegen'de `SQL_UNSUPPORTED` verir (baseline ölçümü: parser operatörlerin ve fonksiyonların çoğunu ayrıştırır, izin listesi reddeder; beş yapıyı parser hiç ayrıştıramaz).

Başarı ölçütü: (a) her yeni yapı derlemede doğrulanır ve özgün metinden, yalnızca schema/fonksiyon nitelemesi ve çıktı adı düzenlemeleriyle üretilir; (b) gerçek PostgreSQL'de üç sürücüde (bun, postgres, pg) ve neon'da çalışır; (c) `readOnly` bayrağı hiçbir yeni yapıda yanlış `true` üretmez; (d) hiçbir yeni ortam değişkeni, `search_path` ya da çalışma anı SQL ayrıştırması eklenmez.

## Kapsam

**Kapsamda (üç plan, sıra E1 → E2 → E3; her plan kendi başına çalışır ve commit'lenir):**

- **E1 — operatör ve fonksiyon.** `->`, `->>`, `#>`, `#>>`, `@>`, `<@`, `?`, `?|`, `?&`, `~`, `~*`, `!~`, `!~*`; `unnest`, `generate_series`, `jsonb_set`, `jsonb_each`, `jsonb_each_text`, `jsonb_array_elements`, `concat`, `replace`, `trim`, `regexp_replace`, `regexp_match`, `regexp_matches`, `array_length`; `FROM` içinde tablo döndüren fonksiyonlar.
- **E2 — sorgu yapıları.** `WITH RECURSIVE`, `INTERSECT`/`EXCEPT` (`ALL` dahil), `IS [NOT] DISTINCT FROM`, pencere çerçevesi, `GROUPING SETS`/`ROLLUP`/`CUBE`/`grouping()`.
- **E3 — ek tipler.** `inet`, `cidr`, `macaddr`, `tsvector`, `tsquery`, `int4range`, `int8range`, `numrange`, `tsrange`, `tstzrange`, `daterange`, `serial`/`smallserial`/`bigserial`; bunlar için operatörler (`@@`, `&&`, `<<`, `>>`, `<<=`, `>>=`, `-|-`) ve tam metin fonksiyonları (`to_tsvector`, `to_tsquery`, `plainto_tsquery`, `websearch_to_tsquery`, `ts_rank`). Operatör ve fonksiyonlardan parser'ın ayrıştıramadıkları plan sırasında ölçülür ve belgelenir.

**Kapsam dışı (belgelenir):**

- DDL: `CREATE VIEW/FUNCTION/TRIGGER/EXTENSION`, `GENERATED … STORED`, dolar tırnaklama.
- **`citext` (roadmap'ten tek sapma, sahip kararı).** Extension tipi `pg_catalog`'da değildir; kurulduğu schema sağlayıcıya göre değişir (Neon'da çoğunlukla `public`, Supabase'te `extensions`). Derleyici DB'siz çalışır ve `search_path` yoktur, dolayısıyla schema yazılamaz; `CREATE EXTENSION` DDL'dir; yeni env istenmez. Karşılığı: `lower(email)` ile karşılaştırma ve `lower(email)` üzerinde unique index (E1'de destekli).
- `WITH ORDINALITY`, `EXCLUDE` çerçeve cümleciği, ifadeli çerçeve ofseti, multirange tipleri.
- Yeni tiplerin dizileri (aşağıya bakın).

## Kararlar

| Karar | Gerekçe |
|---|---|
| Üç plan, tek spec | Riskler bağımsız: E1 yalnızca izin listesi, E2 parser boşlukları, E3 tip eşlemesi. E3 belirsiz çıkarsa E1/E2 teslim edilmiş olur. Sahip kararı. |
| Fonksiyon izin listesine yalnızca **saf** (yan etkisiz) fonksiyon girer; `nextval`, `set_config`, `pg_advisory_lock` asla | `readOnly` doğruluğu buna dayanır: yan etkili fonksiyonlar statik ayrılamaz ([replicas.md](../../../packages/db/docs/replicas.md)). Birim testi her izinli fonksiyonu saf listeye karşı denetler. |
| Operatörler **niteliksiz** kalır | Parser `OPERATOR(pg_catalog.->)` biçimini üretmez. Operatör çözümü argüman tiplerine bağlıdır; yerleşik tipler üzerinde bir extension operatörü yerleşiği gölgeleyemez. |
| `FROM` içi fonksiyon kaynağında `SELECT *` reddedilir; takma ad ve `columnNames` zorunlu | Sütun adları derlemede bilinmez; camelCase eşlemesi tahmin edilmez (mevcut `*` kuralıyla tutarlı). |
| E2 yapıları **parser boşluğu** ile: parser kopyasında değiştirme/örtme, çıktı özgün kaynaktan | Mevcut mekanizma (`parser-gaps.ts`); bugün yalnızca migration'larda çalışır, çalışma anı sorgularına açılır. |
| `INTERSECT`/`EXCEPT` parser kopyasında `UNION`, `IS [NOT] DISTINCT FROM` `<>`/`=`, `GROUPING SETS` `ROLLUP` yazılır; AST'ye bağlama yok | Yürüteç yalnızca yaprak `SELECT`'lerin kapsamını, tablo nitelemesini, fonksiyon izin listesini ve soldaki dalın çıktı adlarını kullanır; ağaç biçimi ve öncelik bunlarda rol oynamaz. Anlam özgün metinden PostgreSQL'e gider. |
| `WITH RECURSIVE`: `RECURSIVE` örtülür ve `with.recursive` olarak bağlanır; CTE takma adı kendi gövdesinden **önce** kapsama girer | Aksi halde özyineleme başvurusu tenant tablosu gibi nitelenirdi. |
| Pencere çerçevesi katı: `ROWS\|RANGE\|GROUPS` + `UNBOUNDED`/`CURRENT ROW`/tam sayı sabiti + `PRECEDING`/`FOLLOWING`, `OVER (…)` parantezinin sonunda | `rows` adlı sütun ya da ifadeli ofset çerçeveyle karışmaz; serbest ifade `search_path`siz nitelemeyi atlatamaz. |
| `ROLLUP`/`CUBE`/`GROUPING SETS` yalnızca doğrudan `GROUP BY` öğesi; `grouping()` özel çağrı (nitelenmez) | Parser bunları `call` görür; başka yerde fonksiyon gibi kabul edilmez. `grouping()` fonksiyon değil söz dizimidir, `pg_catalog` nitelemesi geçersiz olurdu. |
| Kontrolsüz özyineleme için yeni mekanizma yok | Mevcut deadline iptali durdurur; entegrasyon testiyle pinlenir. |
| Yeni tipler yalnızca `pg_catalog` tipleri; hepsi `z.string()` | Üç sürücüde de scalar'lar string döner (ölçüldü: `inet`, `cidr`, `macaddr`, `tsvector`, `tsquery`, aralıklar). |
| **Yeni tipler yalnızca scalar**: dizi öğesi olarak (sütun, cast) `SQL_UNSUPPORTED` | Ölçüldü: `inet[]` bun/pg'de dizi, postgres.js'te ham `"{…}"` metni; aralık dizileri üçünde de ham metin; bun'da tip ayrıştırma kancası yok. Tek kontrol, sessiz sürücü ayrışmasını derlemede keser. Dizi gerekirse `array_agg(ip::text)` ya da JSON. |
| `serial` ailesi yalnızca `CREATE TABLE`/`ADD COLUMN`'da ve **niteliksiz**; katlamada `int2/int4/int8` + `NOT NULL` + varsayılanlı | `pg_catalog.serial` diye bir tip yoktur. PostgreSQL `nextval('s.t_id_seq'::regclass)` varsayılanı üretir; `tools copy` bu kalıbı zaten kabul eder (`validateDefault`). |

## E1: operatör ve fonksiyon

- `grammar.ts`: `operators`'a yeni ikili operatörler; `->`/`->>`/`#>`/`#>>` parser'da `member` düğümüdür, yeni `expr.member` kuralı `{ operand, member, op }`.
- `functions` kümesine fonksiyonlar (mevcut `function` kuralı `pg_catalog`'a niteler). `trim(both … from …)` söz dizimi plan başında AST'de ölçülür; ayrıştırılamıyorsa yalnızca tek argümanlı biçim desteklenir ve belgelenir.
- Yeni `from.call` kuralı `{ function, args, alias, columnNames, join, lateral }`; `casing.ts` bu kaynaklarda `*` açmaz.
- `?` operatörü: sürücülerin hiçbiri `?`'yi yer tutucu saymamalı (parametreler `$n`); gerçek DB'de üç sürücüde ve neon'da doğrulanır.

## E2: sorgu yapıları

`findParserGaps` çalışma anı sorgularına da uygulanır (bugün `migration ? … : undefined`). Her yapı strict bir düzenli ifadeyle, yalnızca `codeView` maskesinin tırnak dışı bölümünde ve tam anahtar sözcük sınırlarında bulunur:

| Yapı | Parser kopyasında | AST'ye bağlama |
|---|---|---|
| `INTERSECT [ALL]`, `EXCEPT [ALL]` | `UNION` (eşit uzunlukta boşlukla) | yok |
| `IS [NOT] DISTINCT FROM` | `<>` / `=` | yok |
| `GROUPING SETS` | `ROLLUP` | yok (yerleşim denetimi: doğrudan `groupBy` öğesi) |
| Pencere çerçevesi | boşlukla örtülür | yok |
| `WITH RECURSIVE` | `RECURSIVE` örtülür | `with.recursive = true` |

`readsOnly`: `INTERSECT`/`EXCEPT` birleşim sayıldığından her dal okuma olmalı; özyinelemeli CTE okumadır. `casing.ts`: özyinelemeli CTE'nin çıktı adları özyinelemesiz (soldaki) daldan; CTE'nin kendi gövdesindeki `*` reddedilir.

## E3: ek tipler

- `grammar.ts` `types`: yeni tipler (kanonik katalog adı = ad). `serial` ailesi ayrı: yalnızca tablo DDL'inde, nitelenmeden yazılır.
- `tables.ts`: yeni tipler `z.string()`; `serial` katlaması; yeni tip dizisi `SQL_UNSUPPORTED`.
- `compiler.ts` `checkDataType`: yeni tiplerin dizi öğesi olarak ve (serial için) DDL dışında kullanımını reddeder.
- `casing.ts` değişmez.

## Sınırlar (belgelenir)

- Yeni tiplerin dizileri desteklenmez; sorguda `array_agg(x::text)` ya da JSON kullanın. Sürücü sonuçlarındaki dizi ayrışması sorguda statik tespit edilemez (ifade tipi bilinmez); yalnızca açık `::tip[]` cast'i ve sütunlar reddedilir.
- Değiştirme tabanlı E2 yapılarının anlamı PostgreSQL'dedir; derleyici operatör önceliğini modellemez ve gerek duymaz.
- `to_tsvector(metin)` tek argümanlı biçimi `default_text_search_config`'e bağlıdır; ifade indekslerinde PostgreSQL kendisi reddeder.

## Test

- **Birim (her plan, TDD):** her operatör, fonksiyon, yapı ve tip için çıktı SQL'i ve `readOnly`; reddedilen katı-dışı biçimler (çerçevede ifade, `ROLLUP` `SELECT` listesinde, yeni tip dizisi, `serial` cast'te, `citext`); her değiştirme için mutasyon kontrolü (değiştirmeyi kaldırınca test düşer); saf fonksiyon listesi testi.
- **Entegrasyon (izole compose):** üç sürücü + neon üzerinde sonuçlar: JSON operatörleri ve `?`; `FROM generate_series`/`jsonb_each`; ağaç gezen özyinelemeli CTE; `INTERSECT`/`EXCEPT`; `IS DISTINCT FROM` ile `NULL`; çerçeveli pencere; `GROUPING SETS` toplamları; yeni tiplerin yaz-oku gidiş-dönüşü (string); `serial` + `stage-copy`; kontrolsüz özyinelemenin deadline ile iptali; replica okuma bağlamında yeni sorguların `readOnly` olarak çalışması.
- Mevcut paketler (birim, tsc, eslint, entegrasyon) yeşil kalır; `*.gen.ts` yeniden üretilir ve `codegen --check` geçer.

## Belgeler

`docs/queries.md` (yeni yapılar, tip tablosu, sınırlar), `src/core/sql/README.md` (desteklenen SQL), `docs/errors.md` değişmez (`SQL_UNSUPPORTED` mevcut), `docs/README.md` ve roadmap'te `citext` notu.

## Plan bölünmesi

1. **E1:** operatör + fonksiyon + `FROM` fonksiyonları (+ `?` sürücü doğrulaması).
2. **E2:** parser boşluğu altyapısını çalışma anına açma, beş yapı, `readsOnly`/`casing`.
3. **E3:** tipler, `serial`, zod, scalar-only kuralı, tip operatör/fonksiyonları, entegrasyon.
