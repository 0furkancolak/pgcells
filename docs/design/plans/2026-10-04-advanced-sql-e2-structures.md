# Advanced SQL E2: Sorgu Yapıları Implementation Plan

> **Durum (2026-10-19): uygulandı.** Onay kutuları işaretlenmedi; gerçek durumun kaynağı koddur, testlerdir ve [yol haritası](2026-10-18-roadmap-remaining.md)dır.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `WITH RECURSIVE`, `INTERSECT`/`EXCEPT` (`ALL` dahil), `IS [NOT] DISTINCT FROM`, pencere çerçevesi ve `GROUPING SETS`/`ROLLUP`/`CUBE`/`grouping()` uygulama sorgularında derlenir ve gerçek PostgreSQL'de çalışır.

**Architecture:** Mevcut parser-boşluğu mekanizması (`parser-gaps.ts`) çalışma anı sorgularına da açılır. Parser'ın ayrıştıramadığı yapılar yalnızca parser'a verilen kopyada eşit uzunlukta yerine konur ya da örtülür; çıktı özgün kaynaktan üretilir ve anlam PostgreSQL'de özgün metinden gelir. Yalnızca `RECURSIVE` AST'ye bağlanır (kapsam için). Yürüteç yalnızca yaprak `SELECT`'lerin kapsamına, işlev izin listesine ve soldaki dalın çıktı adlarına baktığından yerine konan sözcüklerin ağaç biçimi ve önceliği sonucu değiştirmez.

**Tech Stack:** Bun + TypeScript, `pgsql-ast-parser` 12.0.2 (yalnızca derleme zamanı), `bun:test`; entegrasyon için izole compose projesi.

**Spec:** `docs/superpowers/specs/2026-10-04-advanced-sql-design.md` (E2 bölümü, Kararlar). Ön koşul: E1 (`2026-10-04-advanced-sql-e1-operators.md`) tamamlanmış olmalı; bu plan `src/__tests__/unit/sql-advanced.test.ts` ve `src/__tests__/integration/sql-advanced.test.ts` dosyalarını genişletir (E1 `context`, `schemaName`, `withSchema` yardımcılarını koyar).

## Global Constraints

- **`search_path` hiçbir biçimde kullanılmaz;** schema derlemede tablo adına eklenir.
- **Yeni ortam değişkeni yok.** Çalışma anında SQL ayrıştırılmaz (`pgsql-ast-parser` yalnızca derleme zamanı).
- **Değiştirme yalnızca tırnak/yorum dışında, tam anahtar sözcüklerde** yapılır (`codeView` maskesi + `(?<![\w$])…(?![\w$])` sınırları).
- **Pencere çerçevesi katıdır:** `ROWS|RANGE|GROUPS` + `UNBOUNDED`/`CURRENT ROW`/tam sayı sabiti + `PRECEDING`/`FOLLOWING`, `OVER (…)` parantezinin sonunda; `EXCLUDE`, ifadeli ofset ve `$n` reddedilir.
- **`ROLLUP`/`CUBE`/`GROUPING SETS` yalnızca doğrudan `GROUP BY` öğesi;** `grouping()` özel çağrıdır (nitelenmez).
- Kontrolsüz özyineleme için yeni mekanizma yok: sunucu tarafı `statement_timeout` (57014 → `DATABASE_TIMEOUT`) durdurur; entegrasyon testiyle pinlenir.
- Yorumlar Türkçe, hata mesajları İngilizce ve kararlı (`SQL_UNSUPPORTED`).
- Her görev: önce başarısız test (RED), sonra minimal kod; her görev bir commit. Commit mesajı sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push/PR/merge yok.
- Komutlar `packages/db` içinde: birim `bun test src/__tests__/unit/<dosya>`, tip `bunx tsc --noEmit`, lint `bunx eslint <dosyalar> --fix`. Entegrasyon yalnızca izole compose projesinde (`docker compose -p dbsql …`); paylaşılan jamaster stack'ine (5540/5541/5543 portlarını tutan `jamaster-*` container'ları) dokunulmaz — portlar doluysa durulur.

## Ölçülmüş zemin (plan yazılırken, `pgsql-ast-parser` 12.0.2)

- Parser ayrıştıramaz: `IS [NOT] DISTINCT FROM`, `WITH RECURSIVE`, `INTERSECT`/`EXCEPT`, pencere çerçevesi, `GROUPING SETS`.
- `GROUP BY ROLLUP (a, b)` ve `CUBE (…)` bir **`call`** düğümüdür (`function.name` = `rollup`/`cube`; bugün `unsupported function: rollup`). `ROLLUP ((a,b),(c))` içindeki `(c)` düz `c` olur; boş küme `()` ayrıştırılamaz (reddedilir ve belgelenir). `grouping(a)` de `call`'dır; `pg_catalog`'da `grouping`, `rollup`, `cube` işlevi **yoktur** (söz dizimidir, nitelenemez).
- `<>` AST'de `!=` olur (zaten izinli).
- `with` düğümünün `_location.start`'ı `WITH` sözcüğündedir; `FROM (WITH …)` içinde ise sarmalayan `(`'dedir.
- `rows`, `range`, `groups` sütun adı olarak ayrıştırılır (çerçeve sözcükleriyle karışmamalı).

