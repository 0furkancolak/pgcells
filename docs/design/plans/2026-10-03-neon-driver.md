# Neon serverless sürücüsü (B2) Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@repo/db/drivers/neon` sürücüsünü eklemek: Neon'un WebSocket `Pool`'u `Driver` sözleşmesine, `pg.ts` ile ortak bir fabrikadan uydurulur.

**Architecture:** `pg.ts`'teki havuz mantığı `createPgDriver(module, { cancel? })` fabrikasına (`src/core/pg-pool.ts`, `pg`'yi içe aktarmaz) çıkarılır. `pgDriver` bu fabrikanın `cancel` seçenekli çağrısı, `neonDriver` `cancel`'sız çağrısıdır. Yerel test, compose'a eklenen `wsproxy` konteyneri üzerinden yerel Postgres/PgBouncer'a gider; gerçek Neon koşusu B1'in `verify:provider --driver neon` komutudur.

**Tech Stack:** Bun, TypeScript, `@neondatabase/serverless` 1.2.0 (isteğe bağlı peer), `ghcr.io/neondatabase/wsproxy` (yalnızca yerel test), wrangler dry-run.

**Spec:** `docs/superpowers/specs/2026-10-03-neon-supabase-design.md` (bölüm B2)

## Global Constraints

- `neonDriver` yalnızca runtime sürücüsüdür; yönetim (advisory lock) pg/postgres/bun sürücüsü ve doğrudan URL ile çalışır.
- `neonDriver` `cancel` tanımlamaz (`Reserved.cancel?` isteğe bağlı sözleşme).
- Neon HTTP `neon()` fonksiyonu kapsam dışı.
- `@neondatabase/serverless` isteğe bağlı peer bağımlılıktır; `pg` ve `postgres` gibi `build` betiğinde `--external`.
- `src/core/pg-pool.ts` `pg` ve `@neondatabase/serverless`'i içe aktarmaz.
- Yeni ortam değişkeni yok; yerel wsproxy sabit bir portta (5488) çalışır.
- Yorumlar Türkçe, hata mesajları İngilizce; yakındaki kodun yorum yoğunluğu ve adlandırması korunur.
- Commit sonuna: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push ve PR yok.
- Shared jamaster docker stack'ine (5540/5541/5543) dokunulmaz; entegrasyon yalnızca izole `dbprov` stack'inde çalışır (B1 Task 0 dosyaları).
- Mevcut davranış korunur: `pgDriver` için 111 entegrasyon testi ve 242+ birim testi yeşil kalır.

## Review Focus

- Refaktör sonrası `pgDriver` bağlantısı ödünçteyken hata verdiyse havuza dönmemeli (`release(true)`); `onClose` bağlantı başına bir kez çağrılmalı (Task 1 testleri).
- `neonDriver` hiçbir bağlantıda `cancel` göstermemeli; `release(true)` ile atılan meşgul bağlantının backend'i sunucuda bitmeli (Task 1, Task 3 testleri).
- Tür ayrıştırıcıları Neon'da da aynı: `date` UTC gece yarısı `Date`, `interval` metin (Task 1, Task 3 `drivers.test.ts` döngüsü).
- İkinci `close()` havuzu ikinci kez kapatmamalı, `end()` hiç dönmese de `close(ms)` sınırlı sürede dönmeli (Task 1).
- `build` çıktısı ve Workers dry-run `@neondatabase/serverless`'i beklenen şekilde (build: external, Workers: pakete dahil) ele almalı (Task 4).

---

## Dosya yapısı

- Create: `src/core/pg-pool.ts`: ortak fabrika ve minimal `pg` yüzey türleri.
- Modify: `src/core/drivers/pg.ts`: fabrikaya ince sarmalayıcı.
- Create: `src/core/drivers/neon.ts`: `neonDriver`.
- Create: `src/__tests__/unit/pg-pool.test.ts`, `src/__tests__/unit/neon.test.ts`, `src/__tests__/integration/neon-driver.test.ts`.
- Modify: `src/__tests__/integration/helpers.ts` (`drivers` haritasına `neon`, yerel wsproxy ayarı), `compose.yaml` (`wsproxy`), `package.json` (bağımlılık, peer, `build`), `src/__tests__/fixtures/worker.ts`, `src/__tests__/provider/verify.ts` ve testi, `docs/configuration.md`, `docs/providers.md`, `docs/cli.md`.

