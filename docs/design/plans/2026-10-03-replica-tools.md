# Replica Tools Implementation Plan (C2)

> **Durum (2026-10-19): uygulandı (`replicas`, `doctor`, `--from-replica`); sağlayıcı replika ölçümü sahip işidir.** Onay kutuları işaretlenmedi; gerçek durumun kaynağı koddur, testlerdir ve [yol haritası](2026-10-18-roadmap-remaining.md)dır.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operatör replica durumunu görür (`replicas` komutu), `doctor` replica'ları denetler, `backup`/`export` replica'dan (`--from-replica`) alınabilir; sağlayıcı replica lag davranışı için sahip çalıştırması olan bir ölçüm eklenir.

**Architecture:** C1'deki `createReplicaRouter`/`probeReplica` yeniden kullanılır. `replicas` kısa ömürlü bir runtime `Database` açıp `db.replicas()` çağırır. `doctor` her replica'yı kısa ömürlü tek bağlantıyla salt okunur denetler. `--from-replica` gizli girişten doğrudan replica URL'lerini alır, `openReplicaSource` ile doğrular (doğrudan bağlantı, replica olduğu, lag eşiği) ve `writeTenant`'ın veri okumasını yalnızca o replica'ya yönlendirir; placement ve platform kayıtları primary'den okunur. Replica yedeği her zaman tamdır.

**Tech Stack:** Bun + TypeScript, `fakeDriver` birim testleri, C1'in izole replikasyonlu compose çifti (`postgres-rp` / `postgres-rp-replica`) entegrasyon testleri.

