# Sağlayıcı uyumluluğu ve doğrulaması (B1) Uygulama Planı

> **Durum (2026-10-19): uygulandı (belge + `verify:provider`); gerçek sağlayıcı hesabıyla doğrulama yapılmadı, sahip işidir (`providers.md`).** Onay kutuları işaretlenmedi; gerçek durumun kaynağı koddur, testlerdir ve [yol haritası](2026-10-18-roadmap-remaining.md)dır.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Neon ve Supabase üzerinde runtime/yönetim davranışını ölçen bir doğrulama betiği (`bun run verify:provider`) ve ölçümleri tutan `docs/providers.md` eklemek.

**Architecture:** Betik `Driver` sözleşmesiyle doğrudan çalışır (Management açmaz). Yönetim URL'leri mevcut `DATABASE_URLS`'ten, runtime URL'leri `doctor --pooled-urls` gibi gizli girdiyle alınır; yeni ortam değişkeni yoktur. Ölçümler `src/__tests__/provider/measure.ts`'te küçük işlevlerdir (probe, `ALTER DATABASE SET` turu, yetkiler, deadline sonrası sunucu davranışı); `verify.ts` bunları düğüm başına birleştirip yalnızca JSON basar (URL, host, kullanıcı, parola yok).

**Tech Stack:** Bun, TypeScript, `bun:test`, mevcut `Driver` (bun/postgres/pg), yerel Docker compose (yalnızca yerel doğrulama için).

**Spec:** `docs/superpowers/specs/2026-10-03-neon-supabase-design.md` (bölüm B1)

## Global Constraints