Tüm yollar `packages/db`'ye göredir; komutlar `packages/db` içinde çalışır. Dal: `feat/provider-support` (B1'den devam; B1 tamamlanmadan B2 başlamaz).

### Task 1: Ortak fabrika `createPgDriver` ve `pgDriver` refaktörü

**Files:**
- Create: `src/core/pg-pool.ts`
- Modify: `src/core/drivers/pg.ts`
- Test: `src/__tests__/unit/pg-pool.test.ts`

**Interfaces:**
- Produces:
  - `interface PgClient { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>; release(error?: Error | boolean): void; on(event: "end" | "error", listener: () => void): unknown }`
  - `interface PgPool { query(...same); connect(): Promise<PgClient>; on(event: "error" | "connect", listener: (client: PgClient) => void): unknown; end(): Promise<void> }`
  - `interface PgPoolConfig { connectionString: string; max: number; idleTimeoutMillis: number; maxLifetimeSeconds: number; connectionTimeoutMillis: number; types: { getTypeParser(oid: number, format?: "text" | "binary"): unknown } }`
  - `interface PgModule { Pool: new (config: PgPoolConfig) => PgPool; types: { getTypeParser(oid: number, format?: "text" | "binary"): unknown } }`
  - `interface PgDriverOptions { cancel?(client: PgClient, url: string): void }`
  - `createPgDriver(module: PgModule, options?: PgDriverOptions): Driver`

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/pg-pool.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { PoolOptions } from "../../core/driver";
import { createPgDriver, type PgModule, type PgPoolConfig } from "../../core/pg-pool";

type Listener = (...args: unknown[]) => void;
const url = "postgres://app:pw@db.example.com/app";
const options: PoolOptions = { max: 4, idleTimeoutSeconds: 20, maxLifetimeSeconds: 300, connectTimeoutSeconds: 10 };

class Emitter {
  listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}
class FakeClient extends Emitter {
  released: unknown[] = [];
  queries: { text: string; values?: unknown[] }[] = [];
  query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    return Promise.resolve({ rows: [{ a: 1 }], rowCount: 3 });
  }
  release(arg?: unknown) {
    this.released.push(arg);
  }
}

function fakeModule() {
  const pools: FakePool[] = [];
  class FakePool extends Emitter {
    clients: FakeClient[] = [];
    queries: { text: string; values?: unknown[] }[] = [];
    ended = 0;
    endResult: Promise<void> = Promise.resolve();
    constructor(public config: PgPoolConfig) {
      super();
      pools.push(this);
    }
    query(text: string, values?: unknown[]) {
      this.queries.push({ text, values });
      return Promise.resolve({ rows: [{ a: 1 }], rowCount: 3 });
    }
    async connect() {
      const client = new FakeClient();
      this.clients.push(client);
      this.emit("connect", client);
      return client;
    }
    end() {
      this.ended++;
      return this.endResult;
    }
  }
  const module = { Pool: FakePool, types: { getTypeParser: (oid: number) => `parser-${oid}` } } as unknown as PgModule;
  return { module, pools };
}

test("pool options map to the pg config and queries return rows with the affected count", async () => {
  const { module, pools } = fakeModule();
  const pool = createPgDriver(module)(url, options);
  expect(pools[0]?.config).toMatchObject({ connectionString: url, max: 4, idleTimeoutMillis: 20_000, maxLifetimeSeconds: 300, connectionTimeoutMillis: 10_000 });
  const rows = await pool.query("SELECT $1::timestamptz", [new Date("2026-01-02T03:04:05.000Z")]);
  expect(rows).toEqual([{ a: 1 }]);
  expect(rows.count).toBe(3);
  expect(pools[0]?.queries[0]?.values).toEqual(["2026-01-02T03:04:05.000Z"]);
  await pool.exec("CREATE TABLE t(id int)");
  expect(pools[0]?.queries[1]).toEqual({ text: "CREATE TABLE t(id int)", values: undefined });
});

test("date parses to UTC midnight, interval stays text and every other type goes to the module", () => {
  const { module, pools } = fakeModule();
  createPgDriver(module)(url, options);
  const { types } = (pools[0] as { config: PgPoolConfig }).config;
  expect(types.getTypeParser(1082)).toBeInstanceOf(Function);
  expect((types.getTypeParser(1082) as (value: string) => unknown)("2024-01-02")).toEqual(new Date("2024-01-02T00:00:00Z"));
  expect((types.getTypeParser(1186) as (value: string) => unknown)("1 day")).toBe("1 day");
  expect(types.getTypeParser(23)).toBe("parser-23");
});