**Spec:** `docs/superpowers/specs/2026-10-03-replica-support-design.md` (C3 Tool'lar, Hatalar, Test). Ön koşul: `2026-10-03-replica-read-path.md` (C1) tamamlanmış olmalı: `probeReplica`, `createReplicaRouter`, `db.replicas()`, `replica-fixture.ts`.

## Global Constraints

- **Yeni ortam değişkeni yok.** Doğrudan replica URL'leri gizli girişle sorulur (`askSecret`, `db0=url,…` biçimi); `replicas` ve `doctor` mevcut `DATABASE_URLS` + `DATABASE_REPLICA_URLS`'i kullanır.
- Çıktılarda (JSON, doctor ayrıntıları, hata mesajları) URL, host, kullanıcı, parola **yok**; replica `db0#1` / `replica: 1` sıra numarasıyla anılır.
- Tool hata mesajları İngilizce, kodlar kararlı: yeni kodlar `REPLICA_CONFLICT`, `REPLICA_LAG_EXCEEDED`.
- Replica yedeği her zaman **tam**; manifest `source: "replica"` ve `replayLsn` taşır; placement ve `platform.tenants` primary'den okunur; sessizce primary'ye düşme yok.
- Replica URL'si **doğrudan** bağlantı olmalı (transaction pooler → `DIRECT_CONNECTION_REQUIRED`), gerçekten replica olmalı (`pg_is_in_recovery()`), lag `replicaMaxLagMs`'i aşmamalı.
- Spec'teki `export-tenant` adı koddaki mevcut komuttur: **`export`** (Neon'un `neon export-tenant`'ı ayrıdır ve kapsam dışıdır).
- Tüm SQL `pg_catalog.` nitelikli; `search_path` yok. Yorumlar Türkçe.
- Her görev: önce başarısız test (RED), sonra minimal kod; her görev bir commit. Commit mesajı sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push/PR/merge yok.
- Komutlar `packages/db` içinde: birim `bun test src/__tests__/unit/<dosya>`, tip `bunx tsc --noEmit`, lint `bunx eslint <dosyalar> --fix`; entegrasyon yalnızca izole compose projesinde (`docker compose -p dbreplica …`), paylaşılan jamaster stack'ine dokunulmaz.

## Review Focus

- `replicas` çıktısı, doctor ayrıntıları ve hatalar URL/host/kullanıcı/parola içermez (Task 1, 2, 3 scrub testleri).
- Lag eşiği aşıldığında `--from-replica` hiçbir şey yazmadan hata verir: `export` hedef klasörü oluşmaz, `backup` set klasörü kalmaz (Task 4 + 5).
- Primary URL'sini ya da pooler URL'sini replica kaynağı diye vermek reddedilir (Task 3, 5).
- Replica seti sonraki primary yedeğinin artımlı zincirini bozmaz: primary yedeği replica setini taban alsa da tüm tenant'ları yeniden yazar (Task 5).
- Hata yollarında replica havuzları kapanır (Task 3 testi).

---

### Task 1: `replicas` komutu

**Files:**
- Create: `src/core/tools/replicas.ts`
- Modify: `src/core/cli.ts` (komut)
- Test: `src/__tests__/unit/replicas-tool.test.ts` (yeni)

**Interfaces:**
- Consumes: C1 `createDatabase(...).replicas()` → `ReplicaReport[]`, `Management` (`config`, `driver`).
- Produces: `replicaReport(m: Management): Promise<{ ok: boolean; maxLagMs: number; replicas: ReplicaReport[] }>`; CLI `replicas` (çıkış kodu 1: `ok` false).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { replicaReport } from "../../core/tools/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@primary.example.com/app";
const REPLICA = "postgres://app:secret-pw@replica.example.com/app";

function open(handler: Parameters<typeof fakeDriver>[0], replicas: string | string[] = `db0=${REPLICA}`) {
  const fake = fakeDriver(handler);
  const app = createManagement(createConfig([PRIMARY], replicas), { driver: fake.driver });
  return { app, fake };
}
const healthy = (text: string) => {
  if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
  if (text.includes("pg_is_in_recovery")) return [{ in_recovery: true, caught_up: false, lag_ms: 40 }];
  return [];
};

test("replicaReport lists each replica by number with its lag, and opens and closes its own pools", async () => {
  const { app, fake } = open(healthy);
  const report = await replicaReport(app);
  expect(report).toEqual({
    ok: true,
    maxLagMs: 5000,
    replicas: [{ databaseId: "db0", replica: 1, up: true, inRecovery: true, lagMs: 40, usable: true }],
  });
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
  await app.close();
});

test("a lagging or unreachable replica makes ok false and never leaks URLs, hosts or passwords", async () => {
  const lagging = open((text) => (text.includes("pg_is_in_recovery") ? [{ in_recovery: true, caught_up: false, lag_ms: 90_000 }] : healthy(text)));
  expect((await replicaReport(lagging.app)).ok).toBe(false);
  const broken = open((text, _params, pool) => {
    if (pool.url.includes("replica.example.com")) throw Object.assign(new Error(`cannot reach ${pool.url} as secret-pw`), { code: "ECONNREFUSED" });
    return healthy(text);
  });
  const report = await replicaReport(broken.app);
  expect(report.ok).toBe(false);
  expect(report.replicas[0]).toMatchObject({ up: false, usable: false, error: "ECONNREFUSED" });
  const text = JSON.stringify(report);
  for (const secret of ["secret-pw", "replica.example.com", "primary.example.com", "postgres://"]) expect(text).not.toContain(secret);
});

test("no configured replicas is ok with an empty list", async () => {
  const { app } = open(healthy, []);
  expect(await replicaReport(app)).toMatchObject({ ok: true, replicas: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/replicas-tool.test.ts`
Expected: FAIL — `../../core/tools/replicas` bulunamıyor.

- [ ] **Step 3: Write minimal implementation**

`src/core/tools/replicas.ts`:

```ts
/** `replicas` komutu: DATABASE_REPLICA_URLS'teki her replica'nın durumu (sağlık, lag, kullanılabilirlik). Kısa ömürlü bir runtime
 * `Database` açar ve kapatır; yönetim havuzlarına dokunmaz. Çıktıda URL yoktur (replica config sırasıyla 1 tabanlı numaralanır). */
import type { Management } from "../management";
import { createDatabase } from "../runtime";

export async function replicaReport(m: Management) {
  const db = createDatabase(m.config, { driver: m.driver, poolMax: 2, pooler: "assumed", replicaMaxLagMs: m.config.replicaMaxLagMs });
  try {
    const replicas = await db.replicas();
    return { ok: replicas.every((replica) => replica.usable), maxLagMs: m.config.replicaMaxLagMs, replicas };
  } finally {
    await db.close();
  }
}
```

`src/core/cli.ts` — `commands` içine (`databases` komutlarının yakınına):

```ts
  replicas: {
    usage: "",
    summary: "DATABASE_REPLICA_URLS'teki replica'ların durumu ve lag'i (düşük ya da eşiği aşan replica varsa çıkış kodu 1)",
    run: async ({ app }) => {
      const result = await (await import("./tools/replicas")).replicaReport(app);
      if (!result.ok) process.exitCode = 1;
      return result;
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/unit/replicas-tool.test.ts src/__tests__/unit/cli.test.ts && bunx tsc --noEmit && bunx eslint src/core/tools/replicas.ts src/core/cli.ts --fix`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/replicas.ts src/core/cli.ts src/__tests__/unit/replicas-tool.test.ts
git commit -m "tools: replicas status report and CLI command

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `doctor` replica denetimleri

**Files:**
- Modify: `src/core/tools/doctor.ts`
- Test: `src/__tests__/unit/doctor-replica.test.ts` (yeni)

**Interfaces:**
- Consumes: C1 `probeReplica(primary, replica)`; `DatabaseNode.replicas`; mevcut `usesTransactionPooler`, `runtimeDatabaseDefaults`, `DATABASE_ROLE_SETTINGS`, `Add`.
- Produces: her replica için hedef `db0#1` (sıra numarası) ve denetimler `replica_reachable`, `replica_in_recovery`, `replica_lag`, `replica_identity`, `replica_runtime_timeouts`, `replica_pooled`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { nodeMigrations, platformMigrations } from "../../core/migrations/registry";
import { doctor } from "../../core/tools/doctor";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://admin:private-secret@primary.example.com/app";
const REPLICA = "postgres://admin:private-secret@replica.example.com/app";
const TIMEOUTS = "statement_timeout=5000,lock_timeout=1000,client_connection_check_interval=1000";
let pid = 1000;

type Replica = { inRecovery?: boolean; lagMs?: number; identity?: string; settings?: string; pooled?: boolean; fail?: boolean };
function run(replica: Replica = {}) {
  const fake = fakeDriver((text, _params, pool) => {
    const onReplica = pool.url.includes("replica.example.com");
    if (!/^\s*(SELECT|SHOW)\b/.test(text)) throw new Error("Doctor must be read-only");
    if (onReplica && replica.fail) throw Object.assign(new Error(`unreachable ${pool.url}`), { code: "ECONNREFUSED" });
    if (text.includes("pg_backend_pid")) return [{ pid: onReplica && replica.pooled ? 7 : ++pid }];
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: replica.inRecovery ?? true, caught_up: false, lag_ms: replica.lagMs ?? 30 }];
    if (text.includes("set_config")) return [{}];
    if (text.includes("_migrations")) return (text.includes("_node_") ? nodeMigrations : platformMigrations).map(({ id, checksum }) => ({ id, checksum }));
    if (text.includes("platform.nodes") || text.includes("node_identity")) return [{ database_id: onReplica ? (replica.identity ?? "db0") : "db0" }];
    if (text.includes("AS invalid")) return [{ invalid: 0, inactive: 0, moving: 0, recovery: 0 }];
    if (text.includes("standard_conforming_strings")) return [{ on: true }];
    if (text.includes("pg_db_role_setting")) return [{ settings: onReplica ? (replica.settings ?? TIMEOUTS) : TIMEOUTS }];
    throw new Error("Unexpected diagnostic query");
  });
  const app = createManagement(createConfig([PRIMARY], `db0=${REPLICA}`), { driver: fake.driver });
  return doctor(app).then(async (result) => {
    await app.close();
    expect(fake.pools.every((pool) => pool.closed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect(JSON.stringify(result)).not.toContain("replica.example.com");
    return result;
  });
}
const replicaChecks = (result: Awaited<ReturnType<typeof run>>) => result.checks.filter((check) => check.target === "db0#1");
const outcome = (result: Awaited<ReturnType<typeof run>>) => Object.fromEntries(replicaChecks(result).map((check) => [check.check, check.ok]));

test("a healthy replica passes reachability, recovery, lag, identity and timeout checks", async () => {
  expect(await run().then(outcome)).toEqual({
    replica_reachable: true,
    replica_in_recovery: true,
    replica_lag: true,
    replica_identity: true,
    replica_runtime_timeouts: true,
    replica_pooled: false, // doğrudan URL
  });
});

test("a primary given as replica, a lagging replica, another cluster and missing timeouts each fail their own check", async () => {
  expect((await run({ inRecovery: false }).then(outcome)).replica_in_recovery).toBe(false);
  expect((await run({ lagMs: 60_000 }).then(outcome)).replica_lag).toBe(false);
  expect((await run({ identity: "db1" }).then(outcome)).replica_identity).toBe(false);
  expect((await run({ settings: "statement_timeout=1" }).then(outcome)).replica_runtime_timeouts).toBe(false);
  expect((await run({ pooled: true }).then(outcome)).replica_pooled).toBe(true);
});

test("an unreachable replica fails replica_reachable and skips the rest, without leaking the URL", async () => {
  const result = await run({ fail: true });
  expect(outcome(result)).toEqual({ replica_reachable: false });
  expect(result.ok).toBe(false);
});

test("a configuration without replicas adds no replica checks", async () => {
  const fake = fakeDriver((text) => (text.includes("pg_backend_pid") ? [{ pid: 1 }] : []));
  const app = createManagement(createConfig([PRIMARY]), { driver: fake.driver });
  const result = await doctor(app);
  expect(result.checks.some((check) => check.check.startsWith("replica_"))).toBe(false);
  await app.close();
});
```

(Son test'te handler diğer denetimlerde `inspection` başarısızlığı verir; yalnızca replica denetimi olmadığı doğrulanır.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/doctor-replica.test.ts`
Expected: FAIL — `db0#1` hedefli denetim yok.

- [ ] **Step 3: Write minimal implementation**

`src/core/tools/doctor.ts` — içe aktarmalar: `import { probeReplica } from "../tenants/replicas";`. `inspectPooled`'dan sonra:

```ts
/** Replica başına salt okunur denetimler: kısa ömürlü tek bağlantı açılır; replica URL'si hiçbir çıktıya girmez. */
async function inspectReplica(m: Management, node: DatabaseNode, url: string, add: Add) {
  const replica = m.driver(url, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  try {
    let probe: Awaited<ReturnType<typeof probeReplica>>;
    try {
      probe = await probeReplica(m.pools.node(node.id), replica);
    } catch (error) {
      add("replica_reachable", false, `Replica'ya bağlanılamadı (${errorCode(error)}); URL, ağ ve kimlik bilgilerini kontrol edin.`);
      return;
    }
    add("replica_reachable", true, "Replica erişilebilir.");
    add("replica_in_recovery", probe.inRecovery, "URL gerçekten bir replica'ya gitmeli (pg_is_in_recovery); primary'yi replica diye vermek okuma/yazma ayrımını bozar.");
    const lag = probe.lagMs === null ? "bilinmiyor" : `${probe.lagMs} ms`;
    add("replica_lag", probe.lagMs !== null && probe.lagMs <= m.config.replicaMaxLagMs, `Replica lag'i ${m.config.replicaMaxLagMs} ms eşiğinin altında olmalı (ölçülen: ${lag}).`);
    const [identity] = await replica.query<{ database_id: string }>("SELECT database_id FROM platform.node_identity");
    add("replica_identity", identity?.database_id === node.id, `Bu replica ${node.id}'in kopyası olmalı; başka kümeye bakan URL okumaları yanlış veriye götürür.`);
    const [stored] = await replica.query<{ settings: string | null }>(DATABASE_ROLE_SETTINGS);
    const expected = runtimeDatabaseDefaults(m.config);
    const present = expected.every((setting) => stored?.settings?.split(",").includes(setting));
    add("replica_runtime_timeouts", present, `Runtime timeout'ları replika ile gelir (${expected.join(", ")}); primary'de bootstrap çalıştırın.`);
    const pooled = await usesTransactionPooler(m.driver, url, { deadlineMs: POOLED_PROBE_DEADLINE_MS });
    add("replica_pooled", pooled, "Replica runtime URL'si de transaction-mode pooler'a gitmeli (runtime zorlamaz; doctor yalnızca bilgi verir).");
  } finally {
    await replica.close(1000);
  }
}
```

`doctor()` içinde düğüm döngüsüne (pooled denetiminden sonra) ekle:

```ts
    for (const [replicaIndex, replicaUrl] of node.replicas.entries())
      await inspect(`${node.id}#${replicaIndex + 1}`, (add) => inspectReplica(m, node, replicaUrl, add));
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/unit/doctor-replica.test.ts src/__tests__/unit/doctor.test.ts && bunx tsc --noEmit && bunx eslint src/core/tools/doctor.ts --fix`
Expected: PASS; mevcut doctor testleri (replica'sız) etkilenmez.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/doctor.ts src/__tests__/unit/doctor-replica.test.ts
git commit -m "doctor: read-only replica checks (reachable, in recovery, lag, identity, timeouts, pooler)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Replica kaynağı (`openReplicaSource`)

**Files:**
- Create: `src/core/tools/replica-source.ts`
- Test: `src/__tests__/unit/replica-source.test.ts` (yeni)

**Interfaces:**
- Consumes: C1 `probeReplica`; `createConfig(urls, entries)` (`db0=url` ayrıştırması ve doğrulaması); `connect`, `usesTransactionPooler`, `Management` (`driver`, `config.migrationStatementTimeoutMs/migrationLockTimeoutMs/replicaMaxLagMs`, `pools.node`).
- Produces:
  - `interface ReplicaSource { has(databaseId: string): boolean; node(databaseId: string): Database; replayLsn(databaseId: string): string; close(): Promise<void> }`
  - `openReplicaSource(m: Management, entries: string): Promise<ReplicaSource>` — `entries`: `db0=postgres://…,db1=…`; her girilen düğüm için tek doğrudan replica; doğrulama başarısızsa havuzlar kapanır.
  - `replicaConflict(error: unknown): unknown` — recovery çakışmasını (`SQLSTATE 40001` + "conflict with recovery") `AppError("REPLICA_CONFLICT", …)`'e çevirir, diğer hatayı olduğu gibi döndürür; `node(id)` Database'i bu eşlemeyi `query`/`exec`/`transaction` hatalarına uygular.
  - Hatalar: `INVALID_CONFIG` (yanlış biçim, düğüm başına birden çok URL, replica değil, hiç URL yok), `DIRECT_CONNECTION_REQUIRED`, `REPLICA_LAG_EXCEEDED`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { openReplicaSource, replicaConflict } from "../../core/tools/replica-source";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@primary.example.com/app";
const DIRECT = "postgres://app:secret-pw@replica.example.com/app";
const POOLED = "postgres://app:secret-pw@pooled.example.com/app";
let pid = 100;

type State = { inRecovery?: boolean; lagMs?: number | null };
function open(state: State = {}, extra?: { fail?: unknown }) {
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_backend_pid")) return [{ pid: pool.url.includes("pooled") ? 7 : ++pid }];
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: state.inRecovery ?? true, caught_up: false, lag_ms: state.lagMs === undefined ? 20 : state.lagMs }];
    if (text.includes("pg_last_wal_replay_lsn()::")) return [{ lsn: "0/2FFFF00" }];
    if (extra?.fail) throw extra.fail;
    return [];
  });
  const app = createManagement(createConfig([PRIMARY]), { driver: fake.driver });
  return { app, fake };
}
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => (error as { code: string; message: string }));