## Review Focus

- Değiştirilen sözcük bir metin, yorum ya da tırnaklı tanımlayıcı içindeyse dokunulmaz (`'a INTERSECT b'`, `"except"`) → Task 1.
- `rows` adlı sütun, çerçeve düzenli ifadesiyle karışmaz → Task 1.
- Özyinelemeli CTE'nin kendi başvurusu tenant tablosu gibi nitelenmez; `RECURSIVE`'siz aynı SQL'de nitelenir → Task 2.
- `rollup(...)` bir `SELECT` listesinde ya da iç içe `GROUPING SETS` içinde fonksiyon gibi kabul edilmez → Task 2.
- Kontrolsüz özyineleme sunucu tarafında durur ve backend'i arkada çalışır bırakmaz → Task 3.

---

### Task 1: Parser boşluğunu çalışma anına aç; küme işlemleri, `IS DISTINCT FROM`, pencere çerçevesi

**Files:**
- Modify: `src/core/sql/parser-gaps.ts` (yerine koyma tablosu, çerçeve, `overwrite`)
- Modify: `src/core/sql/compiler.ts` (`analyze`: boşluklar migration ile sınırlı değil)
- Test: `src/__tests__/unit/sql-advanced.test.ts` (genişlet)

**Interfaces:**
- Consumes: `findParserGaps(masked): ParserGaps`, `attachParserGaps(statements, found, masked)`, `codeView` (parser-gaps.ts içi), E1'in test yardımcıları `bind`, `rejects`, `qualified`.
- Produces: `findParserGaps` artık çalışma anı kaynaklarında da çağrılır ve yeni yerine koymaları uygular; `ParserGaps` şekli değişmez. Task 2 aynı dosyaya `recursive` boşluk türünü ekler.

- [ ] **Step 1: Başarısız testleri ekle**

`sql-advanced.test.ts` sonuna:

```ts
test("INTERSECT and EXCEPT keep their original keywords and qualify every branch", () => {
  for (const keyword of ["INTERSECT", "INTERSECT ALL", "EXCEPT", "EXCEPT ALL", "intersect", "except   all"])
    expect(bind(`SELECT id FROM events ${keyword} SELECT id FROM archived`)).toBe(
      `SELECT id FROM ${qualified}events ${keyword} SELECT id FROM ${qualified}archived`,
    );
  expect(bind("SELECT id FROM a UNION SELECT id FROM b INTERSECT SELECT id FROM c EXCEPT SELECT id FROM d ORDER BY id")).toBe(
    `SELECT id FROM ${qualified}a UNION SELECT id FROM ${qualified}b INTERSECT SELECT id FROM ${qualified}c EXCEPT SELECT id FROM ${qualified}d ORDER BY id`,
  );
  expect(prepareQuery("SELECT id FROM a EXCEPT SELECT id FROM b").readOnly).toBe(true);
});

test("the first branch still names the output columns of INTERSECT/EXCEPT", () => {
  expect(bind("SELECT first_name FROM a INTERSECT SELECT first_name FROM b ORDER BY first_name")).toBe(
    `SELECT first_name AS "firstName" FROM ${qualified}a INTERSECT SELECT first_name FROM ${qualified}b ORDER BY "firstName"`,
  );
});

test("IS [NOT] DISTINCT FROM keeps its original text and still validates both operands", () => {
  expect(bind("SELECT id FROM events WHERE name IS DISTINCT FROM $1 OR name IS NOT DISTINCT FROM 'x'")).toBe(
    `SELECT id FROM ${qualified}events WHERE name IS DISTINCT FROM $1 OR name IS NOT DISTINCT FROM 'x'`,
  );
  const spread = "SELECT id FROM events WHERE name IS\n  NOT   DISTINCT\tFROM note";
  expect(bind(spread)).toBe(spread.replace("FROM events", `FROM ${qualified}events`));
  rejects("SELECT id FROM events WHERE nextval('s') IS DISTINCT FROM 1", /unsupported function: nextval/);
});

test("window frames pass through when strict and reject everything else", () => {
  for (const frame of [
    "ROWS BETWEEN 1 PRECEDING AND CURRENT ROW",
    "ROWS UNBOUNDED PRECEDING",
    "RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING",
    "GROUPS BETWEEN 2 PRECEDING AND 1 FOLLOWING",
    "ROWS 3 PRECEDING",
    "rows between current row and unbounded following",
  ])
    expect(bind(`SELECT sum(id) OVER (PARTITION BY name ORDER BY id ${frame}) AS s FROM events`)).toBe(
      `SELECT "pg_catalog"."sum"(id) OVER (PARTITION BY name ORDER BY id ${frame}) AS s FROM ${qualified}events`,
    );
  rejects("SELECT sum(id) OVER (ORDER BY id ROWS BETWEEN $1 PRECEDING AND CURRENT ROW) AS s FROM events");
  rejects("SELECT sum(id) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES) AS s FROM events");
  rejects("SELECT sum(id) OVER (ORDER BY id ROWS BETWEEN (SELECT 1) PRECEDING AND CURRENT ROW) AS s FROM events");
  rejects("SELECT ROWS UNBOUNDED PRECEDING FROM events");
});

test("look-alike words in strings, comments, quoted identifiers and plain columns are inert", () => {
  const source = `SELECT 'a INTERSECT b' AS v, "except" AS w, rows, range, groups FROM events WHERE rows BETWEEN 1 AND 2 -- IS DISTINCT FROM
    AND 'GROUPING SETS' = 'x' /* ROWS UNBOUNDED PRECEDING) */`;
  expect(bind(source)).toBe(source.replace("FROM events", `FROM ${qualified}events`));
});

test("migration-only clauses still fail closed in runtime queries", () => {
  rejects("SELECT id FROM events WHERE id = 1 UNIQUE NULLS NOT DISTINCT");
  rejects("ALTER TABLE events ALTER COLUMN id TYPE bigint USING id::bigint");
});
```