test("a released connection returns to the pool, a discarded or broken one is thrown away", async () => {
  const { module, pools } = fakeModule();
  const pool = createPgDriver(module)(url, options);
  const [first, second, third] = [await pool.reserve(), await pool.reserve(), await pool.reserve()];
  first.release();
  second.release(true);
  pools[0]?.clients[2]?.emit("error", new Error("socket reset"));
  third.release();
  expect(pools[0]?.clients.map((client) => client.released)).toEqual([[false], [true], [true]]);
});

test("onClose runs once per client that ends and an idle pool error does not throw", async () => {
  const { module, pools } = fakeModule();
  let closed = 0;
  const pool = createPgDriver(module)(url, { ...options, onClose: () => closed++ });
  const reserved = await pool.reserve();
  pools[0]?.clients[0]?.emit("end");
  expect(closed).toBe(1);
  reserved.release();
  expect(() => pools[0]?.emit("error", new Error("idle client error"))).not.toThrow();
});

test("cancel exists only when the driver was given one, and it receives the client and URL", async () => {
  const { module, pools } = fakeModule();
  expect("cancel" in (await createPgDriver(module)(url, options).reserve())).toBe(false);
  const calls: unknown[][] = [];
  const reserved = await createPgDriver(module, { cancel: (client, target) => calls.push([client, target]) })(url, options).reserve();
  reserved.cancel?.();
  expect(calls).toEqual([[pools[1]?.clients[0], url]]);
});

test("close ends the pool once and returns within the bound even when end() never settles", async () => {
  const { module, pools } = fakeModule();
  const pool = createPgDriver(module)(url, options);
  (pools[0] as { endResult: Promise<void> }).endResult = new Promise(() => {});
  const started = performance.now();
  await pool.close(20);
  await pool.close(20);
  expect(performance.now() - started).toBeLessThan(500);
  expect(pools[0]?.ended).toBe(1);
});
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/pg-pool.test.ts`
Expected: FAIL (`Cannot find module '../../core/pg-pool'`).

- [ ] **Step 3: `src/core/pg-pool.ts`'yi yaz (mantık `pg.ts`'ten taşınır)**

```ts
/** `pg` uyumlu havuz sürücüsü fabrikası: node-postgres (`drivers/pg.ts`) ve Neon serverless (`drivers/neon.ts`) aynı yüzeyi sunar.
 * Bu dosya `pg`'yi veya `@neondatabase/serverless`'i içe aktarmaz: isteğe bağlı peer'ler birbirinin (ve Workers paketinin) bağımlılığı olmasın. */
import { type Connection, type Driver, normalizeParams, withTimeout } from "./driver";

interface QueryResult {
  rows: unknown[];
  rowCount?: number | null;
}
export interface PgClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(error?: Error | boolean): void;
  on(event: "end" | "error", listener: () => void): unknown;
}
export interface PgPool {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  connect(): Promise<PgClient>;
  on(event: "error" | "connect", listener: (client: PgClient) => void): unknown;
  end(): Promise<void>;
}
type TypeParsers = { getTypeParser(oid: number, format?: "text" | "binary"): unknown };
export interface PgPoolConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  maxLifetimeSeconds: number;
  connectionTimeoutMillis: number;
  types: TypeParsers;
}
/** `pg` modülünün (veya Neon'un) bu fabrikanın kullandığı yüzeyi; iki paketin tipleri farklı bildirildiği için çağıran `as unknown as PgModule` ile verir. */
export interface PgModule {
  Pool: new (config: PgPoolConfig) => PgPool;
  types: TypeParsers;
}
export interface PgDriverOptions {
  /** İstemcinin çalışan deyimini sunucuda iptal eder; verilmezse `Reserved.cancel` tanımlanmaz (deadline sonrası bağlantı atılır). */
  cancel?(client: PgClient, url: string): void;
}

// Diğer sürücülerle aynı değerler: date UTC gece yarısı `Date`, interval metin. Global parser'lara dokunulmaz.
const overrides: Record<number, (value: string) => unknown> = {
  1082: (value) => new Date(`${value}T00:00:00Z`),
  1186: (value) => value,
};

