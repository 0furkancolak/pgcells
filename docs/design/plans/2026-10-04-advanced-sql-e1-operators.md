# Advanced SQL E1: Operatör ve Fonksiyon Implementation Plan

> **Durum (2026-10-19): uygulandı.** Onay kutuları işaretlenmedi; gerçek durumun kaynağı koddur, testlerdir ve [yol haritası](2026-10-18-roadmap-remaining.md)dır.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uygulama sorgularında JSON/regex/içerme operatörleri, JSON/dizi/metin fonksiyonları ve `FROM` içinde tablo döndüren fonksiyonlar derlemede doğrulanır ve gerçek PostgreSQL'de üç sürücüde (bun, postgres, pg) ve neon'da çalışır.

**Architecture:** Tamamı `core/sql/` izin listesinin genişlemesidir: `grammar.ts`'e operatör/fonksiyon/`expr.member`/`from.call` kuralları, `compiler.ts`'e iki küçük anlamsal denetim ve `trim` takma adı, `casing.ts`'e `FROM` işlev kaynağı. Çalışma anında SQL ayrıştırılmaz; çıktı özgün metinden yalnızca schema/işlev nitelemesi düzenlemeleriyle üretilir.

**Tech Stack:** Bun + TypeScript, `pgsql-ast-parser` 12.0.2 (yalnızca derleme zamanı), `bun:test`; entegrasyon için izole compose projesi.

**Spec:** `docs/superpowers/specs/2026-10-04-advanced-sql-design.md` (E1 bölümü, Kararlar). Bu plan E1'dir; E2 (`…-e2-structures.md`) ve E3 (`…-e3-types.md`) ayrı planlardır ve E1 bitmeden başlamaz.

## Global Constraints

- **`search_path` hiçbir biçimde kullanılmaz;** işlevler `"pg_catalog"."ad"` olarak nitelenir, schema derlemede tablo adına eklenir.
- **Yeni ortam değişkeni yok.** Çalışma anında SQL ayrıştırılmaz (`pgsql-ast-parser` yalnızca derleme zamanı).
- **Fonksiyon izin listesine yalnızca saf (yan etkisiz) fonksiyon girer;** `nextval`, `set_config`, `pg_advisory_lock` asla (`readOnly` doğruluğu buna dayanır).
- **Operatörler niteliksiz kalır** (parser `OPERATOR(pg_catalog.->)` üretmez).
- `FROM` içi fonksiyon kaynağında **takma ad zorunlu**; `*` yalnızca sütun listesi (`AS e(a, b)`) verilmişse açılır, aksi halde mevcut kuralla reddedilir.
- Yorumlar Türkçe, hata mesajları İngilizce ve kararlı (`SQL_UNSUPPORTED`).
- Her görev: önce başarısız test (RED), sonra minimal kod; her görev bir commit. Commit mesajı sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push/PR/merge yok.
- Komutlar `packages/db` içinde: birim `bun test src/__tests__/unit/<dosya>`, tip `bunx tsc --noEmit`, lint `bunx eslint <dosyalar> --fix`. Entegrasyon yalnızca izole compose projesinde (`docker compose -p dbsql …`); paylaşılan jamaster stack'ine (5540/5541/5543 portlarını tutan `jamaster-*` container'ları) dokunulmaz — portlar doluysa durulur.

## Ölçülmüş zemin (plan yazılırken, `pgsql-ast-parser` 12.0.2 + PostgreSQL 16.15)

- Parser şunları zaten ayrıştırır: `->`/`->>` (`member` düğümü, **anahtar yalnızca sabit metin/sayı**; `data->$1` ayrıştırılamaz), `#>`, `#>>`, `@>`, `<@`, `?`, `?|`, `?&`, `~`, `~*`, `!~`, `!~*` (hepsi `binary`), `FROM` içi fonksiyon (`type: "call"`, `alias: { name, columns? }`, `lateral`, `join`).
- `trim(x)` tek argümanlı biçimi `call` olarak ayrıştırılır; `trim(both … from …)` **ayrıştırılamaz**. `pg_catalog.trim` **yoktur** (`btrim` vardır): `trim(x)` SQL söz dizimidir ve PostgreSQL onu `btrim`'e çevirir.
- `pg_catalog`'da olan: `unnest`, `generate_series`, `jsonb_set`, `jsonb_each`, `jsonb_each_text`, `jsonb_array_elements`, `jsonb_array_elements_text`, `jsonb_extract_path`, `jsonb_extract_path_text`, `concat`, `replace`, `btrim`, `ltrim`, `rtrim`, `regexp_replace`, `regexp_match`, `regexp_matches`, `array_length`.
- Spec'e ek (sahibe son mesajda bildirilir): `jsonb_extract_path` / `jsonb_extract_path_text` (anahtar sabit olmak zorunda olmayan JSON erişimi için; `->` anahtarı yalnızca sabit olabilir), `jsonb_array_elements_text`, `btrim/ltrim/rtrim` (`trim`'in gerçek karşılıkları). Hepsi saf.

