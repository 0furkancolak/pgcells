# Advanced SQL E3: Ek Tipler Implementation Plan

> **Durum (2026-10-19): uygulandı.** Onay kutuları işaretlenmedi; gerçek durumun kaynağı koddur, testlerdir ve [yol haritası](2026-10-18-roadmap-remaining.md)dır.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `inet`, `cidr`, `macaddr`, `tsvector`, `tsquery`, aralık tipleri (`int4range`, `int8range`, `numrange`, `tsrange`, `tstzrange`, `daterange`) ve `serial`/`smallserial`/`bigserial` migration'larda ve sorgularda kabul edilir, zod tablo tipleri üretilir ve üç sürücüde (bun, postgres, pg) ve neon'da aynı değerleri verir; ilgili operatör ve tam metin fonksiyonları eklenir.

**Architecture:** Yeni tipler `grammar.ts`'in `types` tablosuna girer (hepsi `pg_catalog`, derleme bugünkü gibi `"pg_catalog"."inet"` yazar) ve `z.string()` olur. Üç sürücüde de scalar'ları string döner; dizi biçimleri ayrıştığı için (postgres.js ham metin verir) yeni tipler **yalnızca scalar**'dır ve dizi öğesi olarak derlemede reddedilir. `serial` ailesi gerçek bir tip değil `CREATE TABLE`/`ADD COLUMN` söz dizimi olduğundan yalnızca sütun tanımında ve niteliksiz kabul edilir; katlamada `int2/int4/int8` + `NOT NULL` + varsayılanlıdır.

**Tech Stack:** Bun + TypeScript, `pgsql-ast-parser` 12.0.2, `bun:test`; entegrasyon için izole compose projesi.

**Spec:** `docs/superpowers/specs/2026-10-04-advanced-sql-design.md` (E3 bölümü, Kararlar, Sınırlar). Ön koşul: E1 (`…-e1-operators.md`) ve E2 (`…-e2-structures.md`) tamamlanmış olmalı; bu plan `src/__tests__/unit/sql-advanced.test.ts` ve `src/__tests__/integration/sql-advanced.test.ts` dosyalarını genişletir (E1 `withSchema`, `context`, `schemaName` yardımcılarını koyar).

## Global Constraints

- **`search_path` hiçbir biçimde kullanılmaz;** tipler `"pg_catalog"."ad"` olarak nitelenir. `serial` ailesi nitelenmez (`pg_catalog.serial` yoktur).
- **Yeni ortam değişkeni yok.** Çalışma anında SQL ayrıştırılmaz.
- **`citext` kapsam dışı** (extension tipi; schema'sı sağlayıcıya göre değişir, derleyici schema'yı bilemez, `CREATE EXTENSION` DDL'dir): `unsupported type: citext` ile reddedilir; karşılığı `lower(email)`.
- **Yeni tipler yalnızca scalar:** dizi öğesi olarak (sütun, cast, çok boyutlu) `SQL_UNSUPPORTED`.
- Parser'ın ayrıştıramadığı operatörler (`-|-`, `<<=`, `>>=`) desteklenmez ve belgelenir.
- Yorumlar Türkçe, hata mesajları İngilizce ve kararlı (`SQL_UNSUPPORTED`).
- Her görev: önce başarısız test (RED), sonra minimal kod; her görev bir commit. Commit mesajı sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push/PR/merge yok.
- Komutlar `packages/db` içinde: birim `bun test src/__tests__/unit/<dosya>`, tip `bunx tsc --noEmit`, lint `bunx eslint <dosyalar> --fix`. Entegrasyon yalnızca izole compose projesinde (`docker compose -p dbsql …`); paylaşılan jamaster stack'ine (5540/5541/5543 portlarını tutan `jamaster-*` container'ları) dokunulmaz — portlar doluysa durulur.

## Ölçülmüş zemin (plan yazılırken, PostgreSQL 16.15; bun, postgres.js, pg)