function connection(client: Pick<PgPool, "query">): Connection {
  return {
    // Parametresiz sorgu simple protocol ile gider; parametreli sorgu isimsiz statement kullanır.
    query: async <R>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, normalizeParams(values));
      const rows = result.rows as R[] & { count?: number };
      rows.count = result.rowCount ?? undefined;
      return rows;
    },
    exec: async (text) => {
      await client.query(text);
    },
  };
}

export function createPgDriver(module: PgModule, { cancel }: PgDriverOptions = {}): Driver {
  const types: TypeParsers = { getTypeParser: (oid, format) => overrides[oid] ?? module.types.getTypeParser(oid, format) };
  return (url, options) => {
    const pool = new module.Pool({
      connectionString: url,
      max: options.max,
      idleTimeoutMillis: options.idleTimeoutSeconds * 1000,
      maxLifetimeSeconds: options.maxLifetimeSeconds,
      connectionTimeoutMillis: options.connectTimeoutSeconds * 1000,
      types,
    });
    // Boştaki bağlantı hatası süreci düşürmemeli; bağlantı havuzdan zaten atılır.
    pool.on("error", () => {});
    // Ödünçteyken hata veren bağlantı bırakılırken atılır. Dinleyici bağlantı başına bir kez eklenir (ödünç başına değil).
    const broken = new WeakSet<PgClient>();
    pool.on("connect", (client) => {
      client.on("end", () => options.onClose?.());
      client.on("error", () => broken.add(client));
    });
    // pg-pool ikinci end() çağrısında fırlatır; bağlantı kaybı havuzu kapattıktan sonra oturumlar yine kapanabilir.
    let ending: Promise<void> | undefined;
    return {
      ...connection(pool),
      async reserve() {
        const client = await pool.connect();
        return {
          ...connection(client),
          ...(cancel ? { cancel: () => cancel(client, url) } : {}),
          release: (discard) => client.release(broken.has(client) || discard === true),
        };
      },
      close: (ms) => withTimeout((ending ??= pool.end().catch(() => {})), ms),
    };
  };
}
```

- [ ] **Step 4: `src/core/drivers/pg.ts`'yi sarmalayıcıya indir**

```ts
/** node-postgres sürücüsü (isteğe bağlı peer `pg`); Node, Bun ve Cloudflare Workers (`nodejs_compat`) ile çalışır. Mantık
 * `core/pg-pool.ts` fabrikasındadır; yalnızca sunucuda iptal burada tanımlıdır. */
import pg from "pg";
import { createPgDriver, type PgModule } from "../pg-pool";

export const pgDriver = createPgDriver(pg as unknown as PgModule, {
  // `Client#cancel` ayrı bir bağlantıdan CancelRequest gönderir; çalışan sorgu 57014 ile döner.
  cancel: (client, url) => {
    const active = (client as unknown as { _activeQuery?: unknown })._activeQuery;
    if (!active) return;
    const canceller = new pg.Client({ connectionString: url }) as unknown as { connection: { on(event: string, listener: () => void): void }; cancel(client: unknown, query: unknown): void };
    canceller.connection.on("error", () => {});
    canceller.cancel(client, active);
  },
});
```

- [ ] **Step 5: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/pg-pool.test.ts && bun run typecheck && bun run lint && bun run test`
Expected: pg-pool testleri PASS 6/6; typecheck ve lint temiz; tüm birim paketi yeşil.

- [ ] **Step 6: Regresyon: `pg` sürücüsü entegrasyonu**