- [ ] **Step 2: Başarısızlığı doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: "INTERSECT…", "first branch…", "IS [NOT] DISTINCT FROM…", "window frames…" ve "look-alike…" FAIL (`SQL could not be parsed by the supported PostgreSQL grammar` ya da farklı `SQL_UNSUPPORTED`); "migration-only clauses…" ilk koşuda PASS olur (mevcut davranışı pinler).

- [ ] **Step 3: `parser-gaps.ts`'e yerine koyma ve çerçeve**

Dosya başındaki açıklamanın sonuna ekle: `Çalışma anı sorguları da aynı mekanizmayı kullanır; ek olarak INTERSECT/EXCEPT, IS [NOT] DISTINCT FROM, GROUPING SETS ve pencere çerçevesi parser kopyasında yerine konur/örtülür (SUBSTITUTES, FRAME).`

`QUOTED`/`IDENTIFIER` sabitlerinin altına:

```ts
// Parser'ın ayrıştıramadığı ama anlamı yürüteç için gerekmeyen sözcükler parser kopyasında yerine konur. Çıktı özgün kaynaktan üretilir ve
// anlam PostgreSQL'de özgün metinden gelir; yürüteç yalnızca yaprak SELECT'lerin kapsamına, işlev izin listesine ve soldaki dalın çıktı
// adlarına bakar: bunlar yerine konan sözcüğün ağaç biçiminden ve önceliğinden etkilenmez. Yerine konan metin her zaman ilk sözcüğe sığar.
const word = (pattern: string) => new RegExp(String.raw`(?<![\w$])${pattern}(?![\w$])`, "gi");
const SUBSTITUTES: readonly (readonly [RegExp, string])[] = [
  [word("(?:INTERSECT|EXCEPT)"), "UNION"],
  [word(String.raw`IS\s+NOT\s+DISTINCT\s+FROM`), "="],
  [word(String.raw`IS\s+DISTINCT\s+FROM`), "<>"],
  [word(String.raw`GROUPING\s+SETS`), "ROLLUP"],
];
// Pencere çerçevesi: yalnızca `UNBOUNDED`/`CURRENT ROW`/tam sayı sınırları ve `OVER (…)` parantezinin sonunda; `EXCLUDE`, `$n` ve
// ifadeli ofset eşleşmez, çerçeve parser'a kalır ve reddedilir.
const BOUND = String.raw`(?:UNBOUNDED\s+(?:PRECEDING|FOLLOWING)|CURRENT\s+ROW|\d+\s+(?:PRECEDING|FOLLOWING))`;
const FRAME = new RegExp(String.raw`(?<![\w$])(?:ROWS|RANGE|GROUPS)\s+(?:BETWEEN\s+${BOUND}\s+AND\s+${BOUND}|${BOUND})(?=\s*\))`, "gi");

/** `[start, start + length)` aralığına `text` yazar, kalanını boşlukla örter; satır sonları korunur (konumlar değişmez). */
function overwrite(chars: string[], start: number, length: number, text: string): void {
  for (let i = 0; i < length; i++) if (chars[start + i] !== "\n" && chars[start + i] !== "\r") chars[start + i] = text[i] ?? " ";
}
```

`findParserGaps` içinde, `const chars = masked.split("");` ve mevcut boşluk döngüsünden sonra:

```ts
  for (const [pattern, text] of SUBSTITUTES) for (const match of code.matchAll(pattern)) overwrite(chars, match.index, match[0].length, text);
  for (const match of code.matchAll(FRAME)) overwrite(chars, match.index, match[0].length, "");
```