- Scalar değerler **üç sürücüde de string**: `inet` `"10.0.0.1/24"`, `cidr` `"10.0.0.0/8"`, `macaddr` `"08:00:2b:01:02:03"`, `tsvector` `"'a':1 'b':2"`, `tsquery` `"'a'"`, `int4range` `"[1,5)"`, `daterange` `"[2026-01-01,2026-02-01)"`, `numrange` `"[1.5,2.5)"`, `tstzrange` `["2026-01-01 00:00:00+00","2026-02-01 00:00:00+00")`. Parametre olarak string verip `$1::inet`, `$1::int4range`, `$1::tsvector` yazmak üç sürücüde çalışır.
- **Diziler ayrışır:** `inet[]` bun/pg'de dizi, postgres.js'te ham `"{10.0.0.1}"` metni; `citext[]` ve aralık dizileri üçünde de ham metin; Bun SQL'de tip ayrıştırma kancası yoktur. Bu yüzden scalar-only.
- `serial`: PostgreSQL `nextval('s.t_id_seq'::regclass)` varsayılanı ve sahipli sequence üretir; `tools/copy.ts` (`validateDefault`) bu kalıbı tanır.
- Parser: `::inet`, `::int4range`, `to_tsvector(...) @@ to_tsquery(...)`, `@@`, `&&`, `<<`, `>>` ayrıştırılır; `-|-`, `<<=`, `>>=` **ayrıştırılamaz**. `pg_catalog`'da `to_tsvector`, `to_tsquery`, `plainto_tsquery`, `websearch_to_tsquery`, `ts_rank` vardır.

## Review Focus

- Yeni tipin zod eşlemesi unutulursa üretilen modülde sessizce `undefined` çıkar → Task 1 (her `types` girdisi için eşleme testi).
- Yeni tip dizisi hiçbir yoldan sızmaz: sütun, cast, çok boyutlu (`inet[][]`), `ARRAY[…]::cidr[]` → Task 1.
- `serial` yalnızca sütun tanımında geçer: cast, `ALTER … TYPE`, dizi, tırnaklı `"serial"`, schema'lı → Task 1.
- Gerçek veride yaz-oku gidiş-dönüşü ve operatörler dört sürücüde aynı sonucu verir → Task 2.
- `serial` sütunlu tenant schema'sı kopyalanınca sayaç kaldığı yerden devam eder → Task 2.

---

### Task 1: Tipler, scalar-only kuralı, `serial`, zod, operatör ve fonksiyonlar

**Files:**
- Modify: `src/core/sql/grammar.ts` (`scalarOnly`, `types`, `serials`, `columnType`, operatörler, fonksiyonlar)
- Modify: `src/core/sql/compiler.ts` (`checkDataType`: scalar-only ve `serial`)
- Modify: `src/core/sql/tables.ts` (`columnType`/`defineColumn`: `serial`; `ZOD`)
- Test: `src/__tests__/unit/sql-advanced.test.ts` (genişlet)

**Interfaces:**
- Consumes: `prepareQuery`, `prepareMigration(source).statements/bind`, `foldTables(statements)`, `tableModules(scope, shapes)`, E1/E2'nin `bind`, `rejects`, `qualified`, `schema` yardımcıları.
- Produces: `grammar.ts`'ten `scalarOnly: Set<string>` ve `serials: Readonly<Record<string, string>>`; `grammar.columnType` kind'ı; `checkDataType(node, context, column = false)`.

- [ ] **Step 1: Başarısız testleri ekle**

`sql-advanced.test.ts` import satırlarını genişlet:

```ts
import { expect, test } from "bun:test";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { functions, types } from "../../core/sql/grammar";
import { foldTables, tableModules } from "../../core/sql/tables";
```

ve dosyanın sonuna ekle:

```ts
const NEW_TYPES = ["inet", "cidr", "macaddr", "tsvector", "tsquery", "int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange"];
const fold = (ddl: string) => foldTables(prepareMigration(ddl).statements);
const moduleOf = (ddl: string) => tableModules("tenant", fold(ddl)).get("src/tables/tenant/t.gen.ts") as string;

test("new scalar types are qualified with pg_catalog in casts", () => {
  for (const type of NEW_TYPES)
    expect(bind(`SELECT c::${type} AS v FROM hosts`)).toBe(`SELECT c::"pg_catalog"."${type}" AS v FROM ${qualified}hosts`);
  expect(prepareQuery("SELECT c::inet AS v FROM hosts").readOnly).toBe(true);
});

test("every builtin type has a zod mapping and the new types are strings", () => {
  for (const type of new Set(Object.values(types))) expect(moduleOf(`CREATE TABLE t (c ${type} NOT NULL)`)).not.toContain("undefined");
  for (const type of NEW_TYPES) expect(moduleOf(`CREATE TABLE t (c ${type})`)).toContain("  c: z.string().nullable(),");
});

test("serial types are written bare in CREATE TABLE / ADD COLUMN and fold to integer, NOT NULL, with a default", () => {
  expect(prepareMigration("CREATE TABLE t (id serial PRIMARY KEY, big bigserial, small smallserial)").bind(schema)).toEqual([
    `CREATE TABLE ${qualified}t (id serial PRIMARY KEY, big bigserial, small smallserial)`,
  ]);
  expect(prepareMigration("ALTER TABLE t ADD COLUMN extra SERIAL").bind(schema)).toEqual([`ALTER TABLE ${qualified}t ADD COLUMN extra SERIAL`]);
  const shapes = fold("CREATE TABLE t (id serial PRIMARY KEY, big bigserial, small smallserial, plain integer)");
  expect(shapes.tables.get("t")).toEqual([
    { name: "id", type: "int4", arrayDepth: 0, notNull: true, hasDefault: true },
    { name: "big", type: "int8", arrayDepth: 0, notNull: true, hasDefault: true },
    { name: "small", type: "int2", arrayDepth: 0, notNull: true, hasDefault: true },
    { name: "plain", type: "int4", arrayDepth: 0, notNull: false, hasDefault: false },
  ]);
  const module = moduleOf("CREATE TABLE t (id serial PRIMARY KEY, big bigserial)");
  for (const line of ["  id: z.number().int(),", "  id: z.number().int().optional(),", "  big: z.string(),", "  big: z.string().optional(),"])
    expect(module).toContain(line);
});

test("new types are scalar-only: arrays of them are rejected everywhere", () => {
  for (const ddl of ["CREATE TABLE t (c inet[])", "CREATE TABLE t (c int4range[][])", "CREATE TABLE t (c tsvector[])"])
    expect(() => prepareMigration(ddl)).toThrow(/arrays are unsupported/);
  rejects("SELECT $1::inet[] AS v FROM hosts", /arrays are unsupported/);
  rejects("SELECT ARRAY[ip]::cidr[] AS v FROM hosts", /arrays are unsupported/);
  expect(bind("SELECT ARRAY[1, 2]::integer[] AS v FROM hosts")).toContain('"pg_catalog"."int4"[]');
});

test("serial is a column-definition syntax only; citext and other extension types are rejected", () => {
  rejects("SELECT $1::serial AS v FROM hosts", /unsupported type: serial/);
  for (const ddl of ["ALTER TABLE t ALTER COLUMN c TYPE bigserial", "CREATE TABLE t (c serial[])", 'CREATE TABLE t (c "serial")'])
    expect(() => prepareMigration(ddl)).toThrow(/unsupported type: (big)?serial/);
  expect(() => prepareMigration("CREATE TABLE t (c public.serial)")).toThrow(/explicit schema qualification/);
  rejects("SELECT c::citext AS v FROM hosts", /unsupported type: citext/);
  expect(() => prepareMigration("CREATE TABLE t (c citext)")).toThrow(/unsupported type: citext/);
});

test("tsvector, overlap and network operators and the full-text functions compile", () => {
  expect(
    bind("SELECT id FROM docs WHERE tsv @@ to_tsquery('simple', $1) AND ip << '10.0.0.0/8'::inet AND ip >> '10.0.0.1'::inet AND span && '[1,5)'::int4range"),
  ).toBe(
    `SELECT id FROM ${qualified}docs WHERE tsv @@ "pg_catalog"."to_tsquery"('simple', $1) AND ip << '10.0.0.0/8'::"pg_catalog"."inet" AND ip >> '10.0.0.1'::"pg_catalog"."inet" AND span && '[1,5)'::"pg_catalog"."int4range"`,
  );
  for (const name of ["to_tsvector", "to_tsquery", "plainto_tsquery", "websearch_to_tsquery", "ts_rank"])
    expect(bind(`SELECT ${name}(c) AS v FROM docs`)).toBe(`SELECT "pg_catalog"."${name}"(c) AS v FROM ${qualified}docs`);
  for (const operator of ["-|-", "<<=", ">>="]) rejects(`SELECT id FROM docs WHERE span ${operator} other`);
  expect(prepareQuery("SELECT id FROM docs WHERE tsv @@ to_tsquery('simple', $1)").readOnly).toBe(true);
});
```