Run: `bash -c ". $SCRATCH/dbprov/env.sh && DB_DRIVER=pg bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts \$(ls src/__tests__/integration/*.test.ts | grep -v deadline-matrix)"`
Expected: 111/111 PASS (A'daki sonuçla aynı), leak guard temiz.

- [ ] **Step 7: Commit**

```bash
git add src/core/pg-pool.ts src/core/drivers/pg.ts src/__tests__/unit/pg-pool.test.ts
git commit -m "drivers: createPgDriver factory shared by pg and the upcoming Neon driver

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 2: `neonDriver`, bağımlılık ve build girişi

**Files:**
- Create: `src/core/drivers/neon.ts`
- Test: `src/__tests__/unit/neon.test.ts`
- Modify: `package.json`, `../../bun.lock`

**Interfaces:**
- Consumes: `createPgDriver`, `PgModule` (Task 1).
- Produces: `neonDriver: Driver` (`@repo/db/drivers/neon`).

- [ ] **Step 1: Bağımlılığı ekle**

Run: `bun add -d @neondatabase/serverless@1.2.0 --exact`
Expected: `package.json` `devDependencies`'e `"@neondatabase/serverless": "1.2.0"` eklenir, kök `bun.lock` güncellenir.

`package.json`'a elle ekle: `peerDependencies` içine `"@neondatabase/serverless": "^1.2.0"` ve `peerDependenciesMeta` içine `"@neondatabase/serverless": { "optional": true }`. `build` betiğine `src/core/drivers/neon.ts` girişini (`src/core/drivers/pg.ts`'ten sonra) ve `--external @neondatabase/serverless` ekle.

- [ ] **Step 2: Başarısız testi yaz**

`src/__tests__/unit/neon.test.ts`:

```ts
import { Pool, types } from "@neondatabase/serverless";
import { expect, test } from "bun:test";
import { neonDriver } from "../../core/drivers/neon";

test("the Neon module offers the surface createPgDriver relies on", () => {
  expect(typeof Pool).toBe("function");
  expect(typeof types.getTypeParser).toBe("function");
  for (const method of ["connect", "query", "end", "on"]) expect(typeof (Pool.prototype as unknown as Record<string, unknown>)[method], method).toBe("function");
});

test("neonDriver builds a lazy pool: nothing connects until it is used and close returns", async () => {
  const pool = neonDriver("postgres://app:pw@ep-cool-1.eu-central-1.aws.neon.tech/neondb?sslmode=require", {
    max: 1,
    idleTimeoutSeconds: 1,
    maxLifetimeSeconds: 0,
    connectTimeoutSeconds: 5,
  });
  await pool.close(1000);
});
```

- [ ] **Step 3: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/neon.test.ts`
Expected: FAIL (`Cannot find module '../../core/drivers/neon'`).

- [ ] **Step 4: Gerçekle**

`src/core/drivers/neon.ts`:

```ts
/** Neon serverless sürücüsü (isteğe bağlı peer `@neondatabase/serverless`): WebSocket `Pool`, pg uyumlu; Workers/edge runtime'ı içindir.
 * Yalnızca runtime: yönetim (advisory lock) pg/postgres/bun sürücüsü ve doğrudan URL ister. `cancel` tanımlı değildir: Neon istemcisinin
 * iptali yeni bir TCP bağlantısı açar, Workers'ta TCP yok. Deadline sonrası bağlantı atılır, sunucu deyimi `client_connection_check_interval`
 * ile keser (Bun SQL ile aynı sözleşme). WebSocket'ler tek isteği aşamaz: `Pool` istek içinde açılıp kapatılır (`poolMax: 1`). */
import { Pool, types } from "@neondatabase/serverless";
import { createPgDriver, type PgModule } from "../pg-pool";

export const neonDriver = createPgDriver({ Pool, types } as unknown as PgModule);
```

- [ ] **Step 5: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/neon.test.ts && bun run typecheck && bun run lint && bun run build`
Expected: PASS 2/2; typecheck ve lint temiz; `bun run build` `dist/core/drivers/neon.js`'i üretir (`ls dist/core/drivers/neon.js` başarılı) ve `@neondatabase/serverless` dışarıda kalır (`grep -c '@neondatabase/serverless' dist/core/drivers/neon.js` en az 1 içe aktarma satırı verir, dosya birkaç KB'tan büyük değildir).

- [ ] **Step 6: Commit**

```bash
git add src/core/drivers/neon.ts src/__tests__/unit/neon.test.ts package.json ../../bun.lock
git commit -m "drivers: neonDriver (optional peer @neondatabase/serverless), build entry and external

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 3: Yerel wsproxy ile entegrasyon (uyumluluk döngüsü ve backend sonlanması)

**Files:**
- Modify: `compose.yaml`, `src/__tests__/integration/helpers.ts`
- Create: `src/__tests__/integration/neon-driver.test.ts`
- Repo dışı: `$SCRATCH/dbprov/compose.yaml`

**Interfaces:**
- Consumes: `neonDriver` (Task 2); `drivers`, `raw`, `integration`, `directConfig` (`helpers.ts`).
- Produces: `drivers.neon` (`DB_DRIVER=neon` ve `drivers.test.ts` döngüsü).

- [ ] **Step 1: wsproxy servisini ekle**

`compose.yaml` `services`'e (pgbouncer'dan sonra) ekle:

```yaml
  # Yalnızca yerel test: Neon sürücüsü (WebSocket) ana makinenin Postgres/PgBouncer portlarına bu proxy üzerinden bağlanır.
  wsproxy:
    image: ghcr.io/neondatabase/wsproxy@sha256:7f2e2149aa6a57ba382a140102fba44f5053f3e44389ccc18adcecf896054efb
    environment: {ALLOW_ADDR_REGEX: '.*'}
    extra_hosts: ['host.docker.internal:host-gateway']
    ports: ['127.0.0.1:5488:80']
```

`$SCRATCH/dbprov/compose.yaml`'e aynı servisi ekle (`ports: ['127.0.0.1:5488:80']`; proxy ana makinenin 15540/15541/15543 portlarına `host.docker.internal` üzerinden ulaşır). Sonra: `REPO=$(git rev-parse --show-toplevel) docker compose -f "$SCRATCH/dbprov/compose.yaml" up -d --wait wsproxy`.
Expected: `docker ps` `dbprov-wsproxy-1`'i `127.0.0.1:5488->80/tcp` ile gösterir.

- [ ] **Step 2: Başarısız entegrasyon testini yaz**

`src/__tests__/integration/neon-driver.test.ts`:

```ts
import { expect } from "bun:test";
import { neonDriver } from "../../core/drivers/neon";
import { directConfig, integration, raw } from "./helpers";

const pids = (admin: ReturnType<typeof raw>, pid: number) => admin.query<{ n: number }>("SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1", [pid]);

integration("neon: reserved connections carry no cancel, and discarding a busy connection ends its backend on the server", async () => {
  const url = directConfig().nodes[0]?.url as string;
  const pool = neonDriver(url, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  const admin = raw(0);
  try {
    const reserved = await pool.reserve();
    expect("cancel" in reserved).toBe(false);
    const pid = Number((await reserved.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]?.pid);
    await reserved.exec("SET client_connection_check_interval = 500");
    void reserved.exec("SELECT pg_sleep(30)").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await pids(admin, pid))[0]?.n).toBe(1);
    reserved.release(true);
    const deadline = Date.now() + 10_000;
    let alive = 1;
    while (alive > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      alive = (await pids(admin, pid))[0]?.n ?? 0;
    }
    expect(alive).toBe(0);
  } finally {
    await pool.close(1000);
    await admin.close();
  }
});
```

- [ ] **Step 3: Çalıştır, başarısız olduğunu gör (proxy ayarı yokken)**

`helpers.ts` henüz değişmeden çalıştır: `bash -c ". $SCRATCH/dbprov/env.sh && bun test --timeout 60000 src/__tests__/integration/neon-driver.test.ts"`
Expected: FAIL: Neon istemcisi `wss://<host>/v2`'ye gider ve bağlanamaz (`ENOTFOUND` / bağlantı hatası); bu, wsproxy ayarının neden gerektiğini gösterir.

- [ ] **Step 4: `helpers.ts`'e `neon` sürücüsünü ve yerel proxy ayarını ekle**

```ts
import { neonConfig } from "@neondatabase/serverless";
import { neonDriver } from "../../core/drivers/neon";

// Yerel wsproxy (compose `wsproxy`): Neon istemcisi `host:port` yerine yerel proxy'ye WebSocket açar; proxy ana makinenin Postgres/PgBouncer
// portlarına iletir. Gerçek Neon'a karşı çalışma `verify:provider --driver neon`'dur.
neonConfig.useSecureWebSocket = false;
neonConfig.pipelineConnect = false;
neonConfig.wsProxy = (host, port) => `127.0.0.1:5488/v1?address=${["127.0.0.1", "localhost"].includes(host) ? "host.docker.internal" : host}:${port}`;

export const drivers: Record<string, Driver> = { bun: bunDriver, postgres: postgresDriver, pg: pgDriver, neon: neonDriver };
```

(Mevcut `drivers` bildiriminin yerine; importlar mevcut gruplara eklenir.)

- [ ] **Step 5: Çalıştır, geçtiğini gör (helper değişikliğinden sonra)**