test("a direct, caught-up replica opens and exposes its connection and replay position", async () => {
  const { app, fake } = open();
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  expect(source.has("db0")).toBe(true);
  expect(source.has("db1")).toBe(false);
  expect(source.replayLsn("db0")).toBe("0/2FFFF00");
  await source.node("db0").query("SELECT 1");
  expect(fake.commands.some((command) => command.url === DIRECT && command.text === "SELECT 1")).toBe(true);
  await source.close();
  expect(fake.pools.filter((pool) => pool.url === DIRECT).every((pool) => pool.closed)).toBe(true);
});

test("refusals: pooler URL, not a replica, lag over the threshold or unknown, two URLs per database, no URL, bad format", async () => {
  const pooled = open();
  expect(await code(openReplicaSource(pooled.app, `db0=${POOLED}`))).toMatchObject({ code: "DIRECT_CONNECTION_REQUIRED" });
  expect(await code(openReplicaSource(open({ inRecovery: false }).app, `db0=${DIRECT}`))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open({ lagMs: 60_000 }).app, `db0=${DIRECT}`))).toMatchObject({ code: "REPLICA_LAG_EXCEEDED" });
  expect(await code(openReplicaSource(open({ lagMs: null }).app, `db0=${DIRECT}`))).toMatchObject({ code: "REPLICA_LAG_EXCEEDED" });
  expect(await code(openReplicaSource(open().app, `db0=${DIRECT},db0=${DIRECT}?x=1`))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open().app, ""))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open().app, `db9=${DIRECT}`))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open().app, `${PRIMARY}?application_name=x`))).toMatchObject({ code: "INVALID_CONFIG" });
});

test("a failed validation closes the pools it opened and no message carries the URL, host or password", async () => {
  const { app, fake } = open({ lagMs: 60_000 });
  const error = await code(openReplicaSource(app, `db0=${DIRECT}`));
  expect(fake.pools.filter((pool) => pool.url === DIRECT).every((pool) => pool.closed)).toBe(true);
  for (const secret of ["secret-pw", "replica.example.com", "primary.example.com", "postgres://"]) expect(error?.message).not.toContain(secret);
});