- Yeni ortam değişkeni yok; tek değişken ilkesi: `DATABASE_URLS` (+ A'nın isteğe bağlı `DATABASE_REPLICA_URLS`).
- Parola taşıyan değer argv'ye girmez; gizli girdi `askSecret`/`postgresUrl` ile (`src/core/tools/ask-secret.ts`).
- Doğrulama çıktısı URL, host, kullanıcı veya parola içermez.
- Betik ayarı değiştirirse özgün değeri geri yazar; yalnızca geçici/ücretsiz test veritabanları için yazılır.
- Yorumlar Türkçe, hata mesajları İngilizce; yakındaki kodun yorum yoğunluğu ve adlandırması korunur.
- Commit sonuna: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push ve PR yok.
- Shared jamaster docker stack'ine (5540/5541/5543) dokunulmaz; entegrasyon yalnızca Task 0'daki izole `dbprov` stack'inde çalışır.
- Doğrulanmamış sağlayıcı bilgisi `docs/providers.md`'de `documented, not verified` olarak işaretlenir.

## Review Focus

- Betik ortasında hata olsa bile `ALTER DATABASE` özgün değere dönmeli, dönemezse elle çalıştırılacak SQL basılmalı (Task 2 testleri).
- Çıktıda parola, kullanıcı (proje ref'i içeren `postgres.<ref>`), host veya tam URL bulunmamalı; sürücü hata metinleri de temizlenmeli (Task 1, Task 4 testleri).
- Yönetim ve runtime URL listeleri farklı uzunlukta olursa betik hiçbir şey çalıştırmadan reddetmeli (Task 4).
- Deadline ölçümü: sorgu hiç başlamadıysa "sunucu durdu" denmemeli (Task 3).
- `pg_stat_activity` görünmüyorsa (yetki) bu "durdu" değil "gözlenemedi" olarak raporlanmalı (Task 3).

---

## Dosya yapısı

- Create: `packages/db/src/__tests__/provider/measure.ts`: ölçüm işlevleri ve çıktı türleri.
- Create: `packages/db/src/__tests__/provider/verify.ts`: `verify()` birleştirici ve CLI girişi.
- Create: `packages/db/src/__tests__/unit/provider-measure.test.ts`, `provider-verify.test.ts`: sahte sürücüyle birim testleri.
- Create: `packages/db/src/__tests__/integration/provider-verify.test.ts`: yerel PgBouncer/Postgres'e karşı.
- Modify: `packages/db/package.json`: `verify:provider` betiği.
- Create: `packages/db/docs/providers.md`; Modify: `packages/db/docs/README.md`, `packages/db/README.md`, `packages/db/docs/cli.md`.

Tüm yollar `packages/db`'ye göredir; komutlar `packages/db` içinde çalışır.

### Task 0: Dal ve izole yerel stack

**Files:**
- Create (repo dışı): `$SCRATCH/dbprov/compose.yaml`, `$SCRATCH/dbprov/env.sh` (`$SCRATCH` = oturumun scratchpad klasörü)

- [ ] **Step 1: Dalı aç**

Run: `git switch -c feat/provider-support`
Expected: `Switched to a new branch 'feat/provider-support'` (A'nın commit'leri ve B spec'i dalda).

- [ ] **Step 2: Stack dosyalarını yaz**

`$SCRATCH/dbprov/compose.yaml`:

```yaml
name: dbprov
services:
  postgres-0:
    image: postgres:16.15-alpine
    environment: {POSTGRES_DB: app, POSTGRES_USER: admin, POSTGRES_PASSWORD: local_admin_password}
    ports: ['127.0.0.1:15540:5432']
    healthcheck: {test: ['CMD-SHELL', 'pg_isready -U admin -d app'], interval: 2s, timeout: 2s, retries: 30}
  postgres-1:
    image: postgres:16.15-alpine
    environment: {POSTGRES_DB: app, POSTGRES_USER: admin, POSTGRES_PASSWORD: local_admin_password}
    ports: ['127.0.0.1:15541:5432']
    healthcheck: {test: ['CMD-SHELL', 'pg_isready -U admin -d app'], interval: 2s, timeout: 2s, retries: 30}
  pgbouncer:
    build: ${REPO}/packages/db/src/core/local/pgbouncer
    ports: ['127.0.0.1:15543:5432']
    volumes:
      - '${REPO}/packages/db/src/core/local/pgbouncer/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro'
      - '${REPO}/packages/db/src/core/local/pgbouncer/userlist.txt:/etc/pgbouncer/userlist.txt:ro'
    depends_on: {postgres-0: {condition: service_healthy}, postgres-1: {condition: service_healthy}}
    healthcheck: {test: ['CMD-SHELL', 'nc -z 127.0.0.1 5432'], interval: 2s, timeout: 2s, retries: 30}
```

`$SCRATCH/dbprov/env.sh`:

```sh
export DATABASE_URLS=postgres://admin:local_admin_password@127.0.0.1:15540/app,postgres://admin:local_admin_password@127.0.0.1:15541/app
export TEST_POOLED_URLS=postgres://admin:local_admin_password@127.0.0.1:15543/db0,postgres://admin:local_admin_password@127.0.0.1:15543/db1
export RUN_INTEGRATION=1
```

- [ ] **Step 3: Stack'i ayağa kaldır**

Run: `REPO=$(git rev-parse --show-toplevel) docker compose -f "$SCRATCH/dbprov/compose.yaml" up -d --build --wait`
Expected: üç servis `healthy`; `docker ps` yalnızca `dbprov-*` adlarını ve 15540/15541/15543 portlarını gösterir.

- [ ] **Step 4: Bu değişiklikte kod yok; commit yok**

### Task 1: Çıktı temizleme (`scrub`, `describe`)

**Files:**
- Create: `src/__tests__/provider/measure.ts`
- Test: `src/__tests__/unit/provider-measure.test.ts`

**Interfaces:**
- Produces: `scrub(text: string, urls: readonly string[]): string`; `describe(error: unknown, urls: readonly string[]): string` (`<errorCode>: <temizlenmiş mesaj>`, en çok 300 karakter); `Context = { driver: Driver; urls: readonly string[] }`.

- [ ] **Step 1: Başarısız testi yaz**

`src/__tests__/unit/provider-measure.test.ts`:

```ts
import { expect, test } from "bun:test";
import { AppError } from "../../core/errors";
import { describe as describeError, scrub } from "../provider/measure";

const urls = ["postgres://postgres.abcdefgh:s3cr%40t-pw@aws-0-eu.pooler.supabase.com:5432/postgres", "postgres://app:plain-pw@ep-cool-1.eu.neon.tech/neondb"];

test("scrub removes full URLs, passwords (raw and decoded), hosts and project-ref users", () => {
  const text = "connect failed postgres://app:plain-pw@ep-cool-1.eu.neon.tech/neondb; host aws-0-eu.pooler.supabase.com user postgres.abcdefgh pw s3cr@t-pw / s3cr%40t-pw";
  const result = scrub(text, urls);
  for (const secret of ["plain-pw", "ep-cool-1.eu.neon.tech", "aws-0-eu.pooler.supabase.com", "postgres.abcdefgh", "s3cr@t-pw", "s3cr%40t-pw"]) expect(result).not.toContain(secret);
  expect(result).toContain("connect failed");
});

test("scrub keeps the plain 'postgres' role name readable", () => {
  expect(scrub('permission denied for role "postgres"', ["postgres://postgres:pw12@h.example/db"])).toContain('role "postgres"');
});

test("describe prefixes the stable error code, scrubs the message and bounds its length", () => {
  expect(describeError(new AppError("DATABASE_TIMEOUT", "timed out at ep-cool-1.eu.neon.tech"), urls)).toBe("DATABASE_TIMEOUT: timed out at [hidden]");
  expect(describeError(new Error("x".repeat(1000)), urls).length).toBe(300);
  expect(describeError("plain string", urls)).toBe("OPERATION_FAILED: plain string");
});
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/provider-measure.test.ts`
Expected: FAIL (`Cannot find module '../provider/measure'`).

- [ ] **Step 3: Minimal gerçekleme**

`src/__tests__/provider/measure.ts`:

```ts
/** Sağlayıcı doğrulama ölçümleri (`bun run verify:provider`); yayımlanan pakete girmez. Her ölçüm kendi geçici havuzunu açıp kapatır
 * ve çıktıya URL, host, kullanıcı veya parola koymaz. */
import type { Driver } from "../../core/driver";
import { errorCode } from "../../core/errors";

/** Ölçümlerin paylaştığı bağlam: sürücü ve çıktıdan silinecek bütün URL'ler (yönetim + runtime). */
export interface Context {
  driver: Driver;
  urls: readonly string[];
}

const MAX_ERROR_CHARS = 300;

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Tam URL'leri, parolayı (ham ve çözülmüş), host'u ve proje ref'i taşıyan kullanıcı adını metinden siler. Düz `postgres` rolü
 * okunur kalır: yetki hatalarının anlamı ona bağlı. */
export function scrub(text: string, urls: readonly string[]): string {
  let result = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]");
  for (const raw of urls) {
    const url = URL.parse(raw);
    if (!url) continue;
    const user = decoded(url.username);
    for (const secret of [url.password, decoded(url.password), url.hostname, user === "postgres" ? "" : user])
      if (secret) result = result.split(secret).join("[hidden]");
  }
  return result;
}

/** `<kod>: <temizlenmiş mesaj>`; sürücü hataları kimlik bilgisi ve host içerebilir. */
export function describe(error: unknown, urls: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${errorCode(error)}: ${scrub(message, urls)}`.slice(0, MAX_ERROR_CHARS);
}
```

- [ ] **Step 4: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/provider-measure.test.ts`
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/provider/measure.ts src/__tests__/unit/provider-measure.test.ts
git commit -m "verify:provider: scrub URLs, hosts and secrets from measurement output

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 2: `ALTER DATABASE SET` turu ve yetki ölçümü

**Files:**
- Modify: `src/__tests__/provider/measure.ts`
- Test: `src/__tests__/unit/provider-measure.test.ts`

**Interfaces:**
- Consumes: `Context`, `describe` (Task 1); `quoteIdentifier` (`src/core/tenants/model.ts`); `fakeDriver` (`src/__tests__/fixtures/fake-driver.ts`).
- Produces:
  - `interface AlterDatabaseResult { allowed: boolean; newSession?: boolean; throughRuntime?: boolean; error?: string; restoreSql?: string }`
  - `alterDatabase(ctx: Context, managementUrl: string, runtimeUrl: string): Promise<AlterDatabaseResult>`
  - `interface PrivilegeResult { createSchema: boolean; superuser: boolean; extension?: { name: string; allowed: boolean; error?: string }; error?: string }`
  - `privileges(ctx: Context, managementUrl: string): Promise<PrivilegeResult>`

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/provider-measure.test.ts` sonuna ekle (importlara `alterDatabase, privileges` ve `fakeDriver` eklenir):

```ts
import { alterDatabase, privileges } from "../provider/measure";
import { fakeDriver } from "../fixtures/fake-driver";

const admin = "postgres://app:pw-admin@db.example.com/app";
const runtime = "postgres://app:pw-admin@pooler.example.com/app";
const ctx = (fake: ReturnType<typeof fakeDriver>) => ({ driver: fake.driver, urls: [admin, runtime] });
const texts = (fake: ReturnType<typeof fakeDriver>) => fake.commands.map((command) => command.text);

test("alterDatabase sets a probe value, sees it in fresh sessions and puts the stored value back", async () => {
  const fake = fakeDriver((text) =>
    text.includes("pg_db_role_setting") ? [{ name: "app", stored: "statement_timeout=5000" }] : text.includes("current_setting") ? [{ value: "7777ms" }] : [],
  );
  expect(await alterDatabase(ctx(fake), admin, runtime)).toEqual({ allowed: true, newSession: true, throughRuntime: true });
  const alters = texts(fake).filter((text) => text.startsWith("ALTER DATABASE"));
  expect(alters).toEqual([`ALTER DATABASE "app" SET statement_timeout TO '7777ms'`, `ALTER DATABASE "app" SET statement_timeout TO '5000'`]);
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
});

test("alterDatabase resets the setting when none was stored and reports a rejected ALTER without touching anything", async () => {
  const none = fakeDriver((text) => (text.includes("pg_db_role_setting") ? [{ name: "app", stored: null }] : text.includes("current_setting") ? [{ value: "7777ms" }] : []));
  await alterDatabase(ctx(none), admin, runtime);
  expect(texts(none).filter((text) => text.startsWith("ALTER DATABASE")).at(-1)).toBe(`ALTER DATABASE "app" RESET statement_timeout`);

  const denied = fakeDriver((text) => {
    if (text.includes("pg_db_role_setting")) return [{ name: "app", stored: null }];
    if (text.startsWith("ALTER DATABASE")) throw Object.assign(new Error("permission denied to set parameter at pooler.example.com"), { code: "42501" });
    return [];
  });
  const result = await alterDatabase(ctx(denied), admin, runtime);
  expect(result).toEqual({ allowed: false, error: "42501: permission denied to set parameter at [hidden]" });
  expect(texts(denied).filter((text) => text.startsWith("ALTER DATABASE"))).toHaveLength(1);
});

test("alterDatabase restores even when a session check fails, and hands over the SQL when the restore itself fails", async () => {
  const broken = fakeDriver((text) => {
    if (text.includes("pg_db_role_setting")) return [{ name: "app", stored: "statement_timeout=5000" }];
    if (text.includes("current_setting")) throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
    return [];
  });
  const result = await alterDatabase(ctx(broken), admin, runtime);
  expect(result.allowed).toBe(true);
  expect(result.error).toBe("ECONNRESET: boom");
  expect(texts(broken).at(-1)).toBe(`ALTER DATABASE "app" SET statement_timeout TO '5000'`);

  let alters = 0;
  const stuck = fakeDriver((text) => {
    if (text.includes("pg_db_role_setting")) return [{ name: "app", stored: "statement_timeout=5000" }];
    if (text.startsWith("ALTER DATABASE") && ++alters === 2) throw new Error("connection lost");
    return text.includes("current_setting") ? [{ value: "7777ms" }] : [];
  });
  expect((await alterDatabase(ctx(stuck), admin, runtime)).restoreSql).toBe(`ALTER DATABASE "app" SET statement_timeout TO '5000'`);
});

test("privileges reads the database and role rights and tries one extension inside a rolled-back transaction", async () => {
  const fake = fakeDriver((text) => {
    if (text.includes("has_database_privilege")) return [{ create_schema: true, superuser: false }];
    if (text.includes("pg_available_extensions")) return [{ name: "citext" }];
    return [];
  });
  expect(await privileges(ctx(fake), admin)).toEqual({ createSchema: true, superuser: false, extension: { name: "citext", allowed: true } });
  const trial = texts(fake).filter((text) => /^(BEGIN|CREATE EXTENSION|ROLLBACK)/.test(text));
  expect(trial).toEqual(["BEGIN", 'CREATE EXTENSION "citext"', "ROLLBACK"]);

  const denied = fakeDriver((text) => {
    if (text.includes("has_database_privilege")) return [{ create_schema: true, superuser: false }];
    if (text.includes("pg_available_extensions")) return [{ name: "citext" }];
    if (text.startsWith("CREATE EXTENSION")) throw Object.assign(new Error("permission denied to create extension at db.example.com"), { code: "42501" });
    return [];
  });
  expect((await privileges(ctx(denied), admin)).extension).toEqual({ name: "citext", allowed: false, error: "42501: permission denied to create extension at [hidden]" });
  expect(texts(denied).at(-1)).toBe("ROLLBACK");
});
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/provider-measure.test.ts`
Expected: FAIL (`alterDatabase is not exported` / import hatası).

- [ ] **Step 3: Gerçekleme**

`src/__tests__/provider/measure.ts`'e ekle (importlara `Pool` ve `quoteIdentifier`):

```ts
import type { Driver, Pool } from "../../core/driver";
import { quoteIdentifier } from "../../core/tenants/model";

const POOL = { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 } as const;

const withPool = async <T>(driver: Driver, url: string, work: (pool: Pool) => Promise<T>): Promise<T> => {
  const pool = driver(url, POOL);
  try {
    return await work(pool);
  } finally {
    await pool.close(1000);
  }
};

const SETTING = "statement_timeout";
const PROBE_VALUE = "7777ms";
const STORED_SETTING = `SELECT pg_catalog.current_database() AS name,
  (SELECT s FROM pg_catalog.pg_db_role_setting r, pg_catalog.unnest(r.setconfig) AS s
    WHERE r.setrole=0 AND r.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
      AND s LIKE '${SETTING}=%') AS stored`;
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface AlterDatabaseResult {
  /** `ALTER DATABASE … SET` kabul edildi mi. */
  allowed: boolean;
  /** Ayar yeni bir doğrudan oturumda görüldü mü. */
  newSession?: boolean;
  /** Runtime (pooler) URL'sinde görüldü mü; pooler mevcut sunucu bağlantılarını yeniden kullanabilir, `false` tek başına hata değildir. */
  throughRuntime?: boolean;
  error?: string;
  /** Özgün değer geri yazılamadıysa elle çalıştırılacak SQL (URL ve parola içermez). */
  restoreSql?: string;
}

const seesProbe = (driver: Driver, url: string) =>
  withPool(driver, url, async (pool) => (await pool.query<{ value: string }>(`SELECT current_setting('${SETTING}') AS value`))[0]?.value === PROBE_VALUE);

/** `bootstrap`'ın yaptığı `ALTER DATABASE … SET` işini geçici bir değerle dener, yeni oturumlarda görüldüğünü ölçer ve özgün değeri
 * (veya yokluğunu) geri yazar. Ölçüm hata verse de geri yazma çalışır. */
export async function alterDatabase({ driver, urls }: Context, managementUrl: string, runtimeUrl: string): Promise<AlterDatabaseResult> {
  return withPool(driver, managementUrl, async (admin) => {
    const [row] = await admin.query<{ name: string; stored: string | null }>(STORED_SETTING);
    if (!row) return { allowed: false, error: "OPERATION_FAILED: current database name unavailable" };
    const database = quoteIdentifier(row.name);
    const original = row.stored?.slice(SETTING.length + 1);
    const restore = original === undefined ? `ALTER DATABASE ${database} RESET ${SETTING}` : `ALTER DATABASE ${database} SET ${SETTING} TO ${quoted(original)}`;
    try {
      await admin.exec(`ALTER DATABASE ${database} SET ${SETTING} TO ${quoted(PROBE_VALUE)}`);
    } catch (error) {
      return { allowed: false, error: describe(error, urls) };
    }
    const result: AlterDatabaseResult = { allowed: true };
    try {
      result.newSession = await seesProbe(driver, managementUrl);
      result.throughRuntime = await seesProbe(driver, runtimeUrl);
    } catch (error) {
      result.error = describe(error, urls);
    } finally {
      try {
        await admin.exec(restore);
      } catch {
        result.restoreSql = restore;
      }
    }
    return result;
  });
}

const EXTENSIONS = ["citext", "pg_trgm", "pgcrypto"];

export interface PrivilegeResult {
  createSchema: boolean;
  superuser: boolean;
  /** Kurulu olmayan ilk uygun extension'ın `CREATE EXTENSION` denemesi (transaction geri alınır); aday yoksa yok. */
  extension?: { name: string; allowed: boolean; error?: string };
  error?: string;
}

/** `bootstrap`'ın ihtiyacı olan `CREATE` hakkı ve rol türü; extension yetkisi geri alınan bir transaction'da denenir. */
export async function privileges({ driver, urls }: Context, managementUrl: string): Promise<PrivilegeResult> {
  try {
    return await withPool(driver, managementUrl, async (pool) => {
      const [row] = await pool.query<{ create_schema: boolean; superuser: boolean }>(
        "SELECT pg_catalog.has_database_privilege(pg_catalog.current_database(),'CREATE') AS create_schema, COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=pg_catalog.current_user),false) AS superuser",
      );
      const result: PrivilegeResult = { createSchema: row?.create_schema === true, superuser: row?.superuser === true };
      const candidate = await pool.query<{ name: string }>(
        `SELECT name FROM pg_catalog.pg_available_extensions WHERE name IN (${EXTENSIONS.map(quoted).join(",")}) AND installed_version IS NULL ORDER BY name LIMIT 1`,
      );
      const name = candidate[0]?.name;
      if (!name) return result;
      const session = await pool.reserve();
      try {
        await session.exec("BEGIN");
        await session.exec(`CREATE EXTENSION ${quoteIdentifier(name)}`);
        result.extension = { name, allowed: true };
      } catch (error) {
        result.extension = { name, allowed: false, error: describe(error, urls) };
      } finally {
        await session.exec("ROLLBACK").catch(() => {});
        session.release();
      }
      return result;
    });
  } catch (error) {
    return { createSchema: false, superuser: false, error: describe(error, urls) };
  }
}
```

Not: dosyanın başındaki `Driver` import'u `Driver, Pool` olarak birleşir (`no-duplicate-imports`).

- [ ] **Step 4: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/provider-measure.test.ts && bun run typecheck && bun run lint`
Expected: testler PASS (Task 1 dahil toplam 7); typecheck ve lint temiz. Typecheck `quoteIdentifier("citext")` çıktısının `"citext"` olduğunu varsayar (testler `"citext"` bekler).

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/provider/measure.ts src/__tests__/unit/provider-measure.test.ts
git commit -m "verify:provider: ALTER DATABASE SET round trip and privilege measurements

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 3: Pooler sınaması ve deadline ölçümü

**Files:**
- Modify: `src/__tests__/provider/measure.ts`
- Test: `src/__tests__/unit/provider-measure.test.ts`

**Interfaces:**
- Consumes: `Context`, `describe`, `withPool` (Task 1–2); `usesTransactionPooler` (`src/core/tenants/pooler.ts`); `CLIENT_CONNECTION_CHECK_MS` (`src/core/config.ts`).
- Produces:
  - `type ProbeResult = { transactionPooler: boolean } | { error: string }`; `probe(ctx: Context, url: string): Promise<ProbeResult>`
  - `interface DeadlineResult { observedRunning: boolean; cancelDefined: boolean; serverStoppedAfterMs: number | null; error?: string }`
  - `deadline(ctx: Context, runtimeUrl: string, managementUrl: string, timing?: { afterMs?: number; waitMs?: number; pollMs?: number }): Promise<DeadlineResult>` (varsayılan 2000/20000/500 ms)

- [ ] **Step 1: Başarısız testleri yaz**

```ts
import { deadline, probe } from "../provider/measure";

test("probe reports the pooler verdict and turns driver errors into scrubbed text", async () => {
  expect(await probe(ctx(fakeDriver(() => [{ pid: 7 }])), runtime)).toEqual({ transactionPooler: true });
  let pid = 0;
  expect(await probe(ctx(fakeDriver(() => [{ pid: ++pid }])), admin)).toEqual({ transactionPooler: false });
  const failing = fakeDriver(() => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND db.example.com"), { code: "ENOTFOUND" });
  });
  expect(await probe(ctx(failing), admin)).toEqual({ error: "ENOTFOUND: getaddrinfo ENOTFOUND [hidden]" });
});

const timing = { afterMs: 5, waitMs: 60, pollMs: 5 };
const activity = (counts: number[]) => {
  let call = 0;
  return fakeDriver((text) => (text.includes("pg_stat_activity") ? [{ n: counts[Math.min(call++, counts.length - 1)] }] : []));
};

test("deadline starts a tagged sleep on the runtime URL, discards the connection and waits for the server to drop it", async () => {
  const fake = activity([1, 1, 0]);
  const result = await deadline(ctx(fake), runtime, admin, timing);
  expect(result).toMatchObject({ observedRunning: true, cancelDefined: true });
  expect(result.serverStoppedAfterMs).toBeGreaterThan(0);
  const [sleep] = fake.commands.filter((command) => command.text.includes("pg_sleep"));
  expect(sleep?.url).toBe(runtime);
  expect(sleep?.text).toMatch(/SET LOCAL statement_timeout = 0; SET LOCAL client_connection_check_interval = 1000; SELECT pg_sleep\(120\) \/\* verify-provider-[0-9a-f-]{36} \*\//);
  const pool = fake.pools.find((item) => item.url === runtime);
  expect(pool).toMatchObject({ discarded: 1, cancels: 1 });
  expect(fake.pools.every((item) => item.closed)).toBe(true);
});

test("deadline reports no server stop when the backend keeps running, and 'not observed' when the sleep never showed up", async () => {
  const stuck = await deadline(ctx(activity([1])), runtime, admin, timing);
  expect(stuck).toMatchObject({ observedRunning: true, serverStoppedAfterMs: null });
  const never = activity([0]);
  const result = await deadline(ctx(never), runtime, admin, timing);
  expect(result).toMatchObject({ observedRunning: false, serverStoppedAfterMs: null });
  expect(never.pools.find((item) => item.url === runtime)?.discarded).toBe(1);
});

test("deadline turns a failing activity query (no visibility) into an error instead of a stop", async () => {
  const fake = fakeDriver((text) => {
    if (text.includes("pg_stat_activity")) throw Object.assign(new Error("permission denied for view pg_stat_activity"), { code: "42501" });
    return [];
  });
  const result = await deadline(ctx(fake), runtime, admin, timing);
  expect(result).toMatchObject({ observedRunning: false, serverStoppedAfterMs: null, error: "42501: permission denied for view pg_stat_activity" });
});
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/provider-measure.test.ts`
Expected: FAIL (`probe`/`deadline` dışa aktarılmamış).

- [ ] **Step 3: Gerçekleme**

`measure.ts`'e ekle (importlar: `CLIENT_CONNECTION_CHECK_MS` from `../../core/config`, `usesTransactionPooler` from `../../core/tenants/pooler`):

```ts
const PROBE_DEADLINE_MS = 15_000;

export type ProbeResult = { transactionPooler: boolean } | { error: string };

/** A'nın `pg_backend_pid` sınaması: runtime URL'si için `true`, yönetim URL'si için `false` beklenir. */
export async function probe({ driver, urls }: Context, url: string): Promise<ProbeResult> {
  try {
    return { transactionPooler: await usesTransactionPooler(driver, url, { deadlineMs: PROBE_DEADLINE_MS }) };
  } catch (error) {
    return { error: describe(error, urls) };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SLEEP_SECONDS = 120;

export interface DeadlineResult {
  /** Etiketli uzun sorgu `pg_stat_activity`'de görüldü mü; görülmediyse "sunucu durdu" ölçümü anlamsızdır. */
  observedRunning: boolean;
  /** Sürücü `cancel` tanımlıyor mu (`neonDriver` ve Bun SQL tanımlamaz). */
  cancelDefined: boolean;
  /** Bağlantı atıldıktan sonra sunucudaki sorgunun bitmesi için geçen süre; süre içinde bitmediyse `null`. */
  serverStoppedAfterMs: number | null;
  error?: string;
}

/** Runtime URL'sinde ayrılmış bağlantıda uzun bir sorgu başlatır, `afterMs` sonra bağlantıyı atar (`release(true)`, varsa `cancel`)
 * ve yönetim URL'sinden sunucudaki sorgunun ne zaman bittiğini izler. `client_connection_check_interval` `bootstrap`'ın varsayılanıdır. */
export async function deadline(
  { driver, urls }: Context,
  runtimeUrl: string,
  managementUrl: string,
  { afterMs = 2000, waitMs = 20_000, pollMs = 500 } = {},
): Promise<DeadlineResult> {
  const tag = `verify-provider-${crypto.randomUUID()}`;
  const running = (monitor: Pool) =>
    monitor
      .query<{ n: number }>("SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND query LIKE $1", [`%${tag}%`])
      .then(([row]) => row?.n ?? 0);
  try {
    return await withPool(driver, managementUrl, (monitor) =>
      withPool(driver, runtimeUrl, async (pool) => {
        const reserved = await pool.reserve();
        let startError: string | undefined;
        let dropped = false;
        /** Bağlantıyı bir kez atar; ölçüm ortasında hata olsa da sunucuda 120 sn'lik sorgu açık kalmaz. */
        const drop = () => {
          if (dropped) return;
          dropped = true;
          reserved.cancel?.();
          reserved.release(true);
        };
        void reserved
          .exec(`BEGIN; SET LOCAL statement_timeout = 0; SET LOCAL client_connection_check_interval = ${CLIENT_CONNECTION_CHECK_MS}; SELECT pg_sleep(${SLEEP_SECONDS}) /* ${tag} */`)
          .catch((error: unknown) => {
            startError = describe(error, urls);
          });
        try {
          await sleep(afterMs);
          const observedRunning = (await running(monitor)) > 0;
          const cancelDefined = typeof reserved.cancel === "function";
          drop();
          if (!observedRunning) return { observedRunning, cancelDefined, serverStoppedAfterMs: null, ...(startError ? { error: startError } : {}) };
          const started = performance.now();
          while (performance.now() - started < waitMs) {
            await sleep(pollMs);
            if ((await running(monitor)) === 0) return { observedRunning, cancelDefined, serverStoppedAfterMs: Math.max(1, Math.round(performance.now() - started)) };
          }
          return { observedRunning, cancelDefined, serverStoppedAfterMs: null };
        } finally {
          drop();
        }
      }),
    );
  } catch (error) {
    return { observedRunning: false, cancelDefined: false, serverStoppedAfterMs: null, error: describe(error, urls) };
  }
}
```

- [ ] **Step 4: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/provider-measure.test.ts && bun run typecheck && bun run lint`
Expected: PASS (toplam 11); typecheck ve lint temiz. (Sahte sürücüde `BEGIN; …` ile başlayan komut hemen döner; bu testte beklenen davranıştır, `startError` oluşmaz.)

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/provider/measure.ts src/__tests__/unit/provider-measure.test.ts
git commit -m "verify:provider: pooler probe and deadline measurements

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 4: `verify()` birleştirici, CLI girişi ve betik

**Files:**
- Create: `src/__tests__/provider/verify.ts`
- Test: `src/__tests__/unit/provider-verify.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1–3'ün tüm dışa aktarımları; `askSecret`, `postgresUrl` (`src/core/tools/ask-secret.ts`); `loadConfig` (`src/core/config.ts`).
- Produces:
  - `interface NodeReport { id: string; probe: { runtime: ProbeResult; management: ProbeResult }; alterDatabase: AlterDatabaseResult; privileges: PrivilegeResult; deadline: DeadlineResult }`
  - `interface Report { generatedAt: string; driver: string; server: string | null; nodes: NodeReport[] }`
  - `verify(driver: Driver, driverName: string, management: readonly string[], runtime: readonly string[], now?: Date, timing?: Parameters<typeof deadline>[3]): Promise<Report>` (uzunluklar farklıysa `INVALID_CONFIG`)
  - `driverName(argv: readonly string[]): "bun" | "postgres" | "pg"` (`--driver <ad>`, varsayılan `bun`; bilinmeyen değer `USAGE`)

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/provider-verify.test.ts`:

```ts
import { expect, test } from "bun:test";
import { fakeDriver } from "../fixtures/fake-driver";
import { driverName, verify } from "../provider/verify";

const management = ["postgres://app:pw-one@db0.example.com/app", "postgres://app:pw-two@db1.example.com/app"];
const runtime = ["postgres://app:pw-one@pool0.example.com/app", "postgres://app:pw-two@pool1.example.com/app"];
const timing = { afterMs: 1, waitMs: 20, pollMs: 1 };

const handler = (text: string, _params: readonly unknown[], pool: { url: string }) => {
  if (text.includes("pg_backend_pid()") && text.includes("AS pid")) return [{ pid: pool.url.includes("pool") ? 7 : Math.random() }];
  if (text.includes("pg_db_role_setting")) return [{ name: "app", stored: null }];
  if (text.includes("current_setting")) return [{ value: "7777ms" }];
  if (text.includes("has_database_privilege")) return [{ create_schema: true, superuser: false }];
  if (text.includes("pg_stat_activity")) return [{ n: 0 }];
  if (text.includes("version()")) return [{ server: "PostgreSQL 16.4 on x86_64" }];
  return [];
};

test("verify measures every node once and the report never carries URLs, hosts, users or passwords", async () => {
  const fake = fakeDriver(handler);
  const report = await verify(fake.driver, "bun", management, runtime, new Date("2026-10-03T10:00:00Z"), timing);
  expect(report).toMatchObject({ generatedAt: "2026-10-03T10:00:00.000Z", driver: "bun", server: "PostgreSQL 16.4 on x86_64" });
  expect(report.nodes.map((node) => node.id)).toEqual(["db0", "db1"]);
  expect(report.nodes[0]?.probe.runtime).toEqual({ transactionPooler: true });
  expect(report.nodes[0]?.probe.management).toEqual({ transactionPooler: false });
  expect(report.nodes[0]?.alterDatabase).toMatchObject({ allowed: true, newSession: true });
  const text = JSON.stringify(report);
  for (const secret of ["pw-one", "pw-two", "db0.example.com", "pool1.example.com", "postgres://"]) expect(text).not.toContain(secret);
});

test("verify rejects different list lengths before opening any connection", async () => {
  const fake = fakeDriver();
  await expect(verify(fake.driver, "bun", management, runtime.slice(0, 1))).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  expect(fake.pools).toHaveLength(0);
});

test("driverName defaults to bun, accepts the three drivers and rejects anything else", () => {
  expect(driverName([])).toBe("bun");
  expect(driverName(["--driver", "pg"])).toBe("pg");
  expect(driverName(["--driver=postgres"])).toBe("postgres");
  expect(() => driverName(["--driver", "mysql"])).toThrow(expect.objectContaining({ code: "USAGE" }));
  expect(() => driverName(["--driver"])).toThrow(expect.objectContaining({ code: "USAGE" }));
});
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/provider-verify.test.ts`
Expected: FAIL (`Cannot find module '../provider/verify'`).

- [ ] **Step 3: Gerçekleme**

`src/__tests__/provider/verify.ts`:

```ts
/** `bun run verify:provider [--driver bun|postgres|pg]`: yönetilen Postgres'te A'nın sınamasını, `ALTER DATABASE SET`'i, yetkileri ve
 * deadline sonrası sunucu davranışını ölçer; yalnızca JSON basar. Yönetim URL'leri `DATABASE_URLS`'ten, runtime URL'leri gizli
 * girişten gelir (`doctor --pooled-urls` ile aynı biçim). Yalnızca geçici/ücretsiz test veritabanlarında çalıştırın. */
import { loadConfig } from "../../core/config";
import type { Driver } from "../../core/driver";
import { AppError } from "../../core/errors";
import { askSecret, postgresUrl } from "../../core/tools/ask-secret";
import { type AlterDatabaseResult, alterDatabase, type Context, deadline, type DeadlineResult, type PrivilegeResult, privileges, probe, type ProbeResult } from "./measure";

export interface NodeReport {
  id: string;
  probe: { runtime: ProbeResult; management: ProbeResult };
  alterDatabase: AlterDatabaseResult;
  privileges: PrivilegeResult;
  deadline: DeadlineResult;
}
export interface Report {
  generatedAt: string;
  driver: string;
  server: string | null;
  nodes: NodeReport[];
}

const DRIVERS = ["bun", "postgres", "pg"] as const;
type DriverName = (typeof DRIVERS)[number];

export function driverName(argv: readonly string[]): DriverName {
  const index = argv.findIndex((arg) => arg === "--driver" || arg.startsWith("--driver="));
  if (index < 0) return "bun";
  const arg = argv[index] as string;
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1];
  if (!DRIVERS.includes(value as DriverName)) throw new AppError("USAGE", `--driver must be one of ${DRIVERS.join(", ")}`);
  return value as DriverName;
}

async function serverVersion(driver: Driver, url: string): Promise<string | null> {
  const pool = driver(url, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  try {
    return (await pool.query<{ server: string }>("SELECT version() AS server"))[0]?.server ?? null;
  } catch {
    return null;
  } finally {
    await pool.close(1000);
  }
}

/** Düğüm başına ölçümleri sırayla çalıştırır (paralel değil: ölçümler aynı veritabanı ayarına dokunur). */
export async function verify(
  driver: Driver,
  name: string,
  management: readonly string[],
  runtime: readonly string[],
  now = new Date(),
  timing?: Parameters<typeof deadline>[3],
): Promise<Report> {
  if (management.length !== runtime.length) throw new AppError("INVALID_CONFIG", "Runtime URLs must list one URL per DATABASE_URLS entry, in the same order");
  const ctx: Context = { driver, urls: [...management, ...runtime] };
  const nodes: NodeReport[] = [];
  for (const [index, managementUrl] of management.entries()) {
    const runtimeUrl = runtime[index] as string;
    nodes.push({
      id: `db${index}`,
      probe: { runtime: await probe(ctx, runtimeUrl), management: await probe(ctx, managementUrl) },
      alterDatabase: await alterDatabase(ctx, managementUrl, runtimeUrl),
      privileges: await privileges(ctx, managementUrl),
      deadline: await deadline(ctx, runtimeUrl, managementUrl, timing),
    });
  }
  return { generatedAt: now.toISOString(), driver: name, server: await serverVersion(driver, management[0] as string), nodes };
}

if (import.meta.main) {
  const name = driverName(process.argv.slice(2));
  const managementUrls = loadConfig().nodes.map((node) => node.url);
  const answer = await askSecret("Runtime URL'leri (DATABASE_URLS biçimi, virgüllü, yazılan görünmez): ");
  const runtimeUrls = answer.split(",").map((entry) => postgresUrl(entry.trim(), "Runtime URL").href);
  const driver = (await import(`../../core/drivers/${name}`))[`${name}Driver`] as Driver;
  console.log(JSON.stringify(await verify(driver, name, managementUrls, runtimeUrls), null, 2));
}
```

`package.json` `scripts`'e ekle (`bench:spans`'ten sonra):

```json
"verify:provider": "bun src/__tests__/provider/verify.ts",
```

- [ ] **Step 4: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/provider-verify.test.ts src/__tests__/unit/provider-measure.test.ts && bun run typecheck && bun run lint`
Expected: PASS (toplam 14); typecheck ve lint temiz.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/provider/verify.ts src/__tests__/unit/provider-verify.test.ts package.json
git commit -m "verify:provider: per-node report and CLI entry (hidden runtime URLs, no new env)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 5: Yerel stack'e karşı entegrasyon testi

**Files:**
- Test: `src/__tests__/integration/provider-verify.test.ts`

**Interfaces:**
- Consumes: `verify` (Task 4); `directConfig`, `pooledConfig`, `driver`, `integration`, `raw` (`src/__tests__/integration/helpers.ts`).

- [ ] **Step 1: Testi yaz**

```ts
import { expect } from "bun:test";
import { directConfig, driver, integration, pooledConfig, raw } from "./helpers";
import { verify } from "../provider/verify";

const STORED = "SELECT s AS stored FROM pg_catalog.pg_db_role_setting r, pg_catalog.unnest(r.setconfig) AS s WHERE r.setrole=0 AND r.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND s LIKE 'statement_timeout=%'";

integration("verify:provider against local PgBouncer: probes, ALTER DATABASE round trip restores the stored value, deadline drops the backend", async () => {
  const management = directConfig().nodes.map((node) => node.url);
  const runtime = pooledConfig().nodes.map((node) => node.url);
  const db = raw(0);
  const before = await db.query(STORED);
  try {
    const report = await verify(driver, "test", management, runtime);
    const [first] = report.nodes;
    expect(first?.probe.runtime).toEqual({ transactionPooler: true });
    expect(first?.probe.management).toEqual({ transactionPooler: false });
    expect(first?.alterDatabase).toMatchObject({ allowed: true, newSession: true });
    expect(first?.alterDatabase.restoreSql).toBeUndefined();
    expect(first?.privileges).toMatchObject({ createSchema: true });
    expect(first?.deadline).toMatchObject({ observedRunning: true });
    expect(first?.deadline.serverStoppedAfterMs).not.toBeNull();
    expect(await db.query(STORED)).toEqual(before);
    const text = JSON.stringify(report);
    for (const url of [...management, ...runtime]) expect(text).not.toContain(new URL(url).password);
  } finally {
    await db.close();
  }
});
```

(`db.query`/`db.close` imza uyumunu `raw()`'ın döndürdüğü `connect(...)` nesnesine göre ayarla; başka testlerde `raw(0)` kullanımına bak: `grep -n "raw(" src/__tests__/integration/*.test.ts | head`.)

- [ ] **Step 2: İzole stack'e karşı çalıştır**

Run: `bash -c ". $SCRATCH/dbprov/env.sh && for d in bun postgres pg; do echo == \$d; DB_DRIVER=\$d bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/provider-verify.test.ts; done"`
Expected: üç sürücüde PASS. Başarısızlık gerçek bir bulgudur (ör. PgBouncer bağlantıyı bırakınca backend durmuyorsa `serverStoppedAfterMs` null): önce sistematik hata ayıkla, testin beklentisini gevşetme; sapma gerçek davranışsa ledger'a `Ruling:` ve `docs/providers.md`'ye not düş.

- [ ] **Step 3: Tüm birim paketi**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: yeşil (A'nın 242 testi + yeni 14).

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/integration/provider-verify.test.ts
git commit -m "integration: verify:provider against local PgBouncer on three drivers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 6: `docs/providers.md` ve belge bağlantıları

**Files:**
- Create: `docs/providers.md`
- Modify: `docs/README.md`, `README.md`, `docs/cli.md`

**Interfaces:**
- Consumes: Task 4'ün çıktı şeması ve komutu.

- [ ] **Step 1: `docs/providers.md`'yi yaz**

İçerik (Türkçe): (a) başlık "Yönetilen Postgres sağlayıcıları" ve "bu belgedeki her satırın doğrulama durumu"; (b) URL türü → rol matrisi tablosu, sütunlar `Sağlayıcı / URL türü / Kullanım (runtime, yönetim) / Durum`:

| Sağlayıcı | URL türü | Kullanım | Durum |
|---|---|---|---|
| Neon | direct (`ep-…`, `-pooler` yok) | yönetim (advisory lock, `bootstrap`, CLI) | documented, not verified |
| Neon | `-pooler` (PgBouncer, transaction) | runtime | documented, not verified |
| Supabase | direct `db.<ref>.supabase.co:5432` (yalnızca IPv6, IPv4 eklentisi ücretli) | yönetim (IPv6 ağı varsa) | documented, not verified |
| Supabase | Supavisor session `…pooler.supabase.com:5432` (kullanıcı `postgres.<ref>`) | yönetim (IPv4) | documented, not verified |
| Supabase | Supavisor transaction `…pooler.supabase.com:6543` | runtime | documented, not verified |
| Supabase | ayrılmış PgBouncer `db.<ref>.supabase.co:6543` (ücretli plan) | runtime | documented, not verified |
| Hyperdrive | Workers binding | runtime (`pooler: "assumed"` önerilir; sınama yanlış negatif verebilir) | documented, not verified |

(c) "Doğrulama" bölümü: `bun run verify:provider [--driver bun|postgres|pg]` (yönetim URL'leri `DATABASE_URLS`, runtime URL'leri gizli girişle; yalnızca ücretsiz/geçici veritabanı; çıktı yalnızca JSON, URL/host/kullanıcı/parola yok), her alanın anlamı (`probe.runtime` `true`, `probe.management` `false` beklenir; `alterDatabase.allowed/newSession/throughRuntime` ve `throughRuntime: false`'un pooler'ın mevcut sunucu bağlantılarını yeniden kullanmasından olabileceği; `privileges`; `deadline.cancelDefined/serverStoppedAfterMs`), `doctor --pooled-urls` ile birlikte kullanım ve `direct_connection` denetiminin doctor'da olduğu; (d) "Sağlayıcı kararları" tablosu (spec karar tablosu: sınama yanlış negatifse `assumed`, `ALTER DATABASE` reddedilirse `PROVIDER_PRIVILEGE` yalnızca ölçüldüyse, Supabase IPv6 → session pooler, deadline sonrası backend sürerse `neonDriver` sınırı); (e) "Sınırlar": Supabase PITR tüm projeyi yerinde ve kesintiyle geri yükler, tenant bazında geri yükleme yok; Neon HTTP `neon()` kapsam dışı.

- [ ] **Step 2: Bağlantıları ekle**

`docs/README.md` içindekiler listesine `providers.md` (okuma sırasında `operations.md`'den sonra), `README.md` bağlantı satırına `[Sağlayıcılar](docs/providers.md)`, `docs/cli.md`'de `bun run verify:provider` satırını betik tablosuna (`test:integration` satırının yanına; `--driver` seçeneği ve "gizli girişle runtime URL'leri" notu).

- [ ] **Step 3: Doğrula**

Run: `grep -n "providers.md" README.md docs/README.md && bun run lint`
Expected: üç dosyada bağlantı bulunur; lint temiz.

- [ ] **Step 4: Commit**

```bash
git add docs/providers.md docs/README.md README.md docs/cli.md
git commit -m "docs: providers matrix and verify:provider usage (all rows documented, not verified)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 7: Sahip koşusu ve sonuçların işlenmesi (sahibe bağlı)

Bu görev sahibin ücretsiz hesaplarını gerektirir; kod yazmadan önce çıktı gelmelidir. Plan burada durur ve sahibe sorar.

- [ ] **Step 1: Sahibe talimat ver**

Mesaj: Neon ve Supabase ücretsiz projeleri için şunları çalıştırın (parola sohbete girmez):

```bash
DATABASE_URLS='<yönetim URL'leri: Neon direct / Supabase session pooler veya direct>' bun run verify:provider
```

İstemde runtime URL'lerini (Neon `-pooler`, Supabase transaction :6543) girin; çıktıdaki JSON'u buraya yapıştırın (içinde URL, host, parola yok). Aynı komutu `--driver pg` ile de çalıştırmanız yeterlidir; Neon ve Supabase için ayrı birer koşu.

- [ ] **Step 2: Gelen JSON'dan `docs/providers.md` satırlarını güncelle**

Her satırın durumunu `verified (<tarih>, <sürücü>)` yap, ölçülen değerleri (probe sonuçları, `ALTER DATABASE` sonucu, deadline süresi) satırın altına işle. Ölçüm beklenenden saparsa (ör. probe `false`, `allowed: false`, `serverStoppedAfterMs: null`) spec'in karar tablosundaki eylemi uygula; kod değişikliği gerekiyorsa **önce bu plana bir ek görev ve test yaz** (RED→GREEN), sonra uygula. Sapma yoksa yalnızca belge güncellenir.

- [ ] **Step 3: Doğrula ve commit**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: yeşil.

```bash
git add docs/providers.md
git commit -m "docs: providers matrix updated with measured Neon and Supabase results

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 8: Temizlik

- [ ] **Step 1: İzole stack'i kapat**

Run: `docker compose -f "$SCRATCH/dbprov/compose.yaml" down -v`
Expected: `dbprov` konteynerleri ve volume'ları kalkar; jamaster stack'i etkilenmez (`docker ps` ile 5540/5541/5543 hâlâ çalışıyor).