Run: `bash -c ". $SCRATCH/dbprov/env.sh && bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/neon-driver.test.ts src/__tests__/integration/drivers.test.ts"`
Expected: PASS; `drivers.test.ts` `neon` için üç testi (değer türleri, timeout/SQLSTATE, pooled yönetim `DIRECT_CONNECTION_REQUIRED`) de çalıştırır ve geçer. Başarısızlık gerçek bulgudur: sistematik hata ayıkla; test beklentisini gevşetme. Sapma sürücü sözleşmesinden geliyorsa (ör. tür ayrıştırıcıları) `pg-pool.ts`'i düzelt ve Task 1'e test ekle.

- [ ] **Step 6: Tüm paket `DB_DRIVER=neon` ile**

Run: `bash -c ". $SCRATCH/dbprov/env.sh && DB_DRIVER=neon bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts \$(ls src/__tests__/integration/*.test.ts | grep -v deadline-matrix)"`
Expected: 111/111 + yeni testler PASS (Bun SQL de `cancel`'sızdır ve aynı paket onda geçiyor; Neon aynı sözleşmeyi karşılamalı). Başarısız bir test varsa: nedeni sistematik bul. Yalnızca `cancel` yokluğundan değil Neon istemcisinin davranışından (ör. WebSocket kapanışı, `application_name` URL parametresi) kaynaklanıyorsa düzeltme `pg-pool.ts`'te veya testte (gerekçeyle ledger `Ruling:`) yapılır; test beklentisi sürücü adına bağlanarak gevşetilmez.

- [ ] **Step 7: Diğer sürücülerde regresyon ve birim**

Run: `bun run test && bash -c ". $SCRATCH/dbprov/env.sh && for d in bun postgres pg; do DB_DRIVER=\$d bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration/drivers.test.ts; done"`
Expected: yeşil.

- [ ] **Step 8: Commit**

```bash
git add compose.yaml src/__tests__/integration/helpers.ts src/__tests__/integration/neon-driver.test.ts
git commit -m "integration: neon driver through a local wsproxy (conformance loop, discard ends the backend)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 4: Workers paketi, `verify:provider --driver neon`

**Files:**
- Modify: `src/__tests__/fixtures/worker.ts`, `src/__tests__/provider/verify.ts`
- Test: `src/__tests__/unit/provider-verify.test.ts`

**Interfaces:**
- Consumes: `neonDriver`; B1'in `driverName`, `DRIVERS`.

- [ ] **Step 1: `verify.ts` sürücü testini genişlet (RED)**

`provider-verify.test.ts`'teki `driverName` testine ekle: `expect(driverName(["--driver", "neon"])).toBe("neon");` ve `expect(() => driverName(["--driver", "mysql"])).toThrow(...)` mevcut satırı koru.

Run: `bun test src/__tests__/unit/provider-verify.test.ts`
Expected: FAIL (`--driver must be one of bun, postgres, pg`).

- [ ] **Step 2: GREEN**

`src/__tests__/provider/verify.ts`'te `DRIVERS = ["bun", "postgres", "pg", "neon"] as const` yap. Dosya başı yorumdaki seçenek listesini `bun|postgres|pg|neon` olarak güncelle (`await import(\`../../core/drivers/${name}\`)` ve `${name}Driver` adlandırması `neonDriver`'ı zaten çözer).

Run: `bun test src/__tests__/unit/provider-verify.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Workers fixture'ı Neon'u da paketlesin**

`src/__tests__/fixtures/worker.ts`'e `import { neonDriver } from "../../core/drivers/neon";` ekle ve sürücü seçimini ortama bağla:

```ts
/** `DRIVER=neon` Neon serverless sürücüsünü (WebSocket), aksi halde Hyperdrive için postgres.js'i seçer. */
const driverFor = (env: Env) => (env.DRIVER === "neon" ? neonDriver : postgresDriver);
```

`createDatabase(workerConfig(env), { driver: postgresDriver, poolMax: 1 })` çağrısını `{ driver: driverFor(env), poolMax: 1 }` yap; dosya başı açıklamaya "ve Neon serverless sürücüsünü" ekle.

Run: `bun run build:workers`
Expected: wrangler dry-run başarılı; çıktıda toplam bundle boyutu satırı görünür ve hata yok (`@neondatabase/serverless` pakete girer; Workers `nodejs_compat` ile çalışır).

- [ ] **Step 4: Tüm doğrulamalar**

Run: `bun run test && bun run typecheck && bun run lint && bun run build && bun run build:workers && bun run codegen --check`
Expected: hepsi yeşil/temiz.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/fixtures/worker.ts src/__tests__/provider/verify.ts src/__tests__/unit/provider-verify.test.ts
git commit -m "workers fixture bundles neonDriver; verify:provider accepts --driver neon

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 5: Belgeler

**Files:**
- Modify: `docs/configuration.md`, `docs/providers.md`, `docs/cli.md`

- [ ] **Step 1: `docs/configuration.md`**

`driver` satırını `bunDriver`, `postgresDriver`, `pgDriver` veya `neonDriver` olarak güncelle. Cloudflare Workers/Hyperdrive bölümünün yanına "Neon serverless sürücüsü" alt bölümü ekle: kurulum (`bun add @neondatabase/serverless`, isteğe bağlı peer), kullanım (`import { neonDriver } from "@repo/db/drivers/neon"`, Workers'ta `createDatabase(config, { driver: neonDriver, poolMax: 1 })` ve yanıttan sonra `ctx.waitUntil(db.close())`), sınırlar (yalnızca runtime; yönetim pg/postgres/bun ve doğrudan URL; `cancel` yok, deadline sonrası bağlantı atılır ve sunucu `client_connection_check_interval` ile keser; HTTP `neon()` fonksiyonu desteklenmez; Neon `-pooler` URL'si runtime için, doğrudan URL yönetim için; Bun ve Node ≥ 22'de global WebSocket, daha eskisinde `neonConfig.webSocketConstructor`).

- [ ] **Step 2: `docs/providers.md` ve `docs/cli.md`**

`providers.md`'de Neon `-pooler` satırının kullanım hücresine "`neonDriver` ile Workers/edge" notunu ekle; "Doğrulama" bölümünde `--driver bun|postgres|pg|neon`. `docs/cli.md` `verify:provider` satırında aynı seçenek listesi ve yerel testler için `wsproxy`/`DB_DRIVER=neon` notu (`test:integration` satırı: `DB_DRIVER=bun|postgres|pg|neon`).

- [ ] **Step 3: Doğrula ve commit**

Run: `grep -n "neonDriver" docs/configuration.md docs/providers.md docs/cli.md && bun run lint`
Expected: üç dosyada geçer; lint temiz.

```bash
git add docs
git commit -m "docs: neonDriver (install, usage, limits), driver option lists

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 6: Gerçek Neon koşusu (sahibe bağlı)

Bu görev sahibin ücretsiz Neon hesabını gerektirir; plan burada durur ve sahibe sorar.

- [ ] **Step 1: Sahibe talimat ver**

Mesaj: Neon ücretsiz projeniz için, parola sohbete girmeden:

```bash
DATABASE_URLS='<Neon direct URL>' bun run verify:provider --driver neon
```

İstemde Neon `-pooler` URL'sini girin ve çıktı JSON'unu buraya yapıştırın. Bu koşu `neonDriver`'ın gerçek Neon'da çalıştığını ve (`cancelDefined: false` iken) `serverStoppedAfterMs`'in dolduğunu gösterir.

- [ ] **Step 2: Sonucu işle**

`docs/providers.md`'deki Neon satırlarını `verified (<tarih>, neon)` yap ve ölçülen `deadline.serverStoppedAfterMs` ve probe sonuçlarını yaz. `serverStoppedAfterMs: null` çıkarsa (sunucu deyimi bırakmıyor): `neonDriver` belgesine bu sınırı açıkça yaz (deadline sonrası Neon pooler arkasında sorgu `statement_timeout`'a kadar sürebilir) ve bu bulguyu ledger'a `Ruling:` ile kaydet; kod değişikliği gerekiyorsa önce plana bir görev ve RED testi ekle.

- [ ] **Step 3: Doğrula ve commit**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: yeşil.

```bash
git add docs/providers.md docs/configuration.md
git commit -m "docs: Neon results from a real project (neonDriver, pooler, deadline)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 7: Temizlik

- [ ] **Step 1:** `docker compose -f "$SCRATCH/dbprov/compose.yaml" down -v`; `docker ps` jamaster stack'inin (5540/5541/5543) çalışmaya devam ettiğini göstermeli.