## Review Focus

- İzin listesine sonradan eklenen bir fonksiyonun yan etkili/volatile olması `readOnly`'yi yalan yapar → Task 1 (birim kara liste) ve Task 3 (katalog `provolatile` testi).
- `?` operatörünü bir sürücünün yer tutucu sanması (parametreler `$n`'dir) → Task 3 entegrasyon (dört sürücü, hem sabit hem `$1` ile).
- Tırnaklı `"trim"(x)` veya `pg_catalog.trim(x)` ile `btrim` takma adının anlam kayması → Task 1 reddetme testleri.
- `FROM generate_series(…)` takma adsız ya da sütunları bilinmeyen `SELECT *` → Task 2 reddetme testleri.
- Yorum/metin içindeki `?`, `->`, `trim(` ifadeleri derlemeyi etkilemez → Task 1 testi.

---

### Task 1: Operatörler, `->`/`->>`, fonksiyonlar ve `trim` takma adı

**Files:**
- Modify: `src/core/sql/grammar.ts` (operatörler, `expr.member`, `functions`, `functionAliases`)
- Modify: `src/core/sql/compiler.ts` (`function` denetimi: `trim` → `btrim`)
- Create: `src/__tests__/unit/sql-advanced.test.ts`

**Interfaces:**
- Consumes: mevcut `prepareQuery(source, scope?, tables?)`, `functions`, `operators`, `grammar`.
- Produces: `grammar.ts`'ten `functionAliases: Readonly<Record<string, string>>`; `grammar.expr.member`; genişletilmiş `functions` ve `operators.get("binary")`. Task 2 aynı test dosyasını genişletir.

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/sql-advanced.test.ts`:

```ts
import { expect, test } from "bun:test";
import { prepareQuery } from "../../core/sql/compiler";
import { functions } from "../../core/sql/grammar";

const schema = `tenant_${"a".repeat(32)}`;
const qualified = `"${schema}".`;
const bind = (source: string) => prepareQuery(source).bind(schema);
const rejects = (source: string, detail: RegExp = /SQL_UNSUPPORTED/) => expect(() => prepareQuery(source)).toThrow(detail);

test("JSON, regex and containment operators pass through unchanged", () => {
  for (const op of ["@>", "<@", "?", "?|", "?&", "#>", "#>>", "~", "~*", "!~", "!~*"])
    expect(bind(`SELECT id FROM events WHERE data ${op} 'x'`)).toBe(`SELECT id FROM ${qualified}events WHERE data ${op} 'x'`);
});

test("-> and ->> chains pass through unchanged and need a literal key", () => {
  expect(bind("SELECT data->'a' AS a, data->>'b' AS b, data->'c'->>'d' AS d, data->1 AS e FROM events")).toBe(
    `SELECT data->'a' AS a, data->>'b' AS b, data->'c'->>'d' AS d, data->1 AS e FROM ${qualified}events`,
  );
  rejects("SELECT data->>$1 AS v FROM events");
});

test("JSON, array, text and regex functions are qualified with pg_catalog", () => {
  for (const name of [
    "unnest", "jsonb_set", "jsonb_each", "jsonb_each_text", "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_extract_path",
    "jsonb_extract_path_text", "concat", "replace", "btrim", "ltrim", "rtrim", "regexp_replace", "regexp_match", "regexp_matches", "array_length",
  ])
    expect(bind(`SELECT ${name}(name) AS v FROM events`)).toBe(`SELECT "pg_catalog"."${name}"(name) AS v FROM ${qualified}events`);
});

test("trim(x) is the btrim syntax form: written bare, rendered as pg_catalog.btrim", () => {
  expect(bind("SELECT trim(name) AS t, TRIM(name, 'x') AS u FROM events")).toBe(
    `SELECT "pg_catalog"."btrim"(name) AS t, "pg_catalog"."btrim"(name, 'x') AS u FROM ${qualified}events`,
  );
  rejects('SELECT "trim"(name) AS t FROM events');
  rejects("SELECT pg_catalog.trim(name) AS t FROM events");
  rejects("SELECT trim(both 'x' from name) AS t FROM events");
});

test("operator and function look-alikes inside comments and string literals are inert", () => {
  const source = "SELECT id /* data ? 'a' -> trim( */ FROM events WHERE name = 'a ? b -> trim(c)' -- ~ x";
  expect(bind(source)).toBe(source.replace("FROM events", `FROM ${qualified}events`));
});

test("every new construct is a read-only query", () => {
  expect(prepareQuery("SELECT data->>'a' AS a FROM events WHERE data @> '{}' AND name ~ 'x'").readOnly).toBe(true);
});

// `readOnly` izin listesinin yan etkisiz olmasına dayanır; bu bir regresyon bekçisidir (ilk koşuda geçer, ihlali yakalar).
test("the function allowlist never contains side-effecting functions", () => {
  for (const name of [
    "nextval", "currval", "setval", "lastval", "set_config", "pg_advisory_lock", "pg_advisory_xact_lock", "pg_try_advisory_lock", "pg_notify",
    "pg_sleep", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_switch_wal", "lo_import", "lo_export", "lo_create", "lo_unlink",
    "txid_current", "pg_read_file", "pg_ls_dir",
  ])
    expect(functions.has(name)).toBe(false);
});
```

- [ ] **Step 2: Başarısızlığı doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: operatör, `->`, fonksiyon, `trim` ve "read-only" testleri FAIL (`unsupported operator`, `unsupported expr: member`, `unsupported function: …`); "inert" testi ve "side-effecting" bekçisi ilk koşuda PASS olur (ikisi de mevcut davranışı korur).

- [ ] **Step 3: Grammar'ı genişlet**

`src/core/sql/grammar.ts` içinde:

1. `functions` şablon dizisinin son satırına (`lag lead first_value last_value nth_value`) iki satır ekle:

```ts
lag lead first_value last_value nth_value
unnest generate_series jsonb_set jsonb_each jsonb_each_text jsonb_array_elements jsonb_array_elements_text
jsonb_extract_path jsonb_extract_path_text concat replace btrim ltrim rtrim regexp_replace regexp_match regexp_matches array_length`.split(/\s+/),
```

2. `functions` tanımının hemen altına:

```ts
/** SQL söz diziminin çağırdığı gerçek işlev: `trim(x)` PostgreSQL'de `btrim(x)`'tir; `pg_catalog.trim` yoktur. */
export const functionAliases: Readonly<Record<string, string>> = { trim: "btrim" };
```

3. `operators` içindeki `binary` kümesinin sonuna ekle (virgülle): `,@>,<@,?,?|,?&,#>,#>>,~,~*,!~,!~*`

```ts
["binary", commaSet("OR,AND,IN,NOT IN,LIKE,NOT LIKE,ILIKE,NOT ILIKE,=,!=,>,>=,<,<=,+,-,*,/,%,||,@>,<@,?,?|,?&,#>,#>>,~,~*,!~,!~*")],
```

4. `grammar.expr` içinde `binary` satırından sonra:

```ts
    // `->` / `->>`: parser anahtarı yalnızca sabit metin/sayı olarak verir (`data->$1` ayrıştırılamaz).
    member: { type: null, operand: "expr", op: null, member: null },
```

- [ ] **Step 4: `trim` takma adını derleyiciye ekle**

`src/core/sql/compiler.ts`: import satırına `functionAliases` ekle:

```ts
import { accessMethods, types as builtinTypes, functionAliases, functions, grammar, keywords, operators, specialCalls } from "./grammar";
```

`SEMANTIC_CHECKS.function` gövdesini şununla değiştir:

```ts
  function: (node, _type, context) => {
    const name = identifier(node.name);
    const alias = Object.hasOwn(functionAliases, name) && node.schema === undefined ? functionAliases[name] : undefined;
    if (specialCalls.has(name) && node.schema === undefined) {
      const span = location(node);
      if (context.source.slice(span.start, span.end).toLowerCase() !== name) unsupported("quoted SQL syntax is not an allowed function");
    } else if (alias === undefined && (!functions.has(name) || (node.schema !== undefined && node.schema !== "pg_catalog"))) unsupported(`unsupported function: ${name}`);
    else {
      const span = location(node);
      // `trim(x)` yalnızca çıplak yazılırsa söz dizimidir; tırnaklı "trim" gerçek bir işlev adıdır ve yoktur.
      if (alias !== undefined && context.source.slice(span.start, span.end).toLowerCase() !== name) unsupported("quoted SQL syntax is not an allowed function");
      context.edits.push({ ...span, text: `"pg_catalog"."${alias ?? name}"` });
    }
  },
```

- [ ] **Step 5: Testlerin geçtiğini doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: PASS (7 test). Başarısız bir `toBe` yalnızca boşluk farkıysa beklentiyi değil, çıktıyı incele: derleyici özgün metni korumalıdır; fark nitelenmiş işlev/tablo dışında bir yerde ise kod yanlıştır.

- [ ] **Step 6: Mutasyon kontrolleri**

(a) `grammar.ts`'ten `~*` operatörünü geçici sil → "operators pass through" testi düşer; geri koy. (b) `functionAliases` kaydını `{}` yap → `trim` testi düşer; geri koy. (c) `functions` kümesine geçici `nextval` ekle → "side-effecting" bekçisi düşer; geri al. Üçü de geri alındığında test PASS.

- [ ] **Step 7: Tüm birim paketi, tip ve lint**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint src/core/sql src/__tests__/unit/sql-advanced.test.ts --fix`
Expected: tüm birim testleri PASS (önceki 339 + yeni 7), tsc/eslint temiz. Mevcut bir assertion kırılırsa (ör. `sql.test.ts` "unsupported function" listesi `concat`/`replace` gibi adları reddetmeyi bekliyorsa) o assertion yeni davranışa göre güncellenir ve ledger'a `Ruling:` yazılır.

- [ ] **Step 8: Commit**

```bash
git add src/core/sql/grammar.ts src/core/sql/compiler.ts src/__tests__/unit/sql-advanced.test.ts
git commit -m "sql: JSON/regex/containment operators, -> chains, JSON/array/text functions, trim as btrim

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `FROM` içinde tablo döndüren fonksiyonlar

**Files:**
- Modify: `src/core/sql/grammar.ts` (`from.call`, `callAlias`)
- Modify: `src/core/sql/compiler.ts` (`from` ve `callAlias` denetimleri)
- Modify: `src/core/sql/casing.ts` (`fromSources`)
- Test: `src/__tests__/unit/sql-advanced.test.ts` (genişlet)

**Interfaces:**
- Consumes: Task 1'in `functions`/`function` denetimi (FROM içi fonksiyon adı da aynı denetimden geçer).
- Produces: `grammar.from.call`, `grammar.callAlias`; `casing.ts`'te `FROM` işlev kaynağı `Source { visible: alias.name, columns: alias sütun listesi | null, using }`.

- [ ] **Step 1: Başarısız testleri ekle**

`sql-advanced.test.ts` sonuna:

```ts
test("functions in FROM are qualified and need an alias", () => {
  expect(bind("SELECT g FROM generate_series(1, 10) AS g")).toBe(`SELECT g FROM "pg_catalog"."generate_series"(1, 10) AS g`);
  expect(bind("SELECT e.key, e.value FROM events, jsonb_each(events.data) AS e")).toBe(
    `SELECT e.key, e.value FROM ${qualified}events, "pg_catalog"."jsonb_each"(events.data) AS e`,
  );
  expect(bind("SELECT events.id, e.elem FROM events CROSS JOIN LATERAL jsonb_array_elements(events.data->'list') AS e(elem)")).toBe(
    `SELECT events.id, e.elem FROM ${qualified}events CROSS JOIN LATERAL "pg_catalog"."jsonb_array_elements"(events.data->'list') AS e(elem)`,
  );
  rejects("SELECT 1 FROM generate_series(1, 3)", /needs an alias/);
  rejects("SELECT g FROM nextval('s') AS g", /unsupported function: nextval/);
  rejects("SELECT g FROM app.generate_series(1, 3) AS g");
});

test("star over a function source is expanded only when the alias lists its columns", () => {
  rejects("SELECT g.* FROM generate_series(1, 3) AS g", /columns known at compile time/);
  expect(bind("SELECT g.* FROM generate_series(1, 3) AS g(n)")).toBe(`SELECT g.* FROM "pg_catalog"."generate_series"(1, 3) AS g(n)`);
  const expanded = bind("SELECT e.* FROM events, jsonb_each(events.data) AS e(key_name, val)");
  expect(expanded).toContain(`"e"."key_name" AS "keyName", "e"."val"`);
  expect(expanded).toContain(`AS e(key_name, val)`);
});

test("a function source in FROM keeps the query read-only", () => {
  expect(prepareQuery("SELECT g FROM generate_series(1, 3) AS g").readOnly).toBe(true);
});
```

- [ ] **Step 2: Başarısızlığı doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: yeni üç test FAIL (`unsupported from: call`).

- [ ] **Step 3: Grammar**

`grammar.ts` `from` bloğuna `call` satırı, ve `name` satırından sonra `callAlias` kind'ı:

```ts
  from: {
    table: { type: null, name: "relation", join: "join" },
    statement: { type: null, statement: "statement", alias: null, columnNames: "name", join: "join", lateral: null },
    // FROM içinde tablo döndüren işlev; takma ad zorunludur (derleyici denetler). Sütun listesi `alias.columns`'tadır.
    call: { type: null, function: "function", args: "expr", alias: "callAlias", lateral: null, join: "join" },
  },
  name: { "*": { name: null } },
  callAlias: { "*": { name: null, columns: "name" } },
```

- [ ] **Step 4: Derleyici denetimleri**

`compiler.ts` `SEMANTIC_CHECKS.from` ve yeni `callAlias`:

```ts
  from: (node, type) => {
    if (type === "statement") identifier(node.alias);
    if (type === "call" && !node.alias) unsupported("a function in FROM needs an alias");
  },
  callAlias: (node) => {
    checkedName(node);
  },
```

- [ ] **Step 5: Casing: işlev kaynağı**

`casing.ts` `fromSources` içinde `items.map((item) => {` bloğunun ilk satırlarına (using hesabından sonra) ekle:

```ts
    // FROM içi işlev: görünür ad takma addır; sütunlar yalnızca `AS e(a, b)` listesi verildiyse bilinir (aksi halde `*` reddedilir).
    if (item.type === "call") {
      const alias = item.alias as Node;
      const names = (alias.columns as Node[] | undefined)?.map((column) => column.name as string);
      return source(alias.name as string, names ?? null, undefined, using);
    }
```

- [ ] **Step 6: Testlerin geçtiğini doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: PASS (10 test). Not: `rejects("SELECT 1 FROM generate_series(1, 3)", /needs an alias/)` yalnızca `from` denetimi çalıştığında geçer; ayrıştırma hatası değildir.

- [ ] **Step 7: Mutasyon**

`from` denetimindeki `call` satırını geçici sil → "need an alias" testi düşer; `casing.ts` blokunu sil → "star over a function source" testi çöker (TypeError ya da farklı hata); ikisini geri koy.

- [ ] **Step 8: Tüm birim paketi, tip, lint**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint src/core/sql src/__tests__/unit/sql-advanced.test.ts --fix`
Expected: hepsi PASS/temiz.

- [ ] **Step 9: Commit**

```bash
git add src/core/sql/grammar.ts src/core/sql/compiler.ts src/core/sql/casing.ts src/__tests__/unit/sql-advanced.test.ts
git commit -m "sql: table-returning functions in FROM (alias required, star only with a column list)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Gerçek PostgreSQL'de doğrulama, belgeler ve kapanış

**Files:**
- Create: `src/__tests__/integration/sql-advanced.test.ts`
- Modify: `docs/queries.md`, `src/core/sql/README.md`

**Interfaces:**
- Consumes: Task 1–2'nin derleme davranışı; `integration`, `raw`, `q` (`helpers.ts`); `createWithTenant`; `functions` (`grammar.ts`).
- Produces: E2 ve E3'ün aynı dosyaya ekleyeceği `context(db, schema)` / `schemaName()` yardımcıları ve entegrasyon test deseni.

- [ ] **Step 1: Entegrasyon testini yaz**

`src/__tests__/integration/sql-advanced.test.ts`:

```ts
import { expect } from "bun:test";
import type { Database } from "../../core/database";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { functions } from "../../core/sql/grammar";
import { createWithTenant } from "../../core/tenants/context";
import { integration, q, raw } from "./helpers";

function context(db: Database, schema: string) {
  return createWithTenant({ node: () => db } as never, {
    get: async () => ({
      tenantId: "sql-advanced",
      kind: "tenant" as const,
      databaseId: "db0",
      schemaName: schema,
      status: "active" as const,
      schemaVersion: 0,
      placementVersion: 1,
    }),
  });
}
const schemaName = () => `tenant_${crypto.randomUUID().replaceAll("-", "")}`;

/** Her test kendi schema'sını kurar ve siler; `setup`: bu schema'da çalışacak migration SQL'i. */
async function withSchema(setup: string, work: (run: ReturnType<typeof context>) => Promise<void>) {
  const db = raw();
  const schema = schemaName();
  try {
    await db.exec(`CREATE SCHEMA ${q(schema)}`);
    for (const sql of prepareMigration(setup).bind(schema)) await db.exec(sql);
    await work(context(db, schema));
  } finally {
    await db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await db.close();
  }
}

const EVENTS = "CREATE TABLE events (id integer PRIMARY KEY, name text NOT NULL, data jsonb NOT NULL, tags text[] NOT NULL)";
const seed = prepareQuery(
  `INSERT INTO events (id, name, data, tags) VALUES
   (1, 'Ada', '{"a":1,"b":{"c":"x"},"list":[1,2]}', '{x,y}'),
   (2, 'Bob', '{"z":2}', '{}')`,
);

integration("JSON, regex and containment operators evaluate in PostgreSQL on every driver", async () => {
  await withSchema(EVENTS, (run) =>
    run("sql-advanced", async (tenant) => {
      await tenant.query(seed);
      const ids = (sql: string, values: unknown[] = []) => tenant.query(prepareQuery(`${sql} ORDER BY events.id`), values);
      expect(await ids("SELECT id FROM events WHERE data ? 'a'")).toEqual([{ id: 1 }]);
      // `?` yer tutucu sayılmaz: parametreyle de çalışır.
      expect(await ids("SELECT id FROM events WHERE data ? $1", ["z"])).toEqual([{ id: 2 }]);
      expect(await ids("SELECT id FROM events WHERE data ?| ARRAY['a', 'z']")).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await ids("SELECT id FROM events WHERE data ?& ARRAY['a', 'b']")).toEqual([{ id: 1 }]);
      expect(await ids(`SELECT id FROM events WHERE data @> '{"a":1}'`)).toEqual([{ id: 1 }]);
      expect(await ids(`SELECT id FROM events WHERE data <@ '{"a":1,"b":{"c":"x"},"list":[1,2],"extra":true}'`)).toEqual([{ id: 1 }]);
      expect(await ids("SELECT id FROM events WHERE name ~ '^A'")).toEqual([{ id: 1 }]);
      expect(await ids("SELECT id FROM events WHERE name ~* '^b'")).toEqual([{ id: 2 }]);
      expect(await ids("SELECT id FROM events WHERE name !~ '^A'")).toEqual([{ id: 2 }]);
      expect(await ids("SELECT id FROM events WHERE name !~* '^b'")).toEqual([{ id: 1 }]);
      expect(
        await tenant.query(
          prepareQuery(
            "SELECT data->'a' AS a, data->>'a' AS a_text, data->'b'->>'c' AS c, data#>>'{b,c}' AS deep, data#>'{b}' AS sub FROM events WHERE id = 1",
          ),
        ),
      ).toEqual([{ a: 1, aText: "1", c: "x", deep: "x", sub: { c: "x" } }]);
    }),
  );
});

integration("JSON, array, text and regex functions evaluate in PostgreSQL", async () => {
  await withSchema(EVENTS, (run) =>
    run("sql-advanced", async (tenant) => {
      await tenant.query(seed);
      const [row] = await tenant.query(
        prepareQuery(
          `SELECT jsonb_set(data, '{a}', '5') AS d, concat(name, '!') AS c, replace(name, 'Ada', 'Eve') AS r, btrim('  x ') AS t1, trim('  y ') AS t2,
                  array_length(tags, 1) AS n, regexp_replace(name, '[aeiou]', '_', 'g') AS rr, array_length(regexp_match(name, '^(A)(d)'), 1) AS m,
                  jsonb_extract_path_text(data, 'b', 'c') AS x, jsonb_extract_path_text(data, $1, $2) AS y
           FROM events WHERE id = 1`,
        ),
        ["b", "c"],
      );
      expect(row).toEqual({ d: { a: 5, b: { c: "x" }, list: [1, 2] }, c: "Ada!", r: "Eve", t1: "x", t2: "y", n: 2, rr: "Ad_", m: 2, x: "x", y: "x" });
    }),
  );
});

integration("table-returning functions work in FROM and in the select list", async () => {
  await withSchema(EVENTS, (run) =>
    run("sql-advanced", async (tenant) => {
      await tenant.query(seed);
      expect(await tenant.query(prepareQuery("SELECT g FROM generate_series(1, 3) AS g ORDER BY g"))).toEqual([{ g: 1 }, { g: 2 }, { g: 3 }]);
      expect(
        await tenant.query(prepareQuery("SELECT e.key, e.value FROM events, jsonb_each(events.data) AS e WHERE events.id = 2")),
      ).toEqual([{ key: "z", value: 2 }]);
      expect(await tenant.query(prepareQuery("SELECT unnest(tags) AS tag FROM events WHERE id = 1 ORDER BY tag"))).toEqual([{ tag: "x" }, { tag: "y" }]);
      expect(
        await tenant.query(
          prepareQuery(
            "SELECT events.id, e.elem FROM events CROSS JOIN LATERAL jsonb_array_elements(events.data->'list') AS e(elem) WHERE events.id = 1 ORDER BY e.elem",
          ),
        ),
      ).toEqual([{ id: 1, elem: 1 }, { id: 1, elem: 2 }]);
      expect(
        await tenant.query(prepareQuery("SELECT e.* FROM events, jsonb_each(events.data) AS e(key_name, val) WHERE events.id = 2")),
      ).toEqual([{ keyName: "z", val: 2 }]);
    }),
  );
});

// `readOnly` (replica okuma bağlamı) izin listesinin yan etkisiz olmasına dayanır: katalogda `volatile` olan tek istisna `gen_random_uuid`'dir.
integration("allowlisted functions are not volatile in the catalog (except gen_random_uuid)", async () => {
  const db = raw();
  try {
    const rows = (await db.query(
      `SELECT DISTINCT proname AS name FROM pg_catalog.pg_proc
       WHERE pronamespace = 'pg_catalog'::regnamespace AND provolatile = 'v'
         AND proname IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY 1`,
      [JSON.stringify([...functions])],
    )) as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(["gen_random_uuid"]);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: İzole yığını başlat**

Run (önce portların boş olduğunu doğrula; doluysa DURUN, jamaster yığınına dokunulmaz):

```bash
docker ps --format '{{.Names}} {{.Ports}}' | grep -E '5540|5541|5543|5488' && echo "PORTS BUSY: stop and ask" || docker compose -p dbsql -f compose.yaml up -d postgres-0 postgres-1 pgbouncer wsproxy
until docker compose -p dbsql -f compose.yaml exec -T postgres-0 pg_isready -U admin -d app >/dev/null 2>&1 && docker compose -p dbsql -f compose.yaml exec -T postgres-1 pg_isready -U admin -d app >/dev/null 2>&1; do sleep 1; done; echo ready
```

Expected: `ready` (ya da `PORTS BUSY: stop and ask` → görev burada durur ve sahibe sorulur).

- [ ] **Step 3: Testi dört sürücüde çalıştır**

```bash
set -a && . ./.env.example && set +a
for d in bun postgres pg neon; do echo "== $d"; RUN_INTEGRATION=1 DB_DRIVER=$d bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/sql-advanced.test.ts 2>&1 | tail -8; done
```

Expected: dört sürücüde de `4 pass, 0 fail`. Bir sürücüde `?` yer tutucu olarak yorumlanıyorsa test o sürücüde düşer: bu bir bulgudur; sessizce atlama, `systematic-debugging` ile nedenini bul, çözümü ledger'a `Ruling:` ile yaz (olası çözüm: `?` operatörü için sürücü katmanında `$n` zorunluluğunu belgelemek ya da operatörü `jsonb_exists(data, $1)` fonksiyonuna yönlendirmek — her ikisi de spec'e aykırı olabileceğinden önce sahibe sorulur).

- [ ] **Step 4: Belgeleri güncelle**

`docs/queries.md` içinde "## Sonuç adları: snake_case sütun, camelCase anahtar" başlığından **önce** yeni bölüm:

````markdown
## JSON, dizi, regex ve tablo döndüren fonksiyonlar

Operatörler: `->`, `->>` (anahtar **sabit** metin ya da sayı olmalıdır), `#>`, `#>>`, `@>`, `<@`, `?`, `?|`, `?&`, `~`, `~*`, `!~`, `!~*`. Fonksiyonlar: `unnest`, `generate_series`, `jsonb_set`, `jsonb_each`, `jsonb_each_text`, `jsonb_array_elements`, `jsonb_array_elements_text`, `jsonb_extract_path`, `jsonb_extract_path_text`, `concat`, `replace`, `btrim`, `ltrim`, `rtrim`, `trim` (tek argümanlı; `btrim` olarak yazılır), `regexp_replace`, `regexp_match`, `regexp_matches`, `array_length`. Hepsi saf (yan etkisiz) olduğundan bu yapıları içeren `SELECT`'ler `readOnly` kalır ve replica okuma bağlamında çalışır.

```sql
-- name: listByStatus
SELECT id::text AS id, data->>'status' AS status, data#>>'{customer,name}' AS customer_name
FROM orders WHERE data @> $1::text::jsonb ORDER BY orders.id

-- name: listItems
SELECT orders.id::text AS id, item.elem AS item
FROM orders CROSS JOIN LATERAL jsonb_array_elements(orders.data->'items') AS item(elem)
```

- **Dinamik anahtar:** `data->>$1` yazılamaz; `jsonb_extract_path_text(data, $1)` kullanın.
- **`FROM` içinde fonksiyon** için takma ad zorunludur. `SELECT *` yalnızca sütun listesi verilirse açılır (`AS item(elem)`); aksi halde sütunları açıkça yazın.
- **`trim(both … from …)`** ayrıştırılamaz; `btrim(x, 'karakterler')` kullanın.
- `?` bir yer tutucu değildir; parametreler her zaman `$n`'dir.
````

`src/core/sql/README.md` üç düzenleme:

1. "Approved ordinary calls …" paragrafında `and the window calls listed above.` ifadesinden önce ekle: `, \`unnest\`, \`generate_series\`, \`jsonb_set\`, \`jsonb_each\`, \`jsonb_each_text\`, \`jsonb_array_elements\`, \`jsonb_array_elements_text\`, \`jsonb_extract_path\`, \`jsonb_extract_path_text\`, \`concat\`, \`replace\`, \`btrim\`, \`ltrim\`, \`rtrim\`, \`regexp_replace\`, \`regexp_match\`, \`regexp_matches\`, \`array_length\`, plus \`trim(x)\` (rendered as \`pg_catalog.btrim\`)`.
2. "Approved binary operators: …" listesine `` `||` `` sonrasına ekle: `` `@>`, `<@`, `?`, `?|`, `?&`, `#>`, `#>>`, `~`, `~*`, `!~`, `!~*`, and the `member` forms `->`/`->>` (literal key only)``.
3. "Deferred grammar and trust boundary" listesinde `table-valued functions, ` ve `JSON operators, ` ifadelerini sil; paragrafın sonuna yeni cümle ekle: `Functions in FROM are supported only with an alias (a column list enables \`*\`).`

- [ ] **Step 5: Kapanış doğrulaması**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint . && bun run codegen --check`
Expected: birim PASS, tsc/eslint temiz, `codegen --check` temiz (E1 hiçbir `.sql`'i değiştirmez).

Mevcut entegrasyon paketi (izole yığında, `bun` sürücüsü): `RUN_INTEGRATION=1 DB_DRIVER=bun bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration`. Beklenen: yalnızca `deadline-matrix` "PgBouncer without a backend" düşer (taban `6048f9f`'de de düşen, E ile ilgisiz mevcut hata); başka bir düşüş E1'in sorumluluğundadır.

- [ ] **Step 6: Yığını kaldır ve commit**

```bash
docker compose -p dbsql -f compose.yaml down -v
git add src/__tests__/integration/sql-advanced.test.ts docs/queries.md src/core/sql/README.md
git commit -m "sql: advanced operators/functions integration tests on four drivers, docs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: `docker ps` içinde `dbsql` projesine ait container kalmaz.
