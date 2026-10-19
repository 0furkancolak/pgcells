# G2 — `db-single` çekirdeği Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/db-single` (`@repo/db-single`): tenant, placement ve platform kavramı olmayan, tek DB ve tek schema'lı çalışma anı + migration çekirdeği. Derleyici (E dahil), sürücüler, deadline/pool motoru, pooler zorunluluğu, replica okuma ve migration/seed zinciri `db-multi`'den **kopyalanarak** sadeleştirilir; çalışma anı fabrikası, bağlam, migration çalıştırıcısı ve yönetim oturumu tek schema için küçük yeniden yazımlardır.

**Architecture:** `createDb({ schema?, driver, … })` tek birincil havuz (+ isteğe bağlı replica havuzları) açar; her sorgu `"<schema>".tablo` olarak bağlanır (`search_path` yok). Kapsam (`tenant|node|platform`) tümden kalkar: `PreparedQuery = { requiresTransaction, readOnly, bind(schema) }`. Migration geçmişi `<schema>._migrations`, seed geçmişi `<schema>._seeds`; tek session advisory lock aynı anda iki `migrate`'i önler. `db-single`, `db-multi`'ye bağımlı değildir.

**Tech Stack:** Bun, TypeScript, `pgsql-ast-parser` 12.0.2 (yalnızca derleme zamanı), zod 4, bun:test, PostgreSQL 16 (yalıtılmış compose).

**Spec:** `docs/superpowers/specs/2026-10-04-db-single-design.md`

## Global Constraints

- `search_path` yok, hiçbir biçimde. Yeni ortam değişkeni yok (yalnızca mevcut `DATABASE_URLS` ve isteğe bağlı `DATABASE_REPLICA_URLS`). Hedef DB her çağrıda belirlidir (tek DB: kök `db.query` güvenlidir).
- Çalışma anında SQL ayrıştırılmaz: `pgsql-ast-parser` yalnızca `core/sql/*` derleyicisinde, `src/index.ts` onu yüklemez.
- Yorumlar Türkçe, hata mesajları İngilizce; hata mesajları URL, host, kullanıcı veya parola içermez.
- Daha az, daha anlaşılır kod; TDD (önce başarısız test, sonra kod). Kopyalanan her dosya kopyalandığı anda temizlenir: `no-multi-tenant.test.ts` bekçisi (`/tenant|placement|platform/i`, `src/**`, `package.json`, `compose.yaml`, `.env.example`) her commit'te yeşil kalır.
- Kaynak `packages/db-multi` (G1 sonrası). `db-multi` bu planda **değişmez**.
- Commit mesajı sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push, PR, merge yok. Parola/secret sohbete yazılmaz.
- Migration/seed dosyaları yalnızca `bun src/core/cli.ts migration create|seed create` ile (gerçek UTC zaman damgası) üretilir; elle `0000` kimlikli dosya yazılmaz. (Testlerdeki bellek içi migration listeleri dosya değildir; sabit kimlik kullanabilir.)
- Paylaşılan jamaster docker yığınına (5540/5541/5543, `jamaster-*`) dokunulmaz. Entegrasyon yalnızca `docker compose -p dbsingle …` ile, bu planın portları (5560 PostgreSQL, 5563 PgBouncer, 5489 wsproxy, 5565/5566 replica çifti) boş doğrulandıktan sonra; doluysa DURUN ve sorun.

## Plan-time Rulings (yürütücü ledger'a aynen geçirir)

- **R1** Kapsam kavramı tümden kaldırılır (`app` adlı tek kapsam bile yok): tek kapsamda denetlenecek bir şey kalmaz. `defineQuery(parts, requiresTransaction, readOnly)`; `QUERY_SCOPE` hata kodu yok. Spec'teki "tek `app` kapsamı" ifadesiyle eşdeğer, daha az kod. Maliyet: yanlışsa kapsam yeniden eklenir (yüzeysel).
- **R2** `DATABASE_REPLICA_URLS` biçimi düz virgüllü URL listesidir (`db0=` öneki yok): DB kimliği kavramı yok, önek anlamsız. Ad değişmez (yeni env yok). Maliyet: multi'den kopyalanan `.env`'de önek kaldırılır.
- **R3** Seed'ler düzdür: profil (`install|demo`) ve `demo-reset` yok; tek `_seeds` ledger'ı. `src/seeds/*.sql|*.ts`.
- **R4** `migration-recover` ve kalıcı runner marker'ı yok: tek advisory lock + her adım yeniden denenebilir (DDL transaction'da; CONCURRENTLY index idempotent). Maliyet: kilit tutan süreç çökerse sunucu kilidi bağlantıyla birlikte bırakır; tekrar `migrate` yeterlidir.
- **R5** Tenant'sız `provision/move/adopt/platform-*` araçları kopyalanmaz. `copySchema`/`fingerprint` (taşıma doğrulaması) kopyalanmaz.
- **R6** "Önce hepsini kopyala sonra sil" yerine, saklanan her dosya görevinde açıkça kopyalanır (aynı son durum, her commit derlenir).
- **R7** `compose.yaml` ve gerçek PostgreSQL yardımcıları (spec G3'e koymuştu) bu planın son görevindedir: runner ve çalışma anı gerçek PostgreSQL'e karşı kanıtlanmadan G2 bitmez. Dört sürücülü tam tarama G3'te kalır.
- **R8** Bench dizinleri (`__tests__/bench`) kopyalanmaz.
- **R9** `migrate`, `ALTER DATABASE … SET statement_timeout/lock_timeout/client_connection_check_interval` yazar (multi'deki `bootstrap`'ın karşılığı); ayrı komut yok. Yetki yoksa hata olduğu gibi yüzeye çıkar.
- **R10** Spec'teki "Kysely `WithSchemaPlugin` aynıdır" cümlesi bu pakete uygulanmaz: paketin Better Auth bağdaştırıcısı kendi motorunu kullanır, Kysely yoktur (G3'te `--schema` zaten bağdaştırıcıya bağlanır).

## Review Focus

- **`public` varsayılan schema, içinde başka tablolar olan gerçek DB:** `migrate` yalnızca kendi ledger'ını ve migration'larını yazmalı, var olan tablolara dokunmamalı; `public` varsa `CREATE SCHEMA` çalışmamalı (yetki gerektirir).
- **İki eşzamanlı `migrate`:** biri `MIGRATION_RUNNER_BUSY` almalı, ledger bozulmamalı; kilit tutan oturum öldüğünde ikinci çalıştırma devam edebilmeli.
- **Replica kullanılamaz ya da gecikmeli:** `read.query` ilke `primary` iken birincilde `READ ONLY` transaction'da çalışmalı, `error` iken `REPLICA_UNAVAILABLE`; istek kapsamında yazıdan sonra okuma birincilde kalmalı; çıktılarda URL yok.
- **Schema enjeksiyonu ve büyük/küçük harf:** `createDb({ schema: 'x"; DROP …' })`, `Public`, `pg_catalog`, `information_schema` açıkça reddedilmeli (`INVALID_SCHEMA`); `bind` yalnızca doğrulanmış adı birleştirmeli.
- **Hata mesajlarında sır:** `createConfig`, `ready()`, pooler denetimi ve sürücü hataları bağlantı dizesini, parolayı veya host'u mesaja koymamalı.

## File Structure

`packages/db-single/` (yeni):

| Dosya | Sorumluluk | Kaynak |
|---|---|---|
| `package.json`, `tsconfig.json`, `eslint.config.js` | paket tanımı | yeni / kopya |
| `src/core/errors.ts`, `driver.ts`, `pg-pool.ts`, `drivers/*` | hata kodları, sürücü sözleşmesi, bun/postgres/pg/neon | kopya (`driver.ts` kırpılır) |
| `src/core/identifier.ts` | `validateSchema`, `quoteIdentifier`, `qualified`, `DEFAULT_SCHEMA` | yeni |
| `src/core/config.ts` | tek URL + replica URL'leri, sınırlar, `runtimeDatabaseDefaults` | yeniden yazım |
| `src/core/catalog.ts` | `schemaExists` (G3 `schemaIsEmpty` ekler) | yeni |
| `src/core/sql/{compiler,grammar,parser-gaps,casing,tables,codegen,query}.ts`, `README.md` | derleyici, codegen | kopya + kapsam kaldırma |
| `src/core/database.ts` | deadline'lı `connect`, tek birincil + replica havuzları (`createPools`) | kopya + kırpma |
| `src/core/pooler.ts`, `replicas.ts` | pooler kanıtı, replica sağlık/seçim | kopya + tek DB |
| `src/core/context.ts` | `runContext`, `createReader` | yeniden yazım |
| `src/core/runtime.ts` | `createDb` | yeniden yazım |
| `src/core/management.ts`, `locks.ts` | yönetim bağlamı, tek kilit oturumu | yeniden yazım / kırpma |
| `src/core/migrations/{source,registry,runner}.ts` | kaynak biçimi, kayıt, çalıştırıcı | kopya + yeniden yazım |
| `src/{index,management,middleware,telemetry}.ts` | giriş noktaları | yeni / kopya |
| `src/{queries,migrations,seeds,tables}/` | uygulama SQL'i ve üretilmiş modüller (düz) | yeni (boş + `index.gen.ts`) |
| `src/__tests__/{unit,integration,fixtures}/` | testler | yeni + uyarlanmış kopyalar |
| `compose.yaml`, `.env.example` | yalıtılmış yerel altyapı | yeni |

---

### Task 1: İskele, yaprak modüller ve bekçi testi

**Files:**
- Create: `packages/db-single/{package.json,tsconfig.json,eslint.config.js,.env.example}`
- Create: `packages/db-single/src/core/{identifier.ts,config.ts}`
- Copy: `errors.ts`, `driver.ts` (kırpılır), `pg-pool.ts`, `drivers/*.ts`, `local/pgbouncer/*`, `local/replica/*`
- Test: `src/__tests__/unit/{identifier,config,no-multi-tenant}.test.ts`, kopya `pg-pool.test.ts`

**Interfaces:**
- Consumes: yok.
- Produces:
  - `identifier.ts`: `DEFAULT_SCHEMA = "public"`, `validateSchema(value): string` (kural `^[a-z_][a-z0-9_]{0,62}$`, `pg_` öneki ve `information_schema` reddedilir → `AppError("INVALID_SCHEMA", "invalid schema name")`), `quoteIdentifier(value): string`, `qualified(schema, name): string`.
  - `config.ts`: `interface Config { readonly url: string; readonly replicas: readonly string[] }`, `createConfig(url: string | readonly string[], replicas?: string | readonly string[]): Config`, `loadConfig(env?): Config`, `DatabaseOptions`, `ManagementOptions`, `runtimeSettings(config, options)`, `managementSettings(config, options)`, `boundedInteger`, `replicaPolicy`, `ReplicaPolicy`, `runtimeDatabaseDefaults`, `CLIENT_CONNECTION_CHECK_MS`.
  - `driver.ts`: `Connection.query(text, params?)` (üçüncü `tenantId` parametresi yok).

- [ ] **Step 1: Başlangıç doğrulaması**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
git branch --show-current && git log --oneline -1
ls packages/db-multi/package.json && grep '"name"' packages/db-multi/package.json
```
Expected: `feat/db-single`; son commit G1'in yeniden ad commit'i; paket adı `@repo/db-multi`. (Değilse G1 bitmemiştir: DURUN.)

- [ ] **Step 2: Başarısız testleri yaz**

`packages/db-single/src/__tests__/unit/identifier.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_SCHEMA, qualified, quoteIdentifier, validateSchema } from "../../core/identifier";

test("the default schema is public and is a valid name", () => {
  expect(DEFAULT_SCHEMA).toBe("public");
  expect(validateSchema("public")).toBe("public");
  expect(validateSchema("app_1")).toBe("app_1");
  expect(validateSchema("_private")).toBe("_private");
});

test("anything that is not a plain lowercase identifier is rejected with INVALID_SCHEMA", () => {
  for (const bad of ["", "Public", "app-1", "1app", 'a"b', "a b", "a;b", "a".repeat(64), "pg_catalog", "pg_temp_1", "information_schema", "ü"])
    expect(() => validateSchema(bad), bad).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA", message: "invalid schema name" }));
});

test("quoteIdentifier doubles quotes, refuses NUL, empty and over-long names", () => {
  expect(quoteIdentifier("users")).toBe('"users"');
  expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  for (const bad of ["", "a\0b", "a".repeat(64)]) expect(() => quoteIdentifier(bad)).toThrow(expect.objectContaining({ code: "INVALID_IDENTIFIER" }));
});

test("qualified validates the schema and quotes both parts", () => {
  expect(qualified("app_1", "_migrations")).toBe('"app_1"."_migrations"');
  expect(() => qualified('x"; DROP', "t")).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
});
```

`packages/db-single/src/__tests__/unit/config.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig, loadConfig, managementSettings, runtimeSettings } from "../../core/config";

const PRIMARY = "postgres://admin:secret-pw@primary.example:5432/app";
const R1 = "postgres://admin:secret-pw@r1.example:5432/app";
const R2 = "postgres://admin:secret-pw@r2.example:5432/app";
const message = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code: string; message: string }).code + ": " + (error as Error).message;
  }
  return "";
};

test("one URL becomes the config; a list of one works too; replicas default to none", () => {
  expect(createConfig(PRIMARY)).toEqual({ url: PRIMARY, replicas: [] });
  expect(createConfig([PRIMARY])).toEqual({ url: PRIMARY, replicas: [] });
  expect(createConfig(` ${PRIMARY} `).url).toBe(PRIMARY);
});

test("exactly one URL: none, several, non-postgres and schema-routing parameters are refused without echoing the value", () => {
  for (const bad of ["", `${PRIMARY},${R1}`, "mysql://u:secret-pw@h/db", "not a url", `${PRIMARY}?options=-csearch_path%3Dx`, `${PRIMARY}?search_path=x`]) {
    const text = message(() => createConfig(bad));
    expect(text, bad).toBe("INVALID_CONFIG: Invalid configuration: DATABASE_URLS");
  }
});

test("replicas are plain URLs (comma text or array), at most 8, distinct and different from the primary", () => {
  expect(createConfig(PRIMARY, `${R1}, ${R2}`).replicas).toEqual([R1, R2]);
  expect(createConfig(PRIMARY, [R1]).replicas).toEqual([R1]);
  expect(createConfig(PRIMARY, "").replicas).toEqual([]);
  const nine = Array.from({ length: 9 }, (_, i) => `postgres://u:p@r${i}.example/app`);
  for (const bad of [PRIMARY, `${R1},${R1}`, nine, "mysql://u:p@h/db", `${R1}?search_path=x`])
    expect(message(() => createConfig(PRIMARY, bad as string))).toBe("INVALID_CONFIG: Invalid configuration: DATABASE_REPLICA_URLS");
});

test("loadConfig reads DATABASE_URLS and the optional DATABASE_REPLICA_URLS", () => {
  expect(loadConfig({ DATABASE_URLS: PRIMARY })).toEqual({ url: PRIMARY, replicas: [] });
  expect(loadConfig({ DATABASE_URLS: PRIMARY, DATABASE_REPLICA_URLS: `${R1},${R2}` }).replicas).toEqual([R1, R2]);
  expect(message(() => loadConfig({}))).toContain("DATABASE_URLS");
});

