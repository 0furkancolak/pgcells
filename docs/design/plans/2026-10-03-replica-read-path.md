# Replica Read Path Implementation Plan (C1)

> **Durum (2026-10-19): uygulandı (replika okuma yolu); bölge yerelliği F4'te eklendi.** Onay kutuları işaretlenmedi; gerçek durumun kaynağı koddur, testlerdir ve [yol haritası](2026-10-18-roadmap-remaining.md)dır.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Salt okunur sorgular açık bir okuma bağlamıyla (`db.withTenantRead`, `RequestDb.tenantRead`) replica'dan okunur; replica sağlığı/lag önbellekli yoklanır, düşme politikası (`primary` | `error`) ve aynı istekte yazıdan sonra okumanın primary'de kalması çalışır.

**Architecture:** Codegen her sorguya `readOnly` bayrağı yazar (AST'den, çalışma zamanında ayrıştırma yok). `createPools` düğüm başına tembel replica havuzları açar. `createReplicaRouter` replica durumunu (sağlık + lag) süreli önbellekle tutar ve round-robin seçer. `createWithTenantRead` seçilen replica'ya sabitlenmiş bir bağlamda yalnızca `readOnly` sorgu çalıştırır; sağlıklı replica yoksa politikaya göre primary'de `READ ONLY` transaction'a düşer ya da `REPLICA_UNAVAILABLE` verir. `createDbScope` tenant yazısını işaretler, sonraki okumalar primary'ye gider.

**Tech Stack:** Bun + TypeScript, `pgsql-ast-parser` AST'si (`core/sql/compiler.ts`), sürücü sözleşmesi (`core/driver.ts`), `bun test` (birim: `fakeDriver`; entegrasyon: izole compose), PostgreSQL 16 akış replikasyonu.

**Spec:** `docs/superpowers/specs/2026-10-03-replica-support-design.md` (C1 bölümleri: C1 sorgu bayrağı/okuma bağlamı, C2 replica havuzları/sağlık/seçim, Hatalar, Test altyapısı). Araçlar (`replicas` komutu, `doctor`, `--from-replica`) ayrı plandadır: `2026-10-03-replica-tools.md`, bu planın router'ını kullanır.

## Global Constraints

- `search_path` hiçbir biçimde kullanılmaz; her SQL `pg_catalog.` nitelikli.
- **Yeni ortam değişkeni yok.** Ayarlar düz seçenektir (`replicaMaxLagMs`, `replicaStatusMs`, `replicaOnUnavailable`); test sabitleri sabit varsayılandır.
- Hedef DB her çağrıda açık: otomatik yönlendirme yok; `node` ve `platform` bağlamları primary'de kalır.
- Yorumlar Türkçe, hata mesajları İngilizce ve değer (URL/host/kullanıcı) içermez; yeni kodlar: `QUERY_NOT_READ_ONLY`, `REPLICA_UNAVAILABLE`.
- Varsayılanlar: `replicaMaxLagMs` 5000 (üst sınır 3 600 000), `replicaStatusMs` 5000 (üst sınır 60 000), `replicaOnUnavailable` `"primary"`; geçersiz değer `INVALID_CONFIG`.
- Okuma bağlamında `transaction` yok (tip düzeyinde); sorgu başına gizli yeniden deneme yok; bağlantı hatası replica'yı `up = false` işaretler ve hata yüzeye çıkar.
- `ready()` replica'yı beklemez ve ondan hata vermez.
- Her görev: önce başarısız test (RED), sonra minimal kod; her görev bir commit. Commit mesajı sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push/PR/merge yok.
- Testler `packages/db` içinde çalışır: birim `bun test src/__tests__/unit/<dosya>`, tip `bunx tsc --noEmit`, lint `bunx eslint <dosyalar> --fix`.

## Review Focus

- Okuma bağlamında `readOnly` olmayan sorgu **hiçbir DB'ye gitmeden** reddedilir (Task 5 testi komut sayısı 0'ı doğrular).
- Replica sorgusu bağlantı hatasıyla düşünce replica işaretlenir, ama SQL hatası (ör. `57014` statement timeout) replica'yı düşürmez (Task 5).
- Yazıdan sonra okuma: transaction içindeki yazı da işaret koyar, yalnızca okuma yapan transaction koymaz (Task 6).
- Aynı replica için eşzamanlı çağrılar tek yoklamada birleşir; yoklama hatası önbelleğe yazılır ve `replicaStatusMs` boyunca yeniden yoklanmaz (Task 4).
- `onUnavailable: "error"` iken replica hiç yapılandırılmamışsa da `REPLICA_UNAVAILABLE` (primary'ye sessiz düşme yok), ama yazıdan sonra okuma bundan etkilenmez (Task 5).

---

### Task 1: `readOnly` sorgu bayrağı (compiler, `defineQuery`, codegen)

**Files:**
- Modify: `src/core/sql/compiler.ts` (`Compiled`, `compile`, `prepareQuery`)
- Modify: `src/core/sql/query.ts` (`PreparedQuery`, `defineQuery`)
- Modify: `src/core/sql/codegen.ts:53` (`queryExport`)
- Modify: `src/__tests__/fixtures/worker.ts:11`
- Regenerate: `src/queries/node/identity.gen.ts`, `src/queries/platform/tenants.gen.ts`, `src/queries/tenant/auth.gen.ts`
- Modify: `src/__tests__/unit/sql-codegen.test.ts` (lock assertion)
- Test: `src/__tests__/unit/sql-read-only.test.ts` (yeni)

**Interfaces:**
- Consumes: `compile(source, migration, types?, tables?, created?)` AST'si (`statement.type`: `select|values|union|union all|with|insert|update|delete`; `select.for` kilit; `with.bind[].statement`, `with.in`).
- Produces: `PreparedQuery.readOnly: boolean`; `defineQuery(parts, requiresTransaction, scope, readOnly)`; `prepareQuery(...)` bunu doldurur; üretilen dosyalarda `defineQuery([...], <rt>, "<scope>", <readOnly>)`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/unit/sql-read-only.test.ts`:

```ts
import { expect, test } from "bun:test";
import { generate } from "../../core/sql/codegen";
import { prepareQuery } from "../../core/sql/compiler";

const readOnly = (sql: string) => prepareQuery(sql).readOnly;
const one = (source: string) => generate([["src/queries/tenant/q.sql", source]]).get("src/queries/tenant/q.gen.ts");

test("SELECT, set operations and read-only CTEs are readOnly", () => {
  expect(readOnly("SELECT id FROM users WHERE id = $1::uuid")).toBe(true);
  expect(readOnly("SELECT id FROM users UNION ALL SELECT id FROM users")).toBe(true);
  expect(readOnly("WITH a AS (SELECT id FROM users) SELECT id FROM a")).toBe(true);
  expect(readOnly("SELECT 1")).toBe(true);
});

test("writes, row locks and data-modifying CTEs are not readOnly", () => {
  expect(readOnly("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2::text, $3::text)")).toBe(false);
  expect(readOnly("UPDATE users SET name = $1::text WHERE id = $2::uuid")).toBe(false);
  expect(readOnly("DELETE FROM users WHERE id = $1::uuid")).toBe(false);
  expect(readOnly("SELECT id FROM users FOR UPDATE")).toBe(false);
  expect(readOnly("WITH d AS (DELETE FROM users WHERE id = $1::uuid RETURNING id) SELECT id FROM d")).toBe(false);
  expect(readOnly("WITH a AS (SELECT id FROM users) INSERT INTO users (id, name, email) SELECT id, 'x', 'y' FROM a")).toBe(false);
});

test("codegen writes the flag as the fourth defineQuery argument", () => {
  expect(one("-- name: a\nSELECT 1")).toContain('false, "tenant", true);');
  expect(one("-- name: b\nSELECT id FROM t FOR UPDATE")).toContain('true, "tenant", false);');
});
```

Not: `t` tablosu `one()` için codegen'de tablo bilgisi yokken çalışır (mevcut `lockStudent` testi aynı kalıbı kullanıyor).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/sql-read-only.test.ts`
Expected: FAIL — `readOnly` `undefined` (üçüncü test: `'false, "tenant", true);'` bulunamadı).

- [ ] **Step 3: Write minimal implementation**

`src/core/sql/query.ts`:

```ts
export interface PreparedQuery {
  readonly requiresTransaction: boolean;
  readonly scope: QueryScope;
  /** Yalnızca okuyan sorgu (kilitsiz SELECT, veri değiştiren CTE yok): okuma bağlamı (replica) yalnızca bunları çalıştırır. */
  readonly readOnly: boolean;
  readonly bind: (schema: string) => string;
}
```

`defineQuery` imzası ve nesnesi:

```ts
export function defineQuery(parts: readonly string[], requiresTransaction: boolean, scope: QueryScope, readOnly: boolean): PreparedQuery {
  // … (gövde aynı)
  const query = Object.freeze({ requiresTransaction, scope, readOnly, bind });
```

`src/core/sql/compiler.ts` — `Compiled`'a `readonly readOnly: boolean;` ekle, `compile` sonucunu genişlet, yardımcıyı `compile`'dan önce ekle:

```ts
/** Çalışma anı sorgusu yalnızca okuyorsa `true`: üst düzey SELECT/VALUES/UNION, kilitsiz (`FOR …` yok) ve her CTE gövdesi de okuma.
 * Yan etkili fonksiyonlar (`nextval` gibi) statik ayrılamaz; replica salt okunurdur ve primary'ye düşme `READ ONLY` transaction'dadır. */
function readsOnly(node: Node): boolean {
  switch (node.type) {
    case "select":
      return !node.for;
    case "values":
      return true;
    case "union":
    case "union all":
      return readsOnly(node.left as Node) && readsOnly(node.right as Node);
    case "with":
      return (node.bind as { statement: Node }[]).every((binding) => readsOnly(binding.statement)) && readsOnly(node.in as Node);
    default:
      return false;
  }
}
```

`compile` içinde: `return Object.freeze({ parts, requiresTransaction: context.requiresTransaction, readOnly: readsOnly(statement as unknown as Node), ast: statement as unknown as Statement });`

`prepareQuery`: 

```ts
  const { parts, requiresTransaction, readOnly } = compile(source, false, undefined, tables)[0] as Compiled;
  return defineQuery(parts, requiresTransaction, scope, readOnly);
```

`src/core/sql/codegen.ts` `queryExport`:

```ts
    return `\nexport const ${name} = defineQuery(${JSON.stringify(query?.parts)}, ${query?.requiresTransaction}, "${scope}", ${query?.readOnly});\n`;
```

`src/__tests__/fixtures/worker.ts:11`: `…, false, "tenant", true);`

`src/__tests__/unit/sql-codegen.test.ts`: `toContain('true, "tenant");')` → `toContain('true, "tenant", false);')`.

`Node` tipi `compiler.ts`'te zaten tanımlıdır (`walk`/`allowedFields` kullanır); farklı adlıysa mevcut düğüm tipini kullanın.

- [ ] **Step 4: Regenerate and verify**

Run: `bun run codegen && git diff --stat src/queries` — Expected: üç `.gen.ts` dosyası değişir (her `defineQuery`'de 4. argüman).
Run: `bun run codegen -- --check && bun test src/__tests__/unit/sql-read-only.test.ts src/__tests__/unit/sql-codegen.test.ts src/__tests__/unit/sql-extensions.test.ts && bunx tsc --noEmit`
Expected: hepsi PASS, tip hatası yok. (`createPasswordUser` INSERT/CTE → `false`; `getNodeIdentity`, `listTenants` → `true`.)

- [ ] **Step 5: Commit**

```bash
git add src/core/sql src/queries src/__tests__/fixtures/worker.ts src/__tests__/unit
git commit -m "sql: compile-time readOnly flag on prepared queries

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Replica ayarları ve doğrulama

**Files:**
- Modify: `src/core/config.ts` (`RUNTIME_LIMITS`, `DatabaseOptions`, `replicaPolicy`)
- Modify: `src/core/runtime.ts` (`RuntimeOptions` kullanımı, `openDatabase` doğrulaması)
- Test: `src/__tests__/unit/replica-config.test.ts` (yeni)

**Interfaces:**
- Produces: `RUNTIME_LIMITS.replicaMaxLagMs` `[5000, 3_600_000]`, `replicaStatusMs` `[5000, 60_000]` (böylece `runtimeSettings(config, options)` sonucunda sayılar); `export type ReplicaPolicy = "primary" | "error"`; `export function replicaPolicy(value?: unknown): ReplicaPolicy`; `DatabaseOptions = Partial<Values<typeof RUNTIME_LIMITS>> & { replicaOnUnavailable?: ReplicaPolicy }`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createConfig, replicaPolicy, runtimeSettings } from "../../core/config";
import { createDatabase } from "../../core/runtime";
import { fakeDriver } from "../fixtures/fake-driver";

const config = createConfig(["postgres://a@h/d"]);

test("replica settings default to 5000 and are bounded integers", () => {
  expect(runtimeSettings(config)).toMatchObject({ replicaMaxLagMs: 5000, replicaStatusMs: 5000 });
  for (const bad of [0, -1, 1.5, "x", 3_600_001])
    expect(() => runtimeSettings(config, { replicaMaxLagMs: bad as number })).toThrow("replicaMaxLagMs must be an integer from 1 to 3600000");
  expect(() => runtimeSettings(config, { replicaStatusMs: 60_001 })).toThrow("replicaStatusMs must be an integer from 1 to 60000");
  expect(runtimeSettings(config, { replicaMaxLagMs: 200, replicaStatusMs: 1 })).toMatchObject({ replicaMaxLagMs: 200, replicaStatusMs: 1 });
});

test("replicaPolicy accepts primary and error only and defaults to primary", () => {
  expect(replicaPolicy()).toBe("primary");
  expect(replicaPolicy("error")).toBe("error");
  expect(() => replicaPolicy("fallback")).toThrow('replicaOnUnavailable must be "primary" or "error"');
});

test("createDatabase rejects an invalid replicaOnUnavailable with INVALID_CONFIG", () => {
  const { driver } = fakeDriver();
  expect(() => createDatabase(config, { driver, replicaOnUnavailable: "nope" as never })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/replica-config.test.ts`
Expected: FAIL — `replicaPolicy` içe aktarılamıyor / sınır hatası atılmıyor.

- [ ] **Step 3: Write minimal implementation**

`src/core/config.ts` — `RUNTIME_LIMITS`'e ekle:

```ts
  /** Replica okuması: bunu aşan lag'li replica elenir; durum (sağlık + lag) kaydı bu kadar önbellekte kalır. */
  replicaMaxLagMs: [5000, 3_600_000],
  replicaStatusMs: [5000, 60_000],
```

`DatabaseOptions` ve politika:

```ts
/** Sağlıklı replica yokken (düştü ya da lag eşiği aşıldı) okuma: primary'de `READ ONLY` transaction ya da `REPLICA_UNAVAILABLE`. */
export type ReplicaPolicy = "primary" | "error";
export function replicaPolicy(value: unknown = "primary"): ReplicaPolicy {
  if (value === "primary" || value === "error") return value;
  throw new AppError("INVALID_CONFIG", 'replicaOnUnavailable must be "primary" or "error"');
}
export type DatabaseOptions = Partial<Values<typeof RUNTIME_LIMITS>> & { replicaOnUnavailable?: ReplicaPolicy };
```

(`DatabaseOptions`'ın eski tanımını bununla değiştirin.)

`src/core/runtime.ts` `openDatabase` başı:

```ts
function openDatabase(input: Config, { driver, onSpan, pooler = "verified", replicaOnUnavailable, ...options }: RuntimeOptions) {
  // …pooler doğrulaması…
  const onUnavailable = replicaPolicy(replicaOnUnavailable);
```

(`replicaPolicy`'i `./config` içe aktarmasına ekleyin; `onUnavailable` Task 5'te kullanılır — şimdilik değişkeni kullanmak lint hatası verirse `void onUnavailable;` yerine Task 5'e kadar doğrulamayı yalnızca `replicaPolicy(replicaOnUnavailable);` çağrısı olarak bırakın.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/replica-config.test.ts src/__tests__/unit/database-config.test.ts && bunx tsc --noEmit`
Expected: PASS; mevcut ayar testleri etkilenmez.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/core/runtime.ts src/__tests__/unit/replica-config.test.ts
git commit -m "config: replica lag, status cache and unavailable-policy settings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Replica havuzları (`createPools.replicas`)

**Files:**
- Modify: `src/core/database.ts` (`createPools`)
- Test: `src/__tests__/unit/replica-pools.test.ts` (yeni)

**Interfaces:**
- Consumes: `DatabaseNode.replicas` (config sırası), `connect(pool, settings)`.
- Produces: `pools.replicas(id): readonly Database[]` (config sırasıyla, tembel, önbellekli); `pools.close()` replica havuzlarını da kapatır; `DATABASE_CLOSED` kapanınca.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { fakeDriver } from "../fixtures/fake-driver";

const open = () => {
  const fake = fakeDriver();
  const config = { ...createConfig(["postgres://p@h/d"], "db0=postgres://r1@h/d,db0=postgres://r2@h/d"), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 3, { deadlineMs: 1000, maxPending: 8 });
  return { fake, pools };
};

test("replica pools open lazily, in config order, once, with the same pool size", () => {
  const { fake, pools } = open();
  expect(fake.pools.map((pool) => pool.url)).toEqual(["postgres://p@h/d"]); // yalnızca platform havuzu
  const first = pools.replicas("db0");
  expect(first).toHaveLength(2);
  expect(fake.pools.map((pool) => pool.url)).toEqual(["postgres://p@h/d", "postgres://r1@h/d", "postgres://r2@h/d"]);
  expect(fake.pools.slice(1).every((pool) => pool.options.max === 3)).toBe(true);
  expect(pools.replicas("db0")).toBe(first);
});

test("a node without replicas has an empty list and unknown nodes are rejected", () => {
  const fake = fakeDriver();
  const config = { ...createConfig(["postgres://p@h/d"]), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 3, { deadlineMs: 1000, maxPending: 8 });
  expect(pools.replicas("db0")).toEqual([]);
  expect(() => pools.replicas("db9")).toThrow(expect.objectContaining({ code: "DATABASE_NOT_FOUND" }));
});

test("close() closes replica pools too and later use is refused", async () => {
  const { fake, pools } = open();
  pools.replicas("db0");
  await pools.close();
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
  expect(() => pools.replicas("db0")).toThrow(expect.objectContaining({ code: "DATABASE_CLOSED" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/replica-pools.test.ts`
Expected: FAIL — `pools.replicas is not a function`.

- [ ] **Step 3: Write minimal implementation**

`createPools` içinde, `databases` map'inin yanına:

```ts
  const replicaDatabases = new Map<string, Database[]>();

  /** Düğümün replica havuzları (config sırasıyla); tembel açılır, her biri `max` bağlantı alır. */
  function replicas(id: string): readonly Database[] {
    if (closed) throw new AppError("DATABASE_CLOSED", "Database clients are closed");
    const urls = nodeConfig(id).replicas;
    let list = replicaDatabases.get(id);
    if (!list) {
      list = urls.map((url) =>
        connect(driver(url, { max, idleTimeoutSeconds, maxLifetimeSeconds, connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS }), { ...settings, databaseId: id }),
      );
      replicaDatabases.set(id, list);
    }
    return list;
  }
```

`close()`:

```ts
    const outcomes = await Promise.allSettled([...databases.values(), ...[...replicaDatabases.values()].flat()].map((db) => db.close()));
    databases.clear();
    replicaDatabases.clear();
```

Dönüş: `return { platform: node(PLATFORM_DATABASE_ID), node, replicas, nodeConfig, close };`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/replica-pools.test.ts src/__tests__/unit/database.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/database.ts src/__tests__/unit/replica-pools.test.ts
git commit -m "database: lazy per-node replica pools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Replica router (yoklama, durum önbelleği, round-robin, rapor)

**Files:**
- Create: `src/core/tenants/replicas.ts`
- Test: `src/__tests__/unit/replica-router.test.ts` (yeni)

**Interfaces:**
- Consumes: `Pools` (`node`, `replicas`, `nodeConfig`), `Connection`, `errorCode`.
- Produces (C2 de kullanır):
  - `probeReplica(primary: Connection, replica: Connection): Promise<{ inRecovery: boolean; lagMs: number | null }>` — `lagMs`: replay LSN primary'ninkine ulaştıysa `0`, aksi halde `now − pg_last_xact_replay_timestamp` (ms, tam sayı), bilinmiyorsa `null`.
  - `type ReplicaStatus = { up: boolean; inRecovery: boolean; lagMs: number | null; at: number; error?: string }`, `type StatusCache = Map<string, ReplicaStatus>` (anahtar replica URL'si).
  - `createReplicaRouter({ pools, maxLagMs, statusMs, cache?, now? })` → `{ pick(databaseId): Promise<ReplicaHandle | undefined>; report(databaseIds: readonly string[]): Promise<ReplicaReport[]> }`.
  - `type ReplicaHandle = { db: Database; markDown(): void }`; `type ReplicaReport = { databaseId: string; replica: number; up: boolean; inRecovery: boolean; lagMs: number | null; usable: boolean; error?: string }` (`replica` 1 tabanlı sıra, URL yok).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { createReplicaRouter, type StatusCache } from "../../core/tenants/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

type State = { inRecovery?: boolean; caughtUp?: boolean; lagMs?: number | null; fail?: string };
/** URL'ye göre replica durumu; primary her zaman `0/3000000` konumunu bildirir. */
function fixture(states: Record<string, State>, options: { maxLagMs?: number; statusMs?: number } = {}) {
  const urls = Object.keys(states);
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    const state = states[pool.url] ?? {};
    if (state.fail) throw Object.assign(new Error(`secret ${pool.url}`), { code: state.fail });
    return [{ in_recovery: state.inRecovery ?? true, caught_up: state.caughtUp ?? false, lag_ms: state.lagMs === undefined ? 50 : state.lagMs }];
  });
  const config = { ...createConfig(["postgres://p@h/d"], urls.map((url) => `db0=${url}`)), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 2, { deadlineMs: 1000, maxPending: 8 });
  let clock = 1000;
  const cache: StatusCache = new Map();
  const router = createReplicaRouter({ pools, maxLagMs: options.maxLagMs ?? 1000, statusMs: options.statusMs ?? 5000, cache, now: () => clock });
  const probes = () => fake.commands.filter((command) => command.text.includes("pg_is_in_recovery")).length;
  return { router, fake, probes, tick: (ms: number) => (clock += ms), urls };
}

const R1 = "postgres://r1@h/d";
const R2 = "postgres://r2@h/d";

test("pick rotates over usable replicas and pins nothing itself", async () => {
  const { router } = fixture({ [R1]: {}, [R2]: {} });
  const a = await router.pick("db0");
  const b = await router.pick("db0");
  const c = await router.pick("db0");
  expect(a?.db).not.toBe(b?.db);
  expect(c?.db).toBe(a?.db);
});

test("a replica over the lag threshold or not in recovery is skipped; caught-up counts as zero lag", async () => {
  const { router } = fixture({ [R1]: { lagMs: 5000 }, [R2]: { inRecovery: false } });
  expect(await router.pick("db0")).toBeUndefined();
  const idle = fixture({ [R1]: { caughtUp: true, lagMs: 999_999 } });
  expect(await idle.router.pick("db0")).toBeDefined();
  const unknown = fixture({ [R1]: { lagMs: null } });
  expect(await unknown.router.pick("db0")).toBeUndefined();
});

test("status is cached for statusMs and concurrent picks share one probe", async () => {
  const { router, probes, tick } = fixture({ [R1]: {} });
  await Promise.all([router.pick("db0"), router.pick("db0"), router.pick("db0"), router.pick("db0"), router.pick("db0")]);
  expect(probes()).toBe(1);
  await router.pick("db0");
  expect(probes()).toBe(1);
  tick(5001);
  await router.pick("db0");
  expect(probes()).toBe(2);
});

test("a failing probe marks the replica down with the error code only, once per statusMs", async () => {
  const { router, probes, tick } = fixture({ [R1]: { fail: "ECONNREFUSED" } });
  expect(await router.pick("db0")).toBeUndefined();
  expect(await router.pick("db0")).toBeUndefined();
  expect(probes()).toBe(1);
  const [row] = await router.report(["db0"]);
  expect(row).toMatchObject({ databaseId: "db0", replica: 1, up: false, usable: false, error: "ECONNREFUSED" });
  expect(JSON.stringify(row)).not.toContain("secret");
  tick(5001);
  await router.pick("db0");
  expect(probes()).toBe(3); // report zorla yeniledi + tazelik sonrası yeni yoklama
});

test("markDown removes a replica until its status expires", async () => {
  const { router, tick } = fixture({ [R1]: {} });
  const handle = await router.pick("db0");
  handle?.markDown();
  expect(await router.pick("db0")).toBeUndefined();
  tick(5001);
  expect(await router.pick("db0")).toBeDefined();
});

test("report probes every replica fresh and lists 1-based numbers without URLs", async () => {
  const { router } = fixture({ [R1]: { lagMs: 10 }, [R2]: { lagMs: 5000 } });
  const rows = await router.report(["db0"]);
  expect(rows.map((row) => [row.replica, row.usable, row.lagMs])).toEqual([[1, true, 10], [2, false, 5000]]);
  expect(JSON.stringify(rows)).not.toContain("r1@h");
});
```

(`report` ile ilgili üçüncü beklenti: önceki `pick` + `report` + tick sonrası `pick` toplam 3 yoklama; test bunu ilk `pick` (1), `report` (zorla, 2), tick sonrası `pick` (3) olarak sayar.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/replica-router.test.ts`
Expected: FAIL — `../../core/tenants/replicas` bulunamıyor.

- [ ] **Step 3: Write minimal implementation**

`src/core/tenants/replicas.ts`:

```ts
/** Replica sağlığı ve seçimi. Durum (sağlık + lag) `statusMs` boyunca önbellekte kalır; yoklama tembeldir (arka plan zamanlayıcısı yok,
 * Workers'ta yaşamaz) ve aynı replica için eşzamanlı çağrılar tek yoklamayı paylaşır. Önbellek modül düzeyindedir ve yalnızca sayı
 * tutar: Workers'ta istek başına havuz kapansa da durum yaşar. Lag: replay LSN primary'nin LSN'ine ulaştıysa 0, aksi halde son
 * replay edilen commit'ten bu yana geçen süre (commit'siz WAL akarken kısa süre fazla görünebilir; hata yönü güvenlidir). */
import type { Database, Pools } from "../database";
import type { Connection } from "../driver";
import { errorCode } from "../errors";

export type ReplicaStatus = { up: boolean; inRecovery: boolean; lagMs: number | null; at: number; error?: string };
export type StatusCache = Map<string, ReplicaStatus>;
export type ReplicaHandle = { db: Database; markDown(): void };
export type ReplicaReport = { databaseId: string; replica: number; up: boolean; inRecovery: boolean; lagMs: number | null; usable: boolean; error?: string };

const sharedCache: StatusCache = new Map();
const PRIMARY_LSN = "SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn";
const REPLICA_STATE = `SELECT pg_catalog.pg_is_in_recovery() AS in_recovery,
  pg_catalog.pg_last_wal_replay_lsn() >= $1::pg_catalog.pg_lsn AS caught_up,
  (pg_catalog.date_part('epoch', pg_catalog.now() - pg_catalog.pg_last_xact_replay_timestamp()) * 1000)::pg_catalog.float8 AS lag_ms`;

/** Primary'nin LSN'i bir kez okunur, replica'da karşılaştırılır; ikisi de verilen bağlantılarda çalışır. */
export async function probeReplica(primary: Connection, replica: Connection): Promise<{ inRecovery: boolean; lagMs: number | null }> {
  const [position] = await primary.query<{ lsn: string }>(PRIMARY_LSN);
  const [row] = await replica.query<{ in_recovery: boolean; caught_up: boolean | null; lag_ms: number | null }>(REPLICA_STATE, [position?.lsn]);
  if (!row) return { inRecovery: false, lagMs: null };
  const lagMs = row.caught_up ? 0 : row.lag_ms === null || row.lag_ms === undefined ? null : Math.max(0, Math.round(Number(row.lag_ms)));
  return { inRecovery: row.in_recovery === true, lagMs };
}

export interface ReplicaRouterOptions {
  pools: Pick<Pools, "node" | "replicas" | "nodeConfig">;
  maxLagMs: number;
  statusMs: number;
  cache?: StatusCache;
  now?: () => number;
}

export function createReplicaRouter({ pools, maxLagMs, statusMs, cache = sharedCache, now = () => performance.now() }: ReplicaRouterOptions) {
  const rotation = new Map<string, number>();
  const inflight = new Map<string, Promise<ReplicaStatus>>();
  const usable = (status: ReplicaStatus) => status.up && status.lagMs !== null && status.lagMs <= maxLagMs;
  const down = (error?: string): ReplicaStatus => ({ up: false, inRecovery: false, lagMs: null, at: now(), ...(error ? { error } : {}) });

  /** Yoklamayı (varsa süren) çalıştırır; sonuç önbelleğe yazılır. */
  function refresh(databaseId: string, index: number, url: string): Promise<ReplicaStatus> {
    let running = inflight.get(url);
    if (!running) {
      running = probeReplica(pools.node(databaseId), (pools.replicas(databaseId)[index] as Database))
        .then(
          (probe): ReplicaStatus => ({ up: probe.inRecovery, inRecovery: probe.inRecovery, lagMs: probe.lagMs, at: now() }),
          (error: unknown) => down(errorCode(error)),
        )
        .then((status) => {
          cache.set(url, status);
          inflight.delete(url);
          return status;
        });
      inflight.set(url, running);
    }
    return running;
  }

  /** Taze kayıt varsa senkron döner (sıcak yolda Promise yok). */
  function current(databaseId: string, index: number, url: string): ReplicaStatus | Promise<ReplicaStatus> {
    const cached = cache.get(url);
    return cached && now() - cached.at < statusMs ? cached : refresh(databaseId, index, url);
  }

  async function pick(databaseId: string): Promise<ReplicaHandle | undefined> {
    const urls = pools.nodeConfig(databaseId).replicas;
    if (!urls.length) return undefined;
    const states = urls.map((url, index) => current(databaseId, index, url));
    const statuses = states.some((state) => state instanceof Promise) ? await Promise.all(states) : (states as ReplicaStatus[]);
    const candidates = statuses.flatMap((status, index) => (usable(status) ? [index] : []));
    if (!candidates.length) return undefined;
    const turn = rotation.get(databaseId) ?? 0;
    rotation.set(databaseId, turn + 1);
    const index = candidates[turn % candidates.length] as number;
    return { db: pools.replicas(databaseId)[index] as Database, markDown: () => void cache.set(urls[index] as string, down()) };
  }

  /** Her replica'yı önbelleğe bakmadan yoklar; çıktıda URL yoktur (`replica`: config sırasına göre 1 tabanlı numara). */
  async function report(databaseIds: readonly string[]): Promise<ReplicaReport[]> {
    const rows = databaseIds.flatMap((databaseId) =>
      pools.nodeConfig(databaseId).replicas.map(async (url, index): Promise<ReplicaReport> => {
        const status = await refresh(databaseId, index, url);
        return {
          databaseId,
          replica: index + 1,
          up: status.up,
          inRecovery: status.inRecovery,
          lagMs: status.lagMs,
          usable: usable(status),
          ...(status.error ? { error: status.error } : {}),
        };
      }),
    );
    return Promise.all(rows);
  }

  return { pick, report };
}
export type ReplicaRouter = ReturnType<typeof createReplicaRouter>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/replica-router.test.ts && bunx tsc --noEmit && bunx eslint src/core/tenants/replicas.ts src/__tests__/unit/replica-router.test.ts --fix`
Expected: PASS; lint temiz. (Hata: `markDown` sonrası `at` saat `now()`; tick sonrası taze değil → yeniden yoklanır.)

- [ ] **Step 5: Commit**

```bash
git add src/core/tenants/replicas.ts src/__tests__/unit/replica-router.test.ts
git commit -m "tenants: replica router with cached health/lag status and round-robin pick

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Okuma bağlamı ve runtime bağlantısı

**Files:**
- Modify: `src/core/tenants/context.ts` (`runContext` modu, `createWithTenant` `onWrite`, `createWithTenantRead`, `ReadContext`)
- Modify: `src/core/runtime.ts` (`withTenantRead`, `replicas`)
- Modify: `src/index.ts` (`ReadContext` dışa aktarımı)
- Test: `src/__tests__/unit/read-context.test.ts` (yeni)

**Interfaces:**
- Consumes: Task 1 `PreparedQuery.readOnly`; Task 3 `pools.replicas`; Task 4 `ReplicaRouter.pick` / `ReplicaHandle`; Task 2 `ReplicaPolicy`.
- Produces:
  - `type ReadContext = Pick<TenantContext, "query">`.
  - `runContext(connection, transactionDatabase, schema, scope, work, tenantId?, mode?: { readOnly?: boolean; onWrite?: () => void })`.
  - `createWithTenant(...)`'in `forPlacement(placement, work, onWrite?)` ve `withTenant(id, work, onWrite?)`.
  - `createWithTenantRead(pools: Pick<Pools,"node">, placements, router: Pick<ReplicaRouter,"pick">, onUnavailable: ReplicaPolicy)` → `withTenantRead(id, work)` ve `withTenantRead.forPlacement(placement, work, afterWrite = false)`.
  - Runtime `Database`: `withTenantRead`, `replicas(): Promise<ReplicaReport[]>`.
  - Hatalar: `QUERY_NOT_READ_ONLY` (okuma bağlamında `readOnly` olmayan sorgu), `REPLICA_UNAVAILABLE`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/unit/read-context.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createWithTenant, createWithTenantRead } from "../../core/tenants/context";
import { prepareQuery } from "../../core/sql/compiler";
import { tenantSchema } from "../../core/tenants/model";

const select = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const update = prepareQuery("UPDATE students SET name = $1::text WHERE id = $2::uuid");
const placement = {
  tenantId: "demo-tenant",
  kind: "tenant" as const,
  databaseId: "one",
  schemaName: tenantSchema("demo-tenant"),
  status: "active" as const,
  schemaVersion: 3,
  placementVersion: 1,
};

/** Kayıt tutan sahte havuz: `query` ve `transaction(mode)`. */
function recorder(fail?: { code: string }) {
  const log: { text: string; tenantId?: string }[] = [];
  const modes: (string | undefined)[] = [];
  const db = {
    query: async (text: string, _params?: readonly unknown[], tenantId?: string) => {
      log.push({ text, tenantId });
      if (fail) throw Object.assign(new Error("boom"), fail);
      return [];
    },
    transaction: async (work: (tx: unknown) => Promise<unknown>, options?: { mode?: string }) => {
      modes.push(options?.mode);
      return work(db);
    },
  };
  return { db, log, modes };
}

function fixture(options: { replica?: ReturnType<typeof recorder> | undefined; policy?: "primary" | "error" } = {}) {
  const primary = recorder();
  const downs: number[] = [];
  const router = { pick: async () => (options.replica ? { db: options.replica.db as never, markDown: () => void downs.push(1) } : undefined) };
  const pools = { node: () => primary.db } as never;
  const placements = { get: async () => placement };
  return {
    primary,
    downs,
    withTenantRead: createWithTenantRead(pools, placements, router, options.policy ?? "primary"),
    withTenant: createWithTenant(pools, placements),
  };
}

test("a read-only query runs on the picked replica, bound to the tenant schema, and never touches the primary", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  await f.withTenantRead("demo-tenant", (db) => db.query(select, ["id"]));
  expect(replica.log).toHaveLength(1);
  expect(replica.log[0]?.text).toContain(`"${placement.schemaName}"`);
  expect(replica.log[0]?.tenantId).toBe("demo-tenant");
  expect(f.primary.log).toHaveLength(0);
  expect(f.primary.modes).toHaveLength(0);
});

test("a query that is not read-only is rejected before any database is touched", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  const error = await f.withTenantRead("demo-tenant", async (db) => db.query(update, ["x", "id"])).catch((e: unknown) => e as { code: string });
  expect(error).toMatchObject({ code: "QUERY_NOT_READ_ONLY" });
  expect(replica.log).toHaveLength(0);
  expect(f.primary.log).toHaveLength(0);
});

test("with no usable replica the primary policy runs each query in a READ ONLY transaction", async () => {
  const f = fixture();
  await f.withTenantRead("demo-tenant", (db) => db.query(select, ["id"]));
  expect(f.primary.modes).toEqual([" READ ONLY"]);
  expect(f.primary.log).toHaveLength(1);
});

test("the error policy raises REPLICA_UNAVAILABLE without touching any database, also when no replica is configured", async () => {
  const f = fixture({ policy: "error" });
  const error = await f.withTenantRead("demo-tenant", async (db) => db.query(select, ["id"])).catch((e: unknown) => e as { code: string; message: string });
  expect(error).toMatchObject({ code: "REPLICA_UNAVAILABLE" });
  expect(error.message).not.toContain("postgres://");
  expect(f.primary.log).toHaveLength(0);
});

test("after a write in the same request the read goes to the primary even under the error policy", async () => {
  const replica = recorder();
  const f = fixture({ replica, policy: "error" });
  await f.withTenantRead.forPlacement(placement, (db) => db.query(select, ["id"]), true);
  expect(replica.log).toHaveLength(0);
  expect(f.primary.modes).toEqual([" READ ONLY"]);
});

test("a connection error marks the replica down; a SQL error does not; both surface", async () => {
  const dead = recorder({ code: "ECONNRESET" });
  const f = fixture({ replica: dead });
  expect(await f.withTenantRead("demo-tenant", (db) => db.query(select, ["id"])).catch((e: unknown) => (e as { code: string }).code)).toBe("ECONNRESET");
  expect(f.downs).toHaveLength(1);
  const timeout = recorder({ code: "57014" });
  const g = fixture({ replica: timeout });
  expect(await g.withTenantRead("demo-tenant", (db) => db.query(select, ["id"])).catch((e: unknown) => (e as { code: string }).code)).toBe("57014");
  expect(g.downs).toHaveLength(0);
});

test("only tenant-scope queries run and the context expires after the work", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  const nodeQuery = prepareQuery("SELECT 1", "node");
  expect(await f.withTenantRead("demo-tenant", async (db) => db.query(nodeQuery)).catch((e: unknown) => (e as { code: string }).code)).toBe("QUERY_SCOPE");
  let escaped!: { query: (...args: never[]) => unknown };
  await f.withTenantRead("demo-tenant", async (db) => void (escaped = db as never));
  expect(() => escaped.query(select as never)).toThrow(expect.objectContaining({ code: "TRANSACTION_CLOSED" }));
});

test("onWrite fires for writes (also inside transactions) and not for reads", async () => {
  const f = fixture();
  let writes = 0;
  const onWrite = () => void writes++;
  await f.withTenant.forPlacement(placement, (db) => db.query(select, ["id"]), onWrite);
  expect(writes).toBe(0);
  await f.withTenant.forPlacement(placement, (db) => db.transaction((tx) => tx.query(select, ["id"])), onWrite);
  expect(writes).toBe(0);
  await f.withTenant.forPlacement(placement, (db) => db.query(update, ["x", "id"]), onWrite);
  expect(writes).toBe(1);
  await f.withTenant.forPlacement(placement, (db) => db.transaction((tx) => tx.query(update, ["x", "id"])), onWrite);
  expect(writes).toBe(2);
});
```

Sahte havuzdaki `transaction` yalnızca `forPlacement`'in transaction yolunda kullanılır (read yolu için `primaryReads` çağırır; `modes` bunu kaydeder).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/read-context.test.ts`
Expected: FAIL — `createWithTenantRead` dışa aktarılmamış.

- [ ] **Step 3: Write minimal implementation**

`src/core/tenants/context.ts` — içe aktarmalar: `import type { ReplicaPolicy } from "../config";`, `import { databaseUnavailable } from "../errors";` (`AppError` ile birlikte), `import type { ReplicaRouter } from "./replicas";`.

`ReadContext` ve `runContext` modu:

```ts
/** Replica'dan okuma bağlamı: yalnızca `readOnly` sorgular; transaction yoktur. */
export type ReadContext = Pick<TenantContext, "query">;
/** `readOnly`: okuma bağlamı (hata autocommit gibi toparlanabilir, yazan sorgu reddedilir). `onWrite`: `readOnly` olmayan sorgu çalıştığında
 * (transaction içindekiler dahil) çağrılır; istek kapsamı yazıdan sonra okumayı primary'ye yöneltmek için kullanır. */
export interface ContextMode {
  readOnly?: boolean;
  onWrite?: () => void;
}
```

`runContext` imzasının sonuna `mode: ContextMode = {}` ekle ve değiştir:
- `const insideTransaction = !transactionDatabase && !mode.readOnly;`
- `assertRunnable` içinde, `QUERY_SCOPE` denetiminden sonra: `if (mode.readOnly && !query.readOnly) throw new AppError("QUERY_NOT_READ_ONLY", "Read contexts run read-only queries only");`
- `query()` içinde `assertRunnable(query);` sonrası: `if (!query.readOnly) mode.onWrite?.();`
- iç `transaction`: `runContext(tx, undefined, schema, scope, callback, tenantId, { onWrite: mode.onWrite })`.

`createWithTenant`: `forPlacement(placement, work, onWrite?: () => void)` → `runContext(db, db, placement.schemaName, "tenant", work, placement.tenantId, { onWrite })`; `withTenant(id, work, onWrite?)` → `forPlacement(read, work, onWrite)`.

Yeni fabrika (dosya sonuna):

```ts
/** Primary'de okuma: her sorgu `READ ONLY` transaction'da (yan etkili fonksiyonlara karşı ikinci güvence). */
const primaryReads = (db: Database): Connection => ({
  query: ((text: string, params?: readonly unknown[], tenantId?: string) =>
    db.transaction((tx) => tx.query(text, params), { mode: " READ ONLY", tenantId })) as Connection["query"],
  exec: () => Promise.reject(new AppError("QUERY_NOT_READ_ONLY", "Read contexts run prepared read-only queries only")),
});

/** Replica'da okuma: bağlantı hatası replica'yı `up = false` işaretler (SQL hatası işaretlemez); hata her halükârda yüzeye çıkar. */
const replicaReads = ({ db, markDown }: { db: Database; markDown(): void }): Connection => ({
  query: (async (text: string, params?: readonly unknown[], tenantId?: string) => {
    try {
      return await db.query(text, params, tenantId);
    } catch (error) {
      if (databaseUnavailable(error)) markDown();
      throw error;
    }
  }) as Connection["query"],
  exec: () => Promise.reject(new AppError("QUERY_NOT_READ_ONLY", "Read contexts run prepared read-only queries only")),
});

/** Her çağrı bir replica'ya sabitlenir. Sağlıklı replica yoksa (ya da hiç yapılandırılmamışsa) `onUnavailable`: primary'de `READ ONLY`
 * ya da `REPLICA_UNAVAILABLE`. `afterWrite`: aynı istekte yazı oldu, okuma politikadan bağımsız primary'de kalır. */
export function createWithTenantRead(
  pools: Pick<Pools, "node">,
  placements: { get(id: string): Placement | Promise<Placement> },
  router: Pick<ReplicaRouter, "pick">,
  onUnavailable: ReplicaPolicy,
) {
  async function forPlacement<T>(placement: Placement, work: (db: ReadContext) => Promise<T>, afterWrite = false): Promise<T> {
    requireActive(placement);
    const primary = pools.node(placement.databaseId);
    let connection: Connection;
    const handle = afterWrite ? undefined : await router.pick(placement.databaseId);
    if (handle) connection = replicaReads(handle);
    else if (afterWrite || onUnavailable === "primary") connection = primaryReads(primary);
    else throw new AppError("REPLICA_UNAVAILABLE", `No usable replica for database ${placement.databaseId}`);
    return runContext(connection, undefined, placement.schemaName, "tenant", work, placement.tenantId, { readOnly: true });
  }
  const withTenantRead = async <T>(id: string, work: (db: ReadContext) => Promise<T>): Promise<T> => forPlacement(await placements.get(id), work);
  return Object.assign(withTenantRead, { forPlacement });
}
```

`import type { Connection, Row } from "../driver";` zaten var; `Placement` ve `requireActive` içe aktarmaları mevcut. `databaseUnavailable` yalnızca `ECONNRESET` vb. bağlantı sınıfı kodları (`08*`, `53*`, `57P0*`, `CONNECTION_*`, `ECONN*`…) tanır; `57014` tanımaz.

`src/core/runtime.ts`: içe aktar `createReplicaRouter` ve `createWithTenantRead`; `openDatabase`'te `const onUnavailable = replicaPolicy(replicaOnUnavailable);` kullanılır; `createWithTenant` satırından sonra:

```ts
  const replicaRouter = createReplicaRouter({ pools, maxLagMs: config.replicaMaxLagMs, statusMs: config.replicaStatusMs });
  /** `src/queries/tenant/` okuma sorguları replica'dan; bkz. `docs/replicas.md`. */
  const withTenantRead = createWithTenantRead(pools, { get: placement }, replicaRouter, onUnavailable);
  /** Replica durumu (sağlık, lag, kullanılabilirlik); önbelleğe bakmadan yoklar. URL içermez. */
  const replicas = () => replicaRouter.report(config.nodes.map((node) => node.id));
```

Dönüş nesnesine `withTenantRead, replicas` ekle. `src/index.ts`: `export type { ReadContext, TenantContext } from "./core/tenants/context";` (mevcut `TenantContext` satırını genişlet).

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/unit/read-context.test.ts src/__tests__/unit/query-context.test.ts src/__tests__/unit/ready-pooler.test.ts && bunx tsc --noEmit && bunx eslint src/core src/__tests__/unit/read-context.test.ts --fix`
Expected: PASS; mevcut context/ready testleri etkilenmez (`ready()` replica'ya dokunmaz).

- [ ] **Step 5: Commit**

```bash
git add src/core/tenants/context.ts src/core/runtime.ts src/index.ts src/__tests__/unit/read-context.test.ts
git commit -m "runtime: read context routed to replicas with primary/error fallback

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `RequestDb.tenantRead` ve yazıdan sonra okuma

**Files:**
- Modify: `src/middleware.ts` (`RequestDb`, `createDbScope`)
- Test: `src/__tests__/unit/request-read.test.ts` (yeni)

**Interfaces:**
- Consumes: Task 5 `db.withTenant.forPlacement(placement, work, onWrite)`, `db.withTenantRead.forPlacement(placement, work, afterWrite)`.
- Produces: `RequestDb.tenantRead: ReadContext` (`query` tek başına); kapsam `tenant`'ta yazı çalışınca işaretlenir, sonraki `tenantRead` çağrıları primary'ye gider.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createWithTenant, createWithTenantRead } from "../../core/tenants/context";
import { prepareQuery } from "../../core/sql/compiler";
import { tenantSchema } from "../../core/tenants/model";
import { createDbScope } from "../../middleware";

const select = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const update = prepareQuery("UPDATE students SET name = $1::text WHERE id = $2::uuid");
const placement = {
  tenantId: "demo-tenant",
  kind: "tenant" as const,
  databaseId: "one",
  schemaName: tenantSchema("demo-tenant"),
  status: "active" as const,
  schemaVersion: 3,
  placementVersion: 1,
};

function scope() {
  const primary: string[] = [];
  const replica: string[] = [];
  const make = (log: string[]) => {
    const db = {
      query: async (text: string) => void log.push(text) ?? [],
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    };
    return db;
  };
  const primaryDb = make(primary);
  const replicaDb = make(replica);
  const pools = { node: () => primaryDb } as never;
  const placements = { get: async () => placement };
  const router = { pick: async () => ({ db: replicaDb as never, markDown: () => {} }) };
  const db = {
    placement: () => placement,
    withTenant: createWithTenant(pools, placements),
    withTenantRead: createWithTenantRead(pools, placements, router, "primary"),
  };
  return { request: createDbScope(db as never, "demo-tenant"), primary, replica };
}

test("tenantRead reads from the replica until the request writes, then stays on the primary", async () => {
  const { request, primary, replica } = scope();
  await request.tenantRead.query(select, ["id"]);
  expect([replica.length, primary.length]).toEqual([1, 0]);
  await request.tenant.query(select, ["id"]); // okuma yazı sayılmaz
  await request.tenantRead.query(select, ["id"]);
  expect(replica).toHaveLength(2);
  await request.tenant.query(update, ["x", "id"]);
  await request.tenantRead.query(select, ["id"]);
  expect(replica).toHaveLength(2);
  expect(primary.filter((text) => text.startsWith("SELECT"))).toHaveLength(2); // select (tenant) + select (tenantRead, primary'de)
});

test("a write inside a transaction also pins later reads to the primary; a read-only transaction does not", async () => {
  const a = scope();
  await a.request.tenant.transaction((tx) => tx.query(select, ["id"]));
  await a.request.tenantRead.query(select, ["id"]);
  expect(a.replica).toHaveLength(1);
  const b = scope();
  await b.request.tenant.transaction((tx) => tx.query(update, ["x", "id"]));
  await b.request.tenantRead.query(select, ["id"]);
  expect(b.replica).toHaveLength(0);
});

test("scopes do not share write state and tenantRead exposes only query", async () => {
  const a = scope();
  const b = scope();
  await a.request.tenant.query(update, ["x", "id"]);
  await b.request.tenantRead.query(select, ["id"]);
  expect(b.replica).toHaveLength(1);
  expect(Object.keys(a.request.tenantRead)).toEqual(["query"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/request-read.test.ts`
Expected: FAIL — `request.tenantRead` tanımsız.

- [ ] **Step 3: Write minimal implementation**

`src/middleware.ts`: `import type { ReadContext, TenantContext } from "./core/tenants/context";`; `RequestDb`'ye ekle:

```ts
  /** Tenant okuma sorguları replica'dan (`readOnly` sorgular; bkz. `docs/replicas.md`). Aynı istekte `tenant`'ta yazı çalıştıysa okuma
   * primary'de kalır (read-your-writes); başka isteğe taşan tutarlılık garanti edilmez. */
  readonly tenantRead: ReadContext;
```

`createDbScope` içinde:

```ts
  // Aynı istekte `tenant` bağlamında yazı çalıştıysa sonraki okumalar primary'ye gider.
  let wrote = false;
  const markWrite = () => void (wrote = true);
```

ve dönüş nesnesinde:

```ts
    tenant: context(async (work) => db.withTenant.forPlacement(await target(), work, markWrite)),
    tenantRead: Object.freeze({
      query: async (query, values) => {
        const placement = await target();
        return db.withTenantRead.forPlacement(placement, (t) => t.query(query, values), wrote);
      },
    } satisfies ReadContext),
```

(`query` imzası `ReadContext["query"]` jenerik dönüşünü korumalıdır: `query: <R extends unknown[] = Row[]>(query: PreparedQuery, values?: readonly unknown[]) => …` biçiminde yazın; `satisfies` tip hatası verirse bu açık imzayı kullanın.)

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/unit/request-read.test.ts src/__tests__/unit/deadline-middleware.test.ts && bunx tsc --noEmit && bunx eslint src/middleware.ts src/__tests__/unit/request-read.test.ts --fix`
Expected: PASS; mevcut middleware testleri etkilenmez.

- [ ] **Step 5: Commit**

```bash
git add src/middleware.ts src/__tests__/unit/request-read.test.ts
git commit -m "middleware: RequestDb.tenantRead with read-your-writes pinning

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Gerçek replikasyonlu test altyapısı ve entegrasyon testleri

**Files:**
- Modify: `compose.yaml` (`postgres-rp`, `postgres-rp-replica`, volume'lar)
- Create: `src/core/local/replica/allow-replication.sh`, `src/core/local/replica/replica-entrypoint.sh`
- Create: `src/__tests__/integration/replica-fixture.ts`
- Test: `src/__tests__/integration/replica.test.ts`

**Interfaces:**
- Consumes: Task 5 `createDatabase(...).withTenantRead`, Task 6 `createDbScope`, mevcut `createTestManagement`, `bootstrap`, `provisionTenant`, `removeTenants`, `raw`, `createUser`, `listUsers`, `uniqueEmail`, `failure`.
- Produces (C2 de kullanır): `PRIMARY_URL`, `REPLICA_URL`, `DEAD_REPLICA_URL`, `replicaConfig(...replicaUrls)`, `caughtUp(primary, replica)`, `pauseReplay(replica)`, `resumeReplay(replica)`, `replicaFixture()`.

- [ ] **Step 1: Test altyapısını yaz**

`src/core/local/replica/allow-replication.sh`:

```sh
#!/bin/sh
# Yalnızca yerel replica testi: replica konteyneri primary'den pg_basebackup alabilsin.
echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"
```

`src/core/local/replica/replica-entrypoint.sh`:

```sh
#!/bin/sh
# Yalnızca yerel replica testi: ilk açılışta primary'den taban yedek alır, sonra standby olarak başlar. Çakışma testinin tetiklenmesi
# için standby gecikmesi kısa tutulur (sabit varsayılan, ortam değişkeni yok).
set -e
export PGPASSWORD=local_admin_password
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  su-exec postgres pg_basebackup -h postgres-rp -U admin -D "$PGDATA" -R -X stream
fi
exec docker-entrypoint.sh postgres -c hot_standby=on -c max_standby_streaming_delay=1s -c hot_standby_feedback=off
```

`compose.yaml` (mevcut servislere dokunmadan, `wsproxy`'den sonra):

```yaml
  # Yalnızca replica testleri: akış replikasyonlu primary/replica çifti (postgres-0/1'den bağımsız).
  postgres-rp:
    image: postgres:16.15-alpine
    environment: {POSTGRES_DB: app, POSTGRES_USER: admin, POSTGRES_PASSWORD: local_admin_password}
    ports: ['127.0.0.1:5545:5432']
    volumes:
      - 'postgresrp:/var/lib/postgresql/data'
      - './src/core/local/replica/allow-replication.sh:/docker-entrypoint-initdb.d/allow-replication.sh:ro'
    healthcheck: {test: ['CMD-SHELL', 'pg_isready -U admin -d app'], interval: 2s, timeout: 2s, retries: 30}
  postgres-rp-replica:
    image: postgres:16.15-alpine
    entrypoint: ['sh', '/replica-entrypoint.sh']
    ports: ['127.0.0.1:5546:5432']
    volumes:
      - 'postgresrpreplica:/var/lib/postgresql/data'
      - './src/core/local/replica/replica-entrypoint.sh:/replica-entrypoint.sh:ro'
    depends_on: {postgres-rp: {condition: service_healthy}}
    healthcheck: {test: ['CMD-SHELL', 'pg_isready -U admin -d app'], interval: 2s, timeout: 2s, retries: 30}
```

`volumes:` bölümüne `postgresrp:` ve `postgresrpreplica:` ekle. Dosyanın başındaki yorum satırına "postgres-rp/-rp-replica: replica testleri" notu ekleyin.

- [ ] **Step 2: İzole compose'ta altyapıyı doğrula**

Paylaşılan jamaster stack'ine dokunmayın (5540/5541/5543, `jamaster-*`). İzole proje kullanın:

```bash
docker compose -p dbreplica up -d postgres-rp postgres-rp-replica
docker compose -p dbreplica ps
PGPASSWORD=local_admin_password docker compose -p dbreplica exec -T postgres-rp-replica psql -U admin -d app -tAc "select pg_is_in_recovery()"
```

Expected: iki servis `healthy`; son komut `t`. Başarısızsa (`su-exec` yok, hba reddi vb.) `docker compose -p dbreplica logs postgres-rp-replica` ile nedeni bulup betikleri düzeltin ve düzeltmeyi ledger'a `Ruling` olarak yazın.

- [ ] **Step 3: Fixture'ı yaz**

`src/__tests__/integration/replica-fixture.ts`:

```ts
/** Replica testleri: izole compose'taki akış replikasyonlu çift (`postgres-rp` → `postgres-rp-replica`). Sabit yerel varsayılanlar,
 * ortam değişkeni yok. Runtime `pooler: "assumed"` ile doğrudan URL'lere bağlanır. */
import { createConfig } from "../../core/config";
import type { Connection } from "../../core/driver";
import { bootstrap } from "../../core/operations/bootstrap";
import { provisionTenant } from "../../core/operations/provision";
import { createDatabase } from "../../index";
import { createTestManagement, driver, raw, removeTenants } from "./helpers";

export const PRIMARY_URL = "postgres://admin:local_admin_password@127.0.0.1:5545/app";
export const REPLICA_URL = "postgres://admin:local_admin_password@127.0.0.1:5546/app";
/** Dinleyen kimse yok: bağlantı reddedilir. */
export const DEAD_REPLICA_URL = "postgres://admin:local_admin_password@127.0.0.1:5599/app";

export const replicaConfig = (...replicas: string[]) => createConfig([PRIMARY_URL], replicas.map((url) => `db0=${url}`));

/** Replica, primary'nin şu anki WAL konumunu replay edene kadar bekler. */
export async function caughtUp(primary: Connection, replica: Connection, timeoutMs = 15_000) {
  const [position] = await primary.query<{ lsn: string }>("SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await replica.query<{ ok: boolean }>("SELECT pg_catalog.pg_last_wal_replay_lsn() >= $1::pg_catalog.pg_lsn AS ok", [position?.lsn]);
    if (row?.ok) return;
    if (Date.now() > deadline) throw new Error("Replica did not catch up");
    await Bun.sleep(50);
  }
}
export const pauseReplay = (replica: Connection) => replica.exec("SELECT pg_catalog.pg_wal_replay_pause()");
export const resumeReplay = (replica: Connection) => replica.exec("SELECT pg_catalog.pg_wal_replay_resume()");

/** Primary'de bootstrap + bir tenant; replica yetişmiş. `runtime(options)` replica'lı runtime açar. */
export async function replicaFixture(tenantId = `rp-${crypto.randomUUID().slice(0, 8)}`) {
  const management = createTestManagement({}, replicaConfig(REPLICA_URL));
  await bootstrap(management);
  await provisionTenant(management, tenantId);
  const primary = raw(0, PRIMARY_URL);
  const replica = raw(0, REPLICA_URL);
  await caughtUp(primary, replica);
  const opened: ReturnType<typeof createDatabase>[] = [];
  return {
    tenantId,
    management,
    primary,
    replica,
    runtime(replicas: string[] = [REPLICA_URL], options: Parameters<typeof createDatabase>[1] extends infer O ? Partial<O> : never = {}) {
      const db = createDatabase(replicaConfig(...replicas), { driver, pooler: "assumed", replicaStatusMs: 1, ...options } as never);
      opened.push(db);
      return db;
    },
    async close() {
      await resumeReplay(replica).catch(() => {});
      for (const db of opened) await db.close();
      await removeTenants(management, tenantId);
      await primary.close();
      await replica.close();
      await management.close();
    },
  };
}
```

(`runtime` imzası karmaşık görünüyorsa `options: Partial<RuntimeOptions> = {}` olarak `RuntimeOptions` tipini `../../core/runtime`'dan içe aktararak sadeleştirin; `driver` zaten zorunlu alan olduğu için `Omit<RuntimeOptions, "driver">` kullanın.)

- [ ] **Step 4: Write the failing integration tests**

`src/__tests__/integration/replica.test.ts`:

```ts
import { expect } from "bun:test";
import { createDbScope } from "../../middleware";
import { createUser, failure, integration, listUsers, uniqueEmail } from "./helpers";
import { caughtUp, DEAD_REPLICA_URL, pauseReplay, REPLICA_URL, replicaFixture, resumeReplay } from "./replica-fixture";

const names = (rows: unknown[]) => (rows as { name: string }[]).map((row) => row.name);

integration("reads come from the replica: a paused replica stays stale while the primary has the row", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime([REPLICA_URL], { replicaMaxLagMs: 3_600_000 });
    await pauseReplay(f.replica);
    await db.withTenant(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "fresh", uniqueEmail()]));
    expect(names(await db.withTenantRead(f.tenantId, (t) => t.query(listUsers, [50, 0])))).not.toContain("fresh"); // replica bayat
    expect(names(await db.withTenant(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toContain("fresh"); // primary
    await resumeReplay(f.replica);
    await caughtUp(f.primary, f.replica);
    expect(names(await db.withTenantRead(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toContain("fresh");
  } finally {
    await f.close();
  }
});

integration("over the lag threshold the read falls back to the primary, or fails under the error policy", async () => {
  const f = await replicaFixture();
  try {
    const primaryPolicy = f.runtime([REPLICA_URL], { replicaMaxLagMs: 200 });
    const errorPolicy = f.runtime([REPLICA_URL], { replicaMaxLagMs: 200, replicaOnUnavailable: "error" });
    await pauseReplay(f.replica);
    await primaryPolicy.withTenant(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "lagged", uniqueEmail()]));
    await Bun.sleep(500);
    expect(names(await primaryPolicy.withTenantRead(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toContain("lagged");
    expect(await failure(errorPolicy.withTenantRead(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toBe("REPLICA_UNAVAILABLE");
  } finally {
    await f.close();
  }
});

integration("an unreachable replica falls back or fails by policy, and ready() does not wait for it", async () => {
  const f = await replicaFixture();
  try {
    const fallback = f.runtime([DEAD_REPLICA_URL]);
    const strict = f.runtime([DEAD_REPLICA_URL], { replicaOnUnavailable: "error" });
    await fallback.ready();
    expect(Array.isArray(await fallback.withTenantRead(f.tenantId, (t) => t.query(listUsers, [10, 0])))).toBe(true);
    expect(await failure(strict.withTenantRead(f.tenantId, (t) => t.query(listUsers, [10, 0])))).toBe("REPLICA_UNAVAILABLE");
  } finally {
    await f.close();
  }
});

integration("a non-read-only query in a read context is rejected", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime();
    expect(await failure(db.withTenantRead(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "x", uniqueEmail()])))).toBe("QUERY_NOT_READ_ONLY");
  } finally {
    await f.close();
  }
});

integration("RequestDb: after a write in the same request the read sees it even though the replica is stale", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime([REPLICA_URL], { replicaMaxLagMs: 3_600_000 });
    const request = createDbScope(db, f.tenantId);
    await pauseReplay(f.replica);
    await request.tenant.query(createUser, [crypto.randomUUID(), "mine", uniqueEmail()]);
    expect(names(await request.tenantRead.query(listUsers, [50, 0]))).toContain("mine");
    const other = createDbScope(db, f.tenantId);
    expect(names(await other.tenantRead.query(listUsers, [50, 0]))).not.toContain("mine"); // başka istek replica'yı görür
  } finally {
    await f.close();
  }
});

integration("db.replicas() reports a healthy replica with zero lag and no URL", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime();
    const [row] = await db.replicas();
    expect(row).toMatchObject({ databaseId: "db0", replica: 1, up: true, inRecovery: true, usable: true });
    expect(JSON.stringify(row)).not.toContain("127.0.0.1");
  } finally {
    await f.close();
  }
});
```

- [ ] **Step 5: Run to verify (RED → GREEN)**

Önce testleri çalıştırın; Task 1–6 tamam olduğundan RED beklenmez, ancak her test mantığını doğrulamak için ilk iki testte `pauseReplay` satırını geçici olarak yorumlayıp bir test'in başarısız olduğunu bir kez gözleyin (ledger'a not düşün), sonra geri alın.

Run: `docker compose -p dbreplica up -d postgres-rp postgres-rp-replica` (hâlâ ayaktaysa atlanır), sonra
`RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/replica.test.ts`
Expected: 6 test PASS. `leak-guard` preload'ı kullanmayın (bu çift `DATABASE_URLS`'in parçası değildir).

- [ ] **Step 6: Mevcut entegrasyon paketi etkilenmedi mi?**

Mevcut compose'u (postgres-0/1, pgbouncer) yalnızca izole bir proje adıyla ve izole portlarla çalıştırmak gerekir; paylaşılan jamaster stack'i varsa mevcut paketi çalıştırmayın. Sahip ortamında: `bun run test:integration`. Çalıştırılamadıysa ledger'a "mevcut entegrasyon paketi bu ortamda çalıştırılmadı" yazın ve final mesajında belirtin.

- [ ] **Step 7: Commit**

```bash
git add compose.yaml src/core/local/replica src/__tests__/integration/replica-fixture.ts src/__tests__/integration/replica.test.ts
git commit -m "test: streaming-replica compose pair and replica read integration tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Belgeler

**Files:**
- Create: `docs/replicas.md`
- Modify: `docs/configuration.md`, `docs/errors.md`, `docs/middleware-and-jobs.md`, `docs/queries.md`, `docs/README.md`, `README.md`

**Interfaces:** Tüketen yok; belgeler Task 1–7'nin davranışını anlatır.

- [ ] **Step 1: `docs/replicas.md` yaz** (Türkçe, mevcut belgelerin üslubunda). Başlıklar ve içerik:
  - **Ne zaman kullanılır / ne yapmaz:** okuma ölçeği; yazı hâlâ primary; otomatik yönlendirme yok (açık hedef ilkesi).
  - **Yapılandırma:** `DATABASE_REPLICA_URLS=db0=urlA,db0=urlB` (düğüm başına en çok 8; A'dan); üç ayar tablosu (`replicaMaxLagMs` 5000, `replicaOnUnavailable` `"primary"`, `replicaStatusMs` 5000; sınırlar).
  - **Kullanım:** `db.withTenantRead(id, (t) => t.query(q))` ve `RequestDb.tenantRead.query(q)`; örnek kod; bağlamda `transaction` yok; yalnızca `readOnly` sorgular, aksi halde `QUERY_NOT_READ_ONLY`.
  - **`readOnly` bayrağı:** codegen kuralı (kilitsiz SELECT, VALUES, UNION, salt okunur CTE; INSERT/UPDATE/DELETE, `FOR UPDATE/SHARE`, veri değiştiren CTE değil); yan etkili fonksiyonlar statik ayrılamaz → replica salt okunurdur, primary'ye düşme `READ ONLY` transaction'dadır; `bun run codegen` bayrağı yeniden üretir.
  - **Yazıdan sonra okuma:** istek kapsamı kuralı; sınır: başka isteğe taşan tutarlılık garanti değildir (tablo: aynı istek ✔, sonraki istek ✘ replica gecikmesi kadar bayat olabilir).
  - **Düşme politikası:** `primary` / `error`; replica hiç yapılandırılmamışsa da `error` kipi `REPLICA_UNAVAILABLE` verir.
  - **Lag yöntemi ve sınırı:** replay LSN primary'ye ulaştıysa 0, aksi halde son commit'ten süre; commit'siz WAL altında kısa süre fazla görünebilir (güvenli yön).
  - **Bağlantı sayısı:** `poolMax × (1 + replica sayısı)` süreç başına.
  - **Sınırlar:** `ready()` replica'yı beklemez; replica sorgusu bağlantı hatasıyla düşerse hata yüzeye çıkar (gizli yeniden deneme yok), replica işaretlenir; Workers'ta durum önbelleği modül düzeyindedir.
  - Araçlar (`replicas`, `doctor`, `--from-replica`) bu sayfada değil, C2 planının belge görevinde (Task 5) eklenir; bu görev yalnızca okuma yolunu anlatır.
- [ ] **Step 2: Diğer belgeler.** `configuration.md`: üç ayar satırı + `replicaOnUnavailable` tipi; `errors.md`: `QUERY_NOT_READ_ONLY` ("a query that is not read-only ran in a read context; use `tenant`/`withTenant`") ve `REPLICA_UNAVAILABLE` ("no usable replica and `replicaOnUnavailable` is `error`") satırları; `middleware-and-jobs.md`: `RequestDb.tenantRead` bölümü ve cron/kuyruk için `createDbScope` notu; `queries.md`: `readOnly` bayrağı ve `codegen` etkisi; `docs/README.md` ve `README.md`: `replicas.md` bağlantısı.
- [ ] **Step 3: Doğrula.** `bunx eslint . --max-warnings=0` yalnızca TS içindir; belge bağlantılarını `grep -rn "replicas.md" docs README.md` ile doğrulayın. Belgelerdeki kod örneklerinin imzaları kodla aynı mı (`withTenantRead`, `tenantRead.query`, ayar adları) elle karşılaştırın.
- [ ] **Step 4: Commit**

```bash
git add docs README.md
git commit -m "docs: replica read path, readOnly flag, settings and errors

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec kapsamı:** C1 (sorgu bayrağı: Task 1; okuma bağlamı ve API: Task 5–6; `onWrite` yazı takibi: Task 5–6), C2 (havuzlar: Task 3; sağlık/lag/seçim: Task 4; düşme politikası ve ayarlar: Task 2/5; `db.replicas()`: Task 4–5), hatalar `QUERY_NOT_READ_ONLY`/`REPLICA_UNAVAILABLE` (Task 5), test altyapısı ve entegrasyon (Task 7), belgeler (Task 8). `REPLICA_CONFLICT`, `REPLICA_LAG_EXCEEDED`, `replicas` komutu, `doctor`, `--from-replica`, sağlayıcı ölçümü C2 planındadır.
- **Spec'ten küçük sapmalar:** `ReplicaReport`'a `usable` alanı eklendi (CLI çıkış kodu ve doctor tek kaynaktan türer); `ready()` değişmedi. Koddan doğrulanan maddeler: düğüm kimliği `platform.node_identity` (C2 `doctor`), `backupAll` marker'ı (C2), AST `with.bind[].statement`/`select.for` (Task 1 testleri doğrular), ayar doğrulaması `RUNTIME_LIMITS` + `replicaPolicy` (Task 2).
- **Tip tutarlılığı:** `ReplicaHandle`, `ReplicaReport`, `StatusCache`, `ContextMode`, `ReadContext` adları görevler arasında aynı; `pick(databaseId)`, `report(databaseIds)`, `forPlacement(placement, work, afterWrite)` imzaları Task 4–6'da aynı.