(`functions` import'u E1'de zaten vardır; yinelenen import satırı oluşursa tek satırda birleştir.)

- [ ] **Step 2: Başarısızlığı doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: yeni altı test FAIL (`unsupported type: inet`, `unsupported type: serial`, `unsupported operator`, `unsupported function: to_tsvector`, `undefined` içeren modül).

- [ ] **Step 3: `grammar.ts`**

1. `types` tanımının **üstüne** scalar-only listesi, `types`'ı şablon dizisine çevir:

```ts
// Üç sürücüde de string dönen ama dizi biçimi sürücüler arasında ayrışan (postgres.js ham metin verir) pg_catalog tipleri: yalnızca scalar.
const scalarOnlyList = "inet,cidr,macaddr,tsvector,tsquery,int4range,int8range,numrange,tsrange,tstzrange,daterange";
export const scalarOnly = commaSet(scalarOnlyList);
```

`types` içindeki uzun dizgiyi şablon dizisi yap ve sonuna listeyi ekle:

```ts
    `uuid,text,boolean=bool,bool,smallint=int2,int2,integer=int4,int=int4,int4,bigint=int8,int8,real=float4,float4,double precision=float8,float8,numeric,decimal=numeric,varchar,bpchar,bytea,json,jsonb,date,time,timetz,timestamp,timestamptz,interval,${scalarOnlyList}`
      .split(",")
      .map((entry) => [entry.split("=")[0], entry.split("=").pop()]),
```

2. `types`'ın altına:

```ts
/** `serial` ailesi gerçek bir tip değil, CREATE TABLE/ADD COLUMN söz dizimidir: niteliksiz yazılır, PostgreSQL `int2/int4/int8` + sequence + varsayılana açar. */
export const serials: Readonly<Record<string, string>> = { smallserial: "int2", serial: "int4", bigserial: "int8" };
```