test("settings carry defaults, bounds and the primary and replica URLs", () => {
  const config = createConfig(PRIMARY, R1);
  const runtime = runtimeSettings(config);
  expect(runtime).toMatchObject({ url: PRIMARY, replicas: [R1], poolMax: 5, statementTimeoutMs: 5000, replicaMaxLagMs: 5000, replicaStatusMs: 5000 });
  expect(managementSettings(config)).toMatchObject({ migrationStatementTimeoutMs: 30000, migrationLockTimeoutMs: 1000, poolMax: 5 });
  expect(runtimeSettings(config, { poolMax: 9 }).poolMax).toBe(9);
  for (const bad of [0, 101, 1.5, "x"]) expect(() => runtimeSettings(config, { poolMax: bad as never })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
```

`packages/db-single/src/__tests__/unit/no-multi-tenant.test.ts`:

```ts
/** Bekçi: bu paketin kaynağında çok-tenant sözlüğü yoktur. Nedenini anlatan notlar yalnızca `docs/` altındadır (bu test oraya bakmaz). */
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const WORDS = /tenant|placement|platform/i;
const SELF = "src/__tests__/unit/no-multi-tenant.test.ts";

test("package sources, manifests and compose files use no multi-tenant vocabulary", async () => {
  const hits: string[] = [];
  for (const file of new Glob("{src/**/*,package.json,compose.yaml,.env.example}").scanSync({ cwd: root, dot: true })) {
    if (file === SELF) continue;
    (await Bun.file(join(root, file)).text()).split("\n").forEach((line, index) => {
      if (WORDS.test(line)) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  expect(hits).toEqual([]);
});
```

- [ ] **Step 3: Testlerin başarısızlığını izle**

```bash
cd packages/db-single && bun test src/__tests__/unit 2>&1 | tail -15
```
Expected: `identifier.test.ts` ve `config.test.ts` modül bulunamadığı için **fail** (`Cannot find module '../../core/identifier'`); bekçi testi geçer (henüz tarayacak dosya yok). (`package.json` henüz yoksa `bun test` yine çalışır; yoksa Step 4'ü önce başlatın ama kodu yazmayın.)

- [ ] **Step 4: İskele ve kopyalar**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
SRC=packages/db-multi/src; DST=packages/db-single/src
mkdir -p $DST/core/drivers $DST/core/local $DST/__tests__/unit $DST/__tests__/fixtures
cp packages/db-multi/tsconfig.json packages/db-multi/eslint.config.js packages/db-single/
cp $SRC/core/errors.ts $SRC/core/driver.ts $SRC/core/pg-pool.ts $DST/core/
cp $SRC/core/drivers/*.ts $DST/core/drivers/
cp -R $SRC/core/local/pgbouncer $SRC/core/local/replica $DST/core/local/
cp $SRC/__tests__/unit/pg-pool.test.ts $DST/__tests__/unit/
cp $SRC/__tests__/fixtures/fake-driver.ts $DST/__tests__/fixtures/
```

`packages/db-single/package.json`:

```json
{
  "name": "@repo/db-single",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "bun": ">=1.3.14"
  },
  "exports": {
    ".": "./src/index.ts",
    "./management": "./src/management.ts",
    "./middleware": "./src/middleware.ts",
    "./tools": "./src/tools.ts",
    "./auth": "./src/auth.ts",
    "./telemetry": "./src/telemetry.ts",
    "./drivers/*": "./src/core/drivers/*.ts",
    "./queries/*": "./src/queries/*.gen.ts",
    "./tables/*": "./src/tables/*.gen.ts"
  },
  "scripts": {
    "cli": "bun src/core/cli.ts",
    "tools": "bun src/core/cli.ts",
    "db:migrate": "bun src/core/cli.ts migrate",
    "db:rollback": "bun src/core/cli.ts migrate-down",
    "db:status": "bun src/core/cli.ts migration-status",
    "db:seed": "bun src/core/cli.ts seed",
    "db:generate": "bun src/core/cli.ts migration create",
    "db:generate:seed": "bun src/core/cli.ts seed create",
    "db:generate:auth": "bun src/core/cli.ts auth generate",
    "db:pull": "bun src/core/cli.ts pull",
    "db:codegen": "bun src/core/sql/codegen.ts",
    "codegen": "bun src/core/sql/codegen.ts",
    "test": "bun test src/__tests__/unit",
    "test:integration": "RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format": "eslint . --fix",
    "build": "bun build src/index.ts src/management.ts src/middleware.ts src/tools.ts src/core/cli.ts src/core/drivers/bun.ts src/core/drivers/postgres.ts src/core/drivers/pg.ts src/core/drivers/neon.ts src/auth.ts src/telemetry.ts --target bun --outdir dist --external pg --external postgres --external better-auth --external @neondatabase/serverless",
    "verify:provider": "bun src/__tests__/provider/verify.ts"
  },
  "dependencies": {
    "bcryptjs": "3.0.3",
    "pgsql-ast-parser": "12.0.2",
    "zod": "4.1.5"
  },
  "devDependencies": {
    "@eslint/js": "9.39.5",
    "@neondatabase/serverless": "1.2.0",
    "@types/bun": "1.3.0",
    "@types/pg": "8.23.1",
    "better-auth": "1.7.5",
    "eslint": "9.39.5",
    "pg": "8.23.0",
    "postgres": "3.4.7",
    "typescript": "5.9.2",
    "typescript-eslint": "8.70.0",
    "wrangler": "4.71.0"
  },
  "peerDependencies": {
    "@neondatabase/serverless": "^1.2.0",
    "better-auth": "1.7.5",
    "pg": "^8.23.0",
    "postgres": "^3.4.7"
  },
  "peerDependenciesMeta": {
    "@neondatabase/serverless": { "optional": true },
    "better-auth": { "optional": true },
    "pg": { "optional": true },
    "postgres": { "optional": true }
  }
}
```

`packages/db-single/.env.example`:

```
# Yerel demo kimlik bilgileri. Zorunlu tek değişken: DATABASE_URLS (bu pakette tek URL). İsteğe bağlı: DATABASE_REPLICA_URLS.
# CLI, araçlar ve entegrasyon testleri doğrudan PostgreSQL URL'si ister (session advisory lock). Uygulama süreci aynı değişkeni bir
# transaction-mode pooler'a (ör. PgBouncer) yöneltmelidir; yoksa db.ready() POOLER_REQUIRED verir (createDb `pooler: "assumed"` ile atlanır):
# DATABASE_URLS=postgres://admin:local_admin_password@127.0.0.1:5563/app
DATABASE_URLS=postgres://admin:local_admin_password@127.0.0.1:5560/app
# İsteğe bağlı okuma replica'ları (düz URL listesi, en çok 8, virgüllü). Bozuk değer config yüklemede INVALID_CONFIG verir.
# DATABASE_REPLICA_URLS=postgres://admin:local_admin_password@127.0.0.1:5566/app
```

`packages/db-single/src/core/driver.ts`'te `Connection.query` imzasını ve yorumunu şöyle değiştirin (Edit):

```ts
export interface Connection {
  /** `$n` parametreli metin sorgusu; hiçbir zaman isimli prepared statement kullanmaz (PgBouncer/Hyperdrive güvenli).
   * Dizi `count` ile etkilenen/dönen satır sayısını taşır (`@repo/db-single/auth` bağdaştırıcısı `updateMany`/`deleteMany`). */
  query<R = Row>(text: string, params?: readonly unknown[]): Promise<R[] & { count?: number }>;
```

`packages/db-single/src/core/identifier.ts`:

```ts
/** Schema ve identifier doğrulaması: SQL'e giren her ad buradan geçer; identifier hiçbir zaman değer parametresi değildir. */
import { AppError } from "./errors";

/** Uygulama tabloları `createDb`'ye schema verilmezse burada durur. */
export const DEFAULT_SCHEMA = "public";
/** Küçük harf, rakam ve `_`; harf ya da `_` ile başlar, en çok 63 bayt. `pg_*` ve `information_schema` sistemindir. */
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

export function validateSchema(value: string): string {
  if (!SCHEMA.test(value) || value.startsWith("pg_") || value === "information_schema") throw new AppError("INVALID_SCHEMA", "invalid schema name");
  return value;
}

export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0") || new TextEncoder().encode(value).length > 63) throw new AppError("INVALID_IDENTIFIER", "Invalid PostgreSQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

/** `"schema"."ad"`: schema doğrulanır, ikisi de tırnaklanır. */
export const qualified = (schema: string, name: string) => `${quoteIdentifier(validateSchema(schema))}.${quoteIdentifier(name)}`;
```

`packages/db-single/src/core/config.ts`:

```ts
/** `DATABASE_URLS` (bu pakette tek URL) ve isteğe bağlı `DATABASE_REPLICA_URLS` doğrulanır; ayarlar env değil, fabrikalara verilen tipli seçeneklerdir. */
import { AppError } from "./errors";

/** Düz veri: env'den (`loadConfig`) veya doğrudan URL'lerden (`createConfig`). Hata mesajları hiçbir zaman URL içermez. */
export interface Config {
  /** Runtime'da transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive) olmalı; yönetimde doğrudan (veya session pooling) bağlantı olmalı. */
  readonly url: string;
  /** Salt okunur replica URL'leri. */
  readonly replicas: readonly string[];
}

/** Seçenek → [varsayılan, üst sınır]. `statementTimeoutMs` runtime'da bağlantı edinme deadline'ı, yönetimde `migrate`'in yazdığı DB varsayılanıdır. */
const RUNTIME_LIMITS = {
  poolMax: [5, 100],
  statementTimeoutMs: [5000, 300000],
  idleTimeoutSeconds: [20, 300],
  maxLifetimeSeconds: [300, 3600],
  /** Replica okuması: bunu aşan lag'li replica elenir; durum (sağlık + lag) kaydı bu kadar önbellekte kalır. */
  replicaMaxLagMs: [5000, 3_600_000],
  replicaStatusMs: [5000, 60_000],
} as const;
const MANAGEMENT_LIMITS = {
  ...RUNTIME_LIMITS,
  migrationStatementTimeoutMs: [30000, 3600000],
  migrationLockTimeoutMs: [1000, 60000],
} as const;
type Limits = Record<string, readonly [number, number]>;
type Values<T> = { -readonly [K in keyof T]: number };

/** Sağlıklı replica yokken (düştü ya da lag eşiği aşıldı) okuma: primary'de `READ ONLY` transaction ya da `REPLICA_UNAVAILABLE`. */
export type ReplicaPolicy = "primary" | "error";
export function replicaPolicy(value: unknown = "primary"): ReplicaPolicy {
  if (value === "primary" || value === "error") return value;
  throw new AppError("INVALID_CONFIG", 'replicaOnUnavailable must be "primary" or "error"');
}
export type DatabaseOptions = Partial<Values<typeof RUNTIME_LIMITS>> & { replicaOnUnavailable?: ReplicaPolicy };
export type ManagementOptions = Partial<Values<typeof MANAGEMENT_LIMITS>>;
export type ManagementSettings = Config & Values<typeof MANAGEMENT_LIMITS>;

/** 1..max aralığında sayı veya rakam dizesi (CLI) kabul eder. */
export function boundedInteger(value: unknown, name: string, max: number) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= max) return number;
  throw new AppError("INVALID_CONFIG", `${name} must be an integer from 1 to ${max}`);
}

/** Schema yönlendiren URL parametreleri: schema'yı motor seçer, bağlantı değil. */
const ROUTING_PARAMETERS = ["options", "search_path"];
const MAX_REPLICAS = 8;

function isDatabaseUrl(entry: string) {
  const url = URL.parse(entry);
  const routesSchema = [...(url?.searchParams.keys() ?? [])].some((key) => ROUTING_PARAMETERS.includes(key.toLowerCase()));
  return !!url && ["postgres:", "postgresql:"].includes(url.protocol) && !routesSchema;
}

/** Virgüllü metin ya da dizi → kırpılmış girdiler; boş metin boş liste. */
const entries = (value: string | readonly string[]) =>
  typeof value === "string" ? (value.trim() ? value.split(",").map((entry) => entry.trim()) : []) : [...value];

/** Tam olarak bir postgres:// URL'si (schema yönlendirme parametresi yok) ve isteğe bağlı replica URL'leri (en çok 8, tekil, birincilden farklı). */
export function createConfig(value: string | readonly string[], replicas: string | readonly string[] = []): Config {
  const urls = typeof value === "string" ? value.split(",").map((entry) => entry.trim()) : [...value];
  const [url] = urls;
  if (urls.length !== 1 || !url || !isDatabaseUrl(url)) throw new AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_URLS");
  const extra = entries(replicas);
  if (extra.length > MAX_REPLICAS || !extra.every(isDatabaseUrl) || new Set([url, ...extra]).size !== extra.length + 1)
    throw new AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_REPLICA_URLS");
  return { url, replicas: extra };
}

/** Ortam: runtime, CLI, araçlar ve testler `DATABASE_URLS` okur; runtime ayrıca isteğe bağlı `DATABASE_REPLICA_URLS` okur. */
export const loadConfig = (env: Record<string, string | undefined> = process.env) =>
  createConfig(env.DATABASE_URLS ?? "", env.DATABASE_REPLICA_URLS ?? "");

function settings<T extends Limits>(limits: T, config: Config, options: Partial<Values<T>>): Config & Values<T> {
  const values: Record<string, unknown> = { url: config.url, replicas: config.replicas };
  for (const [key, [fallback, max]] of Object.entries(limits)) values[key] = boundedInteger(options[key] ?? fallback, key, max);
  return values as Config & Values<T>;
}
export const runtimeSettings = (config: Config, options: DatabaseOptions = {}) => settings(RUNTIME_LIMITS, config, options);
export const managementSettings = (config: Config, options: ManagementOptions = {}) => settings(MANAGEMENT_LIMITS, config, options);

/** Sunucu, istemcisi kopmuş oturumun çalışan deyimini en geç bu aralıkta keser (PostgreSQL 14+). Deadline'ı dolan bağlantı atılır;
 * iptal edemeyen sürücüde (Bun SQL) deyimin arkadan commit etmemesini bu ayar sağlar. */
export const CLIENT_CONNECTION_CHECK_MS = 1000;

/** Runtime'ın sunucu tarafı ayarları: `migrate` her DB'ye varsayılan olarak yazar (lock_timeout en çok 1000), `doctor` denetler. */
export const runtimeDatabaseDefaults = ({ statementTimeoutMs }: { statementTimeoutMs: number }) => [
  `statement_timeout=${statementTimeoutMs}`,
  `lock_timeout=${Math.min(statementTimeoutMs, 1000)}`,
  `client_connection_check_interval=${CLIENT_CONNECTION_CHECK_MS}`,
];
```

- [ ] **Step 5: Kopya testlerin uyarlanması ve geçişi**

`unit/pg-pool.test.ts` yalnızca `../../core/driver` ve `../../core/pg-pool` içe aktarır; tenant sözlüğü içeriyorsa (bekçi söyler) yeniden yazın. Sonra:

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example && bun install && cd packages/db-single
bun test src/__tests__/unit 2>&1 | tail -12
bun run typecheck && bun run lint
```
Expected: identifier, config, pg-pool ve bekçi testi **yeşil** (tümü pass); `tsc` ve `eslint` temiz. Bekçi bir satır bildirirse (ör. `errors.ts`, `pg-pool.ts` yorumu) o satırı tek-schema anlamına yeniden yazın ve yeniden çalıştırın.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
git add -A packages/db-single bun.lock
git commit -m "$(cat <<'EOF'
db-single: package skeleton, single-URL config, schema identifier rules, drivers copied, vocabulary guard

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: SQL derleyicisi (kapsamsız)

**Files:**
- Copy: `core/sql/{compiler,grammar,parser-gaps,casing,tables}.ts`
- Create: `core/sql/query.ts` (yeni, kapsamsız)
- Test: yeni `unit/sql-single.test.ts`; kopya+uyarlama `unit/{sql,sql-extensions,sql-advanced,sql-read-only}.test.ts`

**Interfaces:**
- Consumes: Task 1 `identifier.validateSchema`, `errors.AppError`.
- Produces:
  - `sql/query.ts`: `interface PreparedQuery { readonly requiresTransaction: boolean; readonly readOnly: boolean; readonly bind: (schema: string) => string }`, `defineQuery(parts: readonly string[], requiresTransaction: boolean, readOnly: boolean): PreparedQuery`, `isPreparedQuery(value): value is PreparedQuery`, `bindParts(parts, schema): string`.
  - `sql/compiler.ts`: `prepareQuery(source: string, tables?: TableColumns): PreparedQuery`, `prepareMigration(source, types?, created?)` (`bind(schema)` artık yalnızca `bindParts`), `compile`, `maskSqlComments`, `unqualifyMigration`, `unsupported`.
  - `sql/tables.ts`: `foldTables`, `tableModules(shapes): Map<string,string>` (anahtar `src/tables/<tablo>.gen.ts`).

- [ ] **Step 1: Başarısız test (kapsamsız davranış)**

`packages/db-single/src/__tests__/unit/sql-single.test.ts`:

```ts
import { expect, test } from "bun:test";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { defineQuery, isPreparedQuery } from "../../core/sql/query";

test("a prepared query has no scope and binds to whatever valid schema it is given", () => {
  const query = prepareQuery("SELECT id FROM users");
  expect(Object.keys(query).sort()).toEqual(["bind", "readOnly", "requiresTransaction"]);
  // Derleyici yalnızca schema'yı tırnaklar; tablo adı olduğu gibi kalır (`"schema".tablo`).
  expect(query.bind("public")).toBe('SELECT id FROM "public".users');
  expect(query.bind("app_1")).toBe('SELECT id FROM "app_1".users');
});

test("bind refuses schemas that are not plain lowercase names", () => {
  const query = prepareQuery("SELECT id FROM users");
  for (const bad of ['x"; DROP SCHEMA public', "Public", "pg_catalog", "information_schema", ""])
    expect(() => query.bind(bad), bad).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
});

test("readOnly and requiresTransaction come from the statement", () => {
  expect(prepareQuery("SELECT id FROM users")).toMatchObject({ readOnly: true, requiresTransaction: false });
  expect(prepareQuery("INSERT INTO users (id) VALUES (1)")).toMatchObject({ readOnly: false, requiresTransaction: false });
  expect(prepareQuery("SELECT id FROM users FOR UPDATE")).toMatchObject({ readOnly: false, requiresTransaction: true });
});

test("only the compiler's output counts as a prepared query", () => {
  expect(isPreparedQuery(prepareQuery("SELECT 1"))).toBe(true);
  expect(isPreparedQuery(defineQuery(["SELECT 1"], false, true))).toBe(true);
  expect(isPreparedQuery({ bind: () => 'SELECT * FROM "public".users', readOnly: true, requiresTransaction: false })).toBe(false);
  expect(isPreparedQuery(null)).toBe(false);
});

test("a migration binds every statement to the given schema", () => {
  const migration = prepareMigration("CREATE TABLE users (id integer PRIMARY KEY);\nCREATE INDEX users_id_idx ON users (id);");
  const bound = migration.bind("app_1");
  expect(bound).toHaveLength(2);
  expect(bound.join("\n")).toContain('"app_1".users');
  expect(() => migration.bind("Bad")).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
});
```

- [ ] **Step 2: Kaynakları kopyala (değiştirmeden) ve başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
SRC=packages/db-multi/src; DST=packages/db-single/src
mkdir -p $DST/core/sql
cp $SRC/core/sql/{compiler,grammar,parser-gaps,casing,tables}.ts $DST/core/sql/
cd packages/db-single && bun test src/__tests__/unit/sql-single.test.ts 2>&1 | tail -10
```
Expected: derleme/çözümleme hatası (`./query` yok) ya da test **fail**. (Kopyalanmış `compiler.ts` `./query`'nin eski dışa aktarımlarını bekler; bu beklenen kırmızıdır.)

- [ ] **Step 3: `query.ts`**

`packages/db-single/src/core/sql/query.ts`:

```ts
/** Runtime: derlenmiş SQL parçalarını markalar ve schema'ya bağlar. Parser yüklemez. */
import { validateSchema } from "../identifier";

export interface PreparedQuery {
  readonly requiresTransaction: boolean;
  /** Yalnızca okuyan sorgu (kilitsiz SELECT, veri değiştiren CTE yok): okuma bağlamı (replica) yalnızca bunları çalıştırır. */
  readonly readOnly: boolean;
  readonly bind: (schema: string) => string;
}
/** `defineQuery` ile markalanmış sorgular. */
const preparedQueries = new WeakSet<object>();

/** Derlenmiş parçaları doğrulanmış schema adıyla birleştirir. */
export const bindParts = (parts: readonly string[], schema: string) => parts.join(`"${validateSchema(schema)}"`);

/** Sorgu başına saklanan bağlanmış metin sayısı (schema başına bir metin); dolunca en eski atılır. */
const BOUND_TEXTS = 256;

/** Yalnızca derleyici çıktısı çağırabilir; `codegen --check` diğer çağıranları reddeder. */
export function defineQuery(parts: readonly string[], requiresTransaction: boolean, readOnly: boolean): PreparedQuery {
  const frozen = Object.freeze([...parts]);
  // Yalnızca doğrulamadan geçmiş schema'nın metni saklanır; sıcak yolda her sorguda birleştirme ve regex yapılmaz.
  const bound = new Map<string, string>();
  const bind = (schema: string) => {
    let text = bound.get(schema);
    if (text === undefined) {
      text = bindParts(frozen, schema);
      if (bound.size >= BOUND_TEXTS) bound.delete(bound.keys().next().value as string);
      bound.set(schema, text);
    }
    return text;
  };
  const query = Object.freeze({ requiresTransaction, readOnly, bind });
  preparedQueries.add(query);
  return query;
}

export const isPreparedQuery = (value: unknown): value is PreparedQuery => typeof value === "object" && value !== null && preparedQueries.has(value);
```

- [ ] **Step 4: `compiler.ts`, `grammar.ts`, `tables.ts` düzenlemeleri**

`core/sql/compiler.ts`:

1. Satır 9 içe aktarma: `import { bindParts, defineQuery, type PreparedQuery } from "./query";`
2. Yorum satırı 19: `// Schema'nın ekleneceği yeri işaretler; NUL içeren kaynak reddedilir.`
3. `export { PLATFORM_SCHEMA };` satırını silin.
4. `prepareQuery` ve `prepareMigration` şu hâle gelir:

```ts
/** `tables`: migration tabloları; codegen ile aynı `*` açılımı için gerekir (yoksa gerçek tablo üzerindeki `*` reddedilir). */
export function prepareQuery(source: string, tables?: TableColumns): PreparedQuery {
  const { parts, requiresTransaction, readOnly } = compile(source, false, undefined, tables)[0] as Compiled;
  return defineQuery(parts, requiresTransaction, readOnly);
}
/** `bind(schema)`: migration'ın çalışacağı schema. `types`: önceki migration'ların enum tipleri; bu kaynaktaki
 * `CREATE TYPE … AS ENUM` / `DROP TYPE` ile güncellenir (registry sırayla aynı kümeyi geçirir). `created`: aynı bölümün önceki
 * parçalarında oluşturulan tablo/tipler (registry her bölümü tek parça derler). */
export function prepareMigration(source: string, types = new Set<string>(), created = new Set<string>()) {
  const statements = compile(source, true, types, undefined, created);
  return Object.freeze({
    statements: statements.map((statement) => statement.ast),
    bind: (schema: string): readonly string[] => Object.freeze(statements.map(({ parts }) => bindParts(parts, schema))),
  });
}
```

5. Yorumlar (bekçi `compiler.ts`, `grammar.ts` için şu satırları bildirecek; her birini aşağıdaki anlamla yeniden yazın):
   - `compiler.ts` ~165: "… Diğer her schema (`public`, `pg_catalog` ilişkileri …) reddedilir." (yalnızca "başka tenant" ibaresi düşer)
   - `compiler.ts` ~223: `// İlişki bir CTE'ye veya uygulama schema'sına, hedef her zaman uygulama schema'sına çözülür.`
   - `grammar.ts` ~116: `// İlişkiler bir CTE'ye veya uygulama schema'sına, hedefler her zaman uygulama schema'sına çözülür.`
   - `grammar.ts` ~140: `// Enum tipleri uygulama schema'sında oluşur; sonraki başvurular derleyicide o schema'ya bağlanır.`

`core/sql/tables.ts`: `tableModules(scope: string, { tables, enums }: Shapes)` imzası `tableModules({ tables, enums }: Shapes)` olur; yol ve başlık:

```ts
      `src/tables/${table}.gen.ts`,
      `// Generated by \`bun run codegen\` from src/migrations. Do not edit.
```

- [ ] **Step 5: Kopya testleri uyarla**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
for t in sql sql-extensions sql-advanced; do cp packages/db-multi/src/__tests__/unit/$t.test.ts packages/db-single/src/__tests__/unit/; done
cd packages/db-single/src/__tests__/unit
perl -pi -e 's/tenant_\$\{"([a-z])"\.repeat\(32\)\}/app_\${"$1".repeat(32)}/g; s/tenant_([a-z0-9])\1{30,}/app_$1$1$1$1$1$1/g' sql.test.ts sql-extensions.test.ts sql-advanced.test.ts
```
Ardından `bun run typecheck` her `prepareQuery(x, "tenant", tables)` / `prepareQuery(x, "node")` çağrısını, `tableModules("tenant", …)` çağrısını ve `QueryScope` içe aktarmasını işaretler: kapsam argümanını **silin**; yalnızca kapsamı/platform schema'sını sınayan test bloklarını (`QUERY_SCOPE`, `PLATFORM_SCHEMA`, `node`/`platform` bağlama) silin ve ledger'a `Task 2: removed tests <başlıklar> — they only exercised scope/platform binding (R1)` yazın. `tenant`/`platform` içeren test metinlerini bekçi satır satır bildirir; yeniden adlandırın (`students` gibi tablo adları serbesttir, yalnızca bu üç sözcük yasaktır).

```bash
cd ../../.. && bun test src/__tests__/unit 2>&1 | tail -12 && bun run typecheck && bun run lint
```
Expected: `sql-single` 5 test **pass**; kopya SQL testleri pass; bekçi, tsc, eslint temiz. (E'nin 28 birim testi `sql-advanced` içindedir; sayı korunmalıdır: `bun test src/__tests__/unit/sql-advanced.test.ts` kopyadaki test sayısına eşit olmalı.)

- [ ] **Step 6: Commit**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
git add -A packages/db-single
git commit -m "$(cat <<'EOF'
db-single: SQL compiler without query scopes (prepared query = bind(schema) + readOnly + requiresTransaction), tables module paths flattened

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Bağlantı katmanı (deadline'lı `connect`, tek birincil + replica havuzları)

**Files:**
- Copy: `core/database.ts` (kırpılır; `createPools` yeniden yazılır)
- Test: yeni `unit/pools.test.ts`; kopya+uyarlama `unit/database.test.ts`

**Interfaces:**
- Consumes: Task 1 `Config`, `driver.ts`, `errors.ts`.
- Produces (`core/database.ts`):
  - `interface Database extends Connection { transaction<T>(work, options?: TransactionOptions): Promise<T>; readonly pool: Pool; close(): Promise<void> }`, `TransactionOptions { statementTimeoutMs?; lockTimeoutMs?; mode? }` (**`tenantId` yok**).
  - `interface Span { name: string; startTime: number; ms: number; error?: string; detail?: string }` (**`databaseId`/`tenantId` yok**), `SpanHandler`, `SpanInput`.
  - `DatabaseSettings { deadlineMs; maxPending; timeouts?; onSpan? }` (`databaseId` yok), `connect(pool, settings): Database`, `createPools(config: Config & { idleTimeoutSeconds; maxLifetimeSeconds }, driver, max, settings): Pools`.
  - `type Pools = { readonly primary: Database; replicas(): readonly Database[]; readonly replicaUrls: readonly string[]; close(): Promise<void> }`.
  - `deadlineExceeded`, `stopwatch`, `reportSpan`, `spanner` (değişmez).

- [ ] **Step 1: Başarısız test**

`packages/db-single/src/__tests__/unit/pools.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://u:p@primary.example/app";
const R1 = "postgres://u:p@r1.example/app";
const R2 = "postgres://u:p@r2.example/app";
const settings = { deadlineMs: 1000, maxPending: 8 };
const withLimits = (config = createConfig(PRIMARY, [R1, R2])) => ({ ...config, idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 });

test("the primary pool opens at creation; replica pools open on first use, once, in config order", () => {
  const { driver, pools } = fakeDriver();
  const set = createPools(withLimits(), driver, 3, settings);
  expect(pools.map((pool) => pool.url)).toEqual([PRIMARY]);
  expect(pools[0]?.options).toMatchObject({ max: 3, idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 });
  const first = set.replicas();
  expect(first).toHaveLength(2);
  expect(set.replicas()).toBe(first);
  expect(pools.map((pool) => pool.url)).toEqual([PRIMARY, R1, R2]);
  expect(set.replicaUrls).toEqual([R1, R2]);
});

test("without replicas no extra pool is ever opened", () => {
  const { driver, pools } = fakeDriver();
  const set = createPools(withLimits(createConfig(PRIMARY)), driver, 2, settings);
  expect(set.replicas()).toEqual([]);
  expect(pools).toHaveLength(1);
});

test("close closes every opened pool once; afterwards replicas() is refused with DATABASE_CLOSED", async () => {
  const { driver, pools } = fakeDriver();
  const set = createPools(withLimits(), driver, 2, settings);
  set.replicas();
  await set.close();
  await set.close();
  expect(pools.every((pool) => pool.closed)).toBe(true);
  expect(() => set.replicas()).toThrow(expect.objectContaining({ code: "DATABASE_CLOSED" }));
});

test("spans carry no database or tenant-like identifiers, only name, timing, detail and error code", async () => {
  const spans: Record<string, unknown>[] = [];
  const { driver } = fakeDriver(() => [{ ok: true }]);
  const set = createPools(withLimits(createConfig(PRIMARY)), driver, 2, { ...settings, onSpan: (span) => void spans.push({ ...span }) });
  await set.primary.query("SELECT 1");
  expect(spans.map((span) => span.name)).toEqual(["db.acquire", "db.query"]);
  for (const span of spans) expect(Object.keys(span).sort()).toEqual(expect.arrayContaining(["name", "ms", "startTime"]));
  expect(spans.some((span) => "databaseId" in span || "tenantId" in span)).toBe(false);
  await set.close();
});
```

- [ ] **Step 2: Kopyala ve başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
cp packages/db-multi/src/core/database.ts packages/db-single/src/core/database.ts
cd packages/db-single && bun test src/__tests__/unit/pools.test.ts 2>&1 | tail -8
```
Expected: **fail** (`createPools` eski imza: `config.nodes` yok → TypeError ya da `primary` tanımsız).

- [ ] **Step 3: `database.ts` düzenlemeleri (Edit, sırayla)**

1. İçe aktarmalar:

```ts
import type { Config } from "./config";
import { type Connection, type Driver, type Pool, type PoolOptions, type Reserved, runInTransaction } from "./driver";
import { AppError, errorCode } from "./errors";
```

2. Dosya başı yorumundaki "(yönetim)" dışındaki ifadeler aynı kalır; `bootstrap` sözcüğü `migrate` olur (`ALTER DATABASE … SET` artık `migrate` yazar).
3. `TransactionOptions`: `tenantId?: string;` alanını ve yorumunu silin.
4. `Span` yorumu ve türü:

```ts
/** Ölçüm noktası: `db.acquire` (bağlantı bekleme), `db.query`, `db.transaction` (BEGIN…COMMIT); yönetimde işlem adımları (`migration`, `seed`, `backup`). */
export interface Span {
  name: string;
  /** Başlangıç (Unix epoch, ms). */
  startTime: number;
  ms: number;
  /** İş hata verdiyse kararlı hata kodu (`errorCode`). */
  error?: string;
  detail?: string;
}
```

5. `DatabaseSettings`: `databaseId?: string;` silinir.
6. `connect(pool, { deadlineMs, maxPending, timeouts, onSpan }: DatabaseSettings)`; içinde `const timed = spanner(onSpan);`.
7. `withReserved(acquireMs, work)` — `tenantId` parametresi ve son argümanı silinir; `acquire` satırı:

```ts
      const session = new DeadlineSession(await (onSpan ? timed("db.acquire", () => acquire(acquireMs)) : acquire(acquireMs)), deadlines);
```

8. `transaction`: `withReserved(statementTimeoutMs || deadlineMs, (session) => timed("db.transaction", () => runInTransaction(session.connection(statementMs), begin, work, session.connection(answerMs))))`.
9. `single(statement, detail?)` — `tenantId` parametresi silinir; iç `span` fonksiyonundan `databaseId` ve `...(tenantId ? { tenantId } : {})` satırları silinir.
10. `query(text, params?)`:

```ts
  function query(text: string, params?: readonly unknown[]) {
    if (timeouts) return transaction((tx) => tx.query(text, params));
    return single((connection) => connection.query(text, params), text);
  }
```

11. Dosyanın sonundaki `PoolConfig`/`createPools` bölümü tamamen şununla değişir:

```ts
type PoolConfig = Config & Pick<PoolOptions, "idleTimeoutSeconds" | "maxLifetimeSeconds">;
export type Pools = ReturnType<typeof createPools>;

/** Tek birincil havuz (hemen açılır) ve replica havuzları (config sırasıyla, ilk kullanımda tembel açılır); her havuz `max` bağlantı alır. */
export function createPools(config: PoolConfig, driver: Driver, max: number, settings: DatabaseSettings) {
  const { idleTimeoutSeconds, maxLifetimeSeconds } = config;
  const open = (url: string) => connect(driver(url, { max, idleTimeoutSeconds, maxLifetimeSeconds, connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS }), settings);
  const primary = open(config.url);
  let replicas: Database[] | undefined;
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    const outcomes = await Promise.allSettled([primary, ...(replicas ?? [])].map((db) => db.close()));
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  return {
    primary,
    replicas(): readonly Database[] {
      if (closed) throw new AppError("DATABASE_CLOSED", "Database clients are closed");
      return (replicas ??= config.replicas.map(open));
    },
    replicaUrls: config.replicas,
    close,
  };
}
```

Not: `PLATFORM_DATABASE_ID`, `DatabaseNode`, `nodeConfig`, `node()` ve `databases` haritası kaldırıldı; `DATABASE_NOT_FOUND` hata kodu artık yok.

- [ ] **Step 3b: `database.test.ts` uyarlaması**

```bash
cp ../db-multi/src/__tests__/unit/database.test.ts src/__tests__/unit/
```
`bun run typecheck` hatalarına göre: `createPools(config, …)` çağrılarında `createConfig([url])` → `createConfig(url)`, `pools.node(id)`/`pools.platform` → `pools.primary`, span beklentilerinden `databaseId`/`tenantId` alanlarını silin. Davranış beklentileri (deadline, DATABASE_BUSY, iptal) değişmez; tenant/platform sözlüğünü bekçi bildirir.

- [ ] **Step 4: Geçişi doğrula**

```bash
bun test src/__tests__/unit 2>&1 | tail -10 && bun run typecheck && bun run lint
```
Expected: `pools` 4 test pass; `database.test.ts` pass; bekçi/tsc/eslint temiz.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: deadline-bounded connect without tenant/database span fields, createPools = one primary + lazy replica pools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Pooler kanıtı ve replica yönlendirici

**Files:**
- Create: `core/pooler.ts` (kopya, içe aktarma düzeltmesi), `core/replicas.ts` (tek DB'ye yeniden yazım)
- Test: kopya `unit/pooler.test.ts`; yeniden yazılmış `unit/replica-router.test.ts`

**Interfaces:**
- Consumes: Task 3 `Pools` (`primary`, `replicas()`, `replicaUrls`), `Database`, `deadlineExceeded`; `driver.ts` tipleri.
- Produces:
  - `pooler.ts`: `usesTransactionPooler(driver, url, { deadlineMs, rounds? }): Promise<boolean>` (davranış aynı).
  - `replicas.ts`: `probeReplica(primary: Connection, replica: Connection): Promise<{ inRecovery: boolean; lagMs: number | null }>`, `createReplicaRouter({ pools, maxLagMs, statusMs, cache?, rotation?, now? })` → `{ pick(): Promise<ReplicaHandle | undefined>; report(): Promise<ReplicaReport[]> }`, tipler `ReplicaStatus`, `StatusCache = Map<string, ReplicaStatus>`, `ReplicaHandle = { db: Database; markDown(): void }`, `ReplicaReport = { replica: number; up: boolean; inRecovery: boolean; lagMs: number | null; usable: boolean; error?: string }`, `ReplicaRouter`.

- [ ] **Step 1: Testler**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
cp packages/db-multi/src/core/tenants/pooler.ts packages/db-single/src/core/pooler.ts
cp packages/db-multi/src/__tests__/unit/pooler.test.ts packages/db-single/src/__tests__/unit/pooler.test.ts
```
`pooler.ts` içe aktarmaları `"../database"`→`"./database"`, `"../driver"`→`"./driver"`; `pooler.test.ts` içe aktarması `"../../core/tenants/pooler"` → `"../../core/pooler"` (testin başka değişikliği yoktur).

`packages/db-single/src/__tests__/unit/replica-router.test.ts` (yeniden yazım):

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createPools } from "../../core/database";
import { createReplicaRouter, type StatusCache } from "../../core/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

type State = { inRecovery?: boolean; caughtUp?: boolean; lagMs?: number | null; fail?: string };
const PRIMARY = "postgres://p@h/d";
/** URL'ye göre replica durumu; birincil her zaman `0/3000000` konumunu bildirir. */
function fixture(states: Record<string, State>, options: { maxLagMs?: number; statusMs?: number; sharedRotation?: boolean } = {}) {
  const urls = Object.keys(states);
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    const state = states[pool.url] ?? {};
    if (state.fail) throw Object.assign(new Error(`secret ${pool.url}`), { code: state.fail });
    return [{ in_recovery: state.inRecovery ?? true, caught_up: state.caughtUp ?? false, lag_ms: state.lagMs === undefined ? 50 : state.lagMs }];
  });
  const config = { ...createConfig(PRIMARY, urls), idleTimeoutSeconds: 20, maxLifetimeSeconds: 300 };
  const pools = createPools(config, fake.driver, 2, { deadlineMs: 1000, maxPending: 8 });
  let clock = 1000;
  const cache: StatusCache = new Map();
  const router = createReplicaRouter({
    pools,
    maxLagMs: options.maxLagMs ?? 1000,
    statusMs: options.statusMs ?? 5000,
    cache,
    ...(options.sharedRotation ? {} : { rotation: { turn: 0 } }),
    now: () => clock,
  });
  const probes = () => fake.commands.filter((command) => command.text.includes("pg_is_in_recovery")).length;
  return { router, fake, probes, tick: (ms: number) => (clock += ms) };
}

const R1 = "postgres://r1@h/d";
const R2 = "postgres://r2@h/d";

test("pick rotates over usable replicas and pins nothing itself", async () => {
  const { router } = fixture({ [R1]: {}, [R2]: {} });
  const a = await router.pick();
  const b = await router.pick();
  const c = await router.pick();
  expect(a?.db).not.toBe(b?.db);
  expect(c?.db).toBe(a?.db);
});

test("a replica over the lag threshold or not in recovery is skipped; caught-up counts as zero lag", async () => {
  const { router } = fixture({ [R1]: { lagMs: 5000 }, [R2]: { inRecovery: false } });
  expect(await router.pick()).toBeUndefined();
  expect(await fixture({ [R1]: { caughtUp: true, lagMs: 999_999 } }).router.pick()).toBeDefined();
  expect(await fixture({ [R1]: { lagMs: null } }).router.pick()).toBeUndefined();
});

test("with no replica configured pick finds nothing and probes nothing", async () => {
  const { router, probes } = fixture({});
  expect(await router.pick()).toBeUndefined();
  expect(await router.report()).toEqual([]);
  expect(probes()).toBe(0);
});

test("status is cached for statusMs and concurrent picks share one probe", async () => {
  const { router, probes, tick } = fixture({ [R1]: {} });
  await Promise.all([router.pick(), router.pick(), router.pick(), router.pick(), router.pick()]);
  expect(probes()).toBe(1);
  await router.pick();
  expect(probes()).toBe(1);
  tick(5001);
  await router.pick();
  expect(probes()).toBe(2);
});

test("a failing probe marks the replica down with the error code only, once per statusMs", async () => {
  const { router, probes, tick } = fixture({ [R1]: { fail: "ECONNREFUSED" } });
  expect(await router.pick()).toBeUndefined();
  expect(await router.pick()).toBeUndefined();
  expect(probes()).toBe(1);
  const [row] = await router.report();
  expect(row).toMatchObject({ replica: 1, up: false, usable: false, error: "ECONNREFUSED" });
  expect(JSON.stringify(row)).not.toContain("secret");
  tick(5001);
  await router.pick();
  expect(probes()).toBe(3); // report zorla yeniledi + tazelik sonrası yeni yoklama
});

test("markDown removes a replica until its status expires", async () => {
  const { router, tick } = fixture({ [R1]: {} });
  (await router.pick())?.markDown();
  expect(await router.pick()).toBeUndefined();
  tick(5001);
  expect(await router.pick()).toBeDefined();
});

test("report probes every replica fresh and lists 1-based numbers without URLs", async () => {
  const { router } = fixture({ [R1]: { lagMs: 10 }, [R2]: { lagMs: 5000 } });
  const rows = await router.report();
  expect(rows.map((row) => [row.replica, row.usable, row.lagMs])).toEqual([[1, true, 10], [2, false, 5000]]);
  expect(JSON.stringify(rows)).not.toContain("r1@h");
});

test("the default rotation is shared by routers, so per-request routers (Workers) do not all start on replica 1", async () => {
  const picked = async () => {
    const f = fixture({ [R1]: {}, [R2]: {} }, { sharedRotation: true });
    await (await f.router.pick())?.db.query("SELECT 1");
    return f.fake.commands.at(-1)?.url;
  };
  const first = await picked();
  const second = await picked();
  expect(first).toBeDefined();
  expect(second).not.toBe(first);
});
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd packages/db-single && bun test src/__tests__/unit/replica-router.test.ts src/__tests__/unit/pooler.test.ts 2>&1 | tail -8
```
Expected: `replicas` modülü yok → **fail**; pooler testi, `pooler.ts` düzeltilmediyse fail.

- [ ] **Step 3: `replicas.ts`**

`packages/db-single/src/core/replicas.ts`:

```ts
/** Replica sağlığı ve seçimi. Durum (sağlık + lag) `statusMs` boyunca önbellekte kalır; yoklama tembeldir (arka plan zamanlayıcısı yok,
 * Workers'ta yaşamaz) ve aynı replica için eşzamanlı çağrılar tek yoklamayı paylaşır. Önbellek ve dönüş sırası modül düzeyindedir ve
 * yalnızca sayı tutar: Workers'ta istek başına havuz kapansa da durum yaşar. Lag: replay LSN primary'nin LSN'ine ulaştıysa 0, aksi halde
 * son replay edilen commit'ten bu yana geçen süre (commit'siz WAL akarken kısa süre fazla görünebilir; hata yönü güvenlidir). */
import type { Database, Pools } from "./database";
import type { Connection } from "./driver";
import { errorCode } from "./errors";

export type ReplicaStatus = { up: boolean; inRecovery: boolean; lagMs: number | null; at: number; error?: string };
export type StatusCache = Map<string, ReplicaStatus>;
export type ReplicaHandle = { db: Database; markDown(): void };
export type ReplicaReport = { replica: number; up: boolean; inRecovery: boolean; lagMs: number | null; usable: boolean; error?: string };

const sharedCache: StatusCache = new Map();
/** Round-robin sırası: istek başına router kuran Workers'ta her istek 1. replica'dan başlamaz. */
const sharedRotation = { turn: 0 };
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
  pools: Pick<Pools, "primary" | "replicas" | "replicaUrls">;
  maxLagMs: number;
  statusMs: number;
  cache?: StatusCache;
  rotation?: { turn: number };
  now?: () => number;
}

export function createReplicaRouter({ pools, maxLagMs, statusMs, cache = sharedCache, rotation = sharedRotation, now = () => performance.now() }: ReplicaRouterOptions) {
  const inflight = new Map<string, Promise<ReplicaStatus>>();
  const usable = (status: ReplicaStatus) => status.up && status.lagMs !== null && status.lagMs <= maxLagMs;
  const down = (error?: string): ReplicaStatus => ({ up: false, inRecovery: false, lagMs: null, at: now(), ...(error ? { error } : {}) });

  /** Yoklamayı (varsa süren) çalıştırır; sonuç önbelleğe yazılır. */
  function refresh(index: number, url: string): Promise<ReplicaStatus> {
    let running = inflight.get(url);
    if (!running) {
      running = probeReplica(pools.primary, pools.replicas()[index] as Database)
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
  function current(index: number, url: string): ReplicaStatus | Promise<ReplicaStatus> {
    const cached = cache.get(url);
    return cached && now() - cached.at < statusMs ? cached : refresh(index, url);
  }

  async function pick(): Promise<ReplicaHandle | undefined> {
    const urls = pools.replicaUrls;
    if (!urls.length) return undefined;
    const states = urls.map((url, index) => current(index, url));
    const statuses = states.some((state) => state instanceof Promise) ? await Promise.all(states) : (states as ReplicaStatus[]);
    const candidates = statuses.flatMap((status, index) => (usable(status) ? [index] : []));
    if (!candidates.length) return undefined;
    const index = candidates[rotation.turn++ % candidates.length] as number;
    return { db: pools.replicas()[index] as Database, markDown: () => void cache.set(urls[index] as string, down()) };
  }

  /** Her replica'yı önbelleğe bakmadan yoklar; çıktıda URL yoktur (`replica`: config sırasına göre 1 tabanlı numara). */
  async function report(): Promise<ReplicaReport[]> {
    return Promise.all(
      pools.replicaUrls.map(async (url, index): Promise<ReplicaReport> => {
        const status = await refresh(index, url);
        return {
          replica: index + 1,
          up: status.up,
          inRecovery: status.inRecovery,
          lagMs: status.lagMs,
          usable: usable(status),
          ...(status.error ? { error: status.error } : {}),
        };
      }),
    );
  }

  return { pick, report };
}
export type ReplicaRouter = ReturnType<typeof createReplicaRouter>;
```

- [ ] **Step 4: Geçiş**

```bash
bun test src/__tests__/unit 2>&1 | tail -8 && bun run typecheck && bun run lint
```
Expected: `replica-router` 8, `pooler` 5 test pass; tümü yeşil.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: pooler proof and replica router for a single database

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Bağlam (`runContext`, `createReader`) ve `createDb`

**Files:**
- Create: `core/context.ts`, `core/runtime.ts`, `src/index.ts`
- Test: yeniden yazılmış `unit/query-context.test.ts`, `unit/read-context.test.ts`, `unit/ready-pooler.test.ts`; yeni `unit/createdb.test.ts`, `unit/runtime-entry.test.ts`

**Interfaces:**
- Consumes: Task 3 `Pools`/`Database`/`SpanHandler`, Task 4 `ReplicaRouter`/`ReplicaHandle`/`usesTransactionPooler`, Task 2 `PreparedQuery`/`isPreparedQuery`, Task 1 `config`/`identifier`.
- Produces:
  - `context.ts`: `Queryable { query<R extends unknown[] = Row[]>(query: PreparedQuery, values?: readonly unknown[]): Promise<R>; transaction<T>(work: (db: Queryable) => Promise<T>): Promise<T> }`, `ReadContext = Pick<Queryable, "query">`, `ContextMode { readOnly?: boolean; onWrite?: () => void }`, `ReadSession { handle?: ReplicaHandle }`, `runContext(connection: Connection, transactionDatabase: Database | undefined, schema: string, work: (db: Queryable) => Promise<T>, mode?: ContextMode): Promise<T>`, `createReader(pools: Pick<Pools, "primary">, router: Pick<ReplicaRouter, "pick">, onUnavailable: ReplicaPolicy, schema: string): <T>(work: (db: ReadContext) => Promise<T>, afterWrite?: boolean, session?: ReadSession) => Promise<T>`.
  - `runtime.ts`: `DbOptions extends DatabaseOptions { driver: Driver; schema?: string; onSpan?: SpanHandler; pooler?: "verified" | "assumed" }`, `createDb(options: DbOptions): Db` ve `createDb(config: Config, options: DbOptions): Db`, `Db = { schema; config; pools; run(work, onWrite?); readRun(work, afterWrite?, session?); query; transaction; read: ReadContext; replicas(): Promise<ReplicaReport[]>; ready(): Promise<void>; close(): Promise<void> }`.
  - `src/index.ts` dışa aktarımları: `AppError`, `createConfig`, `createDb`, `databaseUnavailable`, `DEFAULT_SCHEMA`, `errorCode`, `loadConfig`, tipler (`Config`, `DatabaseOptions`, `Db`, `DbOptions`, `Driver`, `PreparedQuery`, `Queryable`, `ReadContext`, `Span`, `SpanHandler`).

- [ ] **Step 1: Başarısız testler**

`unit/query-context.test.ts` (multi'deki `query-context.test.ts`'in tek-schema karşılığı):

```ts
import { expect, test } from "bun:test";
import { type Queryable, runContext } from "../../core/context";
import { prepareQuery } from "../../core/sql/compiler";

const SCHEMA = "app_test";
const statement = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");

function fixture(execute: (text: string, params: readonly unknown[]) => Promise<unknown> = async () => []) {
  let transactions = 0;
  const commands: { text: string; params: readonly unknown[] }[] = [];
  const raw = {
    query: async (text: string, params: readonly unknown[] = []) => {
      commands.push({ text, params });
      return execute(text, params);
    },
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      return work(raw);
    },
  };
  const run = <T>(work: (db: Queryable) => Promise<T>, onWrite?: () => void) => runContext(raw as never, raw as never, SCHEMA, work, { onWrite });
  return {
    run,
    commands,
    get transactions() {
      return transactions;
    },
  };
}

test("a single query is autocommit, bound to the schema, with its own parameters", async () => {
  const f = fixture();
  await f.run((db) => db.query(statement, ["value"]));
  expect(f.transactions).toBe(0);
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]?.text).toContain(`"${SCHEMA}"`);
  expect(f.commands[0]?.params).toEqual(["value"]);
});

test("an explicit transaction context expires when its callback ends", async () => {
  const f = fixture();
  let escaped!: Queryable;
  await f.run(async (db) => {
    await db.transaction(async (tx) => {
      escaped = tx;
      await tx.query(statement);
    });
    expect(() => escaped.query(statement)).toThrow("closed");
    await db.query(statement);
  });
  expect(f.transactions).toBe(1);
  expect(f.commands).toHaveLength(2);
});

test("raw objects cannot bypass SQL qualification", async () => {
  const f = fixture();
  await f.run(async (db) => {
    expect(() => db.query({ bind: () => "SELECT * FROM public.students" } as never)).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
  });
  expect(f.commands).toHaveLength(0);
});

test("caught autocommit query errors can recover within the context", async () => {
  const failure = new Error("duplicate key");
  const f = fixture(async (_text, values) => {
    if (values[0] === "duplicate") throw failure;
    return [{ id: values[0] }];
  });
  const result = await f.run(async (db) => {
    await expect(db.query(statement, ["duplicate"])).rejects.toBe(failure);
    return db.query<{ id: string }[]>(statement, ["recovered"]);
  });
  expect(result).toEqual([{ id: "recovered" }]);
});

test("caught transaction query errors still fail the transaction", async () => {
  const failure = new Error("duplicate key");
  const f = fixture(async () => {
    throw failure;
  });
  await expect(
    f.run((db) =>
      db.transaction(async (tx) => {
        await expect(tx.query(statement)).rejects.toBe(failure);
        return "must not commit";
      }),
    ),
  ).rejects.toBe(failure);
});

test("uncaught autocommit errors propagate", async () => {
  const failure = new Error("query failed");
  const f = fixture(async () => {
    throw failure;
  });
  await expect(f.run((db) => db.query(statement))).rejects.toBe(failure);
});

test("contexts close and drain unfinished queries before settling", async () => {
  for (const transactional of [false, true]) {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const f = fixture(async () => {
      started();
      await waiting;
      return [];
    });
    let escaped!: Queryable;
    let settled = false;
    const work = async (db: Queryable) => {
      escaped = db;
      void db.query(statement);
    };
    const result = f.run((db) => (transactional ? db.transaction(work) : work(db))).finally(() => (settled = true));
    await ready;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(() => escaped.query(statement)).toThrow("closed");
    release();
    await result;
    expect(settled).toBe(true);
  }
});

test("bound adversarial payloads never become SQL source", async () => {
  const f = fixture();
  const payload = "'); SELECT * FROM public.students; /* ' */ --";
  await f.run((db) => db.query(statement, [payload]));
  expect(f.commands[0]?.params).toEqual([payload]);
  expect(f.commands[0]?.text).not.toContain(payload);
});

test("row locks reject autocommit before dispatch but execute inside a transaction", async () => {
  const f = fixture();
  const locked = prepareQuery("SELECT id FROM students FOR UPDATE SKIP LOCKED");
  await f.run(async (db) => {
    expect(() => db.query(locked)).toThrow(expect.objectContaining({ code: "TRANSACTION_REQUIRED" }));
    expect(f.commands).toHaveLength(0);
    await db.transaction((tx) => tx.query(locked));
  });
  expect(f.commands).toHaveLength(1);
  expect(f.transactions).toBe(1);
});

test("nested transactions are refused", async () => {
  const f = fixture();
  await expect(f.run((db) => db.transaction((tx) => tx.transaction(async () => 1)))).rejects.toMatchObject({ code: "NESTED_TRANSACTION" });
});
```

`unit/read-context.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createReader, type Queryable, runContext } from "../../core/context";
import { prepareQuery } from "../../core/sql/compiler";

const SCHEMA = "app_test";
const select = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const update = prepareQuery("UPDATE students SET name = $1::text WHERE id = $2::uuid");

/** Kayıt tutan sahte havuz: `query` ve `transaction(mode)`. */
function recorder(fail?: { code: string }) {
  const log: { text: string }[] = [];
  const modes: (string | undefined)[] = [];
  const db = {
    query: async (text: string) => {
      log.push({ text });
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

function fixture(options: { replica?: ReturnType<typeof recorder>; policy?: "primary" | "error" } = {}) {
  const primary = recorder();
  const downs: number[] = [];
  const router = { pick: async () => (options.replica ? { db: options.replica.db as never, markDown: () => void downs.push(1) } : undefined) };
  const read = createReader({ primary: primary.db } as never, router, options.policy ?? "primary", SCHEMA);
  const run = <T>(work: (db: Queryable) => Promise<T>, onWrite?: () => void) => runContext(primary.db as never, primary.db as never, SCHEMA, work, { onWrite });
  return { primary, downs, read, run };
}

test("a read-only query runs on the picked replica, bound to the schema, and never touches the primary", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  await f.read((db) => db.query(select, ["id"]));
  expect(replica.log).toHaveLength(1);
  expect(replica.log[0]?.text).toContain(`"${SCHEMA}"`);
  expect(f.primary.log).toHaveLength(0);
  expect(f.primary.modes).toHaveLength(0);
});

test("a query that is not read-only is rejected before any database is touched", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  const error = (await f.read(async (db) => db.query(update, ["x", "id"])).catch((e: unknown) => e)) as { code: string };
  expect(error).toMatchObject({ code: "QUERY_NOT_READ_ONLY" });
  expect(replica.log).toHaveLength(0);
  expect(f.primary.log).toHaveLength(0);
});

test("with no usable replica the primary policy runs each query in a READ ONLY transaction", async () => {
  const f = fixture();
  await f.read((db) => db.query(select, ["id"]));
  expect(f.primary.modes).toEqual([" READ ONLY"]);
  expect(f.primary.log).toHaveLength(1);
});

test("the error policy raises REPLICA_UNAVAILABLE without touching any database, also when no replica is configured", async () => {
  const f = fixture({ policy: "error" });
  const error = (await f.read(async (db) => db.query(select, ["id"])).catch((e: unknown) => e)) as { code: string; message: string };
  expect(error).toMatchObject({ code: "REPLICA_UNAVAILABLE" });
  expect(error.message).not.toContain("postgres://");
  expect(f.primary.log).toHaveLength(0);
});

test("after a write in the same request the read goes to the primary even under the error policy", async () => {
  const replica = recorder();
  const f = fixture({ replica, policy: "error" });
  await f.read((db) => db.query(select, ["id"]), true);
  expect(replica.log).toHaveLength(0);
  expect(f.primary.modes).toEqual([" READ ONLY"]);
});

test("a connection error marks the replica down; a SQL error does not; both surface", async () => {
  const dead = recorder({ code: "ECONNRESET" });
  const f = fixture({ replica: dead });
  expect(await f.read((db) => db.query(select, ["id"])).catch((e: unknown) => (e as { code: string }).code)).toBe("ECONNRESET");
  expect(f.downs).toHaveLength(1);
  const timeout = recorder({ code: "57014" });
  const g = fixture({ replica: timeout });
  expect(await g.read((db) => db.query(select, ["id"])).catch((e: unknown) => (e as { code: string }).code)).toBe("57014");
  expect(g.downs).toHaveLength(0);
});

test("the read context expires after the work", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  let escaped!: { query: (...args: never[]) => unknown };
  await f.read(async (db) => void (escaped = db as never));
  expect(() => escaped.query(select as never)).toThrow(expect.objectContaining({ code: "TRANSACTION_CLOSED" }));
});

test("a session pins reads to the first replica until it fails", async () => {
  const replica = recorder();
  const picks: number[] = [];
  const primary = recorder();
  const router = { pick: async () => (picks.push(1), { db: replica.db as never, markDown: () => {} }) };
  const read = createReader({ primary: primary.db } as never, router, "primary", SCHEMA);
  const session = {};
  await read((db) => db.query(select, ["a"]), false, session);
  await read((db) => db.query(select, ["b"]), false, session);
  expect(picks).toHaveLength(1);
  expect(replica.log).toHaveLength(2);
});

test("onWrite fires for writes (also inside transactions) and not for reads", async () => {
  const f = fixture();
  let writes = 0;
  const onWrite = () => void writes++;
  await f.run((db) => db.query(select, ["id"]), onWrite);
  expect(writes).toBe(0);
  await f.run((db) => db.transaction((tx) => tx.query(select, ["id"])), onWrite);
  expect(writes).toBe(0);
  await f.run((db) => db.query(update, ["x", "id"]), onWrite);
  expect(writes).toBe(1);
  await f.run((db) => db.transaction((tx) => tx.query(update, ["x", "id"])), onWrite);
  expect(writes).toBe(2);
});
```

`unit/createdb.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDb, type DbOptions } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@localhost:6432/one";
const REPLICA = "postgres://app:secret-pw@localhost:6433/one";
const select = prepareQuery("SELECT id FROM users WHERE id = $1::integer");
const insert = prepareQuery("INSERT INTO users (id) VALUES ($1::integer)");

function open(options: Partial<Omit<DbOptions, "driver">> = {}, replicas: string[] = [], handler: Handler = () => []) {
  const fake = fakeDriver(handler);
  const db = createDb(createConfig(PRIMARY, replicas), { driver: fake.driver, pooler: "assumed", ...options });
  return { db, fake };
}
const texts = (fake: ReturnType<typeof fakeDriver>) => fake.commands.map((command) => command.text);
const replicaHandler: Handler = (text) =>
  text.includes("pg_current_wal_lsn") ? [{ lsn: "0/1" }] : text.includes("pg_is_in_recovery") ? [{ in_recovery: true, caught_up: true, lag_ms: 0 }] : [];

test("queries bind to public by default and to the given schema otherwise", async () => {
  const a = open();
  await a.db.query(select, [1]);
  expect(texts(a.fake).at(-1)).toContain('"public".users');
  const b = open({ schema: "app_x" });
  await b.db.query(select, [1]);
  expect(texts(b.fake).at(-1)).toContain('"app_x".users');
  expect(b.db.schema).toBe("app_x");
});

test("a bad schema or option is refused before any pool opens", () => {
  const fake = fakeDriver();
  for (const options of [{ schema: 'x"; DROP' }, { schema: "Public" }, { schema: "pg_catalog" }])
    expect(() => createDb(createConfig(PRIMARY), { driver: fake.driver, ...options })).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
  expect(() => createDb(createConfig(PRIMARY), { driver: fake.driver, replicaOnUnavailable: "sometimes" as never })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(fake.pools).toHaveLength(0);
});

test("a query that is not prepared is rejected", async () => {
  const { db, fake } = open();
  await expect(db.query({} as never)).rejects.toMatchObject({ code: "INVALID_QUERY" });
  expect(fake.commands).toHaveLength(0);
});

test("a transaction wraps its queries in BEGIN and COMMIT, and a failure rolls back", async () => {
  const ok = open();
  await ok.db.transaction(async (tx) => void (await tx.query(insert, [1])));
  expect(texts(ok.fake)).toEqual(["BEGIN", expect.stringContaining('INSERT INTO "public".users'), "COMMIT"]);

  const failing = open({}, [], (text) => {
    if (text.startsWith("INSERT")) throw Object.assign(new Error("duplicate"), { code: "23505" });
    return [];
  });
  await expect(failing.db.transaction((tx) => tx.query(insert, [1]))).rejects.toMatchObject({ code: "23505" });
  expect(texts(failing.fake).at(-1)).toBe("ROLLBACK");
});

test("read.query without a usable replica runs READ ONLY on the primary, or fails under the error policy without leaking the URL", async () => {
  const primary = open();
  await primary.db.read.query(select, [1]);
  expect(texts(primary.fake)).toEqual(["BEGIN READ ONLY", expect.stringContaining("SELECT id FROM"), "COMMIT"]);
  const strict = open({ replicaOnUnavailable: "error" });
  const error = (await strict.db.read.query(select, [1]).catch((e: unknown) => e)) as Error & { code: string };
  expect(error.code).toBe("REPLICA_UNAVAILABLE");
  expect(error.message).not.toContain("secret-pw");
  expect(error.message).not.toContain("localhost");
  await expect(primary.db.read.query(insert as never, [1])).rejects.toMatchObject({ code: "QUERY_NOT_READ_ONLY" });
});

test("a healthy replica serves read.query and replicas() reports it without its URL", async () => {
  const { db, fake } = open({ replicaStatusMs: 1 }, [REPLICA], replicaHandler);
  await db.read.query(select, [1]);
  expect(fake.commands.filter((command) => command.text.startsWith("SELECT id FROM")).map((command) => command.url)).toEqual([REPLICA]);
  const report = await db.replicas();
  expect(report).toEqual([{ replica: 1, up: true, inRecovery: true, lagMs: 0, usable: true }]);
  expect(JSON.stringify(report)).not.toContain("secret-pw");
});

test("close closes every pool", async () => {
  const { db, fake } = open({}, [REPLICA], replicaHandler);
  await db.read.query(select, [1]);
  await db.close();
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
});
```

`unit/ready-pooler.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDb, type DbOptions } from "../../core/runtime";
import { fakeDriver } from "../fixtures/fake-driver";

const url = "postgres://app:secret-pw@localhost:6432/one";

/** `pid()` her `pg_backend_pid` sorgusunun cevabıdır; `SELECT 1` ulaşılabilirlik sınamasıdır. */
function fixture(pid: () => number | Error, reachable: () => void = () => {}) {
  const fake = fakeDriver((text) => {
    if (text.includes("pg_backend_pid")) {
      const value = pid();
      if (value instanceof Error) throw value;
      return [{ pid: value }];
    }
    if (text === "SELECT 1") reachable();
    return [];
  });
  const open = (options: Omit<DbOptions, "driver"> = {}) => createDb(createConfig(url), { driver: fake.driver, ...options });
  const probes = () => fake.commands.filter((command) => command.text.includes("pg_backend_pid")).length;
  return { fake, open, probes };
}

test("ready() refuses a direct connection with POOLER_REQUIRED and reveals no connection detail", async () => {
  let n = 0;
  const { open } = fixture(() => ++n);
  const db = open();
  const error = await db.ready().then(
    () => undefined,
    (reason: unknown) => reason as { code: string; message: string },
  );
  expect(error?.code).toBe("POOLER_REQUIRED");
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

test("pooler: 'assumed' skips the probe but still checks the database answers", async () => {
  let n = 0;
  let pings = 0;
  const { open, probes } = fixture(() => ++n, () => void pings++);
  const db = open({ pooler: "assumed" });
  await db.ready();
  expect(probes()).toBe(0);
  expect(pings).toBe(1);
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

test("an unreachable database is DATABASE_UNAVAILABLE without host or credentials, with or without the probe", async () => {
  const refused = () => {
    throw Object.assign(new Error("refused secret-pw"), { code: "ECONNREFUSED" });
  };
  for (const options of [{}, { pooler: "assumed" as const }]) {
    const { open } = fixture(() => 7, refused);
    const db = open(options);
    const error = (await db.ready().catch((e: unknown) => e)) as { code: string; message: string };
    expect(error.code).toBe("DATABASE_UNAVAILABLE");
    expect(error.message).not.toContain("secret-pw");
    expect(error.message).not.toContain("localhost");
    await db.close();
  }
  const { open } = fixture(() => Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
  const db = open();
  await expect(db.ready()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
  await db.close();
});

test("a pooler value other than verified or assumed is INVALID_CONFIG, never a silently skipped probe", () => {
  const { open, fake } = fixture(() => 1);
  for (const pooler of ["Verified", "off", "", true, 0, null]) expect(() => open({ pooler: pooler as never })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(fake.pools).toHaveLength(0);
});
```

`unit/runtime-entry.test.ts`:

```ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import * as api from "../../index";

test("the runtime entry exports a small, stable surface", () => {
  expect(Object.keys(api).sort()).toEqual(["AppError", "DEFAULT_SCHEMA", "createConfig", "createDb", "databaseUnavailable", "errorCode", "loadConfig"]);
});

test("the runtime bundle never contains the SQL parser or optional peers", async () => {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../index.ts")], target: "bun", external: ["pg", "postgres", "better-auth", "@neondatabase/serverless"] });
  expect(built.success).toBe(true);
  const text = await built.outputs[0]?.text();
  expect(text).not.toContain("pgsql-ast-parser");
  expect(text).not.toContain("better-auth");
});
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single && bun test src/__tests__/unit/{query-context,read-context,createdb,ready-pooler,runtime-entry}.test.ts 2>&1 | tail -15
```
Expected: beş dosya da modül bulunamadığı için **fail** (`core/context`, `core/runtime`, `index`).

- [ ] **Step 3: `context.ts`**

`packages/db-single/src/core/context.ts`:

```ts
/** Hazırlanmış SQL'i schema'ya bağlar ve query, transaction ve context ömrünü yönetir. */
import type { ReplicaPolicy } from "./config";
import type { Database, Pools } from "./database";
import type { Connection, Row } from "./driver";
import { AppError, databaseUnavailable } from "./errors";
import type { ReplicaHandle, ReplicaRouter } from "./replicas";
import { isPreparedQuery, type PreparedQuery } from "./sql/query";

export interface Queryable {
  query<R extends unknown[] = Row[]>(query: PreparedQuery, values?: readonly unknown[]): Promise<R>;
  transaction<T>(work: (db: Queryable) => Promise<T>): Promise<T>;
}

/** Replica'dan okuma bağlamı: yalnızca `readOnly` sorgular; transaction yoktur. */
export type ReadContext = Pick<Queryable, "query">;
/** `readOnly`: okuma bağlamı (hata autocommit gibi toparlanabilir, yazan sorgu reddedilir). `onWrite`: `readOnly` olmayan sorgu
 * çalıştığında (transaction içindekiler dahil) çağrılır; istek kapsamı yazıdan sonra okumayı primary'ye yöneltmek için kullanır. */
export interface ContextMode {
  readOnly?: boolean;
  onWrite?: () => void;
}

/** İstek kapsamının okuma oturumu: kapsam içindeki okumalar ilk okumanın seçtiği replica'ya sabitlenir (çağrılar arası monoton okuma);
 * replica bağlantı hatasıyla düşerse sabitleme kalkar ve sonraki okuma yeniden seçer. */
export interface ReadSession {
  handle?: ReplicaHandle;
}

/** `transactionDatabase` yoksa `connection` zaten bir transaction'dır (iç içe transaction reddedilir); seed'ler de bunu kullanır. */
export async function runContext<T>(
  connection: Connection,
  transactionDatabase: Database | undefined,
  schema: string,
  work: (db: Queryable) => Promise<T>,
  mode: ContextMode = {},
) {
  const insideTransaction = !transactionDatabase && !mode.readOnly;
  let isOpen = true;
  let failure: { error: unknown } | undefined;
  // Bitmemiş sorgular; ilk sorguda açılır. Tepki sorgu çözülünce çağıranın devamından önce çalışır, beklenen sorgu kümede kalmaz.
  let running: Set<Promise<unknown>> | undefined;

  function track<R>(operation: Promise<R>): Promise<R> {
    const pending = (running ??= new Set());
    pending.add(operation);
    operation.then(
      () => void pending.delete(operation),
      (error: unknown) => {
        // Transaction içinde yakalanmış hata da transaction'ı düşürür; autocommit'te çağıran toparlanabilir.
        if (insideTransaction) failure = { error };
        pending.delete(operation);
      },
    );
    return operation;
  }

  function assertOpen() {
    if (!isOpen) throw new AppError("TRANSACTION_CLOSED", "Database context is closed");
  }

  function assertRunnable(query: PreparedQuery) {
    if (!isPreparedQuery(query)) throw new AppError("INVALID_QUERY", "Use a prepared query");
    if (mode.readOnly && !query.readOnly) throw new AppError("QUERY_NOT_READ_ONLY", "Read contexts run read-only queries only");
    if (query.requiresTransaction && !insideTransaction) throw new AppError("TRANSACTION_REQUIRED", "Row locks require db.transaction");
  }

  const context: Queryable = Object.freeze({
    query<R extends unknown[] = Row[]>(query: PreparedQuery, values: readonly unknown[] = []): Promise<R> {
      assertOpen();
      assertRunnable(query);
      if (!query.readOnly) mode.onWrite?.();
      return track(connection.query(query.bind(schema), values) as Promise<R>);
    },
    transaction<R>(callback: (tx: Queryable) => Promise<R>): Promise<R> {
      assertOpen();
      if (!transactionDatabase) throw new AppError("NESTED_TRANSACTION", "Nested transactions are not supported");
      return track(transactionDatabase.transaction((tx) => runContext(tx, undefined, schema, callback, { onWrite: mode.onWrite })));
    },
  });

  let result: T;
  try {
    result = await work(context);
  } finally {
    isOpen = false;
    // Bekletilmemiş sorgular sürerken transaction commit/rollback edilemez.
    if (running?.size) await Promise.allSettled(running);
  }
  if (failure) throw failure.error;
  return result;
}

const NOT_READ_ONLY = () => Promise.reject(new AppError("QUERY_NOT_READ_ONLY", "Read contexts run prepared read-only queries only"));

/** Primary'de okuma: her sorgu `READ ONLY` transaction'da (yan etkili fonksiyonlara karşı ikinci güvence). */
const primaryReads = (db: Database): Connection => ({
  query: ((text: string, params?: readonly unknown[]) => db.transaction((tx) => tx.query(text, params), { mode: " READ ONLY" })) as Connection["query"],
  exec: NOT_READ_ONLY,
});

/** Replica'da okuma: bağlantı hatası replica'yı `up = false` işaretler (SQL hatası işaretlemez); hata her halükârda yüzeye çıkar. */
const replicaReads = ({ db, markDown }: { db: Database; markDown(): void }): Connection => ({
  query: (async (text: string, params?: readonly unknown[]) => {
    try {
      return await db.query(text, params);
    } catch (error) {
      if (databaseUnavailable(error)) markDown();
      throw error;
    }
  }) as Connection["query"],
  exec: NOT_READ_ONLY,
});

/** Her çağrı bir replica'ya sabitlenir. Sağlıklı replica yoksa (ya da hiç yapılandırılmamışsa) `onUnavailable`: primary'de `READ ONLY`
 * ya da `REPLICA_UNAVAILABLE`. `afterWrite`: aynı istekte yazı oldu, okuma politikadan bağımsız primary'de kalır. */
export function createReader(pools: Pick<Pools, "primary">, router: Pick<ReplicaRouter, "pick">, onUnavailable: ReplicaPolicy, schema: string) {
  return async function read<T>(work: (db: ReadContext) => Promise<T>, afterWrite = false, session?: ReadSession): Promise<T> {
    let handle = afterWrite ? undefined : (session?.handle ?? (await router.pick()));
    if (handle && session) {
      const picked = handle;
      session.handle = picked;
      handle = {
        db: picked.db,
        markDown: () => {
          picked.markDown();
          if (session.handle === picked) session.handle = undefined;
        },
      };
    }
    let connection: Connection;
    if (handle) connection = replicaReads(handle);
    else if (afterWrite || onUnavailable === "primary") connection = primaryReads(pools.primary);
    else throw new AppError("REPLICA_UNAVAILABLE", "No usable replica is available");
    return runContext(connection, undefined, schema, work, { readOnly: true });
  };
}
```

- [ ] **Step 4: `runtime.ts` ve `index.ts`**

`packages/db-single/src/core/runtime.ts`:

```ts
/** Runtime fabrikası: tek birincil havuz (+ replica havuzları), pooler kanıtı ve schema'ya bağlı sorgu/transaction/okuma. Yönetim, parser,
 * araçlar ve sürücü modüllerini yüklemez. */
import { type Config, type DatabaseOptions, loadConfig, replicaPolicy, runtimeSettings } from "./config";
import { createReader, type Queryable, type ReadContext, runContext } from "./context";
import { createPools, type SpanHandler } from "./database";
import type { Driver } from "./driver";
import { AppError, databaseUnavailable } from "./errors";
import { DEFAULT_SCHEMA, validateSchema } from "./identifier";
import { usesTransactionPooler } from "./pooler";
import { createReplicaRouter } from "./replicas";
import type { PreparedQuery } from "./sql/query";

export interface DbOptions extends DatabaseOptions {
  /** `@repo/db-single/drivers/bun|postgres|pg|neon`; yalnızca import edilen sürücü bundle'a girer. */
  driver: Driver;
  /** Uygulama tablolarının schema'sı; verilmezse `public`. Her sorgu `"<schema>".tablo` olarak bağlanır. */
  schema?: string;
  /** Ölçüm: bağlantı bekleme, sorgu ve transaction süresi (bkz. `Span`). Verilmezse ek maliyet yok. */
  onSpan?: SpanHandler;
  /** `verified` (varsayılan): `ready()` URL'nin transaction-mode pooler arkasında olduğunu sınar, değilse `POOLER_REQUIRED`.
   * `assumed`: sınama atlanır (sınanamayan ortamlar, ör. doğrulanmamış Hyperdrive); pooler olduğunu sağlamak uygulamanın işidir. */
  pooler?: "verified" | "assumed";
}

/** Bekleyen bağlantı işi sınırı; aşılırsa `DATABASE_BUSY`. */
const RUNTIME_MAX_PENDING = 64;

/** Bun: süreç başına bir kez. Workers: istek başına `{ poolMax: 1 }` ile bir kez (soketler isteği aşamaz). */
function openDb(input: Config, { driver, schema = DEFAULT_SCHEMA, onSpan, pooler = "verified", replicaOnUnavailable, ...options }: DbOptions) {
  // Seçenekler havuz açılmadan doğrulanır; zorunluluk yalnızca bilinçli bir kararla atlanabilir.
  if (pooler !== "verified" && pooler !== "assumed") throw new AppError("INVALID_CONFIG", 'pooler must be "verified" or "assumed"');
  validateSchema(schema);
  const onUnavailable = replicaPolicy(replicaOnUnavailable);
  const config = runtimeSettings(input, options);
  // Sunucu tarafı timeout'lar DB varsayılanıdır (`migrate` yazar): tek sorgu tek gidiş-dönüş.
  const pools = createPools(config, driver, config.poolMax, { deadlineMs: config.statementTimeoutMs, maxPending: RUNTIME_MAX_PENDING, onSpan });
  const router = createReplicaRouter({ pools, maxLagMs: config.replicaMaxLagMs, statusMs: config.replicaStatusMs });
  /** Yazma bağlamı; `onWrite` istek kapsamının (`createDbScope`) yazıdan sonra okumayı primary'de tutması içindir. */
  const run = <T>(work: (db: Queryable) => Promise<T>, onWrite?: () => void) => runContext(pools.primary, pools.primary, schema, work, { onWrite });
  /** Okuma bağlamı: replica'dan, yoksa politikaya göre primary'den; bkz. `createReader`. */
  const readRun = createReader(pools, router, onUnavailable, schema);

  let poolerCheck: Promise<void> | undefined;
  // Eşzamanlı `ready()` çağrıları aynı sonucu bekler, başarılı sonuç saklanır, başarısız olan silinir.
  const checkPooler = () => {
    if (!poolerCheck) {
      poolerCheck = usesTransactionPooler(driver, config.url, { deadlineMs: config.statementTimeoutMs + 1000 }).then(
        (pooled) => {
          if (!pooled)
            throw new AppError("POOLER_REQUIRED", 'Database is reachable without a transaction pooler; use a transaction-mode pooler URL in DATABASE_URLS or set pooler: "assumed"');
        },
        (error: unknown) => {
          throw databaseUnavailable(error) ? new AppError("DATABASE_UNAVAILABLE", "Database is not reachable") : error;
        },
      );
      poolerCheck.catch(() => (poolerCheck = undefined));
    }
    return poolerCheck;
  };
  /** Hazır: veritabanı cevap veriyor; `pooler: "verified"` iken URL bir transaction-mode pooler'a gidiyor. Aksi halde `DATABASE_UNAVAILABLE`,
   * `DATABASE_TIMEOUT` veya `POOLER_REQUIRED`. Başlangıçta ve sağlık uç noktasında çağırın (istek yolunda değil). */
  const ready = async () => {
    await pools.primary.query("SELECT 1").catch((error: unknown) => {
      throw databaseUnavailable(error) ? new AppError("DATABASE_UNAVAILABLE", "Database is not reachable") : error;
    });
    if (pooler === "verified") await checkPooler();
  };

  return Object.freeze({
    schema,
    config,
    pools,
    run,
    readRun,
    query: ((query: PreparedQuery, values?: readonly unknown[]) => run((db) => db.query(query, values))) as Queryable["query"],
    transaction: <T>(work: (tx: Queryable) => Promise<T>) => run((db) => db.transaction(work)),
    /** Okuma sorguları replica'dan (yalnızca `readOnly` sorgular; bkz. `docs/replicas.md`). */
    read: Object.freeze<ReadContext>({ query: ((query: PreparedQuery, values?: readonly unknown[]) => readRun((db) => db.query(query, values))) as ReadContext["query"] }),
    /** Replica durumu (sağlık, lag, kullanılabilirlik); önbelleğe bakmadan yoklar. URL içermez. */
    replicas: () => router.report(),
    ready,
    close: pools.close,
  });
}

export type Db = ReturnType<typeof openDb>;

/** Süreç başına bir kez (Workers'ta istek başına `poolMax: 1`). Config verilmezse `DATABASE_URLS` okunur:
 *   createDb({ driver: bunDriver })
 *   createDb(createConfig(env.DB.connectionString), { driver: postgresDriver, poolMax: 1 }) */
export function createDb(options: DbOptions): Db;
export function createDb(config: Config, options: DbOptions): Db;
export function createDb(configOrOptions: Config | DbOptions, options?: DbOptions): Db {
  return "url" in configOrOptions ? openDb(configOrOptions, options as DbOptions) : openDb(loadConfig(), configOrOptions);
}
```

`packages/db-single/src/index.ts`:

```ts
/** Runtime girişi (`@repo/db-single`): uygulamanın ihtiyaç duyduğu küçük yüzey. Yönetim, parser, araçlar ve sürücü modüllerini yüklemez;
 * sürücü `@repo/db-single/drivers/bun|postgres|pg|neon`, istek kapsamı `@repo/db-single/middleware`, telemetri `@repo/db-single/telemetry`
 * girişindedir. */
export type { Config, DatabaseOptions } from "./core/config";
export { createConfig, loadConfig } from "./core/config";
export type { Queryable, ReadContext } from "./core/context";
export type { Span, SpanHandler } from "./core/database";
export type { Driver } from "./core/driver";
export { AppError, databaseUnavailable, errorCode } from "./core/errors";
export { DEFAULT_SCHEMA } from "./core/identifier";
export { createDb, type Db, type DbOptions } from "./core/runtime";
export type { PreparedQuery } from "./core/sql/query";
```

- [ ] **Step 5: Geçiş**

```bash
bun test src/__tests__/unit 2>&1 | tail -10 && bun run typecheck && bun run lint
```
Expected: beş yeni dosya + önceki tüm testler **pass**; bekçi/tsc/eslint temiz. Bir test başarısız olursa kodu, testi değil, `systematic-debugging` ile düzeltin (testler multi'deki davranışların tek-schema karşılığıdır).

- [ ] **Step 6: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: runContext/createReader and createDb (schema-bound query, transaction, replica reads, ready with pooler proof)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Migration kaynakları, registry, codegen (düz yerleşim)

**Files:**
- Copy+edit: `core/migrations/source.ts`, `core/sql/codegen.ts`, `core/sql/README.md`
- Create: `core/migrations/registry.ts`, `src/migrations/index.gen.ts`, `src/seeds/index.gen.ts` (codegen üretir)
- Test: yeni `unit/codegen-single.test.ts`, `unit/registry-single.test.ts`, `unit/tables-single.test.ts`; kopya+uyarlama `unit/{casing,sql-read-only,migration-files}.test.ts`

**Interfaces:**
- Consumes: Task 2 `compiler`/`tables`, Task 5 `context.runContext`/`Queryable`.
- Produces:
  - `source.ts`: `Migration`, `Seed`, `SeedContext { schema; query; transaction }`, `compileMigrations(list: readonly (readonly [string, string])[]): readonly Migration[]`, `compileSeeds(list: readonly (readonly [string, SeedSource])[]): readonly Seed[]`, `splitMigration`, `migrationPrefix`, `checksum`, `MIGRATION_NAME`, `SOURCE_FILE`, `pulledMarkerOf`, `pullMarker`, `PulledMarker`, `Seed.run(tx: Connection, schema: string, verify): Promise<void>`.
  - `registry.ts`: `migrations`, `seeds`, `registry: Registry`, `Registry { migrations; seeds }`, `migrationTables()`, `pendingMigrations(applied, registry, code?)`, `createLedger(ledger)`, `pendingIn(db, ledger, registry, { code?, missingOk? })`, `rollbackTargets(applied, { steps?, to? }): Migration[]`, `RollbackTarget`.
  - `codegen.ts`: `generate(files, tables?: TableColumns): Map<string,string>`, `codegen(root)`, `staleFiles(root)`, `writeGenerated(root)`, `createMigration({ name, source?, now?, root? })`, `createSeed({ name, kind?, now?, root? })`; yerleşim `src/queries/<alan>.sql`, `src/migrations/<id>.sql`, `src/seeds/<id>.(sql|ts)`, `src/tables/<tablo>.gen.ts`.

- [ ] **Step 1: Başarısız testler**

`unit/registry-single.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { pendingMigrations, rollbackTargets } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";

const list = compileMigrations([
  ["20260101000001_a", "--up\nCREATE TABLE a (id integer PRIMARY KEY);\n--down\nDROP TABLE a;\n"],
  ["20260101000002_b", "--up\nCREATE TABLE b (id integer PRIMARY KEY);\n--down\nDROP TABLE b;\n"],
  ["20260101000003_c", "--up\nCREATE TABLE c (id integer PRIMARY KEY);\n--down\n"],
]);
const history = (count: number) => list.slice(0, count).map(({ id, checksum }) => ({ id, checksum }));

describe("migration planner", () => {
  test("the immutable list yields the unapplied suffix", () => {
    expect(pendingMigrations([], list).map((m) => m.id)).toEqual(list.map((m) => m.id));
    expect(pendingMigrations(history(2), list).map((m) => m.id)).toEqual(["20260101000003_c"]);
    expect(pendingMigrations(history(3), list)).toHaveLength(0);
  });
  test("checksum drift, unknown history, duplicates and holes are errors, never silent migrations", () => {
    expect(() => pendingMigrations([{ id: list[0]?.id ?? "", checksum: "changed" }], list)).toThrow("Unknown or modified migration");
    expect(() => pendingMigrations([{ id: "20990101000000_unknown", checksum: "x" }], list)).toThrow(expect.objectContaining({ code: "MIGRATION_DRIFT" }));
    expect(() => pendingMigrations([...history(1), ...history(1)], list)).toThrow("Duplicate");
    const second = list[1];
    expect(() => pendingMigrations([{ id: second?.id ?? "", checksum: second?.checksum ?? "" }], list)).toThrow("gap");
    expect(() => pendingMigrations(history(1).map((h) => ({ ...h, checksum: "x" })), list, "SEED_DRIFT")).toThrow(expect.objectContaining({ code: "SEED_DRIFT" }));
  });
  test("one definition binds to any schema", () => {
    expect(list[0]?.up.bind("app_a").join("\n")).toContain('"app_a".a');
    expect(list[0]?.up.bind("app_b").join("\n")).not.toContain('"app_a"');
  });
});

describe("rollbackTargets", () => {
  test("steps and to pick the newest applied migrations, newest first", () => {
    const applied = list.slice(0, 2);
    expect(rollbackTargets(applied, {}).map((m) => m.id)).toEqual(["20260101000002_b"]);
    expect(rollbackTargets(applied, { steps: 2 }).map((m) => m.id)).toEqual(["20260101000002_b", "20260101000001_a"]);
    expect(rollbackTargets(applied, { to: "20260101000001_a" }).map((m) => m.id)).toEqual(["20260101000002_b"]);
  });
  test("bad targets are refused before any DDL", () => {
    const applied = list.slice(0, 2);
    expect(() => rollbackTargets(applied, { steps: 1, to: "20260101000001_a" })).toThrow(expect.objectContaining({ code: "USAGE" }));
    expect(() => rollbackTargets(applied, { steps: 3 })).toThrow(expect.objectContaining({ code: "USAGE" }));
    expect(() => rollbackTargets(applied, { steps: 0 })).toThrow(expect.objectContaining({ code: "USAGE" }));
    expect(() => rollbackTargets(applied, { to: "20260101000009_nope" })).toThrow(expect.objectContaining({ code: "MIGRATION_NOT_APPLIED" }));
    expect(() => rollbackTargets(list, { steps: 1 })).toThrow(expect.objectContaining({ code: "MIGRATION_IRREVERSIBLE" }));
  });
});
```

`unit/codegen-single.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codegen, createMigration, createSeed, generate, staleFiles, writeGenerated } from "../../core/sql/codegen";

const users = "-- name: listUsers\nSELECT id FROM users ORDER BY id\n\n-- name: addUser\nINSERT INTO users (id) VALUES ($1::integer)\n";

test("each query file becomes a flat module of defineQuery calls with no scope argument", () => {
  const modules = generate([["src/queries/users.sql", users]]);
  expect([...modules.keys()]).toEqual(["src/queries/users.gen.ts"]);
  const text = modules.get("src/queries/users.gen.ts") ?? "";
  expect(text).toContain('import { defineQuery } from "../core/sql/query";');
  expect(text).toContain('export const listUsers = defineQuery(["SELECT id FROM ",".users ORDER BY id"], false, true);');
  expect(text).toContain("export const addUser = defineQuery(");
  expect(text).toMatch(/, false, false\);/);
});

test("query files must live directly in src/queries and names must be unique across files", () => {
  expect(() => generate([["src/queries/sub/users.sql", users]])).toThrow("query files live in src/queries/");
  expect(() => generate([["src/queries/users.sql", users], ["src/queries/more.sql", users]])).toThrow("duplicate query listUsers");
  expect(() => generate([["src/queries/users.sql", "SELECT 1"]])).toThrow("-- name:");
});

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "single-codegen-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
const migration = "--up\nCREATE TABLE users (id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());\n--down\nDROP TABLE users;\n";

test("codegen emits query, migration list, seed list and table modules from the flat layout", async () => {
  const root = await project({
    "src/migrations/20260101000001_users.sql": migration,
    "src/seeds/20260101000002_first.sql": "INSERT INTO users (id) VALUES (1);\n",
    "src/queries/users.sql": users,
  });
  try {
    const modules = await codegen(root);
    expect([...modules.keys()].sort()).toEqual(["src/migrations/index.gen.ts", "src/queries/users.gen.ts", "src/seeds/index.gen.ts", "src/tables/users.gen.ts"]);
    expect(modules.get("src/migrations/index.gen.ts")).toContain('["20260101000001_users", m0]');
    expect(modules.get("src/seeds/index.gen.ts")).toContain('["20260101000002_first", m0]');
    expect(modules.get("src/tables/users.gen.ts")).toContain("export const userRow");
    expect(modules.get("src/tables/users.gen.ts")).toContain('createdAt: "created_at"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration and seed folders are flat: a nested file is refused", async () => {
  const root = await project({ "src/migrations/legacy/20260101000001_users.sql": migration });
  try {
    await expect(codegen(root)).rejects.toThrow("flat folders");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staleFiles reports missing, edited and orphan generated files; writeGenerated fixes them", async () => {
  const root = await project({ "src/migrations/20260101000001_users.sql": migration, "src/queries/users.sql": users });
  try {
    expect((await staleFiles(root)).length).toBeGreaterThan(0);
    await writeGenerated(root);
    expect(await staleFiles(root)).toEqual([]);
    await writeFile(join(root, "src/queries/users.gen.ts"), "// edited\n");
    expect(await staleFiles(root)).toEqual(["src/queries/users.gen.ts"]);
    await writeGenerated(root);
    expect(await staleFiles(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createMigration and createSeed write UTC-stamped files and refresh the list; ids must increase", async () => {
  const root = await project({});
  try {
    const first = await createMigration({ name: "add_users", now: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), root });
    expect(first).toEqual({ id: "20260102030405_add_users", path: "src/migrations/20260102030405_add_users.sql" });
    expect(await Bun.file(join(root, first.path)).text()).toBe("--up\n\n--down\n");
    expect(await Bun.file(join(root, "src/migrations/index.gen.ts")).text()).toContain('"20260102030405_add_users"');
    await expect(createMigration({ name: "older", now: new Date(Date.UTC(2026, 0, 1)), root })).rejects.toMatchObject({ code: "MIGRATION_INVALID" });
    await expect(createMigration({ name: "Bad Name", root })).rejects.toMatchObject({ code: "USAGE" });
    const seed = await createSeed({ name: "first_user", kind: "ts", now: new Date(Date.UTC(2026, 0, 3)), root });
    expect(seed.path).toBe("src/seeds/20260103000000_first_user.ts");
    expect(await Bun.file(join(root, seed.path)).text()).toContain('import type { SeedContext } from "../management";');
    const sql = await createSeed({ name: "sql_seed", now: new Date(Date.UTC(2026, 0, 4)), root });
    expect(sql.path).toBe("src/seeds/20260104000000_sql_seed.sql");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

`unit/tables-single.test.ts`:

```ts
import { expect, test } from "bun:test";
import { compileMigrations } from "../../core/migrations/source";
import { foldTables, tableModules } from "../../core/sql/tables";

const migrations = compileMigrations([
  ["20260101000001_users", "--up\nCREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email_address text NOT NULL, bio text);\n--down\nDROP TABLE users;\n"],
]);

test("table modules are flat and carry camelCase column maps", () => {
  const modules = tableModules(foldTables(migrations.flatMap((m) => m.up.statements)));
  expect([...modules.keys()]).toEqual(["src/tables/users.gen.ts"]);
  const text = modules.get("src/tables/users.gen.ts") ?? "";
  expect(text).toContain("// Generated by `bun run codegen` from src/migrations. Do not edit.");
  expect(text).toContain("export const userRow");
  expect(text).toContain("export const userInsert");
  expect(text).toContain('emailAddress: "email_address"');
});
```

Kopya testler:

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
for t in casing sql-read-only migration-files; do cp packages/db-multi/src/__tests__/unit/$t.test.ts packages/db-single/src/__tests__/unit/; done
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd packages/db-single && bun test src/__tests__/unit/{registry-single,codegen-single,tables-single}.test.ts 2>&1 | tail -10
```
Expected: `registry` ve `codegen` modülleri/dışa aktarımları yok → **fail**.

- [ ] **Step 3: `source.ts`**

```bash
cp ../db-multi/src/core/migrations/source.ts src/core/migrations/source.ts 2>/dev/null || (mkdir -p src/core/migrations && cp ../db-multi/src/core/migrations/source.ts src/core/migrations/source.ts)
```

Düzenlemeler (Edit):

1. İçe aktarmalar ve kapsam/profil sabitleri:

```ts
import { createHash } from "node:crypto";
import type { Statement } from "pgsql-ast-parser";
import { type Queryable, runContext } from "../context";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { maskSqlComments, prepareMigration } from "../sql/compiler";

export const MIGRATION_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const SOURCE_FILE = /^(\d{14}_[a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.(sql|ts)$/;
```
(`SCOPES`, `Scope`, `SEED_PROFILES`, `SeedProfile` silinir.)

2. `pullMarker` işareti:

```ts
const PULL_MARKER = /^-- @repo\/db-single pull structure=([0-9a-f]{64}) exclude=([a-z0-9_,]*)$/m;
export const pullMarker = ({ structure, exclude }: PulledMarker) => `-- @repo/db-single pull structure=${structure} exclude=${exclude.join(",")}`;
```

3. Seed türleri:

```ts
/** TS seed'in aldığı bağlam: schema'ya bağlı `query` (üretilmiş sorgular) ve seed'in kendi transaction'ı. */
export interface SeedContext {
  readonly schema: string;
  readonly query: Queryable["query"];
  /** Seed zaten tek transaction'dadır; `work` aynı bağlamla çalışır. */
  transaction<T>(work: (db: Queryable) => Promise<T>): Promise<T>;
}
export interface Seed {
  readonly id: string;
  readonly checksum: string;
  run(tx: Connection, schema: string, verify: () => Promise<void>): Promise<void>;
}
```
(`SeedTarget` silinir.)

4. `concurrentIndexStatement` (kapsam parametresi yok; CONCURRENTLY her yerde serbest, tek deyim şartı kalır):

```ts
/** CONCURRENTLY yalnızca bölümün tek deyimi olarak kabul edilir. */
function concurrentIndexStatement(id: string, statements: readonly Statement[], kind: "create index" | "drop index") {
  const found = statements.find((s) => (s.type === "create index" || s.type === "drop index") && s.concurrently);
  if (found && (statements.length !== 1 || found.type !== kind)) {
    const section = kind === "create index" ? "--up" : "--down";
    throw invalid(`${id}: ${found.type.toUpperCase()} CONCURRENTLY must be the only statement of a ${section} section`);
  }
  return found;
}
```

5. `compileMigrations(list)`: imza `compileMigrations(list: readonly (readonly [string, string])[])`; içeride `concurrentIndexStatement(id, up.statements, "create index")` ve `(id, down.statements, "drop index")`.
6. `compileSeeds(list)`:

```ts
/** SQL seed: schema'ya bağlanan INSERT/UPDATE/DELETE. TS seed: schema'ya bağlı bağlamla çağrılır. */
export function compileSeeds(list: readonly (readonly [string, SeedSource])[]): readonly Seed[] {
  return compileList(list, (id, source): Seed => {
    if (typeof source !== "string") {
      const run = (tx: Connection, schema: string) => runContext(tx, undefined, schema, (db) => source.run({ schema, query: db.query, transaction: (work) => work(db) }));
      return { id, checksum: source.checksum, run };
    }
    const prepared = prepareMigration(source);
    if (prepared.statements.some((s) => !["insert", "update", "delete"].includes(s.type)))
      throw invalid(`${id}: SQL seeds may only contain INSERT, UPDATE or DELETE`);
    async function run(tx: Connection, schema: string, verify: () => Promise<void>) {
      for (const statement of prepared.bind(schema)) {
        await verify();
        await tx.exec(statement);
      }
    }
    return { id, checksum: checksum(source), run };
  });
}
```

7. Yorum/metinlerde `tenant` geçen yerleri bekçi bildirir: "tenant'a bağlı" → "schema'ya bağlı" gibi yeniden yazın.

- [ ] **Step 4: `registry.ts`**

`packages/db-single/src/core/migrations/registry.ts`:

```ts
/** Migration ve seed kayıtları ve ledger drift kuralı. Seam: SQL/TS dosyaları core dışındadır; core onları yalnızca üretilmiş
 * `src/migrations/index.gen.ts` ve `src/seeds/index.gen.ts` listelerinden alır. */
import migrationList from "../../migrations/index.gen";
import seedList from "../../seeds/index.gen";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { foldTables } from "../sql/tables";
import { compileMigrations, compileSeeds, type Migration, type Seed } from "./source";

export type { Migration, Seed } from "./source";
export interface Registry {
  readonly migrations: readonly Migration[];
  readonly seeds: readonly Seed[];
}
export const migrations = compileMigrations(migrationList);
export const seeds = compileSeeds(seedList);
export const registry: Registry = { migrations, seeds };
/** Katlanmış migration tabloları: `prepareQuery` codegen ile aynı kaynaktan `*` açar. */
export const migrationTables = () => foldTables(migrations.flatMap((migration) => migration.up.statements)).tables;

export type AppliedMigration = { id: string; checksum: string };
type DriftCode = "MIGRATION_DRIFT" | "SEED_DRIFT";

/** Registry'nin kalan soneki; bilinmeyen, değişmiş, tekrarlanan veya sırası bozuk her geçmiş drift'tir (`code`). */
export function pendingMigrations<T extends AppliedMigration>(applied: readonly AppliedMigration[], list: readonly T[], code: DriftCode = "MIGRATION_DRIFT"): readonly T[] {
  for (const { id, checksum } of applied)
    if (list.find((migration) => migration.id === id)?.checksum !== checksum) throw new AppError(code, `Unknown or modified migration: ${id}`);
  const appliedIds = new Set(applied.map((entry) => entry.id));
  if (appliedIds.size !== applied.length) throw new AppError(code, "Duplicate migration history");
  const pending = list.filter((migration) => !appliedIds.has(migration.id));
  // Uygulanmış geçmiş listenin öneki olmalı: ilk bekleyen migration'dan sonra uygulanmış bir şey olamaz.
  if (list.slice(list.length - pending.length).some((migration) => appliedIds.has(migration.id))) throw new AppError(code, "Migration history contains a gap");
  return pending;
}

/** Sabit, tırnaklı `ledger` tablosu. */
export const createLedger = (ledger: string) =>
  `CREATE TABLE IF NOT EXISTS ${ledger} (id text PRIMARY KEY,checksum text NOT NULL,completed_at timestamptz NOT NULL DEFAULT now())`;

/** Ledger'ı okur ve listenin bekleyen sonekini döndürür; `missingOk`: tablo yoksa hepsi bekler. */
export async function pendingIn<T extends AppliedMigration>(
  db: Connection,
  ledger: string,
  list: readonly T[],
  { code, missingOk }: { code?: DriftCode; missingOk?: boolean } = {},
): Promise<readonly T[]> {
  if (missingOk) {
    const [table] = await db.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [ledger]);
    if (!table?.exists) return list;
  }
  const rows = await db.query<AppliedMigration>(`SELECT id,checksum FROM ${ledger} ORDER BY id`);
  return pendingMigrations(rows, list, code);
}

/** Geri alınacaklar: son `steps` (varsayılan 1) migration veya `to` son uygulanmış kalacak şekilde sonrakiler. */
export type RollbackTarget = { steps?: number; to?: string };

/** Uygulanmış önek → geri alma sırası (yeniden eskiye); bilinmeyen hedefleri ve geri alınamaz migration'ları DDL'den önce reddeder. */
export function rollbackTargets(applied: readonly Migration[], { steps, to }: RollbackTarget): Migration[] {
  if (steps !== undefined && to !== undefined) throw new AppError("USAGE", "Use either steps or to");
  let count = steps ?? 1;
  if (to !== undefined) {
    const index = applied.findIndex((migration) => migration.id === to);
    if (index < 0) throw new AppError("MIGRATION_NOT_APPLIED", `${to} is not an applied migration`);
    count = applied.length - 1 - index;
  } else if (!Number.isSafeInteger(count) || count < 1 || count > applied.length)
    throw new AppError("USAGE", `steps must be between 1 and the ${applied.length} applied migrations`);
  const targets = applied.slice(applied.length - count).reverse();
  const irreversible = targets.find((migration) => !migration.down);
  if (irreversible) throw new AppError("MIGRATION_IRREVERSIBLE", `${irreversible.id} has an empty --down section and cannot be rolled back`);
  return targets;
}
```

- [ ] **Step 5: `codegen.ts` ve README**

```bash
cp ../db-multi/src/core/sql/codegen.ts ../db-multi/src/core/sql/README.md src/core/sql/
mkdir -p src/migrations src/seeds src/queries src/tables
```

`codegen.ts` düzenlemeleri:

1. Başlık yorumu: `/** `bun run codegen [--check]`: sorgular (`src/queries/<alan>.sql` → `.gen.ts`), migration ve seed listeleri (`src/migrations/index.gen.ts`, `src/seeds/index.gen.ts`) ve tablo tipleri (`src/tables/<tablo>.gen.ts`). Seam: core bu klasörleri import etmez (registry yalnızca listeleri); yalnızca bu komut okur ve yazar. */`
2. İçe aktarmalar:

```ts
import { readdir, rm } from "node:fs/promises";
import { Glob } from "bun";
import { AppError } from "../errors";
import { checksum, compileMigrations, compileSeeds, MIGRATION_NAME, migrationPrefix, SOURCE_FILE } from "../migrations/source";
import type { TableColumns } from "./casing";
import { compile } from "./compiler";
import { foldTables, tableModules } from "./tables";
```
3. `QUERY_FILE`, `generate`, `queryModule`, `queryExport`:

```ts
const QUERY_FILE = /^src\/queries\/[a-z0-9_-]+\.sql$/;

/** Her sorgu dosyasının (yol, kaynak) `-- name: x` bloklarını kendi modülüne derler: modül yolu → metin. `tables`: migration tabloları (`*` açılımı). */
export function generate(files: readonly (readonly [string, string])[], tables?: TableColumns): Map<string, string> {
  const modules = new Map<string, string>();
  const fileByQueryName = new Map<string, string>();
  for (const [file, source] of files) modules.set(file.replace(/\.sql$/, ".gen.ts"), queryModule(file, source, fileByQueryName, tables));
  return modules;
}

function queryModule(file: string, source: string, fileByQueryName: Map<string, string>, tables?: TableColumns): string {
  if (!QUERY_FILE.test(file)) throw new Error(`${file}: query files live in src/queries/`);
  let text = `// Generated by \`bun run codegen\` from ${file}. Do not edit.\nimport { defineQuery } from "../core/sql/query";\n`;
  // Bölme sonucu: [önsöz, ad1, sql1, ad2, sql2, …].
  const [preamble = "", ...blocks] = source.split(/^-- name: *(\S+) *$/m);
  if (preamble.replace(/^--.*$/gm, "").trim() || !blocks.length) throw new Error(`${file}: SQL must follow a "-- name: <identifier>" line`);
  for (let i = 0; i < blocks.length; i += 2) {
    const name = blocks[i] as string;
    if (!QUERY_NAME.test(name)) throw new Error(`${file}: query name ${name} must match ${QUERY_NAME}`);
    const previous = fileByQueryName.get(name);
    if (previous) throw new Error(`${file}: duplicate query ${name} (also in ${previous})`);
    fileByQueryName.set(name, file);
    text += queryExport(file, name, blocks[i + 1] as string, tables);
  }
  return text;
}

function queryExport(file: string, name: string, sql: string, tables?: TableColumns): string {
  try {
    const [query] = compile(sql.trim(), false, undefined, tables);
    return `\nexport const ${name} = defineQuery(${JSON.stringify(query?.parts)}, ${query?.requiresTransaction}, ${query?.readOnly});\n`;
  } catch (error) {
    throw new Error(`${file} ${name}: ${(error as Error).message}`);
  }
}
```
4. `SOURCES`, `codegen`, `createSource`, `createMigration`, `createSeed`:

```ts
/** Migration klasörü yalnızca `.sql`, seed klasörü `.sql` ve `.ts` alır; ikisi de düzdür (alt klasör yok). */
const SOURCES = [
  { dir: "src/migrations", ts: false },
  { dir: "src/seeds", ts: true },
];
```
`codegen(root)` gövdesi:

```ts
export async function codegen(root: string): Promise<Map<string, string>> {
  const modules = new Map<string, string>();
  for await (const path of new Glob("src/{migrations,seeds}/*/*").scan(root)) throw new Error(`${path}: migrations and seeds are flat folders`);
  // Sorgulardaki `*` katlanmış migration tablolarından açılır: önce migration'lar.
  let tables: TableColumns | undefined;
  for (const { dir, ts } of SOURCES) {
    const sources = await readSources(root, dir, ts);
    if (!sources) continue;
    modules.set(`${dir}/index.gen.ts`, sourceList(dir, sources));
    if (ts) {
      compileSeeds(sources.map(([id, isTs, text]) => [id, isTs ? { checksum: checksum(text), run: async () => {} } : text]));
      continue;
    }
    const migrations = compileMigrations(sources.map(([id, , text]) => [id, text]));
    const shapes = foldTables(migrations.flatMap((m) => m.up.statements));
    tables = shapes.tables;
    for (const [path, text] of tableModules(shapes)) modules.set(path, text);
  }
  const paths = (await Array.fromAsync(new Glob("src/queries/**/*.sql").scan(root))).sort();
  const files = await Promise.all(paths.map(async (path) => [path, await Bun.file(`${root}/${path}`).text()] as const));
  for (const [path, text] of generate(files, tables)) modules.set(path, text);
  return modules;
}
```
`createSource`: `readSources(root, dir, dir === "src/seeds")`; `createMigration` ve `createSeed`:

```ts
/** Yeni migration dosyası (`source` yoksa boş şablon; `pull` içerik verir) ve liste; tablo tipleri `codegen` ile. */
export async function createMigration({ source = "--up\n\n--down\n", ...options }: SourceOptions & { source?: string }) {
  return createSource("src/migrations", "sql", source, options);
}

/** Yeni seed dosyası (SQL: boş DML şablonu, `kind: "ts"`: varsayılan fonksiyon) ve liste. */
export async function createSeed({ kind = "sql", ...options }: SourceOptions & { kind?: "sql" | "ts" }) {
  const source =
    kind === "ts"
      ? 'import type { SeedContext } from "../management";\n\nexport default async function seed(_context: SeedContext): Promise<void> {}\n'
      : "-- INSERT / UPDATE / DELETE; tablo adları schema'sız.\n";
  return createSource("src/seeds", kind, source, options);
}
```
(`SCOPES`, `SEED_PROFILES`, `Scope` içe aktarmaları ve kullanımları silinir; `QUERY_SCOPES` yok.)

`core/sql/README.md`: kapsam klasörü (`src/queries/<tenant|node|platform>/…`), `prepareQuery(source, scope, tables)`, `@repo/db/queries/tenant/auth` ve platform/tenant sözcükleri bekçi tarafından satır satır bildirilir; her biri tek-schema anlamıyla yeniden yazılır: sorgular `src/queries/<area>.sql`, `@repo/db-single/queries/<area>` olarak import edilir, `prepareQuery(source, tables?)`, `@repo/db-single/management` `prepareQuery(source)` paketin kendi migration tablolarını verir. (Ruling: README İngilizce kalır; aynı bölümler.)

İlk üretilmiş listeler:

```bash
bun src/core/sql/codegen.ts && ls src/migrations src/seeds && cat src/migrations/index.gen.ts
```
Expected: iki boş liste modülü (`export default [] as const;`).

- [ ] **Step 6: Kopya testlerin uyarlanması**

- `casing.test.ts`, `sql-read-only.test.ts`: `generate(files, tables)` çağrılarında `new Map([["tenant", tables]])` → doğrudan `tables`; `src/queries/tenant/x.sql` yolları → `src/queries/x.sql`; kapsam argümanları silinir.
- `migration-files.test.ts`: `compileMigrations(scope, list)` → `compileMigrations(list)`; `one(source, scope, id)` yardımcısından kapsam kalkar; `rollbackTargets` içe aktarması `../../core/migrations/registry`; paketin kendi kaydının içeriğini okuyan beklentiler (`tenantMigrations.map(...)`) ve "platform scope"te CONCURRENTLY reddi testi **silinir** (ledger: `Task 6: removed … — registry content / scope rule (R1)`); `createMigration({ scope })`/`createSeed({ profile })` çağrıları yeni imzaya (`createMigration({ name, root, now })`, `createSeed({ name, kind, root, now })`) uyarlanır; yollar `src/migrations/<id>.sql`.

- [ ] **Step 7: Geçiş**

```bash
bun test src/__tests__/unit 2>&1 | tail -10 && bun run typecheck && bun run lint && bun run codegen --check && echo codegen-ok
```
Expected: yeni üç dosya + kopya testler pass; bekçi (README ve kaynaklar dahil), tsc, eslint, `codegen --check` temiz (`codegen-ok`).

- [ ] **Step 8: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: migration/seed sources and registry without scopes or profiles, codegen on the flat layout (queries, migrations, seeds, tables)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Yönetim bağlamı ve tek kilit oturumu

**Files:**
- Create: `core/management.ts`
- Copy+edit: `core/locks.ts` (kaynak: `db-multi/src/core/operations/locks.ts`)
- Test: yeni `unit/management.test.ts`; kopya+uyarlama `unit/session.test.ts`

**Interfaces:**
- Consumes: Task 3 `createPools`/`spanner`/`reportSpan`/`SpanInput`, Task 1 `config`/`identifier`.
- Produces:
  - `management.ts`: `ManagementFactoryOptions extends ManagementOptions { driver: Driver; schema?: string; onSpan?: SpanHandler }`, `createManagement(options)` / `createManagement(config, options)` → `Management = { config: ManagementSettings; driver: Driver; schema: string; pools: Pools; db: Database; close(): Promise<void>; span: ReturnType<typeof spanner>; emit(span: SpanInput): void }`.
  - `locks.ts`: `MIGRATION_KEY = "migration"`, `cancelled()`, `ownershipCheck(signal, ...checks)`, `openSession(m, options?: { applicationName?: string; signal?: AbortSignal })` → `{ db, pid, acquire(key), assertAlive, signal, close, cancel }`, `openManagementSession(m, key, options?)` → oturum + `{ pid, assertOwned, assertAlive, release }`, `SessionOptions`, `Session`. Meşgul kilit: `AppError("MIGRATION_RUNNER_BUSY", "Another migration run is active; retry when it finishes")`.

- [ ] **Step 1: Başarısız testler**

`unit/management.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { fakeDriver } from "../fixtures/fake-driver";

const URL_ = "postgres://admin:secret-pw@127.0.0.1:7100/app";

test("a bad schema is refused before any pool opens", () => {
  const fake = fakeDriver();
  expect(() => createManagement(createConfig(URL_), { driver: fake.driver, schema: "Bad" })).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
  expect(fake.pools).toHaveLength(0);
});

test("the management context holds one primary pool and the schema, defaulting to public", async () => {
  const fake = fakeDriver();
  const m = createManagement(createConfig(URL_), { driver: fake.driver });
  expect(m.schema).toBe("public");
  expect(m.db).toBe(m.pools.primary);
  expect(fake.pools).toHaveLength(1);
  expect(fake.pools[0]?.options.max).toBe(4);
  await m.close();
  expect(fake.pools[0]?.closed).toBe(true);
});

test("management queries run in a transaction with the migration timeouts", async () => {
  const fake = fakeDriver(() => [{ ok: 1 }]);
  const m = createManagement(createConfig(URL_), { driver: fake.driver, schema: "app_x", migrationStatementTimeoutMs: 45000, migrationLockTimeoutMs: 2000 });
  await m.db.query("SELECT 1");
  expect(fake.commands.map((command) => command.text)).toEqual(["BEGIN; SET LOCAL statement_timeout = 45000; SET LOCAL lock_timeout = 2000", "SELECT 1", "COMMIT"]);
  await m.close();
});

test("span reports run work and emit forwards a finished step", async () => {
  const spans: { name: string; detail?: string }[] = [];
  const fake = fakeDriver();
  const m = createManagement(createConfig(URL_), { driver: fake.driver, onSpan: (span) => void spans.push(span) });
  await m.span("migration", async () => {}, { detail: "20260101000001_x" });
  m.emit({ name: "backup", ms: 12 });
  expect(spans.map((span) => [span.name, span.detail])).toEqual([["migration", "20260101000001_x"], ["backup", undefined]]);
  await m.close();
});
```

`unit/session.test.ts` (multi'den kopya, uyarlanmış):

```bash
cp ../db-multi/src/__tests__/unit/session.test.ts src/__tests__/unit/session.test.ts
```
Uyarlama: içe aktarmalar `import { createManagement } from "../../core/management"; import { openSession } from "../../core/locks";`; `createManagement(createConfig([url]), …)` → `createConfig(url)`; `openSession(app, "db0")` → `openSession(app)`; `openSession(app, "db0", { applicationName: "tenant-migration:x" })` → `openSession(app, { applicationName: "migration:x" })` ve beklenen üçüncü parametre `"migration:x"`. Üç testin geri kalanı aynı kalır (havuz dizini 1 oturum havuzudur).

Ek test (aynı dosyanın sonuna):

```ts
test("the migration lock is exclusive per connection and busy for a second holder, and release frees it", async () => {
  // `pg_locks` sorgusu da `pg_backend_pid()` içerir: önce o denetlenir.
  const { app } = management((text, _params, pool) => {
    if (text.includes("pg_locks")) return [{ pid: 301, held: true }];
    if (text.includes("pg_try_advisory_lock")) return [{ locked: true }];
    if (text.includes("pg_advisory_unlock")) return [{ unlocked: true }];
    if (text.includes("pg_backend_pid")) return [{ pid: 300 + pool.index }];
    return [];
  });
  const session = await openSession(app);
  const lock = await session.acquire(MIGRATION_KEY);
  await expect(session.acquire(MIGRATION_KEY)).rejects.toMatchObject({ code: "MIGRATION_RUNNER_BUSY" });
  await lock.release();
  await session.acquire(MIGRATION_KEY);
  await session.close();
  await app.close();
});
```
(import satırına `MIGRATION_KEY` eklenir.)

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single && bun test src/__tests__/unit/{management,session}.test.ts 2>&1 | tail -8
```
Expected: `core/management`, `core/locks` yok → **fail**.

- [ ] **Step 3: `management.ts`**

`packages/db-single/src/core/management.ts`:

```ts
/** Yönetim bağlamı: doğrudan bağlantı havuzu (her iş `SET LOCAL` zaman aşımlarıyla transaction'da) ve schema. İşlemler bu bağlamı alan düz
 * fonksiyonlardır (`@repo/db-single/management`: `src/management.ts`). */
import { type Config, loadConfig, type ManagementOptions, managementSettings } from "./config";
import { createPools, reportSpan, type SpanHandler, type SpanInput, spanner } from "./database";
import type { Driver } from "./driver";
import { DEFAULT_SCHEMA, validateSchema } from "./identifier";

/** Bir çalıştırma tek kilit oturumu ve birkaç yan sorgu kullanır. */
const MANAGEMENT_POOL_MAX = 4;
const MANAGEMENT_MAX_PENDING = 64;

export interface ManagementFactoryOptions extends ManagementOptions {
  driver: Driver;
  /** Migration ve seed'lerin hedef schema'sı; verilmezse `public`. */
  schema?: string;
  /** Ölçüm: işlem adımları (`migration`, `seed`, `backup`) ve sorgu süreleri. */
  onSpan?: SpanHandler;
}

/** `DATABASE_URLS` doğrudan (veya session pooling) bağlantı olmalı; kilit oturumu açılırken doğrulanır. */
function openManagement(input: Config, { driver, schema = DEFAULT_SCHEMA, onSpan, ...options }: ManagementFactoryOptions) {
  validateSchema(schema);
  const config = managementSettings(input, options);
  const pools = createPools(config, driver, MANAGEMENT_POOL_MAX, {
    deadlineMs: config.migrationStatementTimeoutMs,
    timeouts: { statementTimeoutMs: config.migrationStatementTimeoutMs, lockTimeoutMs: config.migrationLockTimeoutMs },
    maxPending: MANAGEMENT_MAX_PENDING,
    onSpan,
  });
  return {
    config,
    driver,
    schema,
    pools,
    db: pools.primary,
    close: pools.close,
    span: spanner(onSpan),
    emit: (span: SpanInput) => onSpan && reportSpan(onSpan, { startTime: Date.now() - span.ms, ...span }),
  };
}
export type Management = ReturnType<typeof openManagement>;

/** Yönetim bağlamı (doğrudan bağlantı). Config verilmezse `DATABASE_URLS` okunur: `createManagement({ driver: bunDriver })`. */
export function createManagement(options: ManagementFactoryOptions): Management;
export function createManagement(config: Config, options: ManagementFactoryOptions): Management;
export function createManagement(configOrOptions: Config | ManagementFactoryOptions, options?: ManagementFactoryOptions): Management {
  return "url" in configOrOptions ? openManagement(configOrOptions, options as ManagementFactoryOptions) : openManagement(loadConfig(), configOrOptions);
}
```

- [ ] **Step 4: `locks.ts`**

```bash
cp ../db-multi/src/core/operations/locks.ts src/core/locks.ts
```
Düzenlemeler (Edit, sırayla):

1. İçe aktarmalar (dosya `core/` altına taşındı):

```ts
import { type Connection, type Driver, type Pool, type Reserved, runInTransaction } from "./driver";
import { AppError, databaseUnavailable } from "./errors";
import type { Management } from "./management";
```
2. `RUNNER_KEY`, `tenantOperationKey`, `tenantManagementKey` sabitlerini silin; yerine:

```ts
/** Tek advisory lock anahtarı: aynı anda en fazla bir migration/seed/baseline çalışması. */
export const MIGRATION_KEY = "migration";
```
3. `busyErrorFor` yerine:

```ts
const busy = () => new AppError("MIGRATION_RUNNER_BUSY", "Another migration run is active; retry when it finishes");
```
ve `acquireAdvisoryLock` içindeki iki `busyErrorFor(key)` kullanımı `busy()` olur.
4. `openSession` imzası ve gövdesi:

```ts
export async function openSession(m: Management, options: SessionOptions = {}) {
  const { url } = m.config;
```
`m.pools.node(databaseId).pool.query("SELECT pg_cancel_backend($1)", [pid])` → `m.pools.primary.pool.query("SELECT pg_cancel_backend($1)", [pid])`; `options.applicationName ?? "tenant-management"` → `options.applicationName ?? "migration"`.
5. `openManagementSession(m, key, options)` (databaseId parametresi yok):

```ts
export async function openManagementSession(m: Management, key: string, options: SessionOptions = {}) {
  const session = await openSession(m, options);
  try {
    return { ...session, ...(await session.acquire(key)) };
  } catch (error) {
    await session.close();
    throw error;
  }
}
```
6. `afterGrace`, `LockedWork`, `withTenantLock`, `withNodeLocks` ve `PLATFORM_DATABASE_ID` içe aktarması silinir. `ownershipCheck`, `cancelled`, `Session`, `SessionOptions` kalır.

- [ ] **Step 5: Geçiş**

```bash
bun test src/__tests__/unit 2>&1 | tail -8 && bun run typecheck && bun run lint
```
Expected: `management` 4, `session` 4 test pass; tümü yeşil, bekçi temiz.

- [ ] **Step 6: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: management context and the single migration lock session

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Yalıtılmış compose, entegrasyon yardımcıları ve `createDb` gerçek PostgreSQL duman testi

**Files:**
- Create: `compose.yaml`, `src/__tests__/integration/{helpers.ts,leak-guard.ts,database.test.ts}`; `src/core/catalog.ts`
- Modify: `src/core/local/pgbouncer/pgbouncer.ini`
- Local (izlenmez): `packages/db-single/.env`

**Interfaces:**
- Consumes: Task 1–7 modülleri.
- Produces (`integration/helpers.ts`): `enabled`, `integration` (`test`/`test.skip`), `drivers`, `driver`, `managementDriver`, `directConfig()`, `pooledConfig()`, `createTestManagement(options?, config?)`, `raw(url?, max?)`, `q(schema, name?)`, `testSchema()`, `dropSchema(db, schema)`, `failure(promise)`; `catalog.ts`: `schemaExists(db, name)`.

- [ ] **Step 1: Portlar ve yerel ortam**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single
for p in 5560 5563 5489 5565 5566; do lsof -nP -iTCP:$p -sTCP:LISTEN | sed "s/^/port $p: /"; done
cp .env.example .env
```
Expected: hiç `port …` satırı yok. **Satır varsa DURUN ve kullanıcıya sorun** (bu planın portları başka bir şey tarafından tutuluyor).

- [ ] **Step 2: `compose.yaml` ve PgBouncer yapılandırması**

`packages/db-single/compose.yaml`:

```yaml
# Yalıtılmış yerel altyapı (proje adı: dbsingle). postgres: doğrudan bağlantı (yönetim, CLI, testler); pgbouncer: transaction pooling
# (runtime testleri); wsproxy: yalnızca Neon sürücüsü testi; postgres-rp/postgres-rp-replica: replica testleri (akış replikasyonu).
services:
  postgres:
    image: postgres:16.15-alpine
    environment: {POSTGRES_DB: app, POSTGRES_USER: admin, POSTGRES_PASSWORD: local_admin_password}
    ports: ['127.0.0.1:5560:5432']
    volumes: ['postgres:/var/lib/postgresql/data']
    healthcheck: {test: ['CMD-SHELL', 'pg_isready -U admin -d app'], interval: 2s, timeout: 2s, retries: 30}
  pgbouncer:
    build: ./src/core/local/pgbouncer
    ports: ['127.0.0.1:5563:5432']
    volumes:
      - './src/core/local/pgbouncer/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro'
      - './src/core/local/pgbouncer/userlist.txt:/etc/pgbouncer/userlist.txt:ro'
    depends_on: {postgres: {condition: service_healthy}}
    healthcheck: {test: ['CMD-SHELL', 'nc -z 127.0.0.1 5432'], interval: 2s, timeout: 2s, retries: 30}
  # Yalnızca yerel test: Neon sürücüsü (WebSocket) ana makinenin Postgres/PgBouncer portlarına bu proxy üzerinden bağlanır.
  wsproxy:
    image: ghcr.io/neondatabase/wsproxy@sha256:7f2e2149aa6a57ba382a140102fba44f5053f3e44389ccc18adcecf896054efb
    environment: {ALLOW_ADDR_REGEX: '.*'}
    extra_hosts: ['host.docker.internal:host-gateway']
    ports: ['127.0.0.1:5489:80']
  # Yalnızca replica testleri: akış replikasyonlu primary/replica çifti (postgres'ten bağımsız).
  postgres-rp:
    image: postgres:16.15-alpine
    environment: {POSTGRES_DB: app, POSTGRES_USER: admin, POSTGRES_PASSWORD: local_admin_password}
    ports: ['127.0.0.1:5565:5432']
    volumes:
      - 'postgresrp:/var/lib/postgresql/data'
      - './src/core/local/replica/allow-replication.sh:/docker-entrypoint-initdb.d/allow-replication.sh:ro'
    healthcheck: {test: ['CMD-SHELL', 'pg_isready -U admin -d app'], interval: 2s, timeout: 2s, retries: 30}
  postgres-rp-replica:
    image: postgres:16.15-alpine
    entrypoint: ['sh', '/replica-entrypoint.sh']
    ports: ['127.0.0.1:5566:5432']
    volumes:
      - 'postgresrpreplica:/var/lib/postgresql/data'
      - './src/core/local/replica/replica-entrypoint.sh:/replica-entrypoint.sh:ro'
    depends_on: {postgres-rp: {condition: service_healthy}}
    healthcheck: {test: ['CMD-SHELL', 'pg_isready -U admin -d app'], interval: 2s, timeout: 2s, retries: 30}
volumes:
  postgres:
  postgresrp:
  postgresrpreplica:
```

`src/core/local/pgbouncer/pgbouncer.ini` içinde `[databases]` bölümü şu olur (diğer bölümler aynı):

```ini
[databases]
app = host=postgres port=5432 dbname=app
```

- [ ] **Step 3: `catalog.ts` ve yardımcılar**

`packages/db-single/src/core/catalog.ts`:

```ts
/** Katalog okuması: schema durumu. */
import type { Connection } from "./driver";

/** Bu DB'de `name` schema'sı var mı. */
export async function schemaExists(db: Pick<Connection, "query">, name: string): Promise<boolean> {
  const [row] = await db.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1) AS exists", [name]);
  return !!row?.exists;
}
```

`src/__tests__/integration/helpers.ts`:

```ts
/** Entegrasyon yardımcıları. Belgelenen tek env `DATABASE_URLS` (doğrudan URL); testler ayrıca `DB_DRIVER=bun|postgres|pg|neon`
 * ve isteğe bağlı `TEST_POOLED_URLS` (PgBouncer transaction pooling; yoksa yerel compose) okur. */
import { expect, test } from "bun:test";
import { neonConfig } from "@neondatabase/serverless";
import { type Config, createConfig, loadConfig } from "../../core/config";
import { connect, type Database } from "../../core/database";
import type { Driver } from "../../core/driver";
import { bunDriver } from "../../core/drivers/bun";
import { neonDriver } from "../../core/drivers/neon";
import { pgDriver } from "../../core/drivers/pg";
import { postgresDriver } from "../../core/drivers/postgres";
import { errorCode } from "../../core/errors";
import { quoteIdentifier } from "../../core/identifier";
import { createManagement, type ManagementFactoryOptions } from "../../core/management";

export const enabled = process.env.RUN_INTEGRATION === "1";
export const integration = enabled ? test : test.skip;

// Yerel wsproxy (compose `wsproxy`): Neon istemcisi `host:port` yerine yerel proxy'ye WebSocket açar; proxy ana makinenin Postgres/PgBouncer
// portlarına iletir. Gerçek Neon'a karşı çalışma `verify:provider --driver neon`'dur.
neonConfig.useSecureWebSocket = false;
neonConfig.pipelineConnect = false;
neonConfig.wsProxy = (host, port) => `127.0.0.1:5489/v1?address=${["127.0.0.1", "localhost"].includes(host) ? "host.docker.internal" : host}:${port}`;

export const drivers: Record<string, Driver> = { bun: bunDriver, postgres: postgresDriver, pg: pgDriver, neon: neonDriver };
const name = process.env.DB_DRIVER ?? "bun";
if (!drivers[name]) throw new Error(`Unknown DB_DRIVER: ${name}`);
export const driver = drivers[name] as Driver;
/** Yönetim (advisory lock) Neon'da çalışmaz: Neon seçiliyken Bun SQL kullanılır. */
export const managementDriver = name === "neon" ? bunDriver : driver;

/** Doğrudan URL (yönetim ve fikstürler). */
export const directConfig = (): Config => loadConfig();
/** Transaction-pooled URL (aynı DB, aynı kimlik bilgileri): runtime testleri. */
export const pooledConfig = (): Config => createConfig(process.env.TEST_POOLED_URLS ?? "postgres://admin:local_admin_password@127.0.0.1:5563/app");

export const createTestManagement = (options: Partial<ManagementFactoryOptions> = {}, config: Config = directConfig()) =>
  createManagement(config, { driver: managementDriver, ...options });

/** Kendi küçük havuzu olan fikstür bağlantısı (varsayılan: doğrudan URL). */
export function raw(url = directConfig().url, max = 2): Database {
  return connect(driver(url, { max, idleTimeoutSeconds: 60, maxLifetimeSeconds: 600, connectTimeoutSeconds: 10 }), {
    deadlineMs: 60000,
    timeouts: { statementTimeoutMs: 60000, lockTimeoutMs: 10000 },
    maxPending: 256,
  });
}

/** `"schema"` or `"schema"."name"`. */
export const q = (schema: string, name?: string) => (name === undefined ? quoteIdentifier(schema) : `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`);

/** Her test kendi schema'sını kurar ve siler (`leak-guard.ts` kalanı yakalar). */
export const testSchema = () => `app_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
export const dropSchema = (db: Pick<Database, "exec">, schema: string) => db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);

/** Driver-independent failure code of a promise that must reject. */
export async function failure(promise: Promise<unknown>) {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => errorCode(error),
  );
  expect(outcome).toBeDefined();
  return outcome;
}
```

`src/__tests__/integration/leak-guard.ts`:

```ts
/** `test:integration` preload'u: süit paylaşılan DB'de iz bırakmaz. Başta schema, veritabanı ve `public` ilişki adlarının anlık görüntüsü
 * alınır; sonda yeni kalan her ad listelenir ve koşu başarısız olur. */
import { afterAll, beforeAll } from "bun:test";
import { createTestManagement, enabled } from "./helpers";

type Snapshot = Record<string, string[]>;
let before: Snapshot | undefined;

async function snapshot(): Promise<Snapshot> {
  const m = createTestManagement();
  try {
    const names = async (sql: string) => (await m.db.query<{ name: string }>(sql)).map((row) => row.name);
    return {
      schemas: await names("SELECT nspname AS name FROM pg_catalog.pg_namespace"),
      databases: await names("SELECT datname AS name FROM pg_catalog.pg_database"),
      "public relations": await names("SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'"),
    };
  } finally {
    await m.close();
  }
}

beforeAll(async () => {
  if (enabled) before = await snapshot();
});

afterAll(async () => {
  if (!before) return;
  const after = await snapshot();
  const leaks = Object.entries(after).flatMap(([what, names]) => {
    const known = new Set(before?.[what]);
    const added = names.filter((name) => !known.has(name)).sort();
    return added.length ? [`${what}: ${added.join(", ")}`] : [];
  });
  if (leaks.length) throw new Error(`Integration tests left objects behind in the shared database:\n${leaks.join("\n")}`);
});
```

- [ ] **Step 4: Başarısız duman testi**

`src/__tests__/integration/database.test.ts`:

```ts
import { expect } from "bun:test";
import { schemaExists } from "../../core/catalog";
import { createDb } from "../../core/runtime";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { directConfig, driver, dropSchema, failure, integration, pooledConfig, q, raw, testSchema } from "./helpers";

const insert = prepareQuery("INSERT INTO notes (id, body) VALUES ($1::integer, $2::text)");
const list = prepareQuery("SELECT id, body FROM notes ORDER BY id");

/** Her test kendi schema'sında bir `notes` tablosu kurar; iş bitince schema silinir. */
async function withNotes(work: (schema: string) => Promise<void>) {
  const admin = raw();
  const schema = testSchema();
  try {
    await admin.exec(`CREATE SCHEMA ${q(schema)}`);
    for (const sql of prepareMigration("CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL)").bind(schema)) await admin.exec(sql);
    await work(schema);
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
  }
}

integration("createDb runs prepared queries, transactions and reads through the pooler", async () => {
  await withNotes(async (schema) => {
    const db = createDb(pooledConfig(), { driver, schema });
    try {
      await db.ready();
      await db.query(insert, [1, "a"]);
      await db.transaction(async (tx) => void (await tx.query(insert, [2, "b"])));
      expect(await db.query(list)).toEqual([{ id: 1, body: "a" }, { id: 2, body: "b" }]);
      await failure(
        db.transaction(async (tx) => {
          await tx.query(insert, [3, "c"]);
          throw new Error("abort");
        }),
      );
      expect(await db.query(list)).toHaveLength(2);
      // Replica yapılandırılmadı: okuma birincilde `READ ONLY` transaction'da çalışır.
      expect(await db.read.query(list)).toHaveLength(2);
      expect(await failure(db.read.query(insert as never, [9, "x"]))).toBe("QUERY_NOT_READ_ONLY");
    } finally {
      await db.close();
    }
  });
});

integration("ready() refuses a direct URL with POOLER_REQUIRED unless the pooler is assumed", async () => {
  const strict = createDb(directConfig(), { driver });
  try {
    expect(await failure(strict.ready())).toBe("POOLER_REQUIRED");
  } finally {
    await strict.close();
  }
  const assumed = createDb(directConfig(), { driver, pooler: "assumed" });
  try {
    await assumed.ready();
  } finally {
    await assumed.close();
  }
});

integration("the default schema is public and a public table the package did not create stays untouched", async () => {
  const admin = raw();
  const table = `single_default_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const select = prepareQuery(`SELECT count(*)::integer AS n FROM ${table}`);
  try {
    await admin.exec(`CREATE TABLE public.${table} (id integer)`);
    await admin.exec(`INSERT INTO public.${table} VALUES (1), (2)`);
    const db = createDb(pooledConfig(), { driver });
    try {
      expect(await db.query(select)).toEqual([{ n: 2 }]);
      expect(db.schema).toBe("public");
    } finally {
      await db.close();
    }
  } finally {
    await admin.exec(`DROP TABLE IF EXISTS public.${table}`);
    await admin.close();
  }
});

integration("schemaExists tells a missing schema from an existing one", async () => {
  const admin = raw();
  try {
    expect(await schemaExists(admin, "public")).toBe(true);
    expect(await schemaExists(admin, testSchema())).toBe(false);
  } finally {
    await admin.close();
  }
});
```

- [ ] **Step 5: Altyapıyı kur, başarısızlığı (veya ilk yeşili) gör**

`catalog.ts` bu adımda zaten yazıldı (Step 3); `createDb` Task 5'ten gelir. Bu görev altyapı görevidir: "kırmızı" aşaması Step 1'in port denetimi ve altyapı yokken testlerin `RUN_INTEGRATION=1` ile bağlanamamasıdır.

```bash
RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/database.test.ts 2>&1 | tail -6
```
Expected: bağlantı hatası (**fail**: `ECONNREFUSED`/`CONNECTION_CLOSED`), çünkü compose henüz çalışmıyor.

```bash
docker compose -p dbsingle up -d --build --wait postgres pgbouncer wsproxy postgres-rp postgres-rp-replica
bun run test:integration 2>&1 | tail -8
```
Expected: `database.test.ts` 4 test **pass**; `leak-guard` afterAll hata vermez; `docker ps --format '{{.Names}}' | grep dbsingle` altı konteyner değil, beş servis gösterir (`postgres`, `pgbouncer`, `wsproxy`, `postgres-rp`, `postgres-rp-replica`).

Aynı testleri üç sürücüde de koşun (`wsproxy` ve doğrudan portlar açık):

```bash
for d in postgres pg neon; do DB_DRIVER=$d bun run test:integration 2>&1 | tail -3; done
```
Expected: her biri `4 pass`. (Neon yalnızca `createDb` ile pooled URL'ye bağlanır; `managementDriver` Bun'dur.)

- [ ] **Step 6: Commit** (altyapı ayakta kalır; Task 9/10 kullanır)

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: isolated compose project (dbsingle), integration helpers, leak guard and createDb smoke tests on four drivers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Migration çalıştırıcısı (TDD, gerçek PostgreSQL)

**Files:**
- Create: `core/migrations/runner.ts`
- Test: yeni `integration/migrations.test.ts`

**Interfaces:**
- Consumes: Task 6 `Registry`/`pendingIn`/`createLedger`/`rollbackTargets`/`RollbackTarget`, Task 7 `Management`/`openManagementSession`/`MIGRATION_KEY`/`ownershipCheck`/`cancelled`, Task 8 `schemaExists`, Task 1 `runtimeDatabaseDefaults`/`qualified`/`quoteIdentifier`.
- Produces (`runner.ts`): `Report`, `noReport`, `RunOptions { dryRun?; signal?; report? }`, `createRunner(registry: Registry)` → `{ migrate(m, options?): Promise<{ dryRun: boolean; migrations: string[] }>; rollback(m, options?: RunOptions & RollbackTarget): Promise<{ dryRun; migrations: string[] }>; baseline(m, migrationId, options?: Pick<RunOptions, "signal">): Promise<{ migrations: string[] }>; migrationStatus(m): Promise<{ schema; applied: number; pending: { id: string; transactional: boolean }[] }>; seed(m, options?): Promise<{ dryRun; seeds: string[] }> }`. Hata kodları: `MIGRATION_DRIFT`, `SEED_DRIFT`, `MIGRATION_NOT_PENDING`, `MIGRATION_NOT_APPLIED`, `MIGRATION_IRREVERSIBLE`, `MIGRATIONS_PENDING`, `SCHEMA_MISMATCH`, `MIGRATION_INDEX_INVALID`, `MIGRATION_RUNNER_BUSY`, `MIGRATION_CANCELLED`, `LOCK_LOST`.

- [ ] **Step 1: Başarısız entegrasyon testleri**

`src/__tests__/integration/migrations.test.ts`:

```ts
import { expect } from "bun:test";
import { schemaExists } from "../../core/catalog";
import { runtimeDatabaseDefaults } from "../../core/config";
import type { Database } from "../../core/database";
import { MIGRATION_KEY, openManagementSession } from "../../core/locks";
import type { Management } from "../../core/management";
import { createRunner } from "../../core/migrations/runner";
import { compileMigrations, compileSeeds } from "../../core/migrations/source";
import { prepareQuery } from "../../core/sql/compiler";
import { createTestManagement, dropSchema, failure, integration, q, raw, testSchema } from "./helpers";

const IDS = ["20260101000001_users", "20260101000002_posts", "20260101000003_posts_user_idx"];
const migrations = compileMigrations([
  [IDS[0] as string, "--up\nCREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL);\n--down\nDROP TABLE users;\n"],
  [IDS[1] as string, "--up\nCREATE TABLE posts (id integer PRIMARY KEY, user_id integer NOT NULL REFERENCES users (id));\n--down\nDROP TABLE posts;\n"],
  [IDS[2] as string, "--up\nCREATE INDEX CONCURRENTLY posts_user_idx ON posts (user_id);\n--down\nDROP INDEX CONCURRENTLY posts_user_idx;\n"],
]);
const SEED = "20260101000004_first_user";
const seeds = compileSeeds([[SEED, "INSERT INTO users (id, name) VALUES (1, 'Ada');"]]);
const runner = createRunner({ migrations, seeds });

async function withManagement(work: (m: Management, schema: string, admin: Database) => Promise<void>) {
  const schema = testSchema();
  const admin = raw();
  const m = createTestManagement({ schema });
  try {
    await work(m, schema, admin);
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
  }
}
const rows = (admin: Database, schema: string, table: string) => admin.query<{ id: string }>(`SELECT id FROM ${q(schema, table)} ORDER BY id`);
const regclass = async (admin: Database, name: string) => (await admin.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [name]))[0]?.ok;

integration("migrate creates the schema, applies pending migrations in order, and a second run applies none", async () => {
  await withManagement(async (m, schema, admin) => {
    expect(await schemaExists(admin, schema)).toBe(false);
    expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: IDS });
    expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS);
    expect(await regclass(admin, `${q(schema)}.posts`)).toBe(true);
    const [index] = await admin.query<{ valid: boolean }>("SELECT indisvalid AS valid FROM pg_catalog.pg_index WHERE indexrelid = to_regclass($1)", [`${q(schema)}.posts_user_idx`]);
    expect(index?.valid).toBe(true);
    expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: [] });
  });
});

integration("a dry run lists what would run and creates nothing", async () => {
  await withManagement(async (m, schema, admin) => {
    expect(await runner.migrate(m, { dryRun: true })).toEqual({ dryRun: true, migrations: IDS });
    expect(await schemaExists(admin, schema)).toBe(false);
  });
});

integration("status reports applied count and which pending migrations are transactional", async () => {
  await withManagement(async (m, schema) => {
    expect(await runner.migrationStatus(m)).toEqual({
      schema,
      applied: 0,
      pending: [
        { id: IDS[0], transactional: true },
        { id: IDS[1], transactional: true },
        { id: IDS[2], transactional: false },
      ],
    });
    await runner.migrate(m);
    expect((await runner.migrationStatus(m)).pending).toEqual([]);
  });
});

integration("migrate writes the runtime timeouts as database defaults", async () => {
  await withManagement(async (m, _schema, admin) => {
    await runner.migrate(m);
    const [stored] = await admin.query<{ settings: string }>(
      "SELECT pg_catalog.array_to_string(setconfig, ',') AS settings FROM pg_catalog.pg_db_role_setting WHERE setrole=0 AND setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())",
    );
    for (const setting of runtimeDatabaseDefaults(m.config)) expect(stored?.settings.split(",")).toContain(setting);
  });
});

integration("rollback undoes the newest migrations by steps or to, and refuses impossible targets", async () => {
  await withManagement(async (m, schema, admin) => {
    await runner.migrate(m);
    expect(await runner.rollback(m, { dryRun: true })).toEqual({ dryRun: true, migrations: [IDS[2]] });
    expect(await runner.rollback(m)).toEqual({ dryRun: false, migrations: [IDS[2]] });
    expect(await regclass(admin, `${q(schema)}.posts_user_idx`)).toBe(false);
    expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS.slice(0, 2));
    expect(await runner.rollback(m, { to: IDS[0] })).toEqual({ dryRun: false, migrations: [IDS[1]] });
    expect(await failure(runner.rollback(m, { steps: 2 }))).toBe("USAGE");
    expect(await failure(runner.rollback(m, { to: "20260101000009_nope" }))).toBe("MIGRATION_NOT_APPLIED");
    expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: IDS.slice(1) });
  });
});

integration("a migration without a --down section cannot be rolled back", async () => {
  await withManagement(async (m) => {
    const irreversible = createRunner({ migrations: compileMigrations([["20260101000001_t", "--up\nCREATE TABLE t (id integer PRIMARY KEY);\n--down\n"]]), seeds: [] });
    await irreversible.migrate(m);
    expect(await failure(irreversible.rollback(m))).toBe("MIGRATION_IRREVERSIBLE");
  });
});

integration("an edited migration is drift, never silently re-applied or skipped", async () => {
  await withManagement(async (m, schema, admin) => {
    await runner.migrate(m);
    await admin.query(`UPDATE ${q(schema, "_migrations")} SET checksum='edited' WHERE id=$1`, [IDS[0]]);
    expect(await failure(runner.migrate(m))).toBe("MIGRATION_DRIFT");
    expect(await failure(runner.migrationStatus(m))).toBe("MIGRATION_DRIFT");
  });
});

integration("a failing migration rolls its DDL and ledger row back and stops the chain", async () => {
  await withManagement(async (m, schema, admin) => {
    const broken = createRunner({
      migrations: compileMigrations([
        ["20260101000001_ok", "--up\nCREATE TABLE ok (id integer PRIMARY KEY);\n--down\nDROP TABLE ok;\n"],
        ["20260101000002_bad", "--up\nCREATE TABLE b (id integer PRIMARY KEY);\nCREATE TABLE b (id integer);\n--down\nDROP TABLE b;\n"],
      ]),
      seeds: [],
    });
    expect(await failure(broken.migrate(m))).toBe("42P07");
    expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(["20260101000001_ok"]);
    expect(await regclass(admin, `${q(schema)}.b`)).toBe(false);
  });
});

integration("a second run while the migration lock is held is MIGRATION_RUNNER_BUSY, and works once it is released", async () => {
  await withManagement(async (m) => {
    const held = await openManagementSession(m, MIGRATION_KEY);
    try {
      expect(await failure(runner.migrate(m))).toBe("MIGRATION_RUNNER_BUSY");
      expect(await failure(runner.rollback(m))).toBe("MIGRATION_RUNNER_BUSY");
    } finally {
      await held.release();
      await held.close();
    }
    expect((await runner.migrate(m)).migrations).toEqual(IDS);
  });
});

integration("baseline marks migrations applied without running them, only when the live schema already has their objects", async () => {
  await withManagement(async (m, schema, admin) => {
    await admin.exec(`CREATE SCHEMA ${q(schema)}`);
    for (const migration of migrations.slice(0, 2)) for (const sql of migration.up.bind(schema)) await admin.exec(sql);
    expect(await runner.baseline(m, IDS[1] as string)).toEqual({ migrations: IDS.slice(0, 2) });
    expect((await rows(admin, schema, "_migrations")).map((row) => row.id)).toEqual(IDS.slice(0, 2));
    expect(await runner.migrate(m)).toEqual({ dryRun: false, migrations: [IDS[2]] });
    expect(await failure(runner.baseline(m, IDS[0] as string))).toBe("MIGRATION_NOT_PENDING");
  });
  await withManagement(async (m, schema, admin) => {
    await admin.exec(`CREATE SCHEMA ${q(schema)}`);
    await admin.exec(`CREATE TABLE ${q(schema, "users")} (id integer PRIMARY KEY)`);
    expect(await failure(runner.baseline(m, IDS[0] as string))).toBe("SCHEMA_MISMATCH");
    expect(await regclass(admin, `${q(schema)}._migrations`)).toBe(true);
    expect((await rows(admin, schema, "_migrations")).length).toBe(0);
  });
});

integration("seeds need current migrations, run once, and an edited seed is SEED_DRIFT", async () => {
  await withManagement(async (m, schema, admin) => {
    expect(await failure(runner.seed(m))).toBe("MIGRATIONS_PENDING");
    await runner.migrate(m);
    expect(await runner.seed(m, { dryRun: true })).toEqual({ dryRun: true, seeds: [SEED] });
    expect(await runner.seed(m)).toEqual({ dryRun: false, seeds: [SEED] });
    expect(await admin.query(`SELECT name FROM ${q(schema, "users")}`)).toEqual([{ name: "Ada" }]);
    expect(await runner.seed(m)).toEqual({ dryRun: false, seeds: [] });
    await admin.query(`UPDATE ${q(schema, "_seeds")} SET checksum='edited' WHERE id=$1`, [SEED]);
    expect(await failure(runner.seed(m))).toBe("SEED_DRIFT");
  });
});

integration("a TypeScript seed gets a schema-bound context and its own transaction", async () => {
  await withManagement(async (m, schema, admin) => {
    const insertUser = prepareQuery("INSERT INTO users (id, name) VALUES ($1::integer, $2::text)");
    const typed = createRunner({
      migrations,
      seeds: compileSeeds([["20260101000005_ts", { checksum: "ts-1", run: async ({ query, schema: bound }) => void (await query(insertUser, [7, `in-${bound === schema}`])) }]]),
    });
    await typed.migrate(m);
    await typed.seed(m);
    expect(await admin.query(`SELECT id, name FROM ${q(schema, "users")}`)).toEqual([{ id: 7, name: "in-true" }]);
  });
});

integration("an aborted signal stops before taking the lock", async () => {
  await withManagement(async (m) => {
    const controller = new AbortController();
    controller.abort();
    expect(await failure(runner.migrate(m, { signal: controller.signal }))).toBe("MIGRATION_CANCELLED");
  });
});
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single
RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/migrations.test.ts 2>&1 | tail -6
```
Expected: `Cannot find module '../../core/migrations/runner'` → **fail**.

- [ ] **Step 3: `runner.ts`**

`packages/db-single/src/core/migrations/runner.ts`:

```ts
/** Tek schema'nın migration ve seed zinciri: ileri, geri alma, baseline, durum. Tek advisory lock aynı anda iki çalıştırmayı önler; her
 * adım yeniden denenebilir (DDL transaction'da, CONCURRENTLY index idempotent), bu yüzden kalıcı marker ya da kurtarma komutu yoktur. */
import { schemaExists } from "../catalog";
import { runtimeDatabaseDefaults } from "../config";
import type { Connection } from "../driver";
import { AppError, errorCode } from "../errors";
import { qualified, quoteIdentifier } from "../identifier";
import { cancelled, MIGRATION_KEY, openManagementSession, ownershipCheck } from "../locks";
import type { Management } from "../management";
import { foldTables } from "../sql/tables";
import { createLedger, type Migration, pendingIn, type Registry, type RollbackTarget, rollbackTargets, type Seed } from "./registry";

type Verify = () => Promise<void>;
/** İlerleme olayları (JSON'a çevrilebilir düz nesneler); CLI bunları yazdırır. */
export type Report = (event: Record<string, unknown>) => void;
export const noReport: Report = () => {};
export interface RunOptions {
  /** Yalnızca ledger okur; kilit, oturum veya yazma yok. */
  dryRun?: boolean;
  signal?: AbortSignal;
  report?: Report;
}
/** Kilit tutan oturumun bağlantısı: transaction'lar oturumun kendi zaman aşımlarını kullanır. */
type SessionConnection = Connection & { transaction<T>(work: (tx: Connection) => Promise<T>): Promise<T> };

/** `work`'ü tek oturum transaction'ında, CONCURRENTLY index DDL'i için ise doğrudan oturumda çalıştırır. */
const runStep = (session: SessionConnection, outsideTransaction: boolean, work: (db: Connection) => Promise<void>) =>
  outsideTransaction ? work(session) : session.transaction(work);

/** Bağlanmış her deyimi, her birinden önce sahipliği doğrulayarak çalıştırır. */
async function execute(db: Connection, statements: readonly string[], verify: Verify) {
  for (const statement of statements) {
    await verify();
    await db.exec(statement);
  }
}

async function indexState(db: Connection, schema: string, name: string) {
  const [index] = await db.query<{ valid: boolean; is_unique: boolean; relation: string }>(
    "SELECT i.indisvalid AS valid,i.indisunique AS is_unique,c.relname AS relation FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE i.indexrelid=to_regclass($1)",
    [qualified(schema, name)],
  );
  return index;
}

/** CREATE INDEX CONCURRENTLY: aynı tablo ve teklikteki geçerli index kabul edilir, geçersizi yeniden kurulur, diğerleri reddedilir. */
async function applyConcurrentIndex(db: Connection, schema: string, migration: Migration, verify: Verify) {
  const { name, table, unique } = migration.concurrentIndex as NonNullable<Migration["concurrentIndex"]>;
  const existing = await indexState(db, schema, name);
  if (existing) {
    if (existing.relation !== table || existing.is_unique !== unique) throw new AppError("MIGRATION_DRIFT", "Concurrent index definition mismatch");
    if (existing.valid) return;
    await verify();
    await db.exec(`DROP INDEX CONCURRENTLY ${qualified(schema, name)}`);
  }
  await execute(db, migration.up.bind(schema), verify);
  await verify();
  if (!(await indexState(db, schema, name))?.valid) throw new AppError("MIGRATION_INDEX_INVALID", "Concurrent index is invalid");
}

/** Her öğe için `work`; `{ [key]: id, direction }` ile started/succeeded/failed raporlanır. Tamamlanan ID'leri döndürür. */
async function each<T extends { id: string }>(items: readonly T[], key: "migration" | "seed", direction: string, verify: Verify, report: Report, work: (item: T) => Promise<void>) {
  const done: string[] = [];
  for (const item of items) {
    await verify();
    const start = Date.now();
    const event = { [key]: item.id, direction };
    report({ ...event, status: "started" });
    try {
      await work(item);
    } catch (error) {
      report({ ...event, status: "failed", durationMs: Date.now() - start, error: errorCode(error) });
      throw error;
    }
    done.push(item.id);
    report({ ...event, status: "succeeded", durationMs: Date.now() - start });
  }
  return done;
}

/** Katlanmış DDL'in tanımladığı ama canlı schema'da olmayan sütunlar (`tablo.sütun`) ve enum'lar (`type ad`). */
async function missingSchemaObjects(db: Connection, schema: string, expected: ReturnType<typeof foldTables>) {
  const rows = await db.query<{ name: string }>(
    "SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema=$1 UNION ALL SELECT 'type ' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typtype='e'",
    [schema],
  );
  const live = new Set(rows.map((row) => row.name));
  return [
    ...[...expected.tables].flatMap(([table, columns]) => columns.map((column) => `${table}.${column.name}`)),
    ...[...expected.enums.keys()].map((name) => `type ${name}`),
  ].filter((name) => !live.has(name));
}

/** Schema yoksa kurulur (varsa `CREATE SCHEMA` çalışmaz: `public` için yetki gerekmez); runtime timeout'ları veritabanı varsayılanı olarak
 * yazılır (yeni backend'ler her pooler arkasında alır, mevcutlar yeniden bağlanınca). */
async function prepare(m: Management, db: Connection, verify: Verify) {
  await verify();
  if (!(await schemaExists(db, m.schema))) await db.exec(`CREATE SCHEMA ${quoteIdentifier(m.schema)}`);
  const [database] = await db.query<{ name: string }>("SELECT pg_catalog.current_database() AS name");
  for (const setting of runtimeDatabaseDefaults(m.config)) await db.exec(`ALTER DATABASE ${quoteIdentifier(database?.name ?? "")} SET ${setting.replace("=", " = ")}`);
}

/** Tek migration: DDL ve ledger satırı birlikte commit edilir; CREATE INDEX CONCURRENTLY transaction dışında çalışır. */
function applyMigration(m: Management, session: SessionConnection, verify: Verify, migration: Migration) {
  const ledger = qualified(m.schema, "_migrations");
  return m.span(
    "migration",
    () =>
      runStep(session, !!migration.concurrentIndex, async (db) => {
        if (migration.concurrentIndex) await applyConcurrentIndex(session, m.schema, migration, verify);
        else await execute(db, migration.up.bind(m.schema), verify);
        await verify();
        await db.query(`INSERT INTO ${ledger} (id,checksum) VALUES ($1,$2)`, [migration.id, migration.checksum]);
      }),
    { detail: migration.id },
  );
}

/** Tek geri alma: DROP INDEX CONCURRENTLY transaction dışında çalışır; tamamlanmış düşürmeden sonra tekrar deneme yalnızca ledger satırını siler. */
function rollbackMigration(m: Management, session: SessionConnection, verify: Verify, migration: Migration) {
  const ledger = qualified(m.schema, "_migrations");
  return runStep(session, !!migration.concurrentDrop, async (db) => {
    const drop = !migration.concurrentDrop || (await indexState(session, m.schema, migration.concurrentDrop));
    if (drop) await execute(db, (migration.down as NonNullable<Migration["down"]>).bind(m.schema), verify);
    await verify();
    await db.query(`DELETE FROM ${ledger} WHERE id=$1`, [migration.id]);
  });
}

/** Tek seed ve ledger satırı kendi transaction'ında. */
function applySeed(m: Management, session: SessionConnection, verify: Verify, seed: Seed) {
  const ledger = qualified(m.schema, "_seeds");
  return m.span(
    "seed",
    () =>
      session.transaction(async (tx) => {
        await seed.run(tx, m.schema, verify);
        await verify();
        await tx.query(`INSERT INTO ${ledger} (id,checksum) VALUES ($1,$2)`, [seed.id, seed.checksum]);
      }),
    { detail: seed.id },
  );
}

/** `registry`: uygulamanın migration ve seed listeleri (`src/core/migrations/registry.ts`); testler kendi listesini verir. */
export function createRunner({ migrations, seeds }: Registry) {
  const migrationsLedger = (schema: string) => qualified(schema, "_migrations");
  const seedsLedger = (schema: string) => qualified(schema, "_seeds");
  /** Ledger yoksa hepsi bekler; bilinmeyen ya da değişmiş geçmiş `MIGRATION_DRIFT`. */
  const pendingMigrations = (db: Connection, schema: string) => pendingIn(db, migrationsLedger(schema), migrations, { missingOk: true });
  const pendingSeeds = (db: Connection, schema: string) => pendingIn(db, seedsLedger(schema), seeds, { code: "SEED_DRIFT", missingOk: true });
  const appliedMigrations = async (db: Connection, schema: string) => migrations.slice(0, migrations.length - (await pendingMigrations(db, schema)).length);

  /** Kilidi tutan oturumda çalışır; kilit kaybı başarıdan sonra da hata sayılır. */
  async function withLock<T>(m: Management, options: Pick<RunOptions, "signal">, work: (db: SessionConnection, verify: Verify) => Promise<T>): Promise<T> {
    if (options.signal?.aborted) throw cancelled();
    const session = await openManagementSession(m, MIGRATION_KEY, { applicationName: "migration", signal: options.signal });
    try {
      const result = await work(session.db, ownershipCheck(session.signal, session.assertOwned));
      await session.assertOwned();
      return result;
    } finally {
      await session.close();
    }
  }

  /** Bekleyen migration'lar: kilit, schema hazırlığı, ledger, sonra sırayla. `dryRun` yalnızca bekleyenleri listeler. */
  async function migrate(m: Management, options: RunOptions = {}) {
    if (options.dryRun) return { dryRun: true as const, migrations: (await pendingMigrations(m.db, m.schema)).map((migration) => migration.id) };
    return withLock(m, options, async (db, verify) => {
      await prepare(m, db, verify);
      await db.exec(createLedger(migrationsLedger(m.schema)));
      const todo = await pendingMigrations(db, m.schema);
      const applied = await each(todo, "migration", "up", verify, options.report ?? noReport, (migration) => applyMigration(m, db, verify, migration));
      return { dryRun: false as const, migrations: applied };
    });
  }

  /** Son `steps` (varsayılan 1) migration ya da `to`'dan sonrakiler, yeniden eskiye. Geri alınamaz ve bilinmeyen hedefler DDL'den önce reddedilir. */
  async function rollback(m: Management, options: RunOptions & RollbackTarget = {}) {
    if (options.dryRun) return { dryRun: true as const, migrations: rollbackTargets(await appliedMigrations(m.db, m.schema), options).map((migration) => migration.id) };
    return withLock(m, options, async (db, verify) => {
      const targets = rollbackTargets(await appliedMigrations(db, m.schema), options);
      const done = await each(targets, "migration", "down", verify, options.report ?? noReport, (migration) => rollbackMigration(m, db, verify, migration));
      return { dryRun: false as const, migrations: done };
    });
  }

  /** `migrationId`'ye kadar bekleyen migration'ları çalıştırmadan uygulanmış sayar; canlı schema katlanmış tablo, sütun ve enum'ları içermezse reddeder. */
  async function baseline(m: Management, migrationId: string, options: Pick<RunOptions, "signal"> = {}) {
    return withLock(m, options, async (db, verify) => {
      await verify();
      await db.exec(createLedger(migrationsLedger(m.schema)));
      const pending = await pendingMigrations(db, m.schema);
      const marked = pending.slice(0, pending.findIndex((migration) => migration.id === migrationId) + 1);
      if (!marked.length) throw new AppError("MIGRATION_NOT_PENDING", `${migrationId} is not a pending migration`);
      const applied = migrations.length - pending.length + marked.length;
      const missing = await missingSchemaObjects(db, m.schema, foldTables(migrations.slice(0, applied).flatMap((migration) => migration.up.statements)));
      if (missing.length) throw new AppError("SCHEMA_MISMATCH", `Live schema lacks ${missing.slice(0, 20).join(", ")}; baseline refused`);
      await db.transaction(async (tx) => {
        for (const migration of marked) {
          await verify();
          await tx.query(`INSERT INTO ${migrationsLedger(m.schema)} (id,checksum) VALUES ($1,$2)`, [migration.id, migration.checksum]);
        }
      });
      return { migrations: marked.map((migration) => migration.id) };
    });
  }

  /** Salt okunur: uygulanmış sayı ve bekleyen migration'lar (`transactional: false` CONCURRENTLY index'tir). */
  async function migrationStatus(m: Management) {
    const pending = await pendingMigrations(m.db, m.schema);
    return {
      schema: m.schema,
      applied: migrations.length - pending.length,
      pending: pending.map(({ id, concurrentIndex }) => ({ id, transactional: !concurrentIndex })),
    };
  }

  /** Migration'lar güncel olmalı. Her seed ve ledger satırı kendi transaction'ında commit edilir; uygulanmış seed tekrar çalışmaz. */
  async function seed(m: Management, options: RunOptions = {}) {
    if ((await pendingMigrations(m.db, m.schema)).length) throw new AppError("MIGRATIONS_PENDING", "Seeds need current migrations; run migrate first");
    if (options.dryRun) return { dryRun: true as const, seeds: (await pendingSeeds(m.db, m.schema)).map((item) => item.id) };
    return withLock(m, options, async (db, verify) => {
      await verify();
      await db.exec(createLedger(seedsLedger(m.schema)));
      const todo = await pendingSeeds(db, m.schema);
      const done = await each(todo, "seed", "up", verify, options.report ?? noReport, (item) => applySeed(m, db, verify, item));
      return { dryRun: false as const, seeds: done };
    });
  }

  return { migrate, rollback, baseline, migrationStatus, seed };
}
```

- [ ] **Step 4: Geçişi izle**

```bash
RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/migrations.test.ts 2>&1 | tail -12
```
Expected: 13 test **pass**. Başarısızlık olursa `systematic-debugging` ile nedeni bulun (runner mantığı multi'deki `schema.ts`/`runner.ts` ile aynı sözleşmeyi taşır); testi gevşetmeyin.

Mutasyon denetimi (ledger'a yazın): `applyMigration` içindeki `await verify();` satırlarından birini silip testlerin kırıldığını (kilit kaybı denetimi) doğrulamak zorunlu değildir; ancak şu iki mutasyon **zorunludur**:

```bash
# 1) ledger INSERT'ini transaction dışına almak (rollback testi kırılmalı) — yalnızca elle düşünüp geri alın:
sed -i.bak 's/runStep(session, !!migration.concurrentIndex, async (db) => {/runStep(session, true, async (db) => {/' src/core/migrations/runner.ts
RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/migrations.test.ts -t "failing migration" 2>&1 | tail -4
mv src/core/migrations/runner.ts.bak src/core/migrations/runner.ts
```
Expected: mutasyonlu çalıştırmada "a failing migration rolls its DDL and ledger row back" **fail** (tablo `b` kalır); dosya geri yüklendikten sonra yeniden pass. (`git diff --stat` boş olmalı.)

- [ ] **Step 5: Tam paket**

```bash
bun test src/__tests__/unit 2>&1 | tail -4 && bun run typecheck && bun run lint && bun run test:integration 2>&1 | tail -5
```
Expected: birim yeşil; entegrasyon: `database` 4 + `migrations` 13 test pass, leak guard temiz.

- [ ] **Step 6: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: migration runner (migrate, rollback, baseline, status, seed) on one advisory lock, proven against PostgreSQL

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: İstek kapsamı, middleware, telemetri, yönetim girişi ve G2 kabulü

**Files:**
- Create: `src/middleware.ts`, `src/management.ts`, `src/telemetry.ts` (kopya+düzenleme)
- Test: yeni `unit/middleware.test.ts`, `unit/management-entry.test.ts`; kopya+uyarlama `unit/telemetry.test.ts`; yeni `integration/replica.test.ts`, `integration/replica-fixture.ts`

**Interfaces:**
- Consumes: Task 5 `Db`/`createDb`/`Queryable`/`ReadContext`/`ReadSession`, Task 6–9 registry/runner.
- Produces:
  - `middleware.ts`: `RequestDb extends Queryable { readonly read: ReadContext }`, `createDbScope(db: Db): RequestDb`, `dbMiddleware(options)` → `(c, next) => Promise<void>` (`c.set("db", RequestDb)`), `MiddlewareContext { set(key: "db", value: RequestDb): void; env?: unknown }`.
  - `management.ts`: `createManagement`, `Management`, `ManagementOptions`, `SeedContext`, `prepareQuery(source)`, `migrate`, `rollback`, `baseline`, `migrationStatus`, `seed` (paketin kendi kaydıyla `createRunner(registry)`).
  - `telemetry.ts`: `openTelemetry`, `sentry`, `spanAttributes` (öznitelik `db.system.name`, `repo_db.duration_ms`, `repo_db.detail`, `error.type`; **`tenant.id` ve `db.namespace` yok**).

- [ ] **Step 1: Başarısız testler**

`unit/middleware.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDb } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import { createDbScope, dbMiddleware, type RequestDb } from "../../middleware";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@primary.example/app";
const REPLICA = "postgres://app:secret-pw@replica.example/app";
const select = prepareQuery("SELECT id FROM users WHERE id = $1::integer");
const insert = prepareQuery("INSERT INTO users (id) VALUES ($1::integer)");
const handler: Handler = (text) =>
  text.includes("pg_current_wal_lsn") ? [{ lsn: "0/1" }] : text.includes("pg_is_in_recovery") ? [{ in_recovery: true, caught_up: true, lag_ms: 0 }] : [];

test("the middleware puts a request scope with query, transaction and read on the context", async () => {
  const fake = fakeDriver(handler);
  let scope: RequestDb | undefined;
  const middleware = dbMiddleware({ driver: fake.driver, config: createConfig(PRIMARY), pooler: "assumed" });
  await middleware({ set: (_key, value) => void (scope = value) }, async () => {
    await scope?.query(select, [1]);
  });
  expect(Object.keys(scope ?? {}).sort()).toEqual(["query", "read", "transaction"]);
  expect(fake.commands.some((command) => command.text.includes('"public".users'))).toBe(true);
});

test("a shared database is opened once for many requests", async () => {
  const fake = fakeDriver(handler);
  const middleware = dbMiddleware({ driver: fake.driver, config: createConfig(PRIMARY), pooler: "assumed" });
  for (let i = 0; i < 3; i++) await middleware({ set: () => {} }, async () => {});
  expect(fake.pools).toHaveLength(1);
});

test("perRequest opens a one-connection pool per request and closes it after the response", async () => {
  const fake = fakeDriver(handler);
  const middleware = dbMiddleware({ driver: fake.driver, config: createConfig(PRIMARY), pooler: "assumed", perRequest: true });
  for (let i = 0; i < 2; i++) await middleware({ set: () => {} }, async () => {});
  expect(fake.pools).toHaveLength(2);
  expect(fake.pools.every((pool) => pool.options.max === 1 && pool.closed)).toBe(true);
});

test("option combinations that make no sense are INVALID_CONFIG", () => {
  const fake = fakeDriver();
  const db = createDb(createConfig(PRIMARY), { driver: fake.driver, pooler: "assumed" });
  for (const options of [{}, { driver: fake.driver, database: db }, { database: db, perRequest: true }])
    expect(() => dbMiddleware(options as never)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

test("reads go to the replica until the same request writes, then stay on the primary", async () => {
  const fake = fakeDriver(handler);
  const db = createDb(createConfig(PRIMARY, [REPLICA]), { driver: fake.driver, pooler: "assumed", replicaStatusMs: 1 });
  const scope = createDbScope(db);
  await scope.read.query(select, [1]);
  await scope.query(insert, [1]);
  await scope.read.query(select, [1]);
  const reads = fake.commands.filter((command) => command.text.startsWith("SELECT id FROM"));
  expect(reads.map((command) => command.url)).toEqual([REPLICA, PRIMARY]);
  await db.close();
});

test("reads in one scope stay on the first replica; a fresh scope picks again", async () => {
  const second = "postgres://app:secret-pw@replica2.example/app";
  const fake = fakeDriver(handler);
  const db = createDb(createConfig(PRIMARY, [REPLICA, second]), { driver: fake.driver, pooler: "assumed", replicaStatusMs: 1 });
  const scope = createDbScope(db);
  await scope.read.query(select, [1]);
  await scope.read.query(select, [1]);
  const urls = fake.commands.filter((command) => command.text.startsWith("SELECT id FROM")).map((command) => command.url);
  expect(new Set(urls).size).toBe(1);
  await db.close();
});
```

`unit/management-entry.test.ts`:

```ts
import { expect, test } from "bun:test";
import * as management from "../../management";

test("the management entry exposes the context factory, the runner functions and the registry-aware prepareQuery", () => {
  expect(Object.keys(management).sort()).toEqual(["baseline", "createManagement", "migrate", "migrationStatus", "prepareQuery", "rollback", "seed"]);
});

test("prepareQuery compiles with the package's own migration tables (none registered yet)", () => {
  expect(management.prepareQuery("SELECT 1").readOnly).toBe(true);
});
```

`unit/telemetry.test.ts`: kopyalayın ve uyarlayın:

```bash
cp ../db-multi/src/__tests__/unit/telemetry.test.ts src/__tests__/unit/telemetry.test.ts
```
`import … from "../../telemetry"`; span nesnelerinden `databaseId`/`tenantId` alanlarını silin; `db.namespace` ve `tenant.id` beklentilerini silin; `repo_db.duration_ms`, `repo_db.detail`, `error.type`, `db.system.name` beklentileri ve Sentry `op`/ad kuralları (`db.query` → `op: "db"`, ad = SQL) aynı kalır. `tenant.lock` örnekleri `migration` ile değişir (`op` `db.migration`).

`integration/replica-fixture.ts`:

```ts
/** Replica testleri: izole compose'taki akış replikasyonlu çift (`postgres-rp` → `postgres-rp-replica`). Sabit yerel varsayılanlar,
 * ortam değişkeni yok. Runtime `pooler: "assumed"` ile doğrudan URL'lere bağlanır. */
import { createConfig } from "../../core/config";
import type { Connection } from "../../core/driver";
import { createDb, type Db, type DbOptions } from "../../core/runtime";
import { prepareMigration } from "../../core/sql/compiler";
import { driver, dropSchema, q, raw, testSchema } from "./helpers";

export const PRIMARY_URL = "postgres://admin:local_admin_password@127.0.0.1:5565/app";
export const REPLICA_URL = "postgres://admin:local_admin_password@127.0.0.1:5566/app";
/** Dinleyen kimse yok: bağlantı reddedilir. */
export const DEAD_REPLICA_URL = "postgres://admin:local_admin_password@127.0.0.1:5599/app";

export const replicaConfig = (...replicas: string[]) => createConfig(PRIMARY_URL, replicas);

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

/** Primary'de `notes` tablosu olan bir schema; replica yetişmiş. `runtime(replicas, options)` replica'lı `Db` açar. */
export async function replicaFixture() {
  const schema = testSchema();
  const primary = raw(PRIMARY_URL);
  const replica = raw(REPLICA_URL);
  await primary.exec(`CREATE SCHEMA ${q(schema)}`);
  for (const sql of prepareMigration("CREATE TABLE notes (id integer PRIMARY KEY)").bind(schema)) await primary.exec(sql);
  await caughtUp(primary, replica);
  const opened: Db[] = [];
  return {
    schema,
    primary,
    replica,
    runtime(replicas: string[] = [REPLICA_URL], options: Partial<Omit<DbOptions, "driver">> = {}) {
      const db = createDb(replicaConfig(...replicas), { driver, schema, pooler: "assumed", replicaStatusMs: 1, replicaMaxLagMs: 60_000, ...options });
      opened.push(db);
      return db;
    },
    async close() {
      await resumeReplay(replica).catch(() => {});
      for (const db of opened) await db.close();
      await dropSchema(primary, schema);
      await primary.close();
      await replica.close();
    },
  };
}
```

`integration/replica.test.ts`:

```ts
import { expect } from "bun:test";
import { prepareQuery } from "../../core/sql/compiler";
import { createDbScope } from "../../middleware";
import { failure, integration } from "./helpers";
import { caughtUp, DEAD_REPLICA_URL, pauseReplay, REPLICA_URL, replicaFixture, resumeReplay } from "./replica-fixture";

const count = prepareQuery("SELECT count(*)::integer AS n FROM notes");
const insert = prepareQuery("INSERT INTO notes (id) VALUES ($1::integer)");

integration("read.query is served by the replica; the request scope sees its own write on the primary", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime();
    await pauseReplay(f.replica);
    await db.query(insert, [1]);
    expect(await db.read.query(count)).toEqual([{ n: 0 }]); // replay duraklatıldı: replica eski veriyi gösterir
    const scope = createDbScope(db);
    await scope.query(insert, [2]);
    expect(await scope.read.query(count)).toEqual([{ n: 2 }]); // aynı istekte yazıdan sonra okuma primary'de
    await resumeReplay(f.replica);
    await caughtUp(f.primary, f.replica);
    expect(await db.read.query(count)).toEqual([{ n: 2 }]);
  } finally {
    await f.close();
  }
});

integration("an unreachable replica falls back to the primary, or fails under the error policy", async () => {
  const f = await replicaFixture();
  try {
    const fallback = f.runtime([DEAD_REPLICA_URL]);
    expect(await fallback.read.query(count)).toEqual([{ n: 0 }]);
    const strict = f.runtime([DEAD_REPLICA_URL], { replicaOnUnavailable: "error" });
    expect(await failure(strict.read.query(count))).toBe("REPLICA_UNAVAILABLE");
  } finally {
    await f.close();
  }
});

integration("replicas() reports health and lag without exposing URLs", async () => {
  const f = await replicaFixture();
  try {
    const report = await f.runtime([REPLICA_URL, DEAD_REPLICA_URL]).replicas();
    expect(report.map((row) => [row.replica, row.usable])).toEqual([[1, true], [2, false]]);
    expect(typeof report[0]?.lagMs).toBe("number");
    expect(JSON.stringify(report)).not.toContain("127.0.0.1");
    expect(JSON.stringify(report)).not.toContain("local_admin_password");
  } finally {
    await f.close();
  }
});
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single
bun test src/__tests__/unit/{middleware,management-entry,telemetry}.test.ts 2>&1 | tail -8
```
Expected: `../../middleware`, `../../management`, `../../telemetry` yok → **fail**.

- [ ] **Step 3: Giriş noktaları**

`packages/db-single/src/middleware.ts`:

```ts
/** Middleware girişi (`@repo/db-single/middleware`): veritabanını kurar ve isteğin context'ine `db` ekler (`query`, `transaction`,
 * `read.query`). Hono'nun `(c, next)` biçimine uyar (bağımlılık yok; `c.set` yeterli).
 *
 *   app.use(dbMiddleware({ driver: bunDriver })); // Bun/Node: süreç başına tek havuz, DATABASE_URLS
 *   app.use(dbMiddleware({ driver: postgresDriver, perRequest: true, config: (c) => workerConfig(c.env) })); // Workers
 *   app.get("/users/:email", async (c) => c.json(await c.get("db").query(findUserByEmail, [c.req.param("email")]))); // uygulamanın src/queries/users.sql'i
 *
 * HTTP dışında (cron, kuyruk, Worker `scheduled`) aynı yapı `createDbScope(db)` ile kurulur; kapsam havuz tutmaz, `db`'yi çağıran kapatır. */
import { type Config, type DatabaseOptions, loadConfig } from "./core/config";
import type { Queryable, ReadContext, ReadSession } from "./core/context";
import type { SpanHandler } from "./core/database";
import type { Driver } from "./core/driver";
import { AppError } from "./core/errors";
import { createDb, type Db } from "./core/runtime";

/** İstek kapsamı: aynı istekte yazı çalıştıysa sonraki `read.query` okumaları primary'de kalır (read-your-writes); okumalar aynı replica'ya
 * sabitlenir (çağrılar arası monoton okuma). Başka isteğe taşan tutarlılık garanti edilmez. */
export interface RequestDb extends Queryable {
  readonly read: ReadContext;
}
export type { Db };

export function createDbScope(db: Db): RequestDb {
  let wrote = false;
  const markWrite = () => void (wrote = true);
  const session: ReadSession = {};
  return Object.freeze({
    query: ((query, values) => db.run((ctx) => ctx.query(query, values), markWrite)) as Queryable["query"],
    transaction: (work) => db.run((ctx) => ctx.transaction(work), markWrite),
    read: Object.freeze<ReadContext>({ query: ((query, values) => db.readRun((ctx) => ctx.query(query, values), wrote, session)) as ReadContext["query"] }),
  });
}

export interface MiddlewareContext {
  set(key: "db", value: RequestDb): void;
  env?: unknown;
}

interface DbMiddlewareOptions<C extends MiddlewareContext> extends DatabaseOptions {
  /** Middleware'in açtığı havuzun ölçümü (`@repo/db-single/telemetry`). */
  onSpan?: SpanHandler;
  /** Tablo schema'sı; verilmezse `public`. */
  schema?: string;
  pooler?: "verified" | "assumed";
  /** Uygulamanın açtığı veritabanı (`createDb`): `ready()`, Better Auth ve kapanış aynı havuzu kullanır; verilirse `driver`, `config` ve `perRequest` kullanılmaz. */
  database?: Db;
  driver?: Driver;
  /** Varsayılan `loadConfig()` (`process.env.DATABASE_URLS`); Workers'da binding'lerden. */
  config?: Config | ((c: C) => Config);
  /** Workers: istek başına `poolMax: 1` havuz, yanıttan sonra kapanır (soketler isteği aşamaz). */
  perRequest?: boolean;
}

/** Veritabanı kaynağı seçenekleri tutarlı olmalı; aksi halde `INVALID_CONFIG`. */
function assertMiddlewareOptions({ database, driver, perRequest }: DbMiddlewareOptions<never>) {
  const hasOneDatabaseSource = !database !== !driver;
  if (!hasOneDatabaseSource || (!!database && !!perRequest))
    throw new AppError("INVALID_CONFIG", "dbMiddleware needs either database or driver (perRequest only with driver)");
}

export function dbMiddleware<C extends MiddlewareContext>(middlewareOptions: DbMiddlewareOptions<C>) {
  assertMiddlewareOptions(middlewareOptions);
  const { database, driver, config, perRequest, ...options } = middlewareOptions;
  let shared: Db | undefined = database;
  const openDb = (c: C) => createDb(typeof config === "function" ? config(c) : (config ?? loadConfig()), { ...options, driver: driver as Driver, ...(perRequest && { poolMax: 1 }) });

  return async (c: C, next: () => Promise<void>) => {
    const db = perRequest ? openDb(c) : (shared ??= openDb(c));
    c.set("db", createDbScope(db));
    try {
      await next();
    } finally {
      if (perRequest) await db.close().catch(() => {});
    }
  };
}
```

`packages/db-single/src/management.ts`:

```ts
/** Yönetim girişi (`@repo/db-single/management`): bağlam fabrikası ve CLI'nin sardığı işlemler. */
import { migrationTables, registry } from "./core/migrations/registry";
import { createRunner } from "./core/migrations/runner";
import { prepareQuery as compileQuery } from "./core/sql/compiler";

export type { ManagementOptions } from "./core/config";
export { createManagement, type Management } from "./core/management";
export type { SeedContext } from "./core/migrations/source";

/** Paketin kendi migration ve seed listeleriyle çalışan işlemler. */
export const { baseline, migrate, migrationStatus, rollback, seed } = createRunner(registry);

/** Codegen ile aynı derleme: `*` paketin kendi migration tablolarından açılır, çıktı adları camelCase olur. */
export const prepareQuery = (source: string) => compileQuery(source, migrationTables());
```

`src/telemetry.ts`:

```bash
cp ../db-multi/src/telemetry.ts src/telemetry.ts
```
Düzenleme: yorum ve `spanAttributes`:

```ts
/** OpenTelemetry anlamsal adlarıyla öznitelikler: `db.system.name`, `error.type` ve pakete özgü `repo_db.*`. */
export function spanAttributes(span: Span): Attributes {
  const attributes: Attributes = { "db.system.name": "postgresql", "repo_db.duration_ms": span.ms };
  if (span.detail) attributes["repo_db.detail"] = span.detail;
  if (span.error) attributes["error.type"] = span.error;
  return attributes;
}
```
Dosya başı yorumunda `createDatabase` → `createDb`, `@repo/db/telemetry` → `@repo/db-single/telemetry`; `sentryOp` yorumundaki `tenant.lock` → `db.migration`'a çevrilen örnek (`migration` → `db.migration`).

- [ ] **Step 4: Geçiş**

```bash
bun test src/__tests__/unit 2>&1 | tail -6 && bun run typecheck && bun run lint && bun run codegen --check
RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration 2>&1 | tail -6
```
Expected: birim yeşil; entegrasyon: `database` 4 + `migrations` 13 + `replica` 3 test pass, leak guard temiz; tsc/eslint/codegen temiz.

- [ ] **Step 5: G2 kabulü (kanıtla)**

```bash
# 1) Bekçi: kaynakta çok-tenant sözcüğü yok
grep -rniE "tenant|placement|platform" src package.json compose.yaml .env.example | grep -v "no-multi-tenant.test.ts" | wc -l
# 2) Bağımlılık: db-multi'ye ve eski @repo/db adına hiçbir referans yok
grep -rnE "db-multi|@repo/db([^-]|$)" src package.json | wc -l
# 3) Satır sayısı (karşılaştırma G3 sonunda raporlanır)
find src -name '*.ts' -not -path '*/__tests__/*' -not -name '*.gen.ts' | xargs wc -l | tail -1
# 4) Dört sürücüde duman + migrations
for d in postgres pg neon; do DB_DRIVER=$d RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/database.test.ts src/__tests__/integration/migrations.test.ts 2>&1 | tail -2; done
```
Expected: (1) `0`; (2) `0` (`db-multi` ya da `@repo/db` adı geçen satır yok; `@repo/db-single` eşleşmez); (3) toplam kaynak satırı (ledger'a yazın; `db-multi` kaynağı ≈12.8k); (4) her sürücüde `0 fail`.

`db-multi` değişmedi:

```bash
git log --format=%s -- packages/db-multi | grep -c '^db-single:' || true
```
Expected: `0` (bu planın hiçbir commit'i `packages/db-multi` altına dokunmaz).

- [ ] **Step 6: Altyapıyı kapat ve commit**

```bash
docker compose -p dbsingle down -v --remove-orphans
docker ps --format '{{.Names}}' | grep -c '^dbsingle' || true
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: request scope and middleware (read-your-writes), telemetry, management entry; G2 core proven on four drivers and the replica pair

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: `0` dbsingle konteyneri kalır.