(`code`, `codeView(masked)` çıktısıdır: tırnak içleri `_` ile örtülü olduğundan tırnak içindeki sözcükler eşleşmez; yorumlar `masked`'te zaten boşluktur.)

- [ ] **Step 4: `compiler.ts`: boşluklar çalışma anında da**

`analyze` içinde:

```ts
  const parsedSource = maskSqlComments(source);
  const gaps = findParserGaps(parsedSource);
  const statements = parseStatements(gaps.parsable, migration);
  attachParserGaps(statements, gaps, parsedSource);
```

(önceki `migration ? … : undefined` ve `if (gaps)` kalkar.)

- [ ] **Step 5: Testlerin geçtiğini doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: PASS. Başarısız bir `toBe` yalnızca beklenen nitelemeden farklıysa çıktıyı incele; yerine koyma sözcükleri çıktıya sızmamalıdır (çıktıda `UNION`/`ROLLUP`/`<>` görünüyorsa kod yanlıştır: çıktı özgün kaynaktan üretilmelidir).

- [ ] **Step 6: Mutasyon kontrolleri**

(a) `SUBSTITUTES`'ten `INTERSECT|EXCEPT` satırını geçici sil → ilk iki test düşer. (b) `IS DISTINCT FROM` satırını sil → ilgili test düşer. (c) `FRAME` örtmesini (`matchAll(FRAME)` satırı) sil → çerçeve testi düşer. Hepsini geri al; testler PASS.

- [ ] **Step 7: Tüm birim paketi, tip, lint**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint src/core/sql src/__tests__/unit/sql-advanced.test.ts --fix`
Expected: hepsi PASS/temiz. `sql.test.ts` içinde "unsupported" beklentisiyle INTERSECT/EXCEPT/çerçeve kullanan bir assertion varsa yeni davranışa göre güncellenir ve ledger'a `Ruling:` yazılır.

- [ ] **Step 8: Commit**

```bash
git add src/core/sql/parser-gaps.ts src/core/sql/compiler.ts src/__tests__/unit/sql-advanced.test.ts
git commit -m "sql: INTERSECT/EXCEPT, IS DISTINCT FROM and window frames via runtime parser gaps

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `WITH RECURSIVE` ve `GROUPING SETS` / `ROLLUP` / `CUBE` / `grouping()`

**Files:**
- Modify: `src/core/sql/parser-gaps.ts` (`recursive` boşluk türü, `attachRecursive`)
- Modify: `src/core/sql/grammar.ts` (`withStatement.recursive`, `specialCalls`)
- Modify: `src/core/sql/compiler.ts` (`Context.groupings`, `walk`, `expr` denetimi, `isGroupingCall`)
- Test: `src/__tests__/unit/sql-advanced.test.ts` (genişlet)

**Interfaces:**
- Consumes: Task 1'in `findParserGaps`/`overwrite`/`SUBSTITUTES` (`GROUPING SETS` → `ROLLUP` zaten yerine konuyor).
- Produces: `with.recursive: true` AST alanı; `Context.groupings: Set<Node>`; `isGroupingCall(node)`.

- [ ] **Step 1: Başarısız testleri ekle**

```ts
test("WITH RECURSIVE: the CTE sees itself; the same SQL without RECURSIVE reads a real table", () => {
  const body = "SELECT id, parent_id FROM nodes WHERE id = $1 UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN tree t ON n.parent_id = t.id";
  expect(bind(`WITH RECURSIVE tree AS (${body}) SELECT id FROM tree`)).toBe(
    `WITH RECURSIVE tree AS (SELECT id, parent_id FROM ${qualified}nodes WHERE id = $1 UNION ALL SELECT n.id, n.parent_id FROM ${qualified}nodes n JOIN tree t ON n.parent_id = t.id) SELECT id FROM tree`,
  );
  // RECURSIVE olmadan `tree` gövdede gerçek bir tablodur ve PostgreSQL'de de öyle çözülür.
  expect(bind(`WITH tree AS (${body}) SELECT id FROM tree`)).toContain(`JOIN ${qualified}tree t`);
});

test("WITH RECURSIVE works nested, in lower case, and a star over it expands from the first branch", () => {
  const nested = "SELECT id FROM events WHERE EXISTS (with recursive r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT 1 FROM r)";
  expect(bind(nested)).toBe(nested.replace("FROM events", `FROM ${qualified}events`));
  const inFrom = "SELECT s.n FROM (WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r) s";
  expect(bind(inFrom)).toBe(inFrom);
  const star = bind("WITH RECURSIVE r AS (SELECT 1 AS n_one UNION ALL SELECT n_one + 1 FROM r WHERE n_one < 3) SELECT * FROM r");
  expect(star).toContain(`"r"."n_one" AS "nOne"`);
  expect(prepareQuery("WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r").readOnly).toBe(true);
});

test("ROLLUP, CUBE and GROUPING SETS keep their text; grouping() is not qualified", () => {
  expect(bind("SELECT name, count(*) AS n, grouping(name) AS g FROM events GROUP BY ROLLUP (name)")).toBe(
    `SELECT name, "pg_catalog"."count"(*) AS n, grouping(name) AS g FROM ${qualified}events GROUP BY ROLLUP (name)`,
  );
  for (const group of ["CUBE (name, status)", "GROUPING SETS ((name, status), (name), (status))", "status, ROLLUP (name)", "rollup ((name, status), (name))"])
    expect(bind(`SELECT name, status FROM events GROUP BY ${group}`)).toBe(`SELECT name, status FROM ${qualified}events GROUP BY ${group}`);
  expect(prepareQuery("SELECT name FROM events GROUP BY GROUPING SETS ((name), (name))").readOnly).toBe(true);
});

test("ROLLUP, CUBE and GROUPING SETS are accepted only directly under GROUP BY", () => {
  rejects("SELECT rollup(name) AS r FROM events", /only directly in GROUP BY/);
  rejects("SELECT name FROM events GROUP BY name HAVING cube(name) IS NOT NULL", /only directly in GROUP BY/);
  rejects("SELECT name FROM events GROUP BY GROUPING SETS ((name), ROLLUP (status))", /only directly in GROUP BY/);
  rejects("SELECT name FROM events GROUP BY GROUPING SETS ((name), ())");
  rejects('SELECT name FROM events GROUP BY "rollup" (name)', /quoted SQL syntax/);
  rejects("SELECT name FROM events GROUP BY ROLLUP (nextval('s'))", /unsupported function: nextval/);
});
```

- [ ] **Step 2: Başarısızlığı doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: dört yeni test FAIL (`SQL could not be parsed…` — `RECURSIVE`; `unsupported function: rollup`).

- [ ] **Step 3: `parser-gaps.ts`: `recursive` boşluğu**

`GapKind`'e `"recursive"` ekle: `type GapKind = "using" | "nulls not distinct" | "if not exists" | "enum position" | "recursive";`

`nullsNotDistinctGaps`'in altına:

```ts
/** `WITH RECURSIVE` içindeki `RECURSIVE`. */
function recursiveGaps(code: string): Gap[] {
  return [...code.matchAll(/(?<![\w$])WITH(\s+)(RECURSIVE)(?![\w$])/gi)].map((match) => {
    const start = match.index + "WITH".length + (match[1]?.length ?? 0);
    return { kind: "recursive", start, end: start + (match[2]?.length ?? 0) };
  });
}
```

`findParserGaps` içindeki `gaps` listesine `...recursiveGaps(code),` ekle (`...nullsNotDistinctGaps(code),` yanına).

`attachNullsNotDistinct`'in altına:

```ts
/** `WITH` ile biten (varsa `(` ile başlayan) `with` düğümü `recursive` olur. */
function attachRecursive(value: unknown, gap: Gap, code: string): boolean {
  if (Array.isArray(value)) return value.some((item) => attachRecursive(item, gap, code));
  if (!value || typeof value !== "object") return false;
  const node = value as Node;
  const start = span(node)?.start ?? Infinity;
  if (node.type === "with" && start <= gap.start && /^[(\s]*WITH\s+$/i.test(code.slice(start, gap.start))) {
    node.recursive = true;
    return true;
  }
  return Object.entries(node).some(([key, child]) => key !== "_location" && attachRecursive(child, gap, code));
}
```

`attachParserGaps` içindeki ternary'yi genişlet:

```ts
    const attached =
      gap.kind === "using"
        ? attachUsing(statement, gap, found, masked)
        : gap.kind === "nulls not distinct"
          ? attachNullsNotDistinct(statement, gap, found.code)
          : gap.kind === "recursive"
            ? attachRecursive(statement, gap, found.code)
            : attachEnumClause(statement, gap, found.code, masked);
```

- [ ] **Step 4: `grammar.ts`**

```ts
const withStatement = { type: null, bind: "binding", in: "statement", recursive: null } as const;
```
```ts
export const specialCalls = commaSet("any,coalesce,nullif,greatest,least,exists,grouping,rollup,cube");
```

`withStatement` migration `with` ile paylaşıldığından veri migration'ları da `WITH RECURSIVE` kabul eder (tek yol; bilinçli).

- [ ] **Step 5: `compiler.ts`: kapsam ve yerleşim**

`Context`'e alan ekle (`requiresTransaction` satırının üstüne):

```ts
  /** Doğrudan `GROUP BY` öğesi olan `ROLLUP`/`CUBE` çağrıları: başka yerdeki aynı adlı çağrı fonksiyon sayılmaz. */
  readonly groupings: Set<Node>;
```

`analyze` içindeki `context` başlatmasına `groupings: new Set()` ekle:

```ts
  const context: Context = { source, parsedSource, migration, types, ...state, edits: [], requiresTransaction: false, groupings: new Set() };
```

`SEMANTIC_CHECKS`'in üstüne:

```ts
const isGroupingCall = (node: Node) => node.type === "call" && ["rollup", "cube"].includes(String((node.function as Node).name));
```

`SEMANTIC_CHECKS.expr` içinde `unsupported operator` satırının altına:

```ts
    if (isGroupingCall(node) && !context.groupings.has(node)) unsupported("ROLLUP, CUBE and GROUPING SETS are allowed only directly in GROUP BY");
```

`walk` içinde `if (type === "with") scope = new Set(scope);` satırını şununla değiştir ve `rules` döngüsünden önce SELECT kaydını ekle:

```ts
  // WITH yeni bir kapsam açar; her bağlama kendi gövdesinden sonra kapsama katılır. RECURSIVE'de tüm bağlamalar gövdelerde görünür.
  if (type === "with") {
    scope = new Set(scope);
    if (node.recursive) for (const binding of node.bind as Node[]) scope.add((binding.alias as Node).name as string);
  }
  if (type === "select") for (const item of (node.groupBy as Node[] | undefined) ?? []) if (isGroupingCall(item)) context.groupings.add(item);
```

(Mevcut yorum satırı `// WITH yeni bir kapsam açar; …` bu bloğun yorumuyla birleşir; eskisini sil.)

- [ ] **Step 6: Testlerin geçtiğini doğrula**

Run: `bun test src/__tests__/unit/sql-advanced.test.ts`
Expected: PASS. `rejects('… GROUP BY "rollup" (name)', /quoted SQL syntax/)` düşerse: parser tırnaklı adı `rollup` olarak verir ve `specialCalls` denetimi kaynak metni karşılaştırır; ileti farklıysa yalnızca `rejects` eşleşmesini koda göre düzeltmeden önce nedenini doğrula.

- [ ] **Step 7: Mutasyon**

(a) `walk`'taki `scope.add` döngüsünü sil → ilk RECURSIVE testi düşer. (b) `context.groupings.add` satırını sil → ROLLUP kabul testi düşer ("only directly"). (c) `specialCalls`'tan `grouping` sil → `grouping(name)` içeren test düşer. (d) `attachRecursive`'in regex'inde `[(\s]*` yerine `\s*` yap → `FROM (WITH RECURSIVE …)` içeren iç içe test düşer. Hepsini geri al.

- [ ] **Step 8: Tüm birim paketi, tip, lint**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint src/core/sql src/__tests__/unit/sql-advanced.test.ts --fix`
Expected: hepsi PASS/temiz. Mevcut bir assertion `WITH RECURSIVE`/`rollup`/`grouping` reddini bekliyorsa güncellenir ve `Ruling:` yazılır.

- [ ] **Step 9: Commit**

```bash
git add src/core/sql/parser-gaps.ts src/core/sql/grammar.ts src/core/sql/compiler.ts src/__tests__/unit/sql-advanced.test.ts
git commit -m "sql: WITH RECURSIVE scope and ROLLUP/CUBE/GROUPING SETS/grouping() under GROUP BY

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Gerçek PostgreSQL'de doğrulama, belgeler ve kapanış

**Files:**
- Modify: `src/__tests__/integration/sql-advanced.test.ts` (E1'in dosyasını genişlet)
- Modify: `docs/queries.md`, `src/core/sql/README.md`

**Interfaces:**
- Consumes: E1'in `withSchema(setup, work)`, `context`, `schemaName`; `failure` (`helpers.ts`); `raw`, `q`.
- Produces: yok (E3 aynı dosyayı genişletir).

- [ ] **Step 1: Entegrasyon testlerini ekle**

`src/__tests__/integration/sql-advanced.test.ts` import satırını `import { failure, integration, q, raw } from "./helpers";` yap ve dosyanın sonuna ekle:

```ts
const NODES = "CREATE TABLE nodes (id integer PRIMARY KEY, parent_id integer)";
const IDS = "CREATE TABLE left_ids (id integer); CREATE TABLE right_ids (id integer)";
const SALES = "CREATE TABLE sales (id integer PRIMARY KEY, region text NOT NULL, product text NOT NULL, amount integer NOT NULL, note text)";

integration("WITH RECURSIVE walks a tree", async () => {
  await withSchema(NODES, (run) =>
    run("sql-advanced", async (tenant) => {
      await tenant.query(prepareQuery("INSERT INTO nodes (id, parent_id) VALUES (1, NULL), (2, 1), (3, 1), (4, 2), (5, NULL)"));
      const rows = await tenant.query(
        prepareQuery(
          `WITH RECURSIVE tree AS (SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = $1::integer
             UNION ALL SELECT n.id, n.parent_id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id)
           SELECT id, depth FROM tree ORDER BY depth, id`,
        ),
        [1],
      );
      expect(rows).toEqual([{ id: 1, depth: 0 }, { id: 2, depth: 1 }, { id: 3, depth: 1 }, { id: 4, depth: 2 }]);
    }),
  );
});

integration("INTERSECT, EXCEPT and their ALL forms follow PostgreSQL precedence", async () => {
  await withSchema(IDS, (run) =>
    run("sql-advanced", async (tenant) => {
      await tenant.query(prepareQuery("INSERT INTO left_ids (id) VALUES (1), (2), (3), (3)"));
      await tenant.query(prepareQuery("INSERT INTO right_ids (id) VALUES (2), (3), (4)"));
      const ids = async (sql: string) => (await tenant.query(prepareQuery(sql))).map((row) => (row as { id: number }).id);
      expect(await ids("SELECT id FROM left_ids INTERSECT SELECT id FROM right_ids ORDER BY id")).toEqual([2, 3]);
      expect(await ids("SELECT id FROM left_ids EXCEPT SELECT id FROM right_ids ORDER BY id")).toEqual([1]);
      expect(await ids("SELECT id FROM left_ids INTERSECT ALL SELECT id FROM right_ids ORDER BY id")).toEqual([2, 3]);
      expect(await ids("SELECT id FROM left_ids EXCEPT ALL SELECT id FROM right_ids ORDER BY id")).toEqual([1, 3]);
      // INTERSECT, UNION'dan sıkı bağlanır: left ∪ (right ∩ {4}); sola ilişkili okunsaydı sonuç yalnızca [4] olurdu.
      expect(
        await ids("SELECT id FROM left_ids UNION SELECT id FROM right_ids INTERSECT SELECT id FROM right_ids WHERE id > 3 ORDER BY id"),
      ).toEqual([1, 2, 3, 4]);
    }),
  );
});

integration("IS DISTINCT FROM compares NULLs, window frames and grouping sets evaluate", async () => {
  await withSchema(SALES, (run) =>
    run("sql-advanced", async (tenant) => {
      await tenant.query(
        prepareQuery(
          "INSERT INTO sales (id, region, product, amount, note) VALUES (1, 'eu', 'a', 10, NULL), (2, 'eu', 'b', 20, 'x'), (3, 'us', 'a', 30, NULL), (4, 'us', 'b', 40, 'y')",
        ),
      );
      expect(await tenant.query(prepareQuery("SELECT id FROM sales WHERE note IS DISTINCT FROM 'x' ORDER BY id"))).toEqual([{ id: 1 }, { id: 3 }, { id: 4 }]);
      expect(await tenant.query(prepareQuery("SELECT id FROM sales WHERE note IS NOT DISTINCT FROM $1::text ORDER BY id"), [null])).toEqual([{ id: 1 }, { id: 3 }]);

      const frame = async (clause: string) =>
        (await tenant.query(prepareQuery(`SELECT sum(amount) OVER (ORDER BY id ${clause})::integer AS s FROM sales ORDER BY id`))).map((row) => (row as { s: number }).s);
      expect(await frame("ROWS BETWEEN 1 PRECEDING AND CURRENT ROW")).toEqual([10, 30, 50, 70]);
      expect(await frame("ROWS UNBOUNDED PRECEDING")).toEqual([10, 30, 60, 100]);
      expect(await frame("RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING")).toEqual([100, 100, 100, 100]);

      expect(
        await tenant.query(
          prepareQuery(
            "SELECT region, sum(amount)::integer AS total, grouping(region)::integer AS g FROM sales GROUP BY ROLLUP (region) ORDER BY g, region",
          ),
        ),
      ).toEqual([{ region: "eu", total: 30, g: 0 }, { region: "us", total: 70, g: 0 }, { region: null, total: 100, g: 1 }]);
      expect(
        await tenant.query(
          prepareQuery(
            "SELECT region, product, sum(amount)::integer AS total FROM sales GROUP BY GROUPING SETS ((region), (product)) ORDER BY region, product",
          ),
        ),
      ).toEqual([
        { region: "eu", product: null, total: 30 },
        { region: "us", product: null, total: 70 },
        { region: null, product: "a", total: 40 },
        { region: null, product: "b", total: 60 },
      ]);
      const cube = await tenant.query(prepareQuery("SELECT region, product, sum(amount)::integer AS total FROM sales GROUP BY CUBE (region, product)"));
      expect(cube).toHaveLength(9);
      expect(cube).toContainEqual({ region: null, product: null, total: 100 });
    }),
  );
});

// Kontrolsüz özyineleme için yeni mekanizma yoktur: sunucu tarafı statement_timeout durdurur ve backend arkada çalışmaz.
integration("a runaway recursive CTE is ended by the server statement timeout", async () => {
  const db = raw();
  const runaway = prepareQuery("WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r) SELECT count(*) AS runaway_marker FROM r").bind(schemaName());
  try {
    const started = performance.now();
    expect(await failure(db.transaction((tx) => tx.query(runaway, []), { statementTimeoutMs: 500 }))).toBe("DATABASE_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(10_000);
    let active = 1;
    for (let attempt = 0; attempt < 20 && active > 0; attempt++) {
      const [row] = (await db.query(
        "SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE state = 'active' AND query LIKE '%runaway_marker%' AND pid <> pg_catalog.pg_backend_pid()",
        [],
      )) as { n: number }[];
      active = row?.n ?? 0;
      if (active > 0) await Bun.sleep(100);
    }
    expect(active).toBe(0);
  } finally {
    await db.close();
  }
});
```

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

Expected: dört sürücüde de tüm testler PASS (E1'in 4 + E2'nin 4). Bir sürücüde çalışan deyim hâlâ sürüyorsa (runaway testi `active > 0` ile düşer) bu bir bulgudur: nedenini `systematic-debugging` ile bul ve `Ruling:` yaz (olası neden: bağlantı atılırken sunucu timeout'u uygulanmamış ya da `SET LOCAL statement_timeout` çalışmamış); sahibe sormadan sürücü davranışını değiştirme.

- [ ] **Step 4: Belgeleri güncelle**

`docs/queries.md`, E1'in eklediği "## JSON, dizi, regex ve tablo döndüren fonksiyonlar" bölümünün **sonuna** yeni bölüm:

````markdown
## Sorgu yapıları: özyineleme, küme işlemleri, çerçeve, gruplama kümeleri

```sql
-- name: subtree
WITH RECURSIVE tree AS (
  SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = $1::integer
  UNION ALL
  SELECT n.id, n.parent_id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id
)
SELECT id, depth FROM tree ORDER BY depth, id

-- name: movingTotal
SELECT id, sum(amount) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)::integer AS moving FROM sales ORDER BY id
```

- **`INTERSECT` / `EXCEPT`** (`ALL` dahil): her dal ayrı derlenir; çıktı adlarını soldaki dal verir.
- **`IS [NOT] DISTINCT FROM`**: `NULL`'ı eşit sayan karşılaştırma.
- **Pencere çerçevesi:** `ROWS`/`RANGE`/`GROUPS` + `UNBOUNDED PRECEDING|FOLLOWING`, `CURRENT ROW` ya da tam sayı sabiti + `PRECEDING|FOLLOWING`, `OVER (…)` parantezinin sonunda. `EXCLUDE`, `$n` ve ifadeli ofset desteklenmez.
- **`ROLLUP`, `CUBE`, `GROUPING SETS`** yalnızca doğrudan `GROUP BY` öğesi olarak; boş küme `()` ve iç içe `ROLLUP` desteklenmez. `grouping(sütun)` select listesinde ve `HAVING`'de kullanılır.
- **`WITH RECURSIVE`** için ek bir sınır yoktur: kontrolsüz özyinelemeyi sunucunun `statement_timeout`'u (varsayılan 5 sn, `bootstrap` ile DB'ye yazılır) durdurur ve istemci `DATABASE_TIMEOUT` görür. Yinelemenin sonlanacağından siz emin olun (`WHERE depth < N` gibi).
````

`src/core/sql/README.md`:

1. "### Parser gaps" paragrafının başındaki `For migrations only, …` cümlesinde `For migrations only,` ifadesini `In migrations and runtime queries,` ile değiştir ve bölümün sonuna ekle:

```markdown
Runtime queries (and data migrations) also use the gap finder for constructs the parser cannot represent but whose meaning the walker never needs. These are replaced in the parser's copy only, by a word of at most the same length, at whole-keyword boundaries outside quotes and comments: `INTERSECT`/`EXCEPT` → `UNION`, `IS [NOT] DISTINCT FROM` → `<>`/`=`, `GROUPING SETS` → `ROLLUP`. A strict window frame (`ROWS|RANGE|GROUPS` with `UNBOUNDED`/`CURRENT ROW`/integer bounds, ending the `OVER (…)` parentheses) is blanked. The emitted SQL always comes from the original source, so PostgreSQL parses the real keyword; the walker only validates leaf `SELECT`s, scopes, functions and the first branch's output names, none of which depend on set-operation shape or operator precedence. `WITH RECURSIVE` blanks `RECURSIVE` and attaches `recursive` to the `with` node so every CTE alias is in scope inside every body. `ROLLUP`/`CUBE` are parsed as calls and accepted only as direct `GROUP BY` items (nested ones, empty grouping sets and the same names elsewhere reject); `grouping()` is a special call, never qualified.
```

2. "`OVER ()` …" paragrafında `Named windows and explicit \`ROWS\`/\`RANGE\`/\`GROUPS\` frame clauses reject because this parser does not represent them.` cümlesini şununla değiştir: `Explicit \`ROWS\`/\`RANGE\`/\`GROUPS\` frames are supported in the strict form described under Parser gaps; named windows reject.`; `The compiler preserves PostgreSQL's default frame; it never inserts or rewrites a frame.` cümlesi kalır.
3. "Deferred grammar" listesinde `recursive CTEs, named windows/explicit frames,` ifadesini `named windows,` yap.

- [ ] **Step 5: Kapanış doğrulaması**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint . && bun run codegen --check`
Expected: birim PASS, tsc/eslint temiz, `codegen --check` temiz.

Mevcut entegrasyon paketi (izole yığında, `bun`): `RUN_INTEGRATION=1 DB_DRIVER=bun bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration`. Beklenen: yalnızca `deadline-matrix` "PgBouncer without a backend" düşer (taban `6048f9f`'de de düşen mevcut hata); başka bir düşüş E2'nin sorumluluğundadır.

- [ ] **Step 6: Yığını kaldır ve commit**

```bash
docker compose -p dbsql -f compose.yaml down -v
git add src/__tests__/integration/sql-advanced.test.ts docs/queries.md src/core/sql/README.md
git commit -m "sql: query structures integration tests on four drivers, docs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Expected: `docker ps` içinde `dbsql` projesine ait container kalmaz.