3. `functions` şablon dizisine bir satır ekle (E1'in eklediği satırın altına):

```ts
to_tsvector to_tsquery plainto_tsquery websearch_to_tsquery ts_rank
```

4. `operators` `binary` kümesinin sonuna ekle: `,@@,&&,<<,>>`.

5. `grammar` nesnesinin üstüne ortak tip kuralı, `dataType`'ı onunla değiştir, `columnType` ekle ve `column` kuralını ona bağla:

```ts
const dataType = { array: { kind: null, arrayOf: "dataType" }, "*": { name: null, schema: null, doubleQuoted: null, config: null } } as const;
```

`grammar` içinde: `dataType, columnType: dataType,` (eski `dataType: { array: …, "*": … },` satırının yerine) ve:

```ts
  column: { column: { kind: null, name: "name", dataType: "columnType", constraints: "constraint" } },
```

- [ ] **Step 4: `compiler.ts`**

Import'a `scalarOnly`, `serials` ekle:

```ts
import { accessMethods, types as builtinTypes, functionAliases, functions, grammar, keywords, operators, scalarOnly, serials, specialCalls } from "./grammar";
```

`checkDataType` imzasını ve başını değiştir:

```ts
function checkDataType(node: Node, context: Context, column = false): void {
  // Sabitlenmiş parser dizi elemanı niteleyicilerini kaynak aralığından çıkarır: iki kez yazmak yerine reddet.
  if (node.kind === "array") {
    if ((node.arrayOf as Node).config !== undefined) unsupported("array type modifiers are unsupported");
    // Yeni tiplerin dizi biçimi sürücüler arasında ayrışır (postgres.js ham metin döndürür): yalnızca scalar.
    let element = node.arrayOf as Node;
    while (element.kind === "array") element = element.arrayOf as Node;
    if (scalarOnly.has(String(element.name))) unsupported(`${String(element.name)} arrays are unsupported (drivers disagree on their value shape); use a scalar column, ::text or JSON`);
    return;
  }
  const name = identifier(node.name);
  // serial gerçek bir tip değil, sütun tanımı söz dizimidir: yalnızca çıplak, niteliksiz ve sütunda; yazıldığı gibi kalır.
  if (column && Object.hasOwn(serials, name) && node.schema === undefined && !node.doubleQuoted && node.config === undefined) return;
  if (node.schema !== "pg_catalog") stripSourceSchema(node, context);
```

(önceki `const name = identifier(node.name);` ve `if (node.schema !== "pg_catalog") stripSourceSchema(node, context);` satırları bu bloğa taşındı; fonksiyonun geri kalanı değişmez.)

`SEMANTIC_CHECKS`'te `dataType` satırının altına:

```ts
  columnType: (node, _type, context) => checkDataType(node, context, true),
```

- [ ] **Step 5: `tables.ts`**

Import: `import { scalarOnly, serials, types as builtinTypes } from "./grammar";`

`columnType` fonksiyonunda `builtinTypes` satırının üstüne:

```ts
  if (Object.hasOwn(serials, def.name)) return { type: serials[def.name] as string, arrayDepth: 0 };
```

`defineColumn` içinde `columns.push(column);` satırından sonra:

```ts
  // serial: PostgreSQL NOT NULL + sequence varsayılanı ekler.
  if (def.dataType.kind !== "array" && Object.hasOwn(serials, def.dataType.name)) Object.assign(column, { notNull: true, hasDefault: true });
```

`ZOD` içinde `"z.string()"` satırını şablon dizisi yap:

```ts
    "z.string()": `text,varchar,bpchar,int8,numeric,time,timetz,interval,${[...scalarOnly].join(",")}`,
```

- [ ] **Step 6: Testlerin geçtiğini doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: PASS. `bun test` çıktısında `typeof def.dataType.name` tip hatası çıkarsa `tables.ts`'teki `def.dataType` DataTypeDef birleşimidir: `kind !== "array"` daraltması yetmezse `as { name: string }` ile daralt.

- [ ] **Step 7: Mutasyon**

(a) `scalarOnly`'den `tsvector` sil → "zod mapping" testi (`tsvector` için `undefined`) düşer, ek olarak tsvector dizisi artık kabul edilir ve "scalar-only" testi düşer; geri koy. (b) `checkDataType`'taki `column &&` koşulunu `true &&` yap → `$1::serial` testi düşer; geri al. (c) `defineColumn`'daki `Object.assign` satırını sil → katlama testi düşer; geri al.

- [ ] **Step 8: Tüm birim paketi, tip, lint**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint src/core/sql src/__tests__/unit/sql-advanced.test.ts --fix`
Expected: hepsi PASS/temiz. Mevcut bir assertion `serial`/yeni tipleri reddetmeyi bekliyorsa (ör. `sql.test.ts` "rejects unknown types" listesinde `inet`/`serial` varsa) yeni davranışa göre güncellenir ve ledger'a `Ruling:` yazılır.

- [ ] **Step 9: Commit**

```bash
git add src/core/sql/grammar.ts src/core/sql/compiler.ts src/core/sql/tables.ts src/__tests__/unit/sql-advanced.test.ts
git commit -m "sql: inet/cidr/macaddr/tsvector/tsquery/range types (scalar-only), serial columns, full-text and overlap operators

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Gerçek PostgreSQL'de doğrulama, belgeler ve kapanış

**Files:**
- Modify: `src/__tests__/integration/sql-advanced.test.ts` (E1/E2'nin dosyasını genişlet)
- Modify: `docs/queries.md`, `docs/configuration.md`, `src/core/sql/README.md`

**Interfaces:**
- Consumes: E1'in `withSchema(setup, work)`, `schemaName()`; `raw`, `q`, `integration`; `copySchema`, `fingerprint` (`../../core/tools/copy`).
- Produces: yok.

- [ ] **Step 1: Entegrasyon testlerini ekle**

`src/__tests__/integration/sql-advanced.test.ts` import'larına `import { copySchema, fingerprint } from "../../core/tools/copy";` ekle ve dosyanın sonuna:

```ts
const HOSTS = `CREATE TABLE hosts (id serial PRIMARY KEY, label text NOT NULL, ip inet NOT NULL, net cidr, mac macaddr, doc tsvector, topic tsquery,
  span int4range, big int8range, price numrange, local_span tsrange, valid tstzrange, day daterange)`;
const seedHosts = prepareQuery(
  `INSERT INTO hosts (label, ip, net, mac, doc, topic, span, big, price, local_span, valid, day) VALUES
   ('a', '10.0.0.1/24', '10.0.0.0/8', '08:00:2b:01:02:03', to_tsvector('simple', 'quick brown fox'), to_tsquery('simple', 'fox'), '[1,5)', '[1,5)', '[1.5,2.5)',
    '[2026-01-01 00:00:00,2026-02-01 00:00:00)', '[2026-01-01 00:00:00+00,2026-02-01 00:00:00+00)', '[2026-01-01,2026-02-01)'),
   ('b', '192.168.0.1', NULL, NULL, to_tsvector('simple', 'lazy dog'), NULL, '[10,20)', NULL, NULL, NULL, NULL, NULL)`,
);

integration("network, text-search and range types round-trip as strings on every driver", async () => {
  await withSchema(HOSTS, (run) =>
    run("sql-advanced", async (tenant) => {
      await tenant.query(seedHosts);
      expect(
        await tenant.query(prepareQuery("SELECT id, ip, net, mac, doc, topic, span, big, price, local_span, valid, day FROM hosts WHERE label = 'a'")),
      ).toEqual([
        {
          id: 1,
          ip: "10.0.0.1/24",
          net: "10.0.0.0/8",
          mac: "08:00:2b:01:02:03",
          doc: "'brown':2 'fox':3 'quick':1",
          topic: "'fox'",
          span: "[1,5)",
          big: "[1,5)",
          price: "[1.5,2.5)",
          localSpan: '["2026-01-01 00:00:00","2026-02-01 00:00:00")',
          valid: '["2026-01-01 00:00:00+00","2026-02-01 00:00:00+00")',
          day: "[2026-01-01,2026-02-01)",
        },
      ]);
      // Parametreyle yazıp okumak: değer tipi string, cast parametrede.
      await tenant.query(prepareQuery("INSERT INTO hosts (label, ip, span, valid) VALUES ($1, $2::inet, $3::int4range, $4::tstzrange)"), [
        "c",
        "172.16.0.1",
        "[10,20)",
        "[2026-03-01 00:00:00+00,2026-04-01 00:00:00+00)",
      ]);
      expect(await tenant.query(prepareQuery("SELECT ip, span, valid FROM hosts WHERE label = $1"), ["c"])).toEqual([
        { ip: "172.16.0.1", span: "[10,20)", valid: '["2026-03-01 00:00:00+00","2026-04-01 00:00:00+00")' },
      ]);
    }),
  );
});

integration("tsvector, network and range operators evaluate", async () => {
  await withSchema(HOSTS, (run) =>
    run("sql-advanced", async (tenant) => {
      await tenant.query(seedHosts);
      const labels = async (where: string, values: unknown[] = []) =>
        (await tenant.query(prepareQuery(`SELECT label FROM hosts WHERE ${where} ORDER BY label`), values)).map((row) => (row as { label: string }).label);
      expect(await labels("doc @@ to_tsquery('simple', $1)", ["fox"])).toEqual(["a"]);
      expect(await labels("doc @@ plainto_tsquery('simple', 'quick fox')")).toEqual(["a"]);
      expect(await labels(`doc @@ websearch_to_tsquery('simple', '"quick brown"')`)).toEqual(["a"]);
      expect(await labels("ip << '10.0.0.0/8'::inet")).toEqual(["a"]);
      expect(await labels("ip >> '10.0.0.1'::inet")).toEqual(["a"]);
      expect(await labels("span && '[4,10)'::int4range")).toEqual(["a"]);
      expect(await labels("span @> $1::integer", [3])).toEqual(["a"]);
      expect(await tenant.query(prepareQuery("SELECT ts_rank(doc, to_tsquery('simple', 'fox')) > 0 AS ranked, ARRAY[1, 2] && ARRAY[2, 3] AS overlap FROM hosts WHERE label = 'a'"))).toEqual([
        { ranked: true, overlap: true },
      ]);
    }),
  );
});

integration("serial columns survive a schema copy and keep counting", async () => {
  const [source, target] = [raw(0), raw(1)];
  const schema = schemaName();
  try {
    await source.exec(`CREATE SCHEMA ${q(schema)}`);
    for (const sql of prepareMigration("CREATE TABLE tickets (id serial PRIMARY KEY, label text NOT NULL, big bigserial)").bind(schema)) await source.exec(sql);
    await source.exec(`INSERT INTO ${q(schema, "tickets")} (label) VALUES ('a'), ('b')`);
    const before = await fingerprint(source, schema);
    await copySchema(source, target, schema, 10000);
    expect(await fingerprint(target, schema)).toBe(before);
    expect(await target.query(`INSERT INTO ${q(schema, "tickets")} (label) VALUES ('c') RETURNING id, big::text AS big`)).toEqual([{ id: 3, big: "3" }]);
  } finally {
    for (const db of [source, target]) await db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await Promise.all([source.close(), target.close()]);
  }
});
```

(`valid` değerindeki `+00`, DB oturum saat diliminin UTC olmasına dayanır; yerel compose imajı UTC'dir. Farklı bir saat dilimli sunucuda ölçüm farklı çıkarsa test sunucuyu düzeltmez: bu bir ortam farkıdır, `Ruling:` yazılır.)

- [ ] **Step 2: İzole yığını başlat**

```bash
docker ps --format '{{.Names}} {{.Ports}}' | grep -E '5540|5541|5543|5488' && echo "PORTS BUSY: stop and ask" || docker compose -p dbsql -f compose.yaml up -d postgres-0 postgres-1 pgbouncer wsproxy
until docker compose -p dbsql -f compose.yaml exec -T postgres-0 pg_isready -U admin -d app >/dev/null 2>&1 && docker compose -p dbsql -f compose.yaml exec -T postgres-1 pg_isready -U admin -d app >/dev/null 2>&1; do sleep 1; done; echo ready
```

Expected: `ready` (ya da `PORTS BUSY: stop and ask` → görev durur ve sahibe sorulur).

- [ ] **Step 3: Dört sürücüde çalıştır**

```bash
set -a && . ./.env.example && set +a
for d in bun postgres pg neon; do echo "== $d"; RUN_INTEGRATION=1 DB_DRIVER=$d bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/sql-advanced.test.ts 2>&1 | tail -8; done
```

Expected: dört sürücüde de tüm testler PASS (E1 + E2 + E3). Dört sürücüde aynı beklenen sabitler karşılaştırıldığı için sürücüler arası eşitlik testin kendisidir. `serial` kopyası `copySchema` tarafından reddedilirse (ör. `UNSUPPORTED_MOVE`: sahipli sequence ya da `nextval` varsayılanı), bu bir bulgudur: kopyalama aracı E'nin kapsamı dışındadır, aracı değiştirme; bulguyu `Ruling:` ile kaydet ve spec'teki "`tools copy` bu kalıbı kabul eder" varsayımının yanlış olduğunu sahibe bildir (testi `serial` kopyasını reddetmeyi pinleyen bir teste çevirmek sahibin kararıdır).

- [ ] **Step 4: Belgeleri güncelle**

`docs/queries.md` "Tablo tipleri (zod)" tablosunda `| time, timetz, interval | \`z.string()\` |` satırının altına:

```markdown
| inet, cidr, macaddr, tsvector, tsquery, int4range, int8range, numrange, tsrange, tstzrange, daterange | `z.string()` (aralıklar `"[1,5)"` biçiminde) |
```

ve tablonun altındaki "Nullable sütun …" cümlesinden önce yeni paragraf:

```markdown
**Ek tipler yalnızca scalar'dır.** `inet`, `cidr`, `macaddr`, `tsvector`, `tsquery` ve aralık tipleri üç sürücüde de string döner; dizileri sürücülerde farklı biçimde döner (postgres.js ham `"{…}"` metni verir), bu yüzden dizi öğesi olarak (sütun, cast, `inet[][]`) `SQL_UNSUPPORTED`'dir. Dizi gerekirse `array_agg(ip::text)` ya da JSON kullanın. `serial`/`smallserial`/`bigserial` yalnızca `CREATE TABLE`/`ADD COLUMN` sütun tanımında kabul edilir, olduğu gibi yazılır ve tabloda `NOT NULL` + varsayılanlı sayı (`bigserial` string) olarak görünür. Operatörler: `@@` (tam metin), `&&` (dizi/aralık örtüşmesi), `<<`, `>>` (ağ adresi/aralık içerme); `-|-`, `<<=`, `>>=` ayrıştırılamadığı için desteklenmez. Fonksiyonlar: `to_tsvector`, `to_tsquery`, `plainto_tsquery`, `websearch_to_tsquery`, `ts_rank`. **`citext` desteklenmez:** extension tipidir, kurulduğu schema sağlayıcıya göre değişir (Neon'da çoğunlukla `public`, Supabase'te `extensions`) ve derleyici `search_path` olmadan schema'yı bilemez; büyük/küçük harfe duyarsız karşılaştırma için `WHERE lower(email) = lower($1)` ve `lower(email)` üzerinde unique index kullanın.
```

`docs/configuration.md` "Değer tipleri" tablosuna `| uuid, interval, time | \`string\` |` satırının altına:

```markdown
| inet, cidr, macaddr, tsvector, tsquery, aralık tipleri | `string` (yalnızca scalar; dizileri sürücülerde farklıdır ve reddedilir) |
```

`src/core/sql/README.md`:

1. "Approved types and ordinary SQL aliases: …, and `interval`." cümlesinde `and \`interval\`.` ifadesini şununla değiştir: `\`interval\`, \`inet\`, \`cidr\`, \`macaddr\`, \`tsvector\`, \`tsquery\`, \`int4range\`, \`int8range\`, \`numrange\`, \`tsrange\`, \`tstzrange\` and \`daterange\`. The last eleven are scalar-only: arrays of them reject (drivers disagree on array values). \`serial\`/\`smallserial\`/\`bigserial\` are accepted only as a column type in \`CREATE TABLE\`/\`ADD COLUMN\`, written bare (never qualified) and folded to \`int4\`/\`int2\`/\`int8\` with \`NOT NULL\` and a default; anywhere else they reject. \`citext\` and other extension types reject (their schema is provider-specific and there is no \`search_path\`).`
2. Approved binary operators listesine (E1'in eklediği ifadeden sonra) ekle: `` `@@`, `&&`, `<<`, `>>` ``; ve cümleye `-|-`, `<<=` ve `>>=` ayrıştırılamadığı için reddedilir notu: `` (`-|-`, `<<=` and `>>=` are not parseable by the pinned parser and reject)``.
3. "Approved ordinary calls" listesine (E1'in eklediği isimlerden sonra) ekle: `` `to_tsvector`, `to_tsquery`, `plainto_tsquery`, `websearch_to_tsquery`, `ts_rank` ``.
4. "Deferred grammar and trust boundary" listesinde `` `serial` and `nextval` `` ifadesini `` `nextval` `` yap.

- [ ] **Step 5: Kapanış doğrulaması**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint . && bun run codegen --check`
Expected: birim PASS, tsc/eslint temiz, `codegen --check` temiz (`*.gen.ts` zod modülleri yalnızca yeni tip eklenirse değişir; mevcut migration'lar yeni tip kullanmaz).

Mevcut entegrasyon paketi (izole yığında, `bun`): `RUN_INTEGRATION=1 DB_DRIVER=bun bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration`. Beklenen: yalnızca `deadline-matrix` "PgBouncer without a backend" düşer (taban `6048f9f`'de de düşen mevcut hata); başka bir düşüş E3'ün sorumluluğundadır.

- [ ] **Step 6: Yığını kaldır ve commit**

```bash
docker compose -p dbsql -f compose.yaml down -v
git add src/__tests__/integration/sql-advanced.test.ts docs/queries.md docs/configuration.md src/core/sql/README.md
git commit -m "sql: extra types integration tests on four drivers (round-trip, operators, serial copy), docs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: `docker ps` içinde `dbsql` projesine ait container kalmaz.