test("a recovery conflict becomes REPLICA_CONFLICT; any other error passes through untouched", async () => {
  const conflict = Object.assign(new Error("canceling statement due to conflict with recovery"), { code: "40001" });
  expect(replicaConflict(conflict)).toMatchObject({ code: "REPLICA_CONFLICT" });
  const serialization = Object.assign(new Error("could not serialize access"), { code: "40001" });
  expect(replicaConflict(serialization)).toBe(serialization);
  const other = new Error("boom");
  expect(replicaConflict(other)).toBe(other);

  const { app } = open({}, { fail: conflict });
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  expect(await code(source.node("db0").query("SELECT 2"))).toMatchObject({ code: "REPLICA_CONFLICT" });
  expect(await code(source.node("db0").transaction((tx) => tx.query("SELECT 3")))).toMatchObject({ code: "REPLICA_CONFLICT" });
  await source.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/replica-source.test.ts`
Expected: FAIL — `../../core/tools/replica-source` bulunamıyor.

- [ ] **Step 3: Write minimal implementation**

`src/core/tools/replica-source.ts`:

```ts
/** `--from-replica` kaynağı: gizli girişten gelen doğrudan replica URL'leri (`db0=url,…`). Her girilen düğüm için tek replica açılır ve
 * doğrulanır: doğrudan bağlantı (pooler değil), gerçekten replica (`pg_is_in_recovery`), lag eşiğin altında. Veri okuması yalnızca bu
 * replica'dan yapılır; placement ve platform kayıtları primary'den okunur (çağıranın işi). Mesajlar URL, host, kullanıcı içermez. */
import { createConfig } from "../config";
import { connect, type Database } from "../database";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import { usesTransactionPooler } from "../tenants/pooler";
import { probeReplica } from "../tenants/replicas";

const DIRECT_PROBE_DEADLINE_MS = 10_000;
const REPLAY_LSN = "SELECT pg_catalog.pg_last_wal_replay_lsn()::text AS lsn";

export interface ReplicaSource {
  has(databaseId: string): boolean;
  node(databaseId: string): Database;
  /** Doğrulama anında replica'nın replay ettiği WAL konumu (yedek manifest'ine yazılır). */
  replayLsn(databaseId: string): string;
  close(): Promise<void>;
}

/** Uzun snapshot'ı replica'da recovery çakışması iptal edebilir (`max_standby_streaming_delay`): SQLSTATE 40001 ve "conflict with recovery". */
export function replicaConflict(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  if (errorCode(error) === "40001" && /conflict with recovery/i.test(message))
    return new AppError("REPLICA_CONFLICT", "The replica canceled the read because of a recovery conflict; retry or take the export from the primary");
  return error;
}

/** Replica bağlantısı: çakışma hatası `REPLICA_CONFLICT` olur (sorgu, exec ve transaction yollarında). */
function mapConflicts(db: Database): Database {
  const rethrow = (error: unknown): never => {
    throw replicaConflict(error);
  };
  return {
    ...db,
    query: ((text: string, params?: readonly unknown[], tenantId?: string) => db.query(text, params, tenantId).catch(rethrow)) as Database["query"],
    exec: (sql) => db.exec(sql).catch(rethrow),
    transaction: ((work, options) => db.transaction(work, options).catch(rethrow)) as Database["transaction"],
  };
}

export async function openReplicaSource(m: Management, entries: string): Promise<ReplicaSource> {
  // `createConfig` biçimi, DB kimliklerini ve tekrarları doğrular (primary URL'si replica olarak reddedilir).
  const parsed = createConfig(m.config.nodes.map((node) => node.url), entries);
  const { migrationStatementTimeoutMs, migrationLockTimeoutMs, replicaMaxLagMs } = m.config;
  const databases = new Map<string, Database>();
  const positions = new Map<string, string>();
  const close = async () => {
    await Promise.allSettled([...databases.values()].map((db) => db.close()));
    databases.clear();
  };
  try {
    for (const node of parsed.nodes) {
      const [url, extra] = node.replicas;
      if (extra) throw new AppError("INVALID_CONFIG", `--from-replica takes one direct replica URL per database (${node.id})`);
      if (!url) continue;
      if (await usesTransactionPooler(m.driver, url, { deadlineMs: DIRECT_PROBE_DEADLINE_MS }))
        throw new AppError("DIRECT_CONNECTION_REQUIRED", `The replica URL for ${node.id} must be a direct connection, not a transaction pooler`);
      const db = connect(m.driver(url, { max: 2, idleTimeoutSeconds: 60, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 }), {
        deadlineMs: migrationStatementTimeoutMs,
        timeouts: { statementTimeoutMs: migrationStatementTimeoutMs, lockTimeoutMs: migrationLockTimeoutMs },
        maxPending: 64,
        databaseId: node.id,
      });
      databases.set(node.id, db);
      const probe = await probeReplica(m.pools.node(node.id), db);
      if (!probe.inRecovery) throw new AppError("INVALID_CONFIG", `The replica URL for ${node.id} does not point at a replica`);
      if (probe.lagMs === null || probe.lagMs > replicaMaxLagMs)
        throw new AppError("REPLICA_LAG_EXCEEDED", `The replica for ${node.id} is behind by more than ${replicaMaxLagMs} ms`);
      positions.set(node.id, (await db.query<{ lsn: string }>(REPLAY_LSN))[0]?.lsn ?? "");
    }
    if (!databases.size) throw new AppError("INVALID_CONFIG", "--from-replica needs at least one db0=postgres://… replica URL");
  } catch (error) {
    await close();
    throw error;
  }
  const mapped = new Map([...databases].map(([id, db]) => [id, mapConflicts(db)]));
  const missing = (id: string): never => {
    throw new AppError("INVALID_CONFIG", `--from-replica has no replica URL for ${id}`);
  };
  return {
    has: (id) => mapped.has(id),
    node: (id) => mapped.get(id) ?? missing(id),
    replayLsn: (id) => positions.get(id) ?? missing(id),
    close,
  };
}
```

Not: boş `entries` (`""`) için `createConfig` boş metni "replica yok" sayar, `databases.size` 0 → `INVALID_CONFIG` ✓. Primary URL'si olarak verilen girdi (`db0=` öneki yok) `REPLICA_ENTRY` regex'ine uymadığı için `INVALID_CONFIG` ✓.

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/unit/replica-source.test.ts && bunx tsc --noEmit && bunx eslint src/core/tools/replica-source.ts --fix`
Expected: PASS. (`createConfig` hata mesajı "Invalid configuration: DATABASE_REPLICA_URLS" `--from-replica` için de anlaşılırdır; değer içermez.)

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/replica-source.ts src/__tests__/unit/replica-source.test.ts
git commit -m "tools: validated direct replica source with recovery-conflict mapping

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `export` ve `backup` için `--from-replica`

**Files:**
- Modify: `src/core/tools/backup.ts` (`TenantBackup`, `BackupManifest`, `BackupOptions`, `BackupRun`, `writeTenant`, `exportTenant`, `backupAll`)
- Modify: `src/core/cli.ts` (`--from-replica`, `askReplicaUrls`, `replicaEntries`, `backup` ve `export`)
- Test: `src/__tests__/unit/cli.test.ts` (ekleme)

**Interfaces:**
- Consumes: Task 3 `openReplicaSource`, `ReplicaSource`.
- Produces:
  - `exportTenant(m, tenantId, dir, options: { signal?: AbortSignal; replicaUrls?: string })`; `backupAll(m, root, options)` ve `BackupOptions.replicaUrls?: string`.
  - `TenantBackup.source?: "replica"`, `TenantBackup.replayLsn?: string`; `BackupManifest.source?: "replica"`, `BackupManifest.replayLsn?: Record<string, string>`.
  - `replicaEntries(answer: string): string` (cli.ts, dışa aktarılır): virgüllü `db<N>=postgres://…` girdilerini doğrular ve normalize eder; hata mesajları değeri içermez.
  - CLI: `backup … --from-replica`, `export <tenant> <dir> --from-replica` (replica URL'leri gizli girişle sorulur).

- [ ] **Step 1: Write the failing tests**

`src/__tests__/unit/cli.test.ts` sonuna (mevcut içe aktarmaları kullanın; `parseOptions`, `splitArguments` zaten dosyada içe aktarılıyor, `replicaEntries`'i ekleyin):

```ts
test("--from-replica is a value-less switch accepted by backup and export", () => {
  expect(parseOptions(["--from-replica"], ["--from-replica"])).toEqual({ fromReplica: true });
  expect(() => parseOptions(["--from-replica=1"], ["--from-replica"])).toThrow("--from-replica takes no value");
  expect(splitArguments({ usage: "<tenant> <dir> [--from-replica]", flags: ["--from-replica"] }, ["abc", "out", "--from-replica"])).toEqual({
    positional: ["abc", "out"],
    options: ["--from-replica"],
  });
});

test("replicaEntries validates db<N>=postgres://… entries and never echoes the value", () => {
  expect(replicaEntries("db0=postgres://u:p@h:5432/app, db1=postgresql://u:p@h2/app")).toBe("db0=postgres://u:p@h:5432/app,db1=postgresql://u:p@h2/app");
  for (const bad of ["postgres://u:secret-pw@h/app", "db0=http://u:secret-pw@h/app", "x=postgres://u:secret-pw@h/app", "db0=", ""]) {
    const error = (() => {
      try {
        replicaEntries(bad);
      } catch (e) {
        return e as { code: string; message: string };
      }
    })();
    expect(error?.code).toBe("USAGE");
    expect(error?.message).not.toContain("secret-pw");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/cli.test.ts`
Expected: FAIL — `replicaEntries` içe aktarılamıyor / `--from-replica` bilinmeyen seçenek.

- [ ] **Step 3: Write minimal implementation**

`src/core/cli.ts`:
- `Switches`'e `fromReplica?: boolean;`; `BOOLEAN_FLAGS` listesine `"--from-replica"`.
- `NEON_KEY_QUESTION`'ın yanına:

```ts
const REPLICA_URLS_QUESTION = "Doğrudan replica URL'leri (db0=postgres://…, virgüllü, yazılan görünmez): ";
const REPLICA_ENTRY_HINT = "Replica entries look like db0=postgres://… (comma-separated)";
/** `db<N>=postgres://…,…` → doğrulanmış, normalize edilmiş metin; hata metinleri değeri içermez. */
export function replicaEntries(answer: string): string {
  const entries = answer.split(",").map((entry) => entry.trim());
  if (!answer.trim() || entries.some((entry) => !DATABASE_ID.test(entry.slice(0, Math.max(entry.indexOf("="), 0))))) throw usage(REPLICA_ENTRY_HINT);
  return entries
    .map((entry) => {
      const at = entry.indexOf("=");
      const url = URL.parse(entry.slice(at + 1));
      if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) throw usage(REPLICA_ENTRY_HINT);
      return `${entry.slice(0, at)}=${url.href}`;
    })
    .join(",");
}
const askReplicaUrls = async () => replicaEntries(await (await import("./tools/ask-secret")).askSecret(REPLICA_URLS_QUESTION));
```

`url.href` URL'yi normalize eder (sondaki `/` eklenmez: `postgres://u:p@h:5432/app` → aynı; test beklentisi bunu varsayar — farklı normalize ederse beklentiyi gerçek çıktıya göre güncelleyin, normalizasyon dışında davranışı değiştirmeyin).

- `backup` komutu: `usage: "<dir> [--full] [--tenants a,b] [--concurrency N] [--from-replica]"`, `flags: [..., "--from-replica"]`, `run`:

```ts
    run: async ({ app, options }, dir) => {
      const replicaUrls = options.fromReplica ? await askReplicaUrls() : undefined;
      const result = await (await backup()).backupAll(app, dir, { ...options, tenants: optionalCommaList(options.tenants), replicaUrls });
```

- `export` komutu: `usage: "<tenant> <dir> [--from-replica]"`, `flags: ["--from-replica"]`, summary sonuna `(--from-replica: veriyi replica'dan okur)`; `run: async ({ app, options }, tenant, dir) => (await backup()).exportTenant(app, tenant, dir, { ...options, replicaUrls: options.fromReplica ? await askReplicaUrls() : undefined })`.

`src/core/tools/backup.ts`:
- `TenantBackup`'a `source?: "replica"; replayLsn?: string;` (yorum: "replica'dan alındıysa"); `BackupManifest`'e `source?: "replica"; replayLsn?: Record<string, string>;`; `BackupOptions`'a `replicaUrls?: string;`; `BackupRun`'a `source?: ReplicaSource;`.
- İçe aktar: `import { openReplicaSource, type ReplicaSource } from "./replica-source";`.
- `writeTenant(m, p, dir, signal?, replica?: ReplicaSource)`: fonksiyonun **ilk satırı** `if (replica && !replica.has(p.databaseId)) throw new AppError("INVALID_CONFIG", \`--from-replica has no replica URL for ${p.databaseId}\`);`; `const db = replica ? replica.node(p.databaseId) : m.pools.node(p.databaseId);` (mevcut `m.pools.node(...)` satırı); dönen `TenantBackup` nesnesine `...(replica ? { source: "replica" as const, replayLsn: replica.replayLsn(p.databaseId) } : {})`. `placement`/`tenant` okumaları (`m.pools.platform`) aynen kalır.
- `exportTenant`:

```ts
export async function exportTenant(m: Management, tenantId: string, dir: string, options: { signal?: AbortSignal; replicaUrls?: string } = {}) {
  const placement = requireActive(await m.platform.get(tenantId), "Only active tenants can be exported");
  const replica = options.replicaUrls ? await openReplicaSource(m, options.replicaUrls) : undefined;
  try {
    const backup = await writeTenant(m, placement, dir, options.signal, replica);
    return { tenantId, dir, tables: backup.tables.length, rows: totalRows(backup.tables) };
  } finally {
    await replica?.close();
  }
}
```

- `backupOneTenant`: `writeTenant(m, p, join(run.setDir, "tenants", p.tenantId), run.signal, run.source)`.
- `backupAll`: `checkDatabases(...)`'den sonra `const replica = options.replicaUrls ? await openReplicaSource(m, options.replicaUrls) : undefined;` ve fonksiyonun geri kalanı `try { … } finally { await replica?.close(); }` içinde; `const base = options.full || replica ? undefined : (await completeSets(root)).at(-1);`; `const counted = replica ? new Set<string>() : await databasesWithStatsCounters(m);` (replica'dan okunan DB'nin sayaçları primary'ninkini yansıtmaz: işaret yerine her tenant yeniden yazılır; `backupOneTenant` zaten sayaçsız DB için `uncounted:<uuid>` işareti üretir); `placements` listelendikten hemen sonra:

```ts
  if (replica)
    for (const id of new Set(placements.map((p) => p.databaseId)))
      if (!replica.has(id)) {
        await rm(setDir, { recursive: true, force: true });
        throw new AppError("INVALID_CONFIG", `--from-replica has no replica URL for ${id}`);
      }
```

`manifest` nesnesine `...(replica ? { source: "replica" as const, replayLsn: Object.fromEntries(new Set(placements.map((p) => p.databaseId)).values().map((id) => [id, replica.replayLsn(id)])) } : {})` (ES iteratör yardımcıları yoksa `[...new Set(…)].map(…)` kullanın); `run` nesnesine `source: replica`.

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/unit/cli.test.ts src/__tests__/unit/tools-cli.test.ts && bunx tsc --noEmit && bunx eslint src/core/cli.ts src/core/tools/backup.ts --fix`
Expected: PASS. Mevcut yedek davranışı `replicaUrls` verilmediğinde birebir aynıdır (yeni dallar `undefined` ile atlanır).

- [ ] **Step 5: Commit**

```bash
git add src/core/cli.ts src/core/tools/backup.ts src/__tests__/unit/cli.test.ts
git commit -m "backup, export: --from-replica reads tenant data from a validated direct replica

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Araç entegrasyon testleri (gerçek replica)

**Files:**
- Test: `src/__tests__/integration/replica-tools.test.ts` (yeni)
- Modify (gerekirse): `src/__tests__/integration/replica-fixture.ts` (C1'den) — yalnızca eksik yardımcı varsa

**Interfaces:**
- Consumes: C1 `replicaFixture`, `PRIMARY_URL`, `REPLICA_URL`, `DEAD_REPLICA_URL`, `replicaConfig`, `caughtUp`, `pauseReplay`, `resumeReplay`; Task 1–4 araçları; mevcut `createUser`, `listUsers`, `uniqueEmail`, `failure`, `forgetTenant`, `createTestManagement`, `raw`; `restoreTenant`, `exportTenant`, `backupAll`.

- [ ] **Step 1: Write the tests**

```ts
import { expect } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupAll, exportTenant, restoreTenant } from "../../core/tools/backup";
import { doctor } from "../../core/tools/doctor";
import { replicaReport } from "../../core/tools/replicas";
import { replicaConflict } from "../../core/tools/replica-source";
import { createTestManagement, createUser, failure, forgetTenant, integration, listUsers, uniqueEmail } from "./helpers";
import { caughtUp, DEAD_REPLICA_URL, pauseReplay, PRIMARY_URL, REPLICA_URL, replicaConfig, replicaFixture } from "./replica-fixture";

const exists = (path: string) => stat(path).then(() => true, () => false);
const names = (rows: unknown[]) => (rows as { name: string }[]).map((row) => row.name).sort();
const temp = () => mkdtemp(join(tmpdir(), "replica-tools-"));

integration("replicas reports a healthy replica, an unreachable one and a lagging one, without any URL", async () => {
  const f = await replicaFixture();
  const dead = createTestManagement({}, replicaConfig(DEAD_REPLICA_URL));
  const lagging = createTestManagement({ replicaMaxLagMs: 200 }, replicaConfig(REPLICA_URL));
  try {
    const healthy = await replicaReport(f.management);
    expect(healthy).toMatchObject({ ok: true, replicas: [{ databaseId: "db0", replica: 1, up: true, usable: true }] });
    expect(JSON.stringify(healthy)).not.toContain("127.0.0.1");
    expect(await replicaReport(dead)).toMatchObject({ ok: false, replicas: [{ up: false, usable: false }] });
    await pauseReplay(f.replica);
    await f.management.pools.node("db0").query("SELECT pg_catalog.pg_switch_wal()"); // WAL ilerlesin
    await Bun.sleep(500);
    expect((await replicaReport(lagging)).ok).toBe(false);
  } finally {
    await dead.close();
    await lagging.close();
    await f.close();
  }
});

integration("doctor: a real replica passes its checks; the primary given as a replica fails replica_in_recovery", async () => {
  const f = await replicaFixture();
  const asPrimary = createTestManagement({}, replicaConfig(`${PRIMARY_URL}?application_name=not-a-replica`));
  try {
    const checks = (await doctor(f.management)).checks.filter((check) => check.target === "db0#1");
    const outcome = Object.fromEntries(checks.map((check) => [check.check, check.ok]));
    expect(outcome).toMatchObject({ replica_reachable: true, replica_in_recovery: true, replica_lag: true, replica_identity: true, replica_runtime_timeouts: true });
    const wrong = (await doctor(asPrimary)).checks.filter((check) => check.target === "db0#1");
    expect(wrong.find((check) => check.check === "replica_in_recovery")?.ok).toBe(false);
  } finally {
    await asPrimary.close();
    await f.close();
  }
});

integration("export --from-replica writes a restorable export marked as replica-sourced", async () => {
  const f = await replicaFixture();
  const dir = await temp();
  try {
    const db = f.runtime();
    await db.withTenant(f.tenantId, async (t) => {
      await t.query(createUser, [crypto.randomUUID(), "alice", uniqueEmail()]);
      await t.query(createUser, [crypto.randomUUID(), "bob", uniqueEmail()]);
    });
    await caughtUp(f.primary, f.replica);
    const target = join(dir, "export");
    const result = await exportTenant(f.management, f.tenantId, target, { replicaUrls: `db0=${REPLICA_URL}` });
    expect(result.rows).toBeGreaterThanOrEqual(2);
    const stored = JSON.parse(await readFile(join(target, "tenant.json"), "utf8")) as { source?: string; replayLsn?: string };
    expect(stored.source).toBe("replica");
    expect(stored.replayLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    // Geri yükleme birebir aynı veriyi getirir.
    await forgetTenant(f.management, f.tenantId);
    await restoreTenant(f.management, f.tenantId, target);
    expect(names(await db.withTenant(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toEqual(["alice", "bob"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await f.close();
  }
});

integration("backup --from-replica is always full, marked replica, and never poisons the next primary incremental", async () => {
  const f = await replicaFixture();
  const root = await temp();
  try {
    const only = { tenants: [f.tenantId] };
    const first = await backupAll(f.management, root, { ...only, replicaUrls: `db0=${REPLICA_URL}` });
    const second = await backupAll(f.management, root, { ...only, replicaUrls: `db0=${REPLICA_URL}` });
    expect([first.full, first.written, second.full, second.written, second.unchanged]).toEqual([true, 1, true, 1, 0]);
    const manifest = JSON.parse(await readFile(join(root, second.id, "manifest.json"), "utf8")) as { source?: string; replayLsn?: Record<string, string> };
    expect(manifest.source).toBe("replica");
    expect(Object.keys(manifest.replayLsn ?? {})).toEqual(["db0"]);
    const primary = await backupAll(f.management, root, only); // replica setini taban alır, ama işaret olmadığı için yeniden yazar
    expect([primary.written, primary.unchanged]).toEqual([1, 0]);
    const again = await backupAll(f.management, root, only); // şimdi artımlı: değişmemiş
    expect([again.written, again.unchanged]).toEqual([0, 1]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
}, 120_000);

integration("a lagging replica is refused before anything is written: no export directory, no backup set", async () => {
  const f = await replicaFixture();
  const lagging = createTestManagement({ replicaMaxLagMs: 200 }, replicaConfig(REPLICA_URL));
  const dir = await temp();
  try {
    await pauseReplay(f.replica);
    await f.runtime().withTenant(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "late", uniqueEmail()]));
    await Bun.sleep(500);
    const target = join(dir, "export");
    expect(await failure(exportTenant(lagging, f.tenantId, target, { replicaUrls: `db0=${REPLICA_URL}` }))).toBe("REPLICA_LAG_EXCEEDED");
    expect(await exists(target)).toBe(false);
    expect(await failure(backupAll(lagging, join(dir, "sets"), { replicaUrls: `db0=${REPLICA_URL}` }))).toBe("REPLICA_LAG_EXCEEDED");
    expect(await exists(join(dir, "sets"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await lagging.close();
    await f.close();
  }
});

integration("the primary URL is refused as a replica source", async () => {
  const f = await replicaFixture();
  try {
    expect(await failure(exportTenant(f.management, f.tenantId, join(tmpdir(), `never-${crypto.randomUUID()}`), { replicaUrls: `db0=${PRIMARY_URL}?application_name=x` }))).toBe("INVALID_CONFIG");
  } finally {
    await f.close();
  }
});

integration("a real recovery conflict on the replica is recognised as REPLICA_CONFLICT", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime();
    await db.withTenant(f.tenantId, async (t) => {
      for (let i = 0; i < 50; i++) await t.query(createUser, [crypto.randomUUID(), `u${i}`, uniqueEmail()]);
    });
    await caughtUp(f.primary, f.replica);
    const schema = (await f.management.platform.get(f.tenantId)).schemaName;
    const snapshot = await f.replica.pool.reserve();
    try {
      await snapshot.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await snapshot.query(`SELECT count(*) FROM "${schema}".users`);
      await f.primary.pool.exec(`DELETE FROM "${schema}".users`);
      await f.primary.pool.exec(`VACUUM "${schema}".users`);
      let error: unknown;
      for (let attempt = 0; attempt < 40 && !error; attempt++) {
        await Bun.sleep(250);
        error = await snapshot.query(`SELECT count(*) FROM "${schema}".users`).then(() => undefined, (e: unknown) => e);
      }
      expect(error, "standby should cancel the held snapshot after max_standby_streaming_delay").toBeDefined();
      expect(replicaConflict(error)).toMatchObject({ code: "REPLICA_CONFLICT" });
    } finally {
      snapshot.release(true);
    }
  } finally {
    await f.close();
  }
}, 60_000);
```

- [ ] **Step 2: Run**

Run: `docker compose -p dbreplica up -d postgres-rp postgres-rp-replica` (ayakta değilse), sonra
`RUN_INTEGRATION=1 bun test --timeout 120000 src/__tests__/integration/replica-tools.test.ts`
Expected: 7 test PASS. Önceden kasıtlı bozma: bir test'te (ör. `--from-replica` dalını geçici devre dışı bırakarak) başarısızlığı bir kez gözleyin, sonra geri alın; ledger'a yazın.

Bilinen riskler ve kararlar: (a) `pg_switch_wal` ilk testte lag'i görünür kılar ama gerekirse yazı sorgusu kullanın; (b) son test zamanlamaya duyarlıdır — iki ardışık çalıştırmada kararsızsa ledger'a `Ruling` yazıp testi birim düzeyindeki `replicaConflict` testine (Task 3) bırakın ve gerekçeyi final mesajına ekleyin; (c) `f.management.platform.get` dönüş tipi `Placement` değilse (`schemaName` yoksa) `tenantSchema(f.tenantId)` kullanın.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/integration/replica-tools.test.ts src/__tests__/integration/replica-fixture.ts
git commit -m "test: replica tools against a real streaming replica

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sağlayıcı replica ölçümü (`verify:provider --replica`, sahip çalıştırması)

**Files:**
- Modify: `src/__tests__/provider/measure.ts` (`replica` ölçümü)
- Modify: `src/__tests__/provider/verify.ts` (`verify`, `--replica`)
- Test: `src/__tests__/unit/provider-verify.test.ts` (ekleme)

**Interfaces:**
- Consumes: C1 `probeReplica`; mevcut `Context`, `withPool` (measure.ts içinde özel; aynı dosyada kullanılır), `describe`.
- Produces: `replica(ctx, primaryUrl, replicaUrl, samples?, gapMs?): Promise<ReplicaResult>`; `ReplicaResult = { inRecovery: boolean; lagMs: (number | null)[]; maxStandbyStreamingDelay: string | null; hotStandbyFeedback: string | null } | { error: string }`; `verify(..., timing?, replicaUrls?: readonly (string | undefined)[])` ile düğüm raporuna `replica?: ReplicaResult`; `--replica` bayrağı replica URL'lerini gizli girişle sorar.

- [ ] **Step 1: Write the failing test**

`provider-verify.test.ts` sonuna:

```ts
test("verify measures a replica per node when replica URLs are given, and the report still carries no URL or host", async () => {
  const fake = fakeDriver((text, params, pool) => {
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: true, caught_up: false, lag_ms: 12 }];
    if (text.startsWith("SHOW max_standby_streaming_delay")) return [{ max_standby_streaming_delay: "30s" }];
    if (text.startsWith("SHOW hot_standby_feedback")) return [{ hot_standby_feedback: "off" }];
    return handler(text, params, pool);
  });
  const replicas = ["postgres://app:pw-r0@replica0.example.com/app", undefined];
  const report = await verify(fake.driver, "bun", management, runtime, new Date("2026-10-03T10:00:00Z"), timing, replicas);
  expect(report.nodes[0]?.replica).toEqual({ inRecovery: true, lagMs: [12, 12, 12], maxStandbyStreamingDelay: "30s", hotStandbyFeedback: "off" });
  expect(report.nodes[1]?.replica).toBeUndefined();
  const text = JSON.stringify(report);
  for (const secret of ["pw-r0", "replica0.example.com"]) expect(text).not.toContain(secret);
});

test("a failing replica measurement becomes a scrubbed error entry, not an exception", async () => {
  const fake = fakeDriver((text, params, pool) => {
    if (pool.url.includes("replica0")) throw new Error(`cannot connect to ${pool.url} password pw-r0`);
    return handler(text, params, pool);
  });
  const report = await verify(fake.driver, "bun", management, runtime, new Date(), timing, ["postgres://app:pw-r0@replica0.example.com/app", undefined]);
  expect(report.nodes[0]?.replica).toMatchObject({ error: expect.any(String) });
  expect(JSON.stringify(report)).not.toContain("pw-r0");
});
```

Not: `samples`/`gapMs` varsayılanları testte `timing` ile kısaltılamaz; ölçüm yalnızca 3 örnek ve `gapMs` varsayılanı 1000 ms ise test 2 sn sürer. Bunu önlemek için `timing`'e `gapMs` ekleyin: `replica(ctx, primary, replica, timing.gapMs ?? 1000)` ve testteki `timing` nesnesini `{ afterMs: 1, waitMs: 20, pollMs: 1, gapMs: 1 }` yapın.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/unit/provider-verify.test.ts`
Expected: FAIL — `replica` alanı tanımsız.

- [ ] **Step 3: Write minimal implementation**

`measure.ts`'e (dosya sonuna; `probeReplica` içe aktarmasını ekleyin: `import { probeReplica } from "../../core/tenants/replicas";`):

```ts
export type ReplicaResult =
  | { inRecovery: boolean; lagMs: (number | null)[]; maxStandbyStreamingDelay: string | null; hotStandbyFeedback: string | null }
  | { error: string };

const SAMPLES = 3;

/** Replica'nın gerçek davranışı: üç örnekte lag (replay LSN'e göre) ve recovery çakışmasını belirleyen iki ayar. Yalnızca okur. */
export async function replica({ driver, urls }: Context, primaryUrl: string, replicaUrl: string, gapMs = 1000): Promise<ReplicaResult> {
  try {
    return await withPool(driver, primaryUrl, (primary) =>
      withPool(driver, replicaUrl, async (standby) => {
        const lagMs: (number | null)[] = [];
        let inRecovery = false;
        for (let sample = 0; sample < SAMPLES; sample++) {
          if (sample) await sleep(gapMs);
          const probed = await probeReplica(primary, standby);
          inRecovery = probed.inRecovery;
          lagMs.push(probed.lagMs);
        }
        const setting = async (name: string) => (await standby.query<Record<string, string>>(`SHOW ${name}`))[0]?.[name] ?? null;
        return { inRecovery, lagMs, maxStandbyStreamingDelay: await setting("max_standby_streaming_delay"), hotStandbyFeedback: await setting("hot_standby_feedback") };
      }),
    );
  } catch (error) {
    return { error: describe(error, urls) };
  }
}
```

(`sleep` zaten aynı dosyada tanımlı; `SHOW <ad>` sabit isimlerle çağrılır, girdi değildir.)

`verify.ts`: `NodeReport`'a `replica?: ReplicaResult;`; `verify`'ye 7. parametre `replicaUrls: readonly (string | undefined)[] = []`; `ctx.urls` içine ekle (`[...management, ...runtime, ...replicaUrls.filter((u): u is string => !!u)]`); düğüm girdisini oluştururken: `...(replicaUrls[index] ? { replica: await replica(ctx, managementUrl, replicaUrls[index] as string, timing?.gapMs) } : {})` (`deadline`'ın `timing` tipine `gapMs?: number` ekleyin ve `replica`'yı içe aktarın). `main()`:

```ts
    const wantsReplica = process.argv.includes("--replica");
    const replicaAnswer = wantsReplica ? await askSecret("Replica URL'leri (db0=postgres://…, virgüllü, yazılan görünmez): ") : undefined;
    const replicaUrls = replicaAnswer === undefined ? [] : createConfig(managementUrls, replicaAnswer).nodes.map((node) => node.replicas[0]);
```

(`createConfig`'i `../../core/config` içe aktarmasına ekleyin; `verify(driver, name, managementUrls, runtimeUrls, undefined, undefined, replicaUrls)`. Dosyanın başındaki açıklama yorumuna "`--replica`: replica URL'lerini gizli girişle sorar ve lag/ayarları ölçer" ekleyin.)

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/unit/provider-verify.test.ts src/__tests__/unit/provider-measure.test.ts && bunx tsc --noEmit && bunx eslint src/__tests__/provider --fix`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/provider src/__tests__/unit/provider-verify.test.ts
git commit -m "verify:provider: optional replica lag and standby settings measurement

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Belgeler

**Files:**
- Modify: `docs/replicas.md` (C1'de oluşturuldu; araç bölümü), `docs/cli.md`, `docs/errors.md`, `docs/operations.md`, `docs/providers.md`, `docs/README.md`, `README.md`

**Interfaces:** Yok; Task 1–6'nın davranışını anlatır.

- [ ] **Step 1: `docs/replicas.md` — "Araçlar" bölümü ekle:** `replicas` (örnek çıktı, çıkış kodu 1 koşulu, URL yok), `doctor` replica denetimleri tablosu (altı denetim ve `replica_pooled`'ın bilgi amaçlı olduğu), `--from-replica` (gizli girişle `db0=postgres://…` doğrudan URL; neden doğrudan: çok adımlı REPEATABLE READ snapshot'ı; replica olduğu, lag eşiği ve doğrudanlık doğrulaması; her tenant tam yedeklenir ve nedeni: artımlı işaret replike edilmeyen `pg_stat_user_tables` sayaçlarına dayanır; manifest `source: "replica"` + `replayLsn`; placement/platform kayıtları primary'den; uzun snapshot'ta `REPLICA_CONFLICT` ve çaresi (yeniden dene ya da primary'den al); sessiz primary'ye düşme yoktur).
- [ ] **Step 2: Diğer belgeler.** `cli.md`: `replicas` komutu; `backup` ve `export` için `--from-replica` (ve `export`'un spec'teki "export-tenant" olduğunu belirtmeyin, yalnızca komut adını yazın); `errors.md`: `REPLICA_CONFLICT` ("the replica canceled a long snapshot (recovery conflict); retry or export from the primary") ve `REPLICA_LAG_EXCEEDED` ("the replica is behind by more than `replicaMaxLagMs`; wait or raise the limit") satırları; `operations.md`: "Replica'dan yedek" bölümü (ne zaman: primary yükünü azaltmak; sınırlar; geri yükleme aynı `restore`); `providers.md`: replica satırı **"documented, not verified"** ve sahip çalıştırması: `DATABASE_URLS='<yönetim URL>' bun run verify:provider --replica` (replica URL'leri gizli istemde `db0=…`); beklenen alanlar (`replica.lagMs[3]`, `maxStandbyStreamingDelay`, `hotStandbyFeedback`) ve ne için bakıldığı; `docs/README.md` ve `README.md`: `replicas` komutu ve `replicas.md` bağlantısı.
- [ ] **Step 3: Doğrula.** `grep -rn "replicas.md\|--from-replica" docs README.md` ile bağlantıları ve bayrak adlarını; kod örneklerindeki imzaları (`replicaReport`, `exportTenant(…, { replicaUrls })`) kodla karşılaştırın.
- [ ] **Step 4: Tam birim paket ve tip/lint.**

Run: `bun test src/__tests__/unit && bunx tsc --noEmit && bunx eslint .`
Expected: hepsi PASS / temiz. Başarısız bir test varsa (bu planın dışında da olsa) adıyla raporlayın.

- [ ] **Step 5: Commit**

```bash
git add docs README.md
git commit -m "docs: replica tools, replica-sourced backup limits and provider verification

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Owner-run (sahip çalıştırması, kod değil)

Bu plan bittiğinde sahip kendi Neon/Supabase hesabında (replica açık bir projede) çalıştırır; çıktıyı yapıştırır, `docs/providers.md` replica satırı `verified (tarih, sürücü)` olur ve karar tablosuna göre aksiyon alınır (kod gerekirse yeni görev, önce RED test):

```bash
DATABASE_URLS='<yönetim (direct/session) URL>' bun run verify:provider --replica
```

(Runtime URL'si ve replica URL'leri gizli istemde sorulur.)

## Self-Review

- **Spec kapsamı:** C3 `replicas` (Task 1), `doctor` altı denetim (Task 2), `--from-replica` doğrulama/okuma/tam yedek/manifest/placement-primary/lag kapısı/çakışma (Task 3–5), sağlayıcı ölçümü (Task 6), belgeler (Task 7), hatalar `REPLICA_CONFLICT` ve `REPLICA_LAG_EXCEEDED` (Task 3 kaynağı, Task 5 testi). C1 planındaki `replicas()` işlevi ve router ön koşuldur.
- **Spec'ten sapmalar (açık):** komut adı `export` (`export-tenant` değil); `replica_runtime_timeouts` ve `replica_pooled` denetimleri doctor'a eklenir (spec "A'nın pooler sınaması ve DB varsayılan timeout kontrolü replica URL'lerine de uygulanır" der); `REPLICA_CONFLICT` eşlemesi `ReplicaSource.node()` sarmalayıcısında yapıldığı için `backup.ts`'te try/catch gerekmez. Koddan doğrulanan maddeler: kimlik `platform.node_identity` (Task 2), `backupAll` marker'ı (`uncounted:<uuid>` yolu, Task 4–5 testi), düğüm başına tek replica kuralı (`createConfig` doğrulaması + Task 3).
- **Tip tutarlılığı:** `ReplicaSource` (`has/node/replayLsn/close`), `replicaUrls` seçenek adı (Task 3–5 aynı), `ReplicaReport.usable` (C1 ile aynı), `ReplicaResult` (Task 6).
