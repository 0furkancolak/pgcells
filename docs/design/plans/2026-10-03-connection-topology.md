# Bağlantı topolojisi ve pooler zorunluluğu — Uygulama planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Runtime'ın bir transaction-mode pooler arkasında çalıştığını `db.ready()` içinde kanıtlamak (`POOLER_REQUIRED`) ve düğüm başına replica URL'lerini (`DATABASE_REPLICA_URLS`) yapılandırıp doğrulamak.

**Architecture:** Sınama `pg_backend_pid()`'i iki ayrı ayrılmış bağlantıda ardışık çalıştırıp karşılaştırır (doğrudan bağlantıda iki istemci aynı pid'i göremez, pooler'da görür); `core/tenants/pooler.ts` içinde tek işlev. `runtime.ts` `ready()` bunu düğüm başına bir kez çalıştırıp sonucu saklar. Replica yapılandırması `core/config.ts`'te ayrıştırılır ve doğrulanır; A alt projesinde kullanılmaz. `doctor`, `--pooled-urls` ile aynı sınamayı runtime URL'leriyle çalıştırır.

**Tech Stack:** Bun, TypeScript, `bun:test`, ESLint. Sürücüler Bun SQL / postgres.js / pg (`Driver` sözleşmesi). Yerel yığın: Docker Compose (PostgreSQL 16 × 2, PgBouncer 1.24 transaction modu).

**Spec:** [`docs/superpowers/specs/2026-10-03-connection-topology-design.md`](../specs/2026-10-03-connection-topology-design.md) (üst belge: [`2026-10-03-db-roadmap-design.md`](../specs/2026-10-03-db-roadmap-design.md)). Plan, spec'ten üç noktada bilinçli olarak ayrılır; Task 6 spec'i buna göre günceller: (1) sınama süresi sorgu başına değil, **bütün sınama** için sınırlıdır; (2) eşzamanlı `ready()` çağrıları aynı sınamayı bekler; (3) `doctor`, runtime URL'lerinin **kimliğini** denetlemez (yalnızca sayı ve sınama; kimlik `ready()`'nin işi).

## Global Constraints

Spec ve yol haritasından, değerler aynen:

- **`search_path` hiçbir biçimde kullanılmaz.** `options`/`search_path` URL parametresi reddedilir (replica URL'lerinde de).
- `DATABASE_URLS`: virgüllü liste, ilk URL platform DB'si, en çok 100, tekil, liste yalnızca sona eklenir. `DATABASE_URLS` kuralları ve sırası değişmez.
- `DATABASE_REPLICA_URLS` isteğe bağlıdır; biçim `db0=urlA,db0=urlB,db1=urlC`; düğüm başına en çok **8** replica; bütün URL'ler (primary + replica) tekil; replica bir primary'ye eşit olamaz.
- **Hata mesajları değer (URL, parola) içermez;** yalnızca kural ve düğüm kimliği.
- Runtime girişi (`@repo/db`, `core/runtime.ts` ve içe aktardıkları) **yönetim, parser, tools modüllerini yüklemez**. `pooler.ts` yalnızca `../database`, `../driver`'dan içe aktarır; `operations/locks.ts`'e dokunmaz.
- Yönetim (CLI, tools) doğrudan bağlantıda kalır; `DIRECT_CONNECTION_REQUIRED` davranışı değişmez.
- Sıcak yol (`withTenant`, sorgu) değişmez: sınama yalnızca `ready()` içinde, düğüm başına bir kez.
- Kod yorumları Türkçe, hata mesajları İngilizce, testler `bun:test` (mevcut stil).
- ESLint (`bun run lint`), `tsc --noEmit` (`bun run typecheck`) ve `bun test src/__tests__/unit` her görev sonunda temiz olmalı.
- Git: özellik dalı, **görev başına tek yerel commit**; push/PR yalnızca istendiğinde. Commit mesajı sonuna `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Migration/seed dosyası yok; `*.gen.ts` dosyalarına dokunulmaz.
- Bütün komutlar `packages/db` klasöründe çalışır.

## Review Focus

Spec'in ima edip hiçbir görevin testinin zaten örtmediği, en çok ısıracak durumlar (her biri aşağıda sahibi olan görevde bir testle sabitlenir):

1. **Replica URL'sinde `=` ve sorgu dizesi** (`db0=postgres://h/x?sslmode=require`): URL baştan sona korunmalı, anahtar yalnızca ilk `=`'ye kadar okunmalı → Task 1.
2. **`DATABASE_REPLICA_URLS` boş veya yalnızca boşluk:** replica yok sayılmalı, hata değil → Task 1.
3. **İki sağlık denetiminin aynı anda `ready()` çağırması:** tek sınama çalışmalı, ikisi aynı sonucu görmeli → Task 3.
4. **`poolMax: 1` (Workers tarzı) runtime'da `ready()`:** sınama kendi havuzuyla çalışmalı, çalışan havuzu etkilememeli → Task 3.
5. **Yanıt vermeyen veya erişilemeyen DB'de sınama:** süre dolunca `DATABASE_TIMEOUT`, havuz kapanmalı, işlenmemiş (unhandled) reddedilme olmamalı → Task 2.

## Dosya yapısı

| Dosya | Sorumluluk |
|---|---|
| `src/core/config.ts` (değişir) | `DatabaseNode.replicas`, `createConfig` ikinci argüman, `loadConfig` `DATABASE_REPLICA_URLS` |
| `src/core/tenants/pooler.ts` (yeni) | `usesTransactionPooler`: tek amaç, pooler sınaması |
| `src/core/runtime.ts` (değişir) | `pooler` seçeneği, `ready()` sınaması ve önbelleği, `POOLER_REQUIRED` |
| `src/core/tools/doctor.ts`, `src/core/cli.ts` (değişir) | `--pooled-urls`, `pooled_runtime` denetimi |
| `src/__tests__/unit/database-config.test.ts` (değişir) | replica yapılandırma testleri |
| `src/__tests__/unit/pooler.test.ts` (yeni) | sınama algoritması |
| `src/__tests__/unit/ready-pooler.test.ts` (yeni) | `ready()` entegrasyonu (sahte sürücü) |
| `src/__tests__/unit/doctor.test.ts`, `cli.test.ts` (değişir) | `pooled_runtime`, `--pooled-urls` |
| `src/__tests__/integration/pooler.test.ts` (yeni) | gerçek PostgreSQL + PgBouncer |
| `.env.example`, `README.md`, `docs/*.md`, spec (değişir) | belgeler |

Dal: `feat/connection-topology`, mevcut `feat/db-roadmap-specs` dalından açılır.

---

### Task 1: Replica yapılandırması (`DATABASE_REPLICA_URLS`)

**Files:**
- Modify: `src/core/config.ts:8-14` (`DatabaseNode`), `src/core/config.ts:65-75` (`createConfig`, `loadConfig`)
- Modify: `src/__tests__/unit/database-config.test.ts`

**Interfaces:**
- Consumes: mevcut `isDatabaseUrl`, `MAX_DATABASES`, `AppError`.
- Produces:
  - `DatabaseNode { id: string; url: string; replicas: readonly string[] }`
  - `createConfig(value: string | readonly string[], replicas?: string | readonly string[]): Config` (ikinci argüman varsayılan `[]`)
  - `loadConfig(env)` artık `env.DATABASE_REPLICA_URLS` da okur.
  - Hata: `AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_REPLICA_URLS")`.

- [ ] **Step 0: Dalı aç**

```bash
git switch -c feat/connection-topology
```

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/database-config.test.ts` içinde ilk testin beklentisini `replicas: []` ile güncelle ve dosyanın sonuna yeni testleri ekle.

İlk testi şu hale getir (satır 7-14):

```ts
test("DATABASE_URLS is split, trimmed and identified by position; the first URL is the platform DB", () => {
  expect(loadConfig({ DATABASE_URLS: ` ${one} , ${two}` })).toEqual({
    nodes: [
      { id: "db0", url: one, replicas: [] },
      { id: "db1", url: two, replicas: [] },
    ],
  });
});
```

Dosyanın sonuna ekle:

```ts
const replicaA = "postgres://app:local@localhost:6433/one";
const replicaB = "postgres://app:local@localhost:6434/one?sslmode=require";
const replicaC = "postgres://app:local@localhost:6435/two";

test("DATABASE_REPLICA_URLS attaches replicas to databases by id; a repeated key adds replicas and the whole URL is kept", () => {
  const config = loadConfig({ DATABASE_URLS: `${one},${two}`, DATABASE_REPLICA_URLS: ` db0=${replicaA} , db0=${replicaB},db1=${replicaC}` });
  expect(config.nodes.map((node) => [node.id, node.replicas])).toEqual([
    ["db0", [replicaA, replicaB]],
    ["db1", [replicaC]],
  ]);
  // URL içindeki `=` ve sorgu dizesi anahtarı bozmaz.
  expect(config.nodes[0]?.replicas[1]).toBe(replicaB);
});

test("no replica variable, a blank one or the array form: replicas are optional", () => {
  expect(loadConfig({ DATABASE_URLS: one }).nodes[0]?.replicas).toEqual([]);
  expect(loadConfig({ DATABASE_URLS: one, DATABASE_REPLICA_URLS: "" }).nodes[0]?.replicas).toEqual([]);
  expect(loadConfig({ DATABASE_URLS: one, DATABASE_REPLICA_URLS: "   " }).nodes[0]?.replicas).toEqual([]);
  expect(createConfig([one], [`db0=${replicaA}`]).nodes[0]?.replicas).toEqual([replicaA]);
});

test("replica lists reject missing keys, unknown databases, empty and duplicate entries, other protocols, schema routing and more than 8 replicas", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `db0=postgres://app:local@localhost:${7000 + i}/one`).join(",");
  for (const DATABASE_REPLICA_URLS of [
    replicaA,
    `db2=${replicaA}`,
    "db0=",
    `db0=${replicaA},,db0=${replicaB}`,
    `db0=${replicaA},db0=${replicaA}`,
    `db0=${one}`,
    `db1=${one}`,
    "db0=https://localhost/one",
    `db0=${replicaA}?search_path=tenant_a`,
    `db0=${replicaA}?options=-c%20search_path%3Dtenant_a`,
    nine,
  ])
    expect(() => loadConfig({ DATABASE_URLS: `${one},${two}`, DATABASE_REPLICA_URLS })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

test("replica configuration errors never echo URLs or passwords", () => {
  let message = "";
  try {
    loadConfig({ DATABASE_URLS: one, DATABASE_REPLICA_URLS: `db0=${one}` });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toBe("Invalid configuration: DATABASE_REPLICA_URLS");
  expect(message).not.toContain("local");
});
```

- [ ] **Step 2: Testlerin başarısız olduğunu doğrula**

Run: `bun test src/__tests__/unit/database-config.test.ts`
Expected: FAIL (`replicas` alanı yok, ikinci argüman yok).

- [ ] **Step 3: Uygula**

`src/core/config.ts` içinde `DatabaseNode`'u değiştir:

```ts
export interface DatabaseNode {
  id: string;
  /** Runtime'da transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive) olmalı; yönetimde doğrudan (veya session pooling) bağlantı olmalı. */
  url: string;
  /** Salt okunur replica URL'leri (`DATABASE_REPLICA_URLS`). Yalnızca doğrulanır; kullanımı replica çalışmasındadır. Yönetim yok sayar. */
  replicas: readonly string[];
}
```

`createConfig` ve `loadConfig` bloğunu (satır 65-75) şununla değiştir:

```ts
/** Düğüm başına en çok replica sayısı. */
const MAX_REPLICAS_PER_DATABASE = 8;
/** `db0=postgres://…`: anahtar yalnızca ilk `=`'ye kadardır; URL içindeki `=` ve sorgu dizesi korunur. */
const REPLICA_ENTRY = /^(db(?:0|[1-9]\d?))=(.+)$/;

interface MutableNode extends Omit<DatabaseNode, "replicas"> {
  replicas: string[];
}

/** `db0=urlA,db0=urlB,db1=urlC` (virgüllü metin veya dizi) → düğümlerin `replicas` listeleri. Boş metin replica yok demektir.
 * Hatalar hiçbir zaman değer içermez. */
function addReplicas(nodes: MutableNode[], value: string | readonly string[]) {
  const entries = typeof value === "string" ? (value.trim() ? value.split(",").map((entry) => entry.trim()) : []) : [...value];
  const known = new Set(nodes.map((node) => node.url));
  for (const entry of entries) {
    const [, id, url] = REPLICA_ENTRY.exec(entry) ?? [];
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node || !url || !isDatabaseUrl(url) || known.has(url) || node.replicas.length >= MAX_REPLICAS_PER_DATABASE)
      throw new AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_REPLICA_URLS");
    known.add(url);
    node.replicas.push(url);
  }
}

/** Virgüllü metin veya dizi → boş olmayan (en çok 100), tekil, schema yönlendirme parametresi olmayan postgres:// URL'leri.
 * `replicas`: isteğe bağlı `db0=url` girdileri (bkz. `addReplicas`). Hatalar hiçbir zaman değer içermez. */
export function createConfig(value: string | readonly string[], replicas: string | readonly string[] = []): Config {
  const urls = typeof value === "string" ? value.split(",").map((entry) => entry.trim()) : [...value];
  if (!urls.length || urls.length > MAX_DATABASES || !urls.every(isDatabaseUrl) || new Set(urls).size !== urls.length)
    throw new AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_URLS");
  const nodes: MutableNode[] = urls.map((url, index) => ({ id: `db${index}`, url, replicas: [] }));
  addReplicas(nodes, replicas);
  return { nodes };
}

/** Ortam: runtime, CLI, tools ve testler `DATABASE_URLS` okur; runtime ayrıca isteğe bağlı `DATABASE_REPLICA_URLS` okur. */
export const loadConfig = (env: Record<string, string | undefined> = process.env) =>
  createConfig(env.DATABASE_URLS ?? "", env.DATABASE_REPLICA_URLS ?? "");
```

- [ ] **Step 4: Testlerin geçtiğini ve tipin temiz olduğunu doğrula**

Run: `bun test src/__tests__/unit/database-config.test.ts && bun run typecheck`
Expected: PASS; typecheck hata vermez. (`DatabaseNode` literali kuran başka kod yoksa; varsa tsc yerini gösterir, `replicas: []` ekle.)

- [ ] **Step 5: Tüm birim testleri ve lint**

Run: `bun test src/__tests__/unit && bun run lint`
Expected: PASS, lint temiz.

- [ ] **Step 6: Commit**

```bash
git add src/core/config.ts src/__tests__/unit/database-config.test.ts
git commit -m "config: DATABASE_REPLICA_URLS parsed and validated onto each database node

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pooler sınaması (`usesTransactionPooler`)

**Files:**
- Create: `src/core/tenants/pooler.ts`
- Test: `src/__tests__/unit/pooler.test.ts`

**Interfaces:**
- Consumes: `Driver`, `Connection` (`../driver`); `deadlineExceeded` (`../database`, kod `DATABASE_TIMEOUT`).
- Produces:

```ts
export async function usesTransactionPooler(
  driver: Driver,
  url: string,
  options: { deadlineMs: number; rounds?: number },
): Promise<boolean>;
```

`true`: iki ayrı ayrılmış bağlantı aynı sunucu oturumunu (aynı `pg_backend_pid()`) görmüş, yani pooler kesin. `false`: `rounds` (varsayılan 10) turda hiç görülmedi. Hata: bağlantı/sorgu hatası olduğu gibi iletilir; süre dolarsa `DATABASE_TIMEOUT`. Havuz her durumda kapanır.

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/pooler.test.ts`:

```ts
import { expect, test } from "bun:test";
import { usesTransactionPooler } from "../../core/tenants/pooler";
import { fakeDriver } from "../fixtures/fake-driver";

const url = "postgres://app:secret-pw@localhost:6432/one";
const pidQueries = (fake: ReturnType<typeof fakeDriver>) => fake.commands.filter((command) => command.text.includes("pg_backend_pid")).length;

test("one server session seen by two held connections proves a pooler on the first round", async () => {
  const fake = fakeDriver(() => [{ pid: 7 }]);
  expect(await usesTransactionPooler(fake.driver, url, { deadlineMs: 1000 })).toBe(true);
  expect(pidQueries(fake)).toBe(2);
  const [pool] = fake.pools;
  expect(fake.pools).toHaveLength(1);
  expect(pool?.options.max).toBe(2);
  expect(pool?.released).toBe(2);
  expect(pool?.closed).toBe(true);
});

test("a pooler that only repeats a session on a later round is still found", async () => {
  let calls = 0;
  // 1-4. sorgu farklı oturumlar; 5. ve 6. (üçüncü turun çifti) aynı oturum.
  const fake = fakeDriver(() => [{ pid: ++calls <= 4 ? calls : 99 }]);
  expect(await usesTransactionPooler(fake.driver, url, { deadlineMs: 1000 })).toBe(true);
  expect(pidQueries(fake)).toBe(6);
  expect(fake.pools[0]?.released).toBe(6);
});

test("two distinct sessions in every round mean a direct connection", async () => {
  let pid = 0;
  const fake = fakeDriver(() => [{ pid: ++pid }]);
  expect(await usesTransactionPooler(fake.driver, url, { deadlineMs: 1000 })).toBe(false);
  expect(pidQueries(fake)).toBe(20); // varsayılan 10 tur × 2
  expect(fake.pools[0]?.released).toBe(20);
  expect(fake.pools[0]?.closed).toBe(true);

  let other = 0;
  const few = fakeDriver(() => [{ pid: ++other }]);
  expect(await usesTransactionPooler(few.driver, url, { deadlineMs: 1000, rounds: 3 })).toBe(false);
  expect(pidQueries(few)).toBe(6);
});

test("a probe that never gets an answer ends at the deadline, closes its pool and leaves no unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const fake = fakeDriver(() => new Promise<unknown[]>(() => {}));
    await expect(usesTransactionPooler(fake.driver, url, { deadlineMs: 20 })).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
    expect(fake.pools[0]?.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("a query failure is passed through unchanged and still closes the pool", async () => {
  const fake = fakeDriver(() => {
    throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
  });
  await expect(usesTransactionPooler(fake.driver, url, { deadlineMs: 1000 })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  expect(fake.pools[0]?.released).toBe(2);
  expect(fake.pools[0]?.closed).toBe(true);
});
```

- [ ] **Step 2: Testlerin başarısız olduğunu doğrula**

Run: `bun test src/__tests__/unit/pooler.test.ts`
Expected: FAIL (`../../core/tenants/pooler` bulunamaz).

- [ ] **Step 3: Uygula**

`src/core/tenants/pooler.ts`:

```ts
/** Runtime URL'sinin bir transaction-mode pooler'a (PgBouncer, Supavisor, Neon pooler, Hyperdrive) gittiğinin kanıtı. Pooler adı
 * SQL'den güvenilir okunmaz; bu yüzden davranışa bakılır: iki ayrı istemci ardışık deyimlerde aynı sunucu oturumunu görürse
 * (`pg_backend_pid`) pooler kesindir, çünkü doğrudan bağlantıda iki istemci aynı backend'i göremez. Hiç görülmemesi "doğrudan"
 * ya da "çok yoğun / dairesel dağıtan pooler" demektir (yanlış negatif mümkündür; `pooler: "assumed"` açık kaçıştır).
 * Advisory lock kullanılmaz: transaction modunda kilit sunucu bağlantısında sızabilir. */
import { deadlineExceeded } from "../database";
import type { Connection, Driver } from "../driver";

const PROBE_ROUNDS = 10;

const backendPid = async (db: Connection) => Number((await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]?.pid);

/** `true`: aynı sunucu oturumu iki ayrı bağlantıda görüldü. `false`: `rounds` turda görülmedi. Bütün sınama `deadlineMs` ile
 * sınırlıdır (`DATABASE_TIMEOUT`); bağlantı hataları olduğu gibi iletilir. Sınama kendi geçici havuzunu (`max: 2`) açar ve kapatır:
 * `poolMax: 1` (Workers) ve çalışan havuz etkilenmez. */
export async function usesTransactionPooler(
  driver: Driver,
  url: string,
  { deadlineMs, rounds = PROBE_ROUNDS }: { deadlineMs: number; rounds?: number },
): Promise<boolean> {
  const pool = driver(url, { max: 2, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(deadlineExceeded()), deadlineMs);
  });
  const probe = async () => {
    for (let round = 0; round < rounds; round++) {
      const first = await pool.reserve();
      const second = await pool.reserve().catch((error: unknown) => {
        first.release();
        throw error;
      });
      try {
        if ((await backendPid(first)) === (await backendPid(second))) return true;
      } finally {
        first.release();
        second.release();
      }
    }
    return false;
  };
  const work = probe();
  // Süre dolunca havuz kapanır ve yarım kalan sınama reddedilir; kimse beklemediği için işlenmemiş reddedilme olmamalı.
  work.catch(() => {});
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
    await pool.close(1000);
  }
}
```

- [ ] **Step 4: Testlerin geçtiğini doğrula**

Run: `bun test src/__tests__/unit/pooler.test.ts && bun run typecheck && bun run lint`
Expected: PASS, tip ve lint temiz.

- [ ] **Step 5: Commit**

```bash
git add src/core/tenants/pooler.ts src/__tests__/unit/pooler.test.ts
git commit -m "pooler probe: two held connections seeing one backend pid prove a transaction pooler

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `ready()` içinde pooler zorunluluğu (`POOLER_REQUIRED`)

**Files:**
- Modify: `src/core/runtime.ts` (içe aktarımlar, `RuntimeOptions`, `openDatabase`)
- Test: `src/__tests__/unit/ready-pooler.test.ts`

**Interfaces:**
- Consumes: `usesTransactionPooler(driver, url, { deadlineMs })` (Task 2); `DatabaseNode` (Task 1 sonrası); `AppError`, `databaseUnavailable` (`./errors`); `checkDatabases` (mevcut).
- Produces:
  - `RuntimeOptions.pooler?: "verified" | "assumed"` (varsayılan `"verified"`).
  - `Database.ready(): Promise<void>` artık `verified` iken her düğümde sınar:
    - doğrudan bağlantı → `AppError("POOLER_REQUIRED", "Database <id> is reachable without a transaction pooler; use a transaction-mode pooler URL in DATABASE_URLS or set pooler: \"assumed\"")`
    - bağlantı hatası → `AppError("DATABASE_UNAVAILABLE", "Database <id> is not reachable")`
    - süre dolması → `DATABASE_TIMEOUT` (olduğu gibi)
  - Başarılı sonuç düğüm başına saklanır; eşzamanlı çağrılar aynı sınamayı bekler; başarısız sonuç saklanmaz.

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/ready-pooler.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import type { RuntimeOptions } from "../../core/runtime";
import { createDatabase } from "../../core/runtime";
import { fakeDriver } from "../fixtures/fake-driver";

const url = "postgres://app:secret-pw@localhost:6432/one";

/** `pid()` her `pg_backend_pid` sorgusunun cevabıdır; kimlik ve kayıt sorguları db0'ı doğrular. */
function fixture(pid: () => number | Error) {
  const fake = fakeDriver((text) => {
    if (text.includes("pg_backend_pid")) {
      const value = pid();
      if (value instanceof Error) throw value;
      return [{ pid: value }];
    }
    if (text.includes("node_identity") || text.includes("platform.nodes")) return [{ database_id: "db0" }];
    return [];
  });
  const open = (options: Omit<RuntimeOptions, "driver"> = {}) => createDatabase(createConfig([url]), { driver: fake.driver, ...options });
  const probes = () => fake.commands.filter((command) => command.text.includes("pg_backend_pid")).length;
  return { fake, open, probes };
}

test("ready() refuses a direct connection with POOLER_REQUIRED and names only the database", async () => {
  let n = 0;
  const { open } = fixture(() => ++n);
  const db = open();
  const error = await db.ready().then(
    () => undefined,
    (reason: unknown) => reason as { code: string; message: string },
  );
  expect(error?.code).toBe("POOLER_REQUIRED");
  expect(error?.message).toContain("db0");
  expect(error?.message).not.toContain("secret-pw");
  expect(error?.message).not.toContain("localhost");
  await db.close();
});

test("a pooler passes and the result is kept: later ready() calls do not probe again", async () => {
  const { open, probes } = fixture(() => 7);
  const db = open();
  await db.ready();
  expect(probes()).toBe(2);
  await db.ready();
  await db.ready();
  expect(probes()).toBe(2);
  await db.close();
});

test("pooler: 'assumed' skips the probe", async () => {
  let n = 0;
  const { open, probes } = fixture(() => ++n);
  const db = open({ pooler: "assumed" });
  await db.ready();
  expect(probes()).toBe(0);
  await db.close();
});

test("a failed probe is not kept: the next ready() tries again", async () => {
  let pooled = false;
  let n = 0;
  const { open } = fixture(() => (pooled ? 7 : ++n));
  const db = open();
  await expect(db.ready()).rejects.toMatchObject({ code: "POOLER_REQUIRED" });
  pooled = true;
  await db.ready();
  await db.close();
});

test("two health checks calling ready() at once share one probe", async () => {
  const { open, probes } = fixture(() => 7);
  const db = open();
  await Promise.all([db.ready(), db.ready()]);
  expect(probes()).toBe(2);
  await db.close();
});

test("with poolMax 1 the probe uses its own two-connection pool and leaves the runtime pool alone", async () => {
  const { fake, open } = fixture(() => 7);
  const db = open({ poolMax: 1 });
  await db.ready();
  expect(fake.pools.some((pool) => pool.options.max === 2)).toBe(true);
  expect(fake.pools.filter((pool) => pool.options.max === 1).every((pool) => !pool.closed)).toBe(true);
  await db.close();
});

test("an unreachable database during the probe is DATABASE_UNAVAILABLE, not POOLER_REQUIRED", async () => {
  const { open } = fixture(() => Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
  const db = open();
  await expect(db.ready()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", message: expect.stringContaining("db0") });
  await db.close();
});
```

- [ ] **Step 2: Testlerin başarısız olduğunu doğrula**

Run: `bun test src/__tests__/unit/ready-pooler.test.ts`
Expected: FAIL (`pooler` seçeneği yok; `ready()` sınama yapmıyor; "POOLER_REQUIRED" yerine çözüm).

- [ ] **Step 3: Uygula**

`src/core/runtime.ts` içinde:

İçe aktarımları şöyle düzenle (satır 3 ve 9 çevresi):

```ts
import { type Config, type DatabaseNode, type DatabaseOptions, loadConfig, runtimeSettings } from "./config";
import { createPools, reportSpan, type SpanHandler, spanner } from "./database";
import type { Driver } from "./driver";
import { AppError, databaseUnavailable } from "./errors";
import { PLATFORM_SCHEMA } from "./sql/query";
import { createWithTenant, runContext, type TenantContext } from "./tenants/context";
import type { Placement } from "./tenants/model";
import { checkDatabases } from "./tenants/nodes";
import { createPlatform } from "./tenants/placement";
import { usesTransactionPooler } from "./tenants/pooler";
```

`RuntimeOptions`'a alan ekle:

```ts
export interface RuntimeOptions extends DatabaseOptions {
  /** `@repo/db/drivers/bun|postgres|pg`; yalnızca import edilen sürücü bundle'a girer. */
  driver: Driver;
  /** Ölçüm: her placement okuması, bağlantı bekleme, sorgu ve transaction süresi (bkz. `Span`). Verilmezse ek maliyet yok. */
  onSpan?: SpanHandler;
  /** `verified` (varsayılan): `ready()` her DB'nin transaction-mode pooler arkasında olduğunu sınar, değilse `POOLER_REQUIRED`.
   * `assumed`: sınama atlanır (sınanamayan ortamlar, ör. doğrulanmamış Hyperdrive); pooler olduğunu sağlamak uygulamanın işidir. */
  pooler?: "verified" | "assumed";
}
```

`openDatabase` imzası ve `ready` tanımı:

```ts
function openDatabase(input: Config, { driver, onSpan, pooler = "verified", ...options }: RuntimeOptions) {
```

`ready` satırını (şimdiki `const ready = () => checkDatabases(...).then(() => {});` ve üstündeki yorum) şununla değiştir:

```ts
  // Düğüm başına tek sınama: eşzamanlı `ready()` çağrıları aynı sonucu bekler, başarılı sonuç saklanır, başarısız olan silinir.
  const poolerChecks = new Map<string, Promise<void>>();
  const checkPooler = (node: DatabaseNode) => {
    let check = poolerChecks.get(node.id);
    if (!check) {
      check = usesTransactionPooler(driver, node.url, { deadlineMs: config.statementTimeoutMs + 1000 }).then(
        (pooled) => {
          if (!pooled)
            throw new AppError(
              "POOLER_REQUIRED",
              `Database ${node.id} is reachable without a transaction pooler; use a transaction-mode pooler URL in DATABASE_URLS or set pooler: "assumed"`,
            );
        },
        (error: unknown) => {
          throw databaseUnavailable(error) ? new AppError("DATABASE_UNAVAILABLE", `Database ${node.id} is not reachable`) : error;
        },
      );
      check.catch(() => poolerChecks.delete(node.id));
      poolerChecks.set(node.id, check);
    }
    return check;
  };
  /** Hazır: `platform.nodes` kayıtlı her DB'nin URL'si var, erişilebilir ve kimliği doğru; `pooler: "verified"` iken her URL bir
   * transaction-mode pooler'a gidiyor. Aksi halde `DATABASE_NOT_CONFIGURED`, `DATABASE_NOT_REGISTERED`, `DATABASE_UNAVAILABLE`,
   * `DATABASE_ORDER_CHANGED`, `DATABASE_TIMEOUT` veya `POOLER_REQUIRED`. Başlangıçta ve sağlık uç noktasında çağırın (istek yolunda değil). */
  const ready = async () => {
    await checkDatabases(pools, config.nodes.map((node) => node.id));
    if (pooler === "verified") await Promise.all(config.nodes.map(checkPooler));
  };
```

- [ ] **Step 4: Testlerin geçtiğini doğrula**

Run: `bun test src/__tests__/unit/ready-pooler.test.ts`
Expected: PASS (7 test).

- [ ] **Step 5: Tüm birim testleri, tip, lint**

Run: `bun test src/__tests__/unit && bun run typecheck && bun run lint`
Expected: PASS. (Mevcut birim testlerde `ready()` çağrılmıyor; çağıran olursa `pooler: "assumed"` ver.)

- [ ] **Step 6: Commit**

```bash
git add src/core/runtime.ts src/__tests__/unit/ready-pooler.test.ts
git commit -m "ready(): runtime must sit behind a transaction pooler (POOLER_REQUIRED, pooler option verified|assumed)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `doctor --pooled-urls` ve `pooled_runtime` denetimi

**Files:**
- Modify: `src/core/tools/doctor.ts` (içe aktarımlar, `externalChecks`, yeni işlevler, `doctor`)
- Modify: `src/core/cli.ts:49-58` (`Switches`), `:76` (`BOOLEAN_FLAGS`), `:78-84` (sorular ve `askUrl`), `:472-483` (`doctor` komutu)
- Modify: `src/__tests__/unit/doctor.test.ts`, `src/__tests__/unit/cli.test.ts`

**Interfaces:**
- Consumes: `usesTransactionPooler` (Task 2); `createConfig` (Task 1); `Management.driver` (mevcut).
- Produces:
  - `doctor(m, options: { pgbouncerUrl?: string; pooledUrls?: string; consoleDriver?: Driver })`
  - `pooledUrls`: `DATABASE_URLS` biçimi (virgüllü), aynı sayıda ve sırada. Sayı farklıysa `INVALID_CONFIG`.
  - Yeni denetim: `{ target: "<dbN>", check: "pooled_runtime", ok, detail }`.
  - Bayrak verilmezse `externalChecks` `pooled_runtime` içerir (doğrulanmamış); verilirse içermez.
  - CLI bayrağı `--pooled-urls`: değer almaz, gizli girişle sorar.

- [ ] **Step 1: Başarısız `doctor` testlerini yaz**

`src/__tests__/unit/doctor.test.ts` içinde handler'daki şu satırı değiştir:

```ts
    if (text.includes("pg_backend_pid")) return [{ pid: options.pooled ? 1 : 100 + pool.index }];
```

şununla:

```ts
    if (text.includes("pg_backend_pid")) {
      // Runtime URL'si sınaması: aynı havuzda iki bağlantı; pooler tek oturum, doğrudan her sorguda yeni oturum.
      if (pool.url.includes("pooler.example")) return [{ pid: 7 }];
      if (pool.url.includes("direct.example")) return [{ pid: ++runtimePid }];
      return [{ pid: options.pooled ? 1 : 100 + pool.index }];
    }
```

ve `let port = 8000;` satırının altına `let runtimePid = 1000;` ekle.

Dosyanın sonuna ekle:

```ts
const runtimeUrl = (host: string) => `postgres://admin:private-secret@${host}:6432/app`;

test("doctor --pooled-urls: a runtime URL on a transaction pooler passes pooled_runtime, a direct one fails it", async () => {
  for (const [host, ok] of [["pooler.example", true], ["direct.example", false]] as const) {
    const { app, fake } = fixture({});
    const result = await doctor(app, { pooledUrls: runtimeUrl(host) });
    await app.close();
    expect(result.checks).toContainEqual(expect.objectContaining({ target: "db0", check: "pooled_runtime", ok }));
    expect(result.externalChecks.map((item) => item.check)).not.toContain("pooled_runtime");
    expect(fake.pools.every((pool) => pool.closed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-secret");
  }
});

test("without --pooled-urls the pooled runtime requirement is reported as unverified and does not change ok", async () => {
  const result = await run({});
  expect(result.ok).toBe(true);
  expect(result.externalChecks).toContainEqual(expect.objectContaining({ check: "pooled_runtime", status: "unverified" }));
  expect(result.checks.map((item) => item.check)).not.toContain("pooled_runtime");
});

test("--pooled-urls must list exactly one URL per database", async () => {
  const { app } = fixture({});
  await expect(doctor(app, { pooledUrls: `${runtimeUrl("pooler.example")},${runtimeUrl("direct.example")}` })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await app.close();
});
```

- [ ] **Step 2: Testlerin başarısız olduğunu doğrula**

Run: `bun test src/__tests__/unit/doctor.test.ts`
Expected: yeni testler FAIL (`pooledUrls` yok); eskiler PASS.

- [ ] **Step 3: `doctor.ts`'i uygula**

İçe aktarımları değiştir:

```ts
import { createConfig, type DatabaseNode, runtimeDatabaseDefaults } from "../config";
import type { Connection, Driver } from "../driver";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import { tenantMigrations } from "../migrations/registry";
import { pendingPlatformMigrations, type PlatformScope } from "../operations/bootstrap";
import { openSession } from "../operations/locks";
import { usesTransactionPooler } from "../tenants/pooler";
```

`externalChecks` listesini şöyle yap:

```ts
const externalChecks = [
  ["pooled_runtime", "Uygulamanın DATABASE_URLS'i transaction-mode pooler'a gitmeli; doctor --pooled-urls ile sınayın (ready() de açılışta sınar)."],
  ["effective_pgbouncer_mode", "PgBouncer kullanılıyorsa uygulamanın kullanıcı/DB pool'ları için transaction modunu SHOW POOLS ile doğrulayın."],
  ["hyperdrive_cache", "Hyperdrive kullanılıyorsa bütün bağlantılarda query caching kapalı olmalı; hesap ayarından doğrulayın."],
  ["deployment", "Hedef ortamda /ready, TLS/ağ erişimi ve uygulamanın DATABASE_URLS sırasının yönetimle aynı olduğunu doğrulayın."],
].map(([check, detail]) => ({ check, status: "unverified", detail }));
```

`inspectPgBouncer`'dan önce şu iki işlevi ekle:

```ts
/** `--pooled-urls` sınaması için üst süre. */
const POOLED_PROBE_DEADLINE_MS = 10_000;

/** `--pooled-urls`: runtime URL'leri, `DATABASE_URLS` ile aynı sayıda ve sırada. Kimlik denetimi runtime'da `ready()`'nin işidir. */
function runtimeUrls(m: Management, pooledUrls: string) {
  const { nodes } = createConfig(pooledUrls);
  if (nodes.length !== m.config.nodes.length)
    throw new AppError("INVALID_CONFIG", "--pooled-urls must list one URL per DATABASE_URLS entry, in the same order");
  return nodes.map((node) => node.url);
}

/** Runtime URL'si bir transaction-mode pooler'a gitmeli; doğrudan bağlantı runtime'da `POOLER_REQUIRED` verir. */
async function inspectPooled(m: Management, url: string, add: Add) {
  const pooled = await usesTransactionPooler(m.driver, url, { deadlineMs: POOLED_PROBE_DEADLINE_MS });
  add("pooled_runtime", pooled, "Runtime DATABASE_URLS transaction-mode pooler'a gitmeli; doğrudan bağlantı runtime'da POOLER_REQUIRED verir.");
}
```

`doctor` işlevinin imzasını ve gövdesini şöyle güncelle:

```ts
export async function doctor(m: Management, options: { pgbouncerUrl?: string; pooledUrls?: string; consoleDriver?: Driver } = {}) {
  const pooled = options.pooledUrls === undefined ? undefined : runtimeUrls(m, options.pooledUrls);
  const checks: Check[] = [];
  /** Tek hedefi denetler; sürücü hataları kimlik bilgisi içerebildiğinden hata, ayrıntısı gizlenmiş bir denetim olur. */
  async function inspect(target: string, run: (add: Add) => Promise<void>) {
    const add: Add = (check, ok, detail) => checks.push({ target, check, ok, detail });
    try {
      await run(add);
    } catch (error) {
      add("inspection", false, `Denetim tamamlanamadı (${errorCode(error)}). Bağlantı ve yetkileri kontrol edin.`);
    }
  }

  await inspect("platform", (add) => inspectPlatform(m, add));
  for (const [index, node] of m.config.nodes.entries()) {
    await inspect(node.id, (add) => inspectNode(m, node, add));
    const url = pooled?.[index];
    if (url) await inspect(node.id, (add) => inspectPooled(m, url, add));
  }
  const { pgbouncerUrl, consoleDriver } = options;
  if (pgbouncerUrl !== undefined) await inspect("pgbouncer", (add) => inspectPgBouncer(pgbouncerUrl, consoleDriver, add));

  return {
    ok: checks.every((c) => c.ok),
    checks,
    externalChecks: pooled ? externalChecks.filter((item) => item.check !== "pooled_runtime") : externalChecks,
  };
}
```

- [ ] **Step 4: `doctor` testlerinin geçtiğini doğrula**

Run: `bun test src/__tests__/unit/doctor.test.ts`
Expected: PASS (eski ve yeni testler).

- [ ] **Step 5: Başarısız CLI testlerini yaz**

`src/__tests__/unit/cli.test.ts` içinde:

(a) `"tools commands share the CLI entry..."` testinde `--pgbouncer-url` içeren yardım metni listesini `["rollback-move <moveId>", "--pgbouncer-url", "--pooled-urls", "--writers-drained"]` yap ve hata listesine `["doctor", "--pooled-urls=postgres://admin:pw@h:5432/app"]` satırını ekle.

(b) `"URL options take no value from argv..."` testinin listesine iki satır ekle:

```ts
    ["doctor", `--pooled-urls=${url}`],
    ["doctor", "--pooled-urls", url],
```

(c) `"the PgBouncer admin URL is read from hidden input..."` testinin hemen ardından yeni test ekle:

```ts
test("the runtime URLs of doctor --pooled-urls are read from hidden input; a wrong count is INVALID_CONFIG and nothing is echoed", async () => {
  const cwd = await mkdtemp(join(scratch, ".tmp-cli-"));
  try {
    const secret = "postgres://admin:hunter2@127.0.0.1:1/app"; // DATABASE_URLS iki girdi, burada bir tane
    const child = Bun.spawn([process.execPath, cli, "doctor", "--pooled-urls"], {
      cwd,
      env: { PATH: process.env.PATH ?? "", DATABASE_URLS: "postgres://admin:hunter2@127.0.0.1:1/app,postgres://admin:hunter2@127.0.0.1:2/app" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const question = await readUntil(child.stderr as ReadableStream<Uint8Array>, "Runtime");
    const argv = await processArguments(child.pid);
    expect(argv).toContain("--pooled-urls");
    expect(argv).not.toContain("postgres://");
    child.stdin.write(`${secret}\n`);
    await child.stdin.flush();
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), question.rest()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("INVALID_CONFIG");
    expect(`${question.text}${stderr}${stdout}`).not.toContain("hunter2");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: CLI testlerinin başarısız olduğunu doğrula**

Run: `bun test src/__tests__/unit/cli.test.ts`
Expected: yeni/güncellenen testler FAIL (`--pooled-urls` bilinmiyor); diğerleri PASS.

- [ ] **Step 7: CLI'yi uygula**

`src/core/cli.ts`:

`Switches` tipine ekle (satır 49 yorumunu ve alanı):

```ts
/** Değer almayan seçenekler; `--from-url`, `--pgbouncer-url` ve `--pooled-urls` yalnızca "URL'yi gizli girişle sor" anlamına gelir. */
type Switches = {
  demo?: boolean;
  ts?: boolean;
  writersDrained?: boolean;
  fromUrl?: boolean;
  pgbouncerUrl?: boolean;
  pooledUrls?: boolean;
  full?: boolean;
  dropSource?: boolean;
  keepUnmatched?: boolean;
};
```

`BOOLEAN_FLAGS`'e `"--pooled-urls"` ekle:

```ts
const BOOLEAN_FLAGS = ["--dry-run", "--demo", "--ts", "--continue-on-error", "--writers-drained", "--from-url", "--pgbouncer-url", "--pooled-urls", "--full", "--drop-source", "--keep-unmatched"];
```

`askUrl`'ün altına ekle (soru sabiti `PGBOUNCER_URL_QUESTION`'ın yanına):

```ts
const POOLED_URLS_QUESTION = "Runtime URL'leri (DATABASE_URLS biçimi, virgüllü, yazılan görünmez): ";
/** Virgüllü URL listesi gizli girişle sorulur; her girdi doğrulanır, hata metinleri değeri içermez. */
const askUrls = async (question: string, subject: string) => {
  const { askSecret, postgresUrl } = await import("./tools/ask-secret");
  return (await askSecret(question))
    .split(",")
    .map((entry) => postgresUrl(entry.trim(), subject).href)
    .join(",");
};
```

`doctor` komutunu şöyle değiştir:

```ts
  doctor: {
    usage: "[--pgbouncer-url] [--pooled-urls]",
    summary:
      "Bağlantı, DB kimliği, timeout'lar ve platform durumunu salt okunur denetler (--pgbouncer-url: konsol URL'sini, --pooled-urls: runtime URL'lerini gizli girişle sorar)",
    flags: ["--pgbouncer-url", "--pooled-urls"],
    run: async ({ app, options }) => {
      const pgbouncerUrl = options.pgbouncerUrl ? await askUrl(PGBOUNCER_URL_QUESTION, "PgBouncer admin URL") : undefined;
      const pooledUrls = options.pooledUrls ? await askUrls(POOLED_URLS_QUESTION, "Runtime URL") : undefined;
      const result = await (await import("./tools/doctor")).doctor(app, { pgbouncerUrl, pooledUrls });
      if (!result.ok) process.exitCode = 1;
      return result;
    },
  },
```

- [ ] **Step 8: Testlerin geçtiğini doğrula**

Run: `bun test src/__tests__/unit && bun run typecheck && bun run lint`
Expected: PASS, tip ve lint temiz.

- [ ] **Step 9: Commit**

```bash
git add src/core/tools/doctor.ts src/core/cli.ts src/__tests__/unit/doctor.test.ts src/__tests__/unit/cli.test.ts
git commit -m "doctor --pooled-urls: runtime URLs are probed for a transaction pooler (hidden input, one URL per database)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Gerçek PostgreSQL + PgBouncer entegrasyon testi

**Files:**
- Create: `src/__tests__/integration/pooler.test.ts`

**Interfaces:**
- Consumes: `integration`, `driver`, `directConfig`, `pooledConfig`, `failure` (`./helpers`); `usesTransactionPooler`, `createDatabase`, `doctor`, `createManagement`.
- Produces: yok (yalnızca test).

Ön koşul: yerel yığın ayakta ve bootstrap edilmiş olmalı (`docker compose up -d --wait`, `.env`'de `DATABASE_URLS` doğrudan portlar 5540/5541; PgBouncer 5543). Başka bir compose projesi aynı portları tutuyorsa onu kullan.

- [ ] **Step 1: Testi yaz**

`src/__tests__/integration/pooler.test.ts`:

```ts
import { expect } from "bun:test";
import { createManagement } from "../../management";
import { doctor } from "../../core/tools/doctor";
import { usesTransactionPooler } from "../../core/tenants/pooler";
import { createDatabase } from "../../index";
import { directConfig, driver, failure, integration, pooledConfig } from "./helpers";

const urls = (config: ReturnType<typeof directConfig>) => config.nodes.map((node) => node.url);

integration("a direct URL fails the pooler probe and ready(); a transaction pooler passes; 'assumed' skips the probe", async () => {
  const [direct] = urls(directConfig());
  const [pooled] = urls(pooledConfig());
  expect(await usesTransactionPooler(driver, direct as string, { deadlineMs: 10_000 })).toBe(false);
  expect(await usesTransactionPooler(driver, pooled as string, { deadlineMs: 10_000 })).toBe(true);

  const refused = createDatabase(directConfig(), { driver });
  try {
    expect(await failure(refused.ready())).toBe("POOLER_REQUIRED");
  } finally {
    await refused.close();
  }
  const assumed = createDatabase(directConfig(), { driver, pooler: "assumed" });
  try {
    await assumed.ready();
  } finally {
    await assumed.close();
  }
  const accepted = createDatabase(pooledConfig(), { driver });
  try {
    await accepted.ready();
    await accepted.ready(); // saklanan sonuç
  } finally {
    await accepted.close();
  }
});

integration("doctor --pooled-urls: pooled runtime URLs pass pooled_runtime, direct ones fail it", async () => {
  const management = createManagement(directConfig(), { driver });
  try {
    const passing = await doctor(management, { pooledUrls: urls(pooledConfig()).join(",") });
    expect(passing.checks.filter((check) => check.check === "pooled_runtime").every((check) => check.ok)).toBe(true);
    const failing = await doctor(management, { pooledUrls: urls(directConfig()).join(",") });
    expect(failing.checks.filter((check) => check.check === "pooled_runtime").every((check) => !check.ok)).toBe(true);
    expect(failing.ok).toBe(false);
  } finally {
    await management.close();
  }
});
```

- [ ] **Step 2: Testi çalıştır**

Run: `RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/pooler.test.ts`
Expected: PASS (2 test). Yığın yoksa test atlanmaz, bağlantı hatası verir; önce `docker compose up -d --wait`.

- [ ] **Step 3: Diğer iki sürücüyle çalıştır**

Run: `DB_DRIVER=postgres RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/pooler.test.ts && DB_DRIVER=pg RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/pooler.test.ts`
Expected: PASS ikisinde de. Bir sürücüde sınama "doğrudan"ı pooler sanırsa ya da tersi olursa durup nedenini bul: sürücünün `reserve()` davranışı sınamanın varsayımını (iki ayrı istemci) bozuyor olabilir; çözümü `pooler.ts`'te yap, test beklentisini gevşetme.

- [ ] **Step 4: Mevcut entegrasyon testleri ve `ready()` kullanan test**

Run: `RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/tenancy.test.ts src/__tests__/integration/middleware.test.ts src/__tests__/integration/drivers.test.ts`
Expected: PASS. (`tenancy.test.ts` içindeki `ready` testi pooled URL'lerle çalışır; sınama `checkDatabases` hataları sonrasına düştüğü için hata kodları değişmez.)

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/integration/pooler.test.ts
git commit -m "integration: pooler probe, ready() and doctor --pooled-urls against real PostgreSQL and PgBouncer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Belgeler, `.env.example` ve spec eşitleme

**Files:**
- Modify: `.env.example`
- Modify: `README.md` (paket)
- Modify: `docs/configuration.md`, `docs/getting-started.md`, `docs/operations.md`, `docs/errors.md`, `docs/cli.md`, `docs/tenants.md`, `docs/jamaster-api.md`
- Modify: `../../docs/superpowers/specs/2026-10-03-connection-topology-design.md`

**Interfaces:** yok (yalnızca belge).

- [ ] **Step 1: `.env.example`'a replica açıklamasını ekle**

Dosyanın sonuna ekle (mevcut `DATABASE_URLS` satırından sonra):

```
# Optional read replicas (runtime only; CLI and tools ignore them), keyed by database id; repeat a key for several replicas of one
# database, at most 8 each. Parsed and validated now; read routing arrives with the replica work.
# DATABASE_REPLICA_URLS=db0=postgres://admin:local_admin_password@127.0.0.1:5545/app,db1=postgres://admin:local_admin_password@127.0.0.1:5546/app
```

Ayrıca dosyanın başındaki `An application process may point the same variable at PgBouncer (transaction pooling)` cümlesini `An application process must point the same variable at a transaction-mode pooler such as PgBouncer (db.ready() refuses direct URLs with POOLER_REQUIRED unless createDatabase gets pooler: "assumed")` olarak değiştir.

- [ ] **Step 2: `README.md` (paket) cümlesini güncelle**

Satır 3'teki `Uygulama PgBouncer (transaction modu) veya Hyperdrive üzerinden, yönetim (CLI ve yönetim fonksiyonları) doğrudan bağlantıyla çalışır.` cümlesini şununla değiştir:

`Uygulama bir transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive) üzerinden çalışır ve `db.ready()` bunu açılışta sınar (`POOLER_REQUIRED`); yönetim (CLI ve yönetim fonksiyonları) doğrudan bağlantıyla çalışır.`

- [ ] **Step 3: `docs/configuration.md`**

(a) "Doğrudan bağlantı ve pooler" tablosunun uygulama satırını şununla değiştir:

```
| Uygulama (`createDatabase`, `dbMiddleware`) | Transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Cloudflare Hyperdrive) | Sorgu yolu isimli prepared statement ve oturum durumu kullanmaz; sunucu tarafı timeout’lar DB varsayılanıdır. `db.ready()` bunu sınar; doğrudan bağlantıda `POOLER_REQUIRED` |
```

(b) Aynı bölümde, "Her yönetim oturumu açılırken…" paragrafından hemen sonra yeni paragraf ekle:

```
**Runtime’da pooler zorunludur.** `db.ready()` (`pooler: "verified"`, varsayılan) her DB için iki ayrı bağlantıyı ayırır ve ardışık olarak `pg_backend_pid()` sorar: pooler’da iki istemci aynı sunucu oturumunu görür, doğrudan bağlantıda hiçbir zaman göremez. Hiç görülmezse `POOLER_REQUIRED` fırlatır (mesaj yalnızca DB kimliğini içerir). Sınama bir sezgisel yöntemdir: aynı oturum **görülürse** pooler kesindir; görülmezse bağlantı doğrudandır ya da pooler çok yoğundur. Yanlış negatifte `createDatabase(…, { pooler: "assumed" })` sınamayı açıkça atlar; bu yalnızca sınanamayan ortamlar içindir (ör. Hyperdrive’da sınamanın çalıştığı henüz doğrulanmadı). Sonuç DB başına bir kez saklanır; sağlık uç noktasında `ready()`’yi tekrar çağırmak yeniden sınamaz. `ready()`’yi başlangıçta ve `/ready` uç noktasında çağırın, istek yolunda değil (Workers’ta istek başına havuz kurulur). `ready()` çağrılmayan uygulamada zorunluluk uygulanmaz.

**Replica URL’leri (isteğe bağlı).** `DATABASE_REPLICA_URLS=db0=urlA,db0=urlB,db1=urlC`: anahtar DB kimliğidir, aynı anahtar tekrarlanarak bir DB’ye birden çok replica eklenir (en çok 8). Bütün URL’ler (primary ve replica) tekil olmalı, replica bir primary’ye eşit olamaz, `options`/`search_path` parametresi yasaktır; hatalar `INVALID_CONFIG` verir ve değer içermez. Yönetim replica’ları yok sayar. Replica’lar şimdilik yalnızca doğrulanır; okuma yönlendirmesi replica çalışmasında gelir.
```

(c) "### PgBouncer" bölümünün ilk maddesinin üstüne şu cümleyi ekle: `PgBouncer, runtime için kabul edilen pooler’lardan yalnızca biridir (bkz. yukarıdaki tablo); aşağıdakiler PgBouncer’a özeldir.`

(d) "### Bun sunucusu" paragrafındaki `Uygulama DATABASE_URLS’i PgBouncer’a yöneltebilir;` ifadesini `Uygulama DATABASE_URLS’i bir transaction-mode pooler’a yöneltmelidir (PgBouncer vb.; db.ready() sınar);` yap.

- [ ] **Step 4: `docs/getting-started.md`**

(a) `await db.ready();` satırının yorumunu şu yap: `// eksik, kapalı, sırası değişmiş DB ya da pooler’sız (doğrudan) URL varsa başlamaz`.

(b) "Sık hatalar" listesinin başına ekle:

```
- **`POOLER_REQUIRED`** — uygulamanın `DATABASE_URLS`’i doğrudan PostgreSQL portlarına (5540/5541) gidiyor; runtime transaction-mode pooler ister. Yerel yığında PgBouncer adresini (`:5543/db0,…/db1`) kullanın; sınanamayan ortamlarda bilerek `pooler: "assumed"` verin.
```

- [ ] **Step 5: `docs/operations.md` doctor tablosu**

`global_pool_mode` satırının hemen üstüne şu satırı ekle:

```
| `pooled_runtime` | her DB | `--pooled-urls` verildiyse: runtime URL’si transaction-mode pooler’a gitmiyor (runtime’da `POOLER_REQUIRED` verir). Seçenek değer almaz; URL’ler (`DATABASE_URLS` biçimi, aynı sayıda ve sırada) gizli girişle sorulur, argv’ye düşmez. Sayı uyuşmazsa `INVALID_CONFIG` |
```

Tablonun altındaki `externalChecks` paragrafında `effective_pgbouncer_mode` ifadesinden önce `pooled_runtime` (`--pooled-urls` verilmediyse; `ready()` zaten açılışta sınar), ve `effective_pgbouncer_mode`'u `(PgBouncer kullanılıyorsa DB/kullanıcı pool’ları için SHOW POOLS)` olarak düzelt.

`global_pool_mode` satırının başına `PgBouncer’a özel ek bilgi:` ekle.

- [ ] **Step 6: `docs/errors.md`**

`DATABASE_NOT_CONFIGURED` satırının altına ekle:

```
| `POOLER_REQUIRED` | `ready()`: bir DB’ye transaction pooler olmadan (doğrudan) bağlanılıyor; mesaj yalnızca `dbN` içerir | `DATABASE_URLS`’i transaction-mode pooler’a yöneltin (PgBouncer, Supavisor, Neon pooler, Hyperdrive); sınanamayan ortamda bilerek `pooler: "assumed"`; 503 |
```

`INVALID_CONFIG` satırına (bulunduğu yerde) şu ifadeyi ekle: `, geçersiz `DATABASE_REPLICA_URLS` (bilinmeyen DB, tekrarlı/yanlış URL, 8’den çok replica, `--pooled-urls` sayısı)`.

- [ ] **Step 7: `docs/cli.md`**

`doctor` satırını şu yap:

```
| `doctor [--pgbouncer-url] [--pooled-urls]` | — (yalnızca CLI) | Salt okunur denetim; `ok: false` ise çıkış kodu 1. `--pgbouncer-url` ve `--pooled-urls` değer almaz: konsol URL’si / runtime URL’leri (virgüllü, `DATABASE_URLS` sırasıyla) gizli girişle sorulur (argv’ye yazılmaz), terminal yoksa stdin’in ilk satırı okunur |
```

- [ ] **Step 8: `docs/tenants.md` "Hazırlık: `db.ready()`"**

İlk paragrafın sonuna `Ayrıca her DB’nin bir transaction-mode pooler arkasında olduğunu sınar (`pooler: "verified"`, varsayılan); değilse `POOLER_REQUIRED`.` cümlesini ekle ve tablonun altına satır ekle:

```
| `POOLER_REQUIRED` | DB’ye doğrudan (pooler’sız) bağlanılıyor | `DATABASE_URLS`’i pooler’a yöneltin ya da sınanamayan ortamda bilerek `pooler: "assumed"` |
```

- [ ] **Step 9: `docs/jamaster-api.md`**

Eşleme tablosundaki ilk satırın sağ hücresinin sonuna `; `db.ready()` açılışta PgBouncer arkasında olduğunu sınar (`POOLER_REQUIRED`)` ekle.

- [ ] **Step 10: Spec'i uygulamayla eşitle**

`../../docs/superpowers/specs/2026-10-03-connection-topology-design.md` içinde üç değişiklik:

1. `5. Havuzu her durumda kapat; her sorgu `deadlineMs` ile sınırlı.` satırını şununla değiştir:
`5. Havuzu her durumda kapat; bütün sınama `deadlineMs` ile sınırlıdır (süre dolunca `DATABASE_TIMEOUT`); `ready()` bunu `statementTimeoutMs + 1 sn` olarak verir.`
2. `` `ready()` her çağrıda (sağlık uç noktası) yeniden sınamaz. `` ifadesinin sonuna ` Eşzamanlı çağrılar aynı sınamayı bekler.` ekle.
3. `Sayı veya kimlik uyuşmazlığı `database_identity` ile yakalanır.` cümlesini şununla değiştir:
`Girilen URL sayısı `DATABASE_URLS` ile aynı değilse `INVALID_CONFIG` (runtime URL'lerinin kimlik denetimi `ready()`'nin işidir).`

Run: `grep -n "database_identity\` ile yakalanır\|her sorgu \`deadlineMs\`" ../../docs/superpowers/specs/2026-10-03-connection-topology-design.md`
Expected: çıktı boş (eski ifadeler kalmadı).

- [ ] **Step 11: Doğrula ve commit**

Run: `bun test src/__tests__/unit && bun run lint && bun run codegen --check`
Expected: PASS (belge değişiklikleri testleri etkilemez; `codegen --check` temiz).

```bash
git add .env.example README.md docs ../../docs/superpowers/specs/2026-10-03-connection-topology-design.md
git commit -m "docs: POOLER_REQUIRED, pooler option, DATABASE_REPLICA_URLS, doctor --pooled-urls; spec synced with implementation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Son doğrulama

**Files:** yok (yalnızca doğrulama; sorun bulunursa ilgili görevin dosyasında düzelt ve ayrı commit at).

- [ ] **Step 1: Birim testler, tip, lint, codegen, build**

Run: `bun test src/__tests__/unit && bun run typecheck && bun run lint && bun run codegen --check && bun run build && bun run build:workers`
Expected: hepsi PASS; `build` runtime girişlerini üretir, `build:workers` (Workers paketleme) hata vermez. `core/tenants/pooler.ts` yönetim/parser modülü içe aktarmaz: `grep -n "import" src/core/tenants/pooler.ts` yalnızca `../database` ve `../driver` göstermeli.

- [ ] **Step 2: Entegrasyon testleri üç sürücüyle**

Run (her sürücü için bir kez, `DB_DRIVER=bun|postgres|pg`): `RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration`
Expected: PASS; sızıntı bekçisi (leak guard) temiz. (Uzun sürebilir; ayrı terminalde çalıştırılabilir.)

- [ ] **Step 3: Davranışı elle doğrula**

Run: `bun -e 'import { createDatabase } from "./src/index"; import { bunDriver } from "./src/core/drivers/bun"; import { loadConfig } from "./src/index"; const db = createDatabase(loadConfig(), { driver: bunDriver }); await db.ready().then(() => console.log("ready"), (e) => console.log(e.code)); await db.close();'`
Expected: `.env`'deki doğrudan URL'lerle `POOLER_REQUIRED` yazar; `DATABASE_URLS`'i PgBouncer adresleriyle (`...:5543/db0,...:5543/db1`) vererek tekrarlayınca `ready` yazar.

- [ ] **Step 4: Sonucu raporla**

Yalnızca gerçekten çalıştırılan ve geçen komutları rapor et. Çalıştırılamayan (ör. Docker yığını yok) adım varsa açıkça "çalıştırılmadı" de.

---

## Spec kapsam kontrolü

| Spec bölümü | Görev |
|---|---|
| §1 Yapılandırma (`replicas`, `createConfig` ikinci argüman, `loadConfig`, doğrulama kuralları) | Task 1 |
| §2 Pooler sınaması (algoritma, geçici havuz, deadline, asimetri) | Task 2 |
| §3 `ready()` entegrasyonu (`pooler` seçeneği, `POOLER_REQUIRED`, `DATABASE_UNAVAILABLE`, önbellek, sıcak yola etki yok, Workers/Hyperdrive notu) | Task 3, belge: Task 6 |
| §4 `doctor` (`--pooled-urls`, `pooled_runtime`, `externalChecks`, `--pgbouncer-url` ek bilgi) | Task 4, belge: Task 6 |
| §5 Kırıcı etki ve belgeler | Task 6 |
| Testler (birim, entegrasyon, başarısızlık modları) | Task 1-5 |
| Riskler (yanlış negatif → `assumed`; Hyperdrive doğrulanmadı; `ready()` çağrılmayan uygulama) | Task 3 (`assumed`), Task 6 (belge) |
