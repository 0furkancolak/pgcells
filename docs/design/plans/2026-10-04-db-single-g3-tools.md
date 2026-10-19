# G3 — `db-single` araçları, auth, belge ve dört sürücülü kabul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** G2 çekirdeğinin üstüne `db-single`'ın CLI'sini ve araçlarını (migrate/seed komutları, pull, export/backup/restore, doctor, replicas, Neon/Supabase, Better Auth), belgelerini ve dört sürücülü tam entegrasyon taramasını eklemek; spec'in beş kabul ölçütünü kanıtlamak.

**Architecture:** Araçlar G2'nin `Management` bağlamını (`m.db`, `m.schema`, `m.config.url`) alan düz fonksiyonlardır; tenant'lı karşılıklarından kopyalanmaz, tek schema için küçük yeniden yazımlardır (yalnızca `jsonl`, `ask-secret`, `copy` ve `neon`/`pull`'un genel kısımları kopyalanır). CLI aynı seçenek ayrıştırıcısını kullanır; hedef schema `--schema <ad>` bayrağıyla (varsayılan `public`) verilir, env değişkeni eklenmez.

**Tech Stack:** Bun, TypeScript, Better Auth 1.7.5 (isteğe bağlı peer), bun:test, yalıtılmış compose (`dbsingle`).

**Spec:** `docs/superpowers/specs/2026-10-04-db-single-design.md`; önceki plan: `docs/superpowers/plans/2026-10-04-db-single-g2-core.md` (G2 commit'leri dalda olmalı).

## Global Constraints

- G2'nin tüm kısıtları geçerlidir: `search_path` yok; yeni ortam değişkeni yok; çalışma anında SQL ayrıştırılmaz; yorumlar Türkçe, hata mesajları İngilizce ve URL/host/kullanıcı/parola içermez; daha az kod; TDD; `no-multi-tenant.test.ts` bekçisi her commit'te yeşil; `db-multi` değişmez.
- Parola, API anahtarı ve URL'ler yalnızca gizli girişle (`askSecret`) sorulur; argv'ye, env'e, çıktıya veya hata mesajına girmez (CLI JSON hata satırı yalnızca `AppError` mesajlarını yazar).
- Migration/seed dosyaları yalnızca CLI ile üretilir (`migration create`, `seed create`); gerçek UTC zaman damgası, yuvarlak `0000` kimlik yok.
- Commit mesajı sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push, PR, merge yok.
- Paylaşılan jamaster docker yığınına (5540/5541/5543, `jamaster-*`) dokunulmaz. Entegrasyon yalnızca `docker compose -p dbsingle …` ile, portlar (5560, 5563, 5489, 5565, 5566) boş doğrulandıktan sonra; doluysa DURUN ve sorun. Gerçek Neon/Supabase'e **bu planda hiçbir çağrı yapılmaz** (sağlayıcı araçları sahte API ile sınanır; gerçek çalıştırma kullanıcıya aittir).

## Plan-time Rulings (yürütücü ledger'a aynen geçirir)

- **R11** `export <dir>` tam o klasörü yazar (var olmamalı); `backup <kök>` her çalıştırmada `<kök>/<UTC yyyyMMddHHmmss>` altına **tam** bir set yazar, `--keep N` eskileri siler. Kademeli set, manifest, tenant işareti (istatistik sayaçları) yoktur: tenant başına incremental mantığın tek-schema karşılığı yok.
- **R12** `restore`, hedef schema yok ya da boşken çalışır (`SCHEMA_NOT_EMPTY` aksi halde, hiçbir şeyi silmez); yedekteki migration ledger'ı bu kodun listesinin öneki olmalı (`MIGRATION_DRIFT`); yedek eskiyse restore sonrası bekleyen migration'lar uygulanır. Yedek başka bir schema adına da geri yüklenebilir.
- **R13** `pull [schema]`: kaynak schema konumsal argümandır (varsayılan `public`); `pull` `--schema` bayrağını **kabul etmez**. Çıktı `src/migrations/<zaman>_<ad>.sql`'dir; ardından `migration baseline <id>` ile uygulanmış işaretlenir.
- **R14** CLI: `neon stage-copy`, `neon export <dir> --at ZAMAN`, `migrate --safety-point neon|supabase [--org ID]`. (`neon export-tenant` ve `migrate-all` yok.)
- **R15** Better Auth: tek kullanıcı kümesi (`users`, `session`, `account`, `verification`, `two_factor`, `rate_limit`); `authTables()`/`twoFactorTables()`/`rateLimitTable()` auth türü almaz; çerez öneki sabittir (`cookiePrefix`, varsayılan `auth`); tenant başına secret/önbellek/cookieCache-izolasyonu korumaları yoktur (izole edilecek bir şey yok). `importedPasswords` (bcrypt/argon2 doğrulaması) korunur; HKDF tuzu yeni pakete ait: yoktur (tenant başına secret yok).
- **R16** Pakete tek temel migration girer: `auth` (CLI ile üretilir). Başka tablo gönderilmez.
- **R17** Hata kodu `UNSUPPORTED_MOVE` → `UNSUPPORTED_SCHEMA` (taşıma kavramı yok).
- **R18** Belgeler yürütülebilir denetimle korunur (`docs.test.ts`): göreli bağlantılar çözülür, `docs/cli.md`'deki her komut `--help`'te vardır, `docs/errors.md` ile kaynaktaki hata kodları birebir aynıdır.
- **R19** `users import`, `dump *`, `app-migrate`, `adopt`, `platform-*`, `move`, `reserve/unreserve/databases`, `seed-all`, `migrate-all`, `demo-reset`, `migration-recover` yoktur (spec "Silinenler" + R3/R4).

## Review Focus

- **`restore` var olan, dolu `public`'e:** reddedilmeli, tek satır silmemeli; yarım kalan `*.partial` klasörleri geride kalmamalı (`export` başarısızsa temizlenir).
- **`public` içinde desteklenmeyen nesne** (ör. PostGIS tablosu, view): `export`/`backup` hiçbir dosya bırakmadan `UNSUPPORTED_SCHEMA` ile durmalı; mesaj nesne adını söyler, URL söylemez.
- **`migrate --safety-point neon` güvenlik noktası alınamazsa migrate hiç çalışmamalı** (önce nokta, sonra migrate); `--dry-run` nokta almaz.
- **Gizli girişler:** `--from-replica`, `--pooled-url`, `--pgbouncer-url` değeri argv'de yok; yanlış biçimli girişte hata değeri içermez; `askSecret` raw modu her çıkış yolunda geri verir.
- **`doctor` çıkış kodu:** herhangi bir denetim başarısızsa 1; sürücü hatası kimlik bilgisi sızdırmadan "inspection" olarak raporlanır; replica URL'si birincil ise `replica_in_recovery` başarısız.
- **CLI `--schema` doğrulaması:** `x"; DROP`, büyük harf, `pg_*` `INVALID_SCHEMA` ile DB'ye gitmeden reddedilmeli.

## File Structure

| Dosya | Sorumluluk | Kaynak |
|---|---|---|
| `src/core/cli.ts` | seçenek ayrıştırma, komut tablosu, `main` | yeniden yazım (genel ayrıştırıcılar kopya) |
| `src/core/tools/{ask-secret,jsonl}.ts` | gizli giriş, JSON Lines | kopya |
| `src/core/tools/copy.ts` | şekil okuma/kurma, satır akıtma (taşıma kısmı çıkarılır) | kopya + kırpma |
| `src/core/tools/backup.ts` | `exportSchema`, `backupSchema`, `restoreSchema`, `pruneBackups` | yeniden yazım |
| `src/core/tools/replica-source.ts`, `replicas.ts` | `--from-replica` kaynağı, replica raporu | yeniden yazım |
| `src/core/tools/doctor.ts` | salt okunur denetim | yeniden yazım |
| `src/core/tools/pull.ts` | var olan schema'dan başlangıç migration'ı | kopya + tek schema |
| `src/core/tools/neon.ts`, `src/__tests__/provider/*` | Neon API araçları, sağlayıcı ölçümleri | kopya + tek DB |
| `src/core/{auth,auth-adapter,auth-schema}.ts`, `src/core/tools/auth.ts` | Better Auth | yeniden yazım / kopya |
| `src/{tools,auth}.ts` | giriş noktaları | yeni |
| `src/migrations/<ts>_auth.sql` | temel migration | CLI ile üretilir |
| `src/__tests__/fixtures/{worker.ts,wrangler.jsonc,auth-options.ts}` | Workers ve auth fikstürleri | kopya + uyarlama |
| `README.md`, `docs/*.md`, `src/__tests__/unit/docs.test.ts` | belgeler ve yürütülebilir denetim | yeni |

---

### Task 1: CLI çatısı, gizli giriş, JSON Lines ve migrate/seed komutları

**Files:**
- Create: `src/core/cli.ts`; copy: `core/tools/{ask-secret,jsonl}.ts`
- Modify: `src/__tests__/integration/helpers.ts` (`packageCopy`)
- Test: yeni `unit/cli.test.ts`, kopya `unit/ask-secret.test.ts`, yeni `integration/cli.test.ts`

**Interfaces:**
- Consumes: G2 `management.ts` girişi (`createManagement`, `migrate`, `rollback`, `baseline`, `migrationStatus`, `seed`), `sql/codegen` (`createMigration`, `createSeed`), `config.boundedInteger`/`loadConfig`.
- Produces:
  - `cli.ts`: `parseOptions(args, allowed): Options`, `splitArguments(command, rest): { positional: string[]; options: string[] }`, `main(argv?): Promise<void>`, tipler `CliOptions`. Komut tablosu bu görevde: `migrate`, `migrate-down`, `migration-status`, `migration create`, `migration baseline`, `seed`, `seed create`. Sonraki görevler tabloya komut ekler (aynı dosya).
  - `tools/ask-secret.ts`: `askSecret(question, input?, output?, signals?): Promise<string>`, `postgresUrl(value, subject): URL`. `tools/jsonl.ts`: `readLines`, `batches`, `openGzipWriter`.
  - `helpers.ts`: `packageCopy(label)` → `{ root, write(path, source), codegen(), cli(...args): Promise<unknown>, remove() }`.

- [ ] **Step 1: Başlangıç doğrulaması**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
git branch --show-current && git log --format=%s -3
ls packages/db-single/src/core/migrations/runner.ts packages/db-single/src/management.ts
for p in 5560 5563 5489 5565 5566; do lsof -nP -iTCP:$p -sTCP:LISTEN | sed "s/^/port $p: /"; done
```
Expected: dal `feat/db-single`; son commit'ler G2'nin ("db-single: request scope and middleware …"); iki dosya var; port satırı yok (varsa DURUN ve sorun). `packages/db-single/.env` yoksa `cp packages/db-single/.env.example packages/db-single/.env`.

- [ ] **Step 2: Başarısız testler**

`unit/cli.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { main, parseOptions, splitArguments } from "../../core/cli";

afterEach(() => {
  process.exitCode = 0;
});

/** `console.log`/`console.error` çıktısını yakalar. */
async function capture(work: () => Promise<unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (message?: unknown) => void out.push(String(message));
  console.error = (message?: unknown) => void err.push(String(message));
  try {
    await work();
  } finally {
    [console.log, console.error] = [log, error];
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("parseOptions takes --option value and --option=value, switches and repeatable lists", () => {
  expect(parseOptions(["--schema", "app_x", "--dry-run"], ["--schema", "--dry-run"])).toEqual({ schema: "app_x", dryRun: true });
  expect(parseOptions(["--steps=3"], ["--steps"])).toEqual({ steps: 3 });
  expect(parseOptions(["--exclude", "a,b", "--exclude", "c"], ["--exclude"])).toEqual({ exclude: ["a", "b", "c"] });
});

test("unknown, repeated, valueless and out-of-range options are usage errors that never echo an argument", () => {
  expect(() => parseOptions(["--bogus"], ["--schema"])).toThrow("Unknown option: --bogus");
  expect(() => parseOptions(["--schema", "a", "--schema", "b"], ["--schema"])).toThrow("Repeated option: --schema");
  expect(() => parseOptions(["--schema"], ["--schema"])).toThrow("--schema needs a value");
  expect(() => parseOptions(["--dry-run=1"], ["--dry-run"])).toThrow("takes no value");
  for (const bad of ["0", "x", "10001"]) expect(() => parseOptions(["--steps", bad], ["--steps"])).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  const error = (() => {
    try {
      parseOptions(["postgres://admin:secret-pw@host/db"], []);
    } catch (e) {
      return e as Error;
    }
  })();
  expect(error?.message).toContain("Unexpected argument");
  expect(error?.message).not.toContain("secret-pw");
});

test("splitArguments takes positional arguments before or after options and sends extras to the option list", () => {
  const command = { usage: "<migrationId> [--schema ad]", flags: ["--schema"] };
  expect(splitArguments(command, ["--schema", "app_x", "20260101000001_x"])).toEqual({ positional: ["20260101000001_x"], options: ["--schema", "app_x"] });
  expect(splitArguments(command, ["20260101000001_x", "--schema", "app_x"])).toEqual({ positional: ["20260101000001_x"], options: ["--schema", "app_x"] });
  expect(splitArguments(command, ["a", "extra"]).options).toEqual(["extra"]);
});

test("--help lists the migration and seed commands; an unknown command fails with exit code 1", async () => {
  const help = await capture(() => main(["--help"]));
  for (const name of ["migrate", "migrate-down", "migration-status", "migration create", "migration baseline", "seed", "seed create"]) expect(help.out).toContain(name);
  const unknown = await capture(() => main(["frobnicate"]));
  expect(unknown.err).toContain("Bilinmeyen komut");
  expect(process.exitCode).toBe(1);
});

test("a bad option or a bad schema fails before any database is touched, as a JSON error line without secrets", async () => {
  const bad = await capture(() => main(["migrate", "--steps", "1"]));
  expect(JSON.parse(bad.err)).toMatchObject({ error: "USAGE" });
  const schema = await capture(() => main(["migrate", "--schema", 'x"; DROP', "--dry-run"]));
  expect(JSON.parse(schema.err)).toMatchObject({ error: "INVALID_SCHEMA" });
  const required = await capture(() => main(["migration", "baseline"]));
  expect(JSON.parse(required.err).message).toContain("Usage: migration baseline");
});
```

`integration/cli.test.ts`:

```ts
import { expect } from "bun:test";
import { dropSchema, integration, packageCopy, q, raw, testSchema } from "./helpers";

integration("authoring through the CLI: create, codegen, migrate (dry run first), status, seed, roll back", async () => {
  const copy = await packageCopy("cli");
  const schema = testSchema();
  const admin = raw();
  try {
    const created = (await copy.cli("migration", "create", "add_notes")) as { id: string; path: string };
    expect(created.path).toMatch(/^src\/migrations\/\d{14}_add_notes\.sql$/);
    await copy.write(created.path, "--up\nCREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL);\n--down\nDROP TABLE notes;\n");
    const seed = (await copy.cli("seed", "create", "first_note")) as { id: string; path: string };
    await copy.write(seed.path, "INSERT INTO notes (id, body) VALUES (1, 'hello');\n");
    await copy.codegen();

    expect(await copy.cli("migration-status", "--schema", schema)).toMatchObject({ schema, applied: 0, pending: [{ id: created.id, transactional: true }] });
    expect(await copy.cli("migrate", "--schema", schema, "--dry-run")).toEqual({ dryRun: true, migrations: [created.id] });
    expect(await copy.cli("migrate", "--schema", schema)).toEqual({ dryRun: false, migrations: [created.id] });
    expect(await copy.cli("seed", "--schema", schema)).toEqual({ dryRun: false, seeds: [seed.id] });
    expect(await admin.query(`SELECT body FROM ${q(schema, "notes")}`)).toEqual([{ body: "hello" }]);
    expect(await copy.cli("migrate", "--schema", schema)).toEqual({ dryRun: false, migrations: [] });
    expect(await copy.cli("migrate-down", "--schema", schema)).toEqual({ dryRun: false, migrations: [created.id] });
    const [gone] = await admin.query<{ ok: boolean }>("SELECT to_regclass($1) IS NULL AS ok", [`${q(schema)}.notes`]);
    expect(gone?.ok).toBe(true);
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await copy.remove();
  }
});

integration("migration baseline marks a hand-built schema applied through the CLI", async () => {
  const copy = await packageCopy("baseline");
  const schema = testSchema();
  const admin = raw();
  try {
    const created = (await copy.cli("migration", "create", "add_notes")) as { id: string; path: string };
    await copy.write(created.path, "--up\nCREATE TABLE notes (id integer PRIMARY KEY);\n--down\nDROP TABLE notes;\n");
    await copy.codegen();
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "notes")} (id integer PRIMARY KEY)`);
    expect(await copy.cli("migration", "baseline", created.id, "--schema", schema)).toEqual({ migrations: [created.id] });
    expect(await copy.cli("migrate", "--schema", schema)).toEqual({ dryRun: false, migrations: [] });
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await copy.remove();
  }
});
```

Kopya test: `cp packages/db-multi/src/__tests__/unit/ask-secret.test.ts packages/db-single/src/__tests__/unit/` (yalnızca `../../core/tools/ask-secret` içe aktarır; tenant/platform sözcüğü içeriyorsa bekçi bildirir).

`helpers.ts`'e ekleyin (üst içe aktarmalara `cp, mkdtemp, rm` ve `join`, `writeGenerated`):

```ts
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeGenerated } from "../../core/sql/codegen";
```
```ts
/** CLI Neon (yalnızca runtime) kullanamaz: Neon seçiliyken Bun SQL. */
const cliDriver = name === "neon" ? "bun" : name;

/** Paketin geçici kopyası (testler hariç; `packages/db-single` altında, bağımlılıklar çözülür). Test-yerel migration ve seed kaynakları
 * buraya yazılır; `codegen` sonrası kopyanın CLI'si kendi registry'siyle çalışır, bu sürecin registry'si değişmez. */
export async function packageCopy(label: string) {
  const root = await mkdtemp(join(import.meta.dir, `../../../.tmp-${label}-`));
  await cp(join(import.meta.dir, "../.."), join(root, "src"), { recursive: true, filter: (path) => !path.includes("__tests__") });
  return {
    root,
    write: (path: string, source: string) => Bun.write(join(root, path), source),
    codegen: () => writeGenerated(root),
    /** Kopyada `src/core/cli.ts`; çıkış kodu 0 olmalı, son JSON nesnesi döner. */
    async cli(...args: string[]): Promise<unknown> {
      const child = Bun.spawn([process.execPath, "src/core/cli.ts", ...args, `--driver=${cliDriver}`], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, `${args.join(" ")}: ${stderr}`).toBe(0);
      return JSON.parse(stdout.split(/\n(?=\{)/).at(-1) ?? "");
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 3: Başarısızlığı gör**

```bash
cd packages/db-single && bun test src/__tests__/unit/cli.test.ts 2>&1 | tail -6
```
Expected: `core/cli` yok → **fail**.

- [ ] **Step 4: Kopyalar ve `cli.ts`**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
mkdir -p packages/db-single/src/core/tools
cp packages/db-multi/src/core/tools/{ask-secret,jsonl}.ts packages/db-single/src/core/tools/
cp packages/db-multi/src/__tests__/unit/ask-secret.test.ts packages/db-single/src/__tests__/unit/
```

`packages/db-single/src/core/cli.ts`:

```ts
/** `bun run cli` ve `bun run tools` (aynı giriş): argümanları doğrular, yönetim ve araç fonksiyonlarını çağırır, JSON yazdırır; hata
 * veya eksik işte çıkış kodu 1. DB modülleri ve seçilen sürücü geç yüklenir; `local` komutlar (dosya üretenler) DB'ye bağlanmaz. */
import { boundedInteger } from "./config";
import type { Driver } from "./driver";
import { AppError, errorCode } from "./errors";
import { validateSchema } from "./identifier";
import type { Management } from "./management";
import type * as ManagementApi from "../management";

export type CliOptions = {
  /** Hedef schema (`--schema`); verilmezse `public`. */
  schema?: string;
  steps?: number;
  to?: string;
  name?: string;
  keep?: number;
  set?: string;
  at?: string;
  org?: string;
  safetyPoint?: string;
  exclude?: string[];
  signal?: AbortSignal;
  report?: (event: Record<string, unknown>) => void;
};
/** Değer almayan seçenekler; `--pgbouncer-url`, `--pooled-url` ve `--from-replica` yalnızca "URL'yi gizli girişle sor" anlamına gelir. */
type Switches = { dryRun?: boolean; ts?: boolean; pgbouncerUrl?: boolean; pooledUrl?: boolean; fromReplica?: boolean };
type Options = CliOptions & Switches;
interface Command {
  /** `<x>` zorunlu, `[x]` isteğe bağlı argüman; `--…` yalnızca yardım metnidir. */
  usage: string;
  summary: string;
  /** Kabul edilen seçenekler. */
  flags?: readonly string[];
  /** SIGINT/SIGTERM yeni iş alımını durdurur ve iş iptal edilir; yerel komutlarda işi durdurur. */
  cancellable?: boolean;
  local?(options: Options, ...args: string[]): Promise<unknown>;
  run?(context: { api: typeof ManagementApi; app: Management; options: Options }, ...args: string[]): Promise<unknown>;
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const usage = (message: string) => new AppError("USAGE", message);
const BOOLEAN_FLAGS = ["--dry-run", "--ts", "--pgbouncer-url", "--pooled-url", "--from-replica"];
/** Tekrarlanabilen seçenekler: değerler (virgülle de ayrılabilir) listede birikir. */
const REPEATABLE_FLAGS = ["--exclude"];
/** Sayı seçenekleri → üst sınır. */
const INTEGER_FLAGS: Record<string, number> = { "--steps": 10000, "--keep": 1000 };
const HELP_FLAGS = ["--help", "-h"];
const DRIVER_FLAG = "--driver=";
const SCHEMA_FLAGS = ["--schema"];
const commaList = (value: string) => value.split(",").map((id) => id.trim()).filter(Boolean);
/** Yalnızca seçilen sürücü yüklenir; CLI Bun'da çalıştığı için varsayılan Bun SQL'dir. */
const drivers: Record<string, () => Promise<Driver>> = {
  bun: () => import("./drivers/bun").then((m) => m.bunDriver),
  postgres: () => import("./drivers/postgres").then((m) => m.postgresDriver),
  pg: () => import("./drivers/pg").then((m) => m.pgDriver),
};

const commands: Record<string, Command> = {
  migrate: {
    usage: "[--dry-run] [--schema ad]",
    summary: "Bekleyen migration'ları uygular; schema yoksa kurar ve runtime timeout'larını DB varsayılanı olarak yazar",
    flags: ["--dry-run", ...SCHEMA_FLAGS],
    cancellable: true,
    run: ({ api, app, options }) => api.migrate(app, options),
  },
  "migrate-down": {
    usage: "[--steps N | --to ID] [--dry-run] [--schema ad]",
    summary: "Son migration'ları geri alır (varsayılan 1)",
    flags: ["--steps", "--to", "--dry-run", ...SCHEMA_FLAGS],
    cancellable: true,
    run: ({ api, app, options }) => api.rollback(app, options),
  },
  "migration-status": {
    usage: "[--schema ad]",
    summary: "Uygulanmış sayıyı ve bekleyen migration'ları gösterir (salt okunur)",
    flags: SCHEMA_FLAGS,
    run: ({ api, app }) => api.migrationStatus(app),
  },
  "migration create": {
    usage: "<name>",
    summary: "Boş --up/--down dosyası (src/migrations/<UTC zaman>_<ad>.sql) ve liste",
    local: async (_, name) => (await import("./sql/codegen")).createMigration({ name }),
  },
  "migration baseline": {
    usage: "<migrationId> [--schema ad]",
    summary: "Çalıştırmadan uygulanmış işaretler (canlı schema migration'ın tablo, sütun ve enum'larını içermeli)",
    flags: SCHEMA_FLAGS,
    cancellable: true,
    run: ({ api, app, options }, migrationId) => api.baseline(app, migrationId, options),
  },
  seed: {
    usage: "[--dry-run] [--schema ad]",
    summary: "Bekleyen seed'leri uygular (migration'lar güncel olmalı)",
    flags: ["--dry-run", ...SCHEMA_FLAGS],
    cancellable: true,
    run: ({ api, app, options }) => api.seed(app, options),
  },
  "seed create": {
    usage: "<name> [--ts]",
    summary: "Boş SQL (veya --ts) seed dosyası ve liste",
    flags: ["--ts"],
    local: async ({ ts }, name) => (await import("./sql/codegen")).createSeed({ name, kind: ts ? "ts" : "sql" }),
  },
};

/** Kısa satırlarda özet 40. sütunda; uzun satırlarda bir alt satırda aynı sütunda. */
const helpLine = ([name, command]: [string, Command]) => {
  const line = `${name} ${command.usage}`.trim();
  return line.length < 40 ? `  ${line.padEnd(40)}${command.summary}` : `  ${line}\n  ${" ".repeat(40)}${command.summary}`;
};

const help = `Tek veritabanı yönetim aracı

Kullanım:
  bun run cli <komut> [argümanlar] [seçenekler] [--driver=bun|postgres|pg]

Komutlar:
${Object.entries(commands).map(helpLine).join("\n")}

Seçenek değeri --ad değer veya --ad=değer biçiminde verilir. Hedef schema --schema ile verilir (varsayılan public).
Ortam: DATABASE_URLS (zorunlu; bu pakette tek URL; doğrudan veya session pooling bağlantısı).
Sürücü: --driver (varsayılan bun). Ayrıntılı kurulum için README'ye bakın.`;

const camelCase = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Değerli seçeneğin değerini türüne göre çözer: sınırlı tamsayı ya da metin. */
function optionValue(flag: string, value: string): unknown {
  const max = INTEGER_FLAGS[flag];
  return max === undefined ? value : boundedInteger(value, flag.slice(2), max);
}

/** `--seçenek değer` veya `--seçenek=değer`; kabul edilmeyen, tekrarlanan veya değersiz seçenek `USAGE`. */
export function parseOptions(args: readonly string[], allowed: readonly string[] = []): Options {
  const options: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const [flag = "", inline] = (args[i] ?? "").split(/=(.*)/s);
    // Argüman metni gizli olabilir (parolalı URL): yalnızca seçenek adları yazdırılır.
    if (!allowed.includes(flag))
      throw usage(flag.startsWith("--") ? `Unknown option: ${flag}` : "Unexpected argument: values are given as --option value, and URL options ask for the value with hidden input");
    const repeatable = REPEATABLE_FLAGS.includes(flag);
    if (seen.has(flag) && !repeatable) throw usage(`Repeated option: ${flag}`);
    seen.add(flag);
    const key = camelCase(flag.slice(2));
    if (BOOLEAN_FLAGS.includes(flag)) {
      if (inline !== undefined) throw usage(`${flag} takes no value`);
      options[key] = true;
      continue;
    }
    const value = inline ?? args[++i];
    if (!value || value.startsWith("--")) throw usage(`${flag} needs a value`);
    options[key] = repeatable ? [...((options[key] as string[] | undefined) ?? []), ...commaList(value)] : optionValue(flag, value);
  }
  return options;
}

/** `--driver=` argümanlarını ayırır; geri kalanlar komut ve seçeneklerdir. */
function takeDriverFlag(argv: readonly string[]) {
  const isDriverFlag = (arg: string) => arg.startsWith(DRIVER_FLAG);
  return {
    driverNames: argv.filter(isDriverFlag).map((arg) => arg.slice(DRIVER_FLAG.length)),
    args: argv.filter((arg) => !isDriverFlag(arg)),
  };
}

function selectDriver(driverNames: readonly string[]) {
  const driver = drivers[driverNames.at(-1) ?? "bun"];
  if (driverNames.length > 1 || !driver) throw usage("--driver must be one of: bun, postgres, pg");
  return driver;
}

/** İki kelimelik komutlar (`migration create`) tek kelimelilerden önce eşleşir. */
function resolveCommand(args: readonly string[]) {
  const words = Object.hasOwn(commands, args.slice(0, 2).join(" ")) ? 2 : 1;
  const name = args.slice(0, words).join(" ");
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  return { name, command, rest: args.slice(words) };
}

const requiredCount = (command: Pick<Command, "usage">) => command.usage.split("<").length - 1;

/** Konum argümanları seçeneklerden önce ya da sonra gelebilir (script'ler seçeneği önce yazar: `migration create --x ad`).
 * Kabul edilen değerli seçeneğin (`--ad değer`) sonraki argümanı değeridir. En çok zorunlu + isteğe bağlı sayıda konum argümanı
 * alınır; fazlası seçenek listesine düşer ve `USAGE` verir. `[x]` isteğe bağlı konum argümanıdır, `[--x]` sayılmaz. */
export function splitArguments(command: Pick<Command, "usage" | "flags">, rest: readonly string[]) {
  const max = requiredCount(command) + (command.usage.match(/\[(?!-)/g)?.length ?? 0);
  const positional: string[] = [];
  const options: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    const next = rest[i + 1];
    if (arg.startsWith("--")) {
      options.push(arg);
      const takesValue = !arg.includes("=") && !BOOLEAN_FLAGS.includes(arg) && (command.flags ?? []).includes(arg);
      if (takesValue && next !== undefined && !next.startsWith("--")) options.push(rest[++i] ?? "");
    } else if (positional.length < max) positional.push(arg);
    else options.push(arg);
  }
  return { positional, options };
}

const CANCEL_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** İptal edilebilir komutlarda SIGINT/SIGTERM `stop` çağırır. */
function onCancelSignals(command: Command, stop: () => void) {
  if (command.cancellable) for (const signal of CANCEL_SIGNALS) process.once(signal, stop);
}

const wantsHelp = (name: string, command: Command | undefined, rest: readonly string[]) =>
  ["", "help", ...HELP_FLAGS].includes(name) || (command !== undefined && rest.some((arg) => HELP_FLAGS.includes(arg)));

export async function main(argv = process.argv.slice(2)) {
  const { driverNames, args } = takeDriverFlag(argv);
  const { name, command, rest } = resolveCommand(args);
  if (wantsHelp(name, command, rest)) return console.log(help);
  if (!command) {
    console.error(`Bilinmeyen komut: ${name}\n\n${help}`);
    process.exitCode = 1;
    return;
  }
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  let app: Management | undefined;
  try {
    const driver = selectDriver(driverNames);
    const split = splitArguments(command, rest);
    const options = parseOptions(split.options, command.flags ?? []);
    // Hedef schema DB'ye ve ortama bakmadan doğrulanır.
    if (options.schema !== undefined) validateSchema(options.schema);
    const positional = split.positional;
    if (positional.length < requiredCount(command)) throw usage(`Usage: ${name} ${command.usage}`.trim());
    onCancelSignals(command, stop);
    if (command.local) return print(await command.local({ ...options, signal: cancellation.signal }, ...positional));
    const [api, { loadConfig }] = await Promise.all([import("../management"), import("./config")]);
    app = api.createManagement(loadConfig(), { driver: await driver(), schema: options.schema });
    print(await command.run?.({ api, app, options: { ...options, signal: cancellation.signal, report: print } }, ...positional));
  } catch (error) {
    // Sürücü hataları kimlik bilgisi içerebilir: yalnızca AppError mesajları yazdırılır.
    const message = error instanceof AppError ? error.message : "Operation failed; inspect PostgreSQL availability";
    console.error(JSON.stringify({ error: errorCode(error), message }));
    process.exitCode = 1;
  } finally {
    for (const signal of CANCEL_SIGNALS) process.removeListener(signal, stop);
    if (cancellation.signal.aborted) process.exitCode = 1;
    await app?.close().catch(() => {});
  }
}

if (import.meta.main) await main();
```

- [ ] **Step 5: Geçiş**

```bash
bun run typecheck && bun run lint && bun test src/__tests__/unit 2>&1 | tail -6
docker compose -p dbsingle up -d --build --wait postgres pgbouncer wsproxy postgres-rp postgres-rp-replica
RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/cli.test.ts 2>&1 | tail -6
```
Expected: birim yeşil (cli 5, ask-secret pass); `cli` entegrasyon 2 test **pass**; `ls .tmp-* 2>/dev/null | wc -l` `0` (kopyalar silinir).

- [ ] **Step 6: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: CLI skeleton with migrate, migrate-down, migration-status, migration create/baseline, seed commands; hidden-input and JSON Lines helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `pull` — var olan schema'dan başlangıç migration'ı

**Files:**
- Copy+edit: `core/tools/pull.ts`
- Modify: `core/cli.ts` (komut ekler)
- Test: kopya+uyarlama `unit/pull.test.ts`; yeni `integration/pull.test.ts`

**Interfaces:**
- Consumes: G2 `source.ts` (`checksum`, `compileMigrations`, `MIGRATION_NAME`, `migrationPrefix`, `pullMarker`), `compiler.unqualifyMigration`, `identifier.quoteIdentifier`, `codegen.createMigration`, Task 1 CLI.
- Produces (`pull.ts`): `PulledStructure`, `pullStructure(db: Connection, schema: string, exclude?: readonly string[]): Promise<PulledStructure>`, `pulledMigration(pulled, schema): string`, `PullOptions { name?; exclude?; now?; root? }`, `pullSchema(m: Management, schema: string, options?: PullOptions)`, `sqlType`, `canonicalTypes`. CLI: `pull [schema] [--name ad] [--exclude tablo ...]`.

- [ ] **Step 1: Başarısız entegrasyon testi**

`integration/pull.test.ts`:

```ts
/** `pull`: canlı schema → başlangıç migration'ı → aynı yapı başka schema'da; farklı yapı farklı özet; desteklenmeyen nesneler; baseline ile uygulanmış. */
import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { compileMigrations } from "../../core/migrations/source";
import { createRunner } from "../../core/migrations/runner";
import { pullSchema, pullStructure } from "../../core/tools/pull";
import { createTestManagement, dropSchema, failure, integration, q, raw, testSchema } from "./helpers";

/** Eski uygulamanın bir schema'sı: enum, identity, yabancı anahtar, CHECK, kısmi ifade index'i ve Drizzle ledger'ı. */
const legacySchema = (schema: string) => `CREATE SCHEMA ${q(schema)};
CREATE TYPE ${q(schema, "task_status")} AS ENUM ('TODO', 'DONE');
CREATE TABLE ${q(schema, "users")} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(255) NOT NULL, created_at timestamp(3) with time zone DEFAULT now() NOT NULL, tags text[] DEFAULT '{}'::text[]);
CREATE TABLE ${q(schema, "tasks")} (number integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES ${q(schema, "users")}(id) ON DELETE CASCADE,
  status ${q(schema, "task_status")} DEFAULT 'TODO' NOT NULL, title varchar(80), CONSTRAINT title_check CHECK (title::varchar(20) <> ''));
CREATE UNIQUE INDEX users_email_lower ON ${q(schema, "users")} (lower(email)) WHERE created_at IS NOT NULL;
CREATE TABLE ${q(schema, "drizzle_migrations")} (id serial PRIMARY KEY, hash text)`;

integration("pull writes an initial migration that rebuilds the same structure in another schema, and baseline marks the source applied", async () => {
  const admin = raw();
  const m = createTestManagement();
  const [source, copy, drifted] = [testSchema(), testSchema(), testSchema()];
  const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-pull-"));
  try {
    await admin.exec(legacySchema(source));
    await mkdir(join(root, "src/migrations"), { recursive: true });
    const result = await pullSchema(m, source, { root, now: new Date(Date.UTC(2026, 8, 15, 18, 4, 27)) });
    expect(result).toMatchObject({ id: "20260915180427_init", schema: source, enums: 1, tables: 2, exclude: ["_migrations", "_seeds", "drizzle_migrations"] });
    expect(result.path).toBe("src/migrations/20260915180427_init.sql");
    const text = await Bun.file(join(root, result.path)).text();
    // Yalnızca başlık kaynağı adlandırır; SQL schema'sızdır.
    expect(text.split("\n").slice(3).join("\n")).not.toContain(source);
    const [migration] = compileMigrations([[result.id, text]]);
    expect(migration?.pulled?.structure).toBe(result.structure);
    expect(migration?.down).toBeUndefined();

    await admin.exec(`CREATE SCHEMA ${q(copy)}`);
    await admin.transaction(async (tx) => {
      for (const statement of migration?.up.bind(copy) ?? []) await tx.exec(statement);
    });
    expect((await pullStructure(admin, copy)).structure).toBe(result.structure);
    await admin.exec(`INSERT INTO ${q(copy, "users")} (email) VALUES ('a@example.com'); INSERT INTO ${q(copy, "tasks")} (user_id) SELECT id FROM ${q(copy, "users")}`);

    // Aynı eski schema bir index eksikse yapısı (özeti) farklıdır.
    await admin.exec(`${legacySchema(drifted)}; DROP INDEX ${q(drifted, "users_email_lower")}`);
    expect((await pullStructure(admin, drifted)).structure).not.toBe(result.structure);

    // Kaynak schema'da migration çalıştırılmaz, uygulanmış işaretlenir (CLI akışı: pull → codegen → baseline).
    const runner = createRunner({ migrations: compileMigrations([[result.id, text]]), seeds: [] });
    const target = createTestManagement({ schema: source });
    try {
      expect(await runner.baseline(target, result.id)).toEqual({ migrations: [result.id] });
      expect(await runner.migrate(target)).toEqual({ dryRun: false, migrations: [] });
    } finally {
      await target.close();
    }
  } finally {
    for (const schema of [source, copy, drifted]) await dropSchema(admin, schema);
    await admin.close();
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});

integration("pull refuses objects an initial migration cannot express, names them, and does not write a file", async () => {
  const admin = raw();
  const m = createTestManagement();
  const schema = testSchema();
  const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-pull-"));
  try {
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "t")} (id integer PRIMARY KEY); CREATE VIEW ${q(schema, "v")} AS SELECT id FROM ${q(schema, "t")}`);
    await mkdir(join(root, "src/migrations"), { recursive: true });
    const error = (await pullSchema(m, schema, { root }).catch((e: unknown) => e)) as { code: string; message: string };
    expect(error.code).toBe("PULL_UNSUPPORTED");
    expect(error.message).toContain("view v");
    expect(await Array.fromAsync(new Bun.Glob("src/migrations/*.sql").scan(root))).toEqual([]);
    expect(await failure(pullSchema(m, "information_schema", { root }))).toBe("USAGE");
    expect(await failure(pullSchema(m, "Bad-Name", { root }))).toBe("USAGE");
    expect(await failure(pullSchema(m, testSchema(), { root }))).toBe("SOURCE_SCHEMA_MISSING");
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single
RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/pull.test.ts 2>&1 | tail -5
```
Expected: `core/tools/pull` yok → **fail**.

- [ ] **Step 3: `pull.ts` (kopya + düzenleme)**

```bash
cp ../db-multi/src/core/tools/pull.ts src/core/tools/pull.ts
cp ../db-multi/src/__tests__/unit/pull.test.ts src/__tests__/unit/pull.test.ts
```

Düzenlemeler (Edit):

1. Başlık yorumu ve içe aktarmalar:

```ts
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { quoteIdentifier, validateSchema } from "../identifier";
import type { Management } from "../management";
import { checksum, compileMigrations, MIGRATION_NAME, migrationPrefix, pullMarker } from "../migrations/source";
import { unqualifyMigration } from "../sql/compiler";
```
2. `SCHEMA_NAME`, `RESERVED_SCHEMAS`, `PULL_SCOPES` sabitlerini ve `validateSchemaName` fonksiyonunu silin; `ALWAYS_EXCLUDED` kalır. `pullStructure` içinde `validateSchemaName(schema)` yerine:

```ts
  try {
    validateSchema(schema);
  } catch {
    throw new AppError("USAGE", "pull needs a plain lower-case schema name other than information_schema and pg_*");
  }
```
3. `pulledMigration(pulled, schema)` (DB kimliği yok):

```ts
export function pulledMigration(pulled: PulledStructure, schema: string): string {
  const header = [pullMarker(pulled), `-- Kaynak: schema ${schema}. Bu dosyayı değiştirmeyin; sonraki değişiklikler yeni migration'a yazılır.`];
  return `--up\n${header.join("\n")}\n\n${pulled.sql}\n--down\n`;
}
```
4. `PullOptions` ve `pullSchema`:

```ts
export interface PullOptions {
  name?: string;
  exclude?: readonly string[];
  now?: Date;
  root?: string;
}

/** `pull`: yapıyı okur, derleyiciyle doğrular ve `src/migrations/<zaman>_<ad>.sql` olarak yazar (listeyi günceller). Hata olursa dosya yazılmaz. */
export async function pullSchema(m: Management, schema: string, { name = "init", exclude = [], now = new Date(), root = "." }: PullOptions = {}) {
  if (!MIGRATION_NAME.test(name)) throw new AppError("USAGE", "Migration name must be snake_case");
  const pulled = await pullStructure(m.db, schema, exclude);
  const source = pulledMigration(pulled, schema);
  compileMigrations([[`${migrationPrefix(now)}_${name}`, source]]);
  const { createMigration } = await import("../sql/codegen");
  const created = await createMigration({ name, now, root, source });
  const next = `bun run db:codegen; on the existing database mark it applied instead of running it (bun run cli migration baseline ${created.id}); later changes go into a new migration (bun run db:generate <name>)`;
  return { ...created, schema, ...pulled.counts, structure: pulled.structure, exclude: pulled.exclude, next };
}
```
5. Tenant/platform/`databaseId` sözcüklerini bekçi bildirir; yorumları tek-schema anlamıyla yeniden yazın.

`core/cli.ts` komut tablosuna ekleyin (`seed create`'in ardından):

```ts
  pull: {
    usage: "[schema] [--name init] [--exclude tablo ...]",
    summary: "Var olan schema'nın yapısından tek başlangıç migration'ı yazar (DB'yi yalnızca okur; schema varsayılan public; ardından migration baseline)",
    flags: ["--name", "--exclude"],
    run: async ({ app, options }, schema) => (await import("./tools/pull")).pullSchema(app, schema || "public", { name: options.name, exclude: options.exclude }),
  },
```
**Not (R13):** `pull` `--schema` kabul etmez; `app` bağlamının `schema` alanı (`public`) yalnızca kaynak varsayılanını belirler.

`unit/pull.test.ts` uyarlaması: `pullMarker({structure, exclude})` beklentisi `-- @repo/db-single pull structure=…` (Task 6'daki `source.ts` işareti); `pulledMigration(pulled, schema, databaseId)` çağrıları `(pulled, schema)`; `canonicalTypes`/`sqlType` testleri aynı kalır.

- [ ] **Step 4: Geçiş**

```bash
bun run typecheck && bun run lint && bun test src/__tests__/unit 2>&1 | tail -4
RUN_INTEGRATION=1 bun test --timeout 60000 src/__tests__/integration/pull.test.ts 2>&1 | tail -5
```
Expected: birim yeşil; `pull` entegrasyon 2 test **pass**.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: pull command (existing schema to an initial migration, baseline afterwards)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Export, backup, restore ve `--from-replica`

**Files:**
- Copy+edit: `core/tools/copy.ts`; create: `core/tools/backup.ts`, `core/tools/replica-source.ts`
- Modify: `core/catalog.ts` (`schemaIsEmpty`), `core/cli.ts`
- Test: kopya `unit/copy.test.ts`; yeni `unit/backup-prune.test.ts`, `integration/backup.test.ts`, `integration/replica-tools.test.ts`

**Interfaces:**
- Consumes: G2 `Management`, `createRunner`/`Registry`/`registry`, `openManagementSession`/`MIGRATION_KEY`, `catalog.schemaExists`, `replicas.probeReplica`, `pooler.usesTransactionPooler`, `database.connect`, Task 1 `jsonl`/`ask-secret`.
- Produces:
  - `copy.ts`: `SNAPSHOT_MODE`, `snapshotTransaction(timeoutMs)`, `streamCursor`, `validateDefault`, `columnDefinition`, `sequenceDefinition`, `readSchema(db, schema)`, `SchemaShape`, `serverFacts`, `ServerFacts`, `assertCompatible`, `insertRows`, `readRows`, `buildSchema(to, schema, shape, fill, signal?)` (`CREATE SCHEMA IF NOT EXISTS`), `FillTable`. **`copySchema`, `fingerprint` yok.** Hata kodu `UNSUPPORTED_SCHEMA`.
  - `catalog.ts`: `schemaIsEmpty(db, name): Promise<boolean>` (schema yok ya da hiç ilişki yok).
  - `backup.ts`: `BackupMeta`, `exportSchema(m, dir, options?: { signal?; replicaUrls?: string }): Promise<{ dir; tables: number; rows: number }>`, `backupSchema(m, root, options?: { keep?; signal?; replicaUrls?; now?: () => Date }): Promise<{ id; dir; tables; rows; pruned: string[] }>`, `restoreSchema(m, source, options?: { set?; signal?; report?; registry?: Registry }): Promise<{ restoredFrom: string; migrationsApplied: string[]; rows: number }>`, `pruneBackups(root, keep): Promise<{ kept: string[]; removed: string[] }>`.
  - `replica-source.ts`: `ReplicaSource { db: Database; replayLsn: string; catchUp(): Promise<string>; close(): Promise<void> }`, `openReplicaSource(m, entry: string): Promise<ReplicaSource>`, `replicaConflict(error)`. Hata kodları: `BACKUP_EXISTS`, `BACKUP_NOT_FOUND`, `BACKUP_INVALID`, `SCHEMA_NOT_EMPTY`, `RESTORE_MISMATCH`, `UNSUPPORTED_SCHEMA`, `REPLICA_CONFLICT`, `REPLICA_LAG_EXCEEDED`, `DIRECT_CONNECTION_REQUIRED`.

- [ ] **Step 1: Başarısız testler**

`unit/backup-prune.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneBackups } from "../../core/tools/backup";

async function root(sets: Record<string, boolean>) {
  const dir = await mkdtemp(join(tmpdir(), "single-prune-"));
  for (const [id, complete] of Object.entries(sets)) {
    await mkdir(join(dir, id));
    if (complete) await writeFile(join(dir, id, "backup.json"), "{}");
  }
  return dir;
}

test("prune keeps the newest N complete sets, removes older ones and never touches incomplete or foreign folders", async () => {
  const dir = await root({ "20260101000001": true, "20260101000002": true, "20260101000003": true, "20260101000004": false });
  await mkdir(join(dir, "notes"));
  try {
    expect(await pruneBackups(dir, 2)).toEqual({ kept: ["20260101000002", "20260101000003"], removed: ["20260101000001"] });
    expect((await readdir(dir)).sort()).toEqual(["20260101000002", "20260101000003", "20260101000004", "notes"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune accepts a numeric string, refuses 0 and non-numbers, and an empty or missing root is a no-op", async () => {
  const dir = await root({ "20260101000001": true });
  try {
    expect(await pruneBackups(dir, "5")).toEqual({ kept: ["20260101000001"], removed: [] });
    for (const bad of [0, "x", 1001]) await expect(pruneBackups(dir, bad)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(await pruneBackups(join(dir, "missing"), 1)).toEqual({ kept: [], removed: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

`integration/backup.test.ts`:

```ts
import { expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { schemaExists, schemaIsEmpty } from "../../core/catalog";
import type { Database } from "../../core/database";
import type { Management } from "../../core/management";
import { createRunner } from "../../core/migrations/runner";
import type { Registry } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";
import { backupSchema, exportSchema, restoreSchema } from "../../core/tools/backup";
import { createTestManagement, dropSchema, failure, integration, q, raw, testSchema } from "./helpers";

const FIRST = ["20260101000001_users", "--up\nCREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, tags text[] NOT NULL DEFAULT '{}', meta jsonb);\n--down\nDROP TABLE users;\n"] as const;
const SECOND = ["20260101000002_posts", "--up\nCREATE TABLE posts (id integer PRIMARY KEY, user_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE, body text NOT NULL);\nCREATE INDEX posts_user_idx ON posts (user_id);\n--down\nDROP TABLE posts;\n"] as const;
const OLD: Registry = { migrations: compileMigrations([FIRST]), seeds: [] };
const NEW: Registry = { migrations: compileMigrations([FIRST, SECOND]), seeds: [] };

/** Her tablonun sıralı `row_to_json` satırları: yedek ve geri yükleme eşitliği için tek oracle. */
async function dump(db: Database, schema: string) {
  const tables = await db.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY 1", [schema]);
  return Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [name, (await db.query<{ r: string }>(`SELECT row_to_json(t)::text AS r FROM ${q(schema, name)} t ORDER BY 1`)).map((row) => row.r)] as const)));
}

async function withBackup(work: (ctx: { m: Management; schema: string; admin: Database; dir: string }) => Promise<void>) {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema });
  const dir = await mkdtemp(join(import.meta.dir, "../../../.tmp-backup-"));
  try {
    await work({ m, schema, admin, dir });
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function seeded(m: Management, schema: string, admin: Database, registry: Registry = NEW) {
  await createRunner(registry).migrate(m);
  await admin.exec(`INSERT INTO ${q(schema, "users")} (email, tags, meta) VALUES ('a@example.com','{x,y}','{"k":1}'),('b@example.com','{}',NULL)`);
  if (registry === NEW) await admin.exec(`INSERT INTO ${q(schema, "posts")} VALUES (1, 1, 'hello'),(2, 2, 'it''s')`);
}

integration("export then restore into a dropped schema reproduces tables, rows, sequences and the ledger", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    const before = await dump(admin, schema);
    const exported = await exportSchema(m, join(dir, "x"));
    expect(exported).toMatchObject({ dir: join(dir, "x") });
    expect(exported.rows).toBe(Object.values(before).flat().length);
    await dropSchema(admin, schema);
    const restored = await restoreSchema(m, join(dir, "x"), { registry: NEW });
    expect(restored).toMatchObject({ restoredFrom: join(dir, "x"), migrationsApplied: [], rows: exported.rows });
    expect(await dump(admin, schema)).toEqual(before);
    // serial dizisi kaldığı yerden sürer
    await admin.exec(`INSERT INTO ${q(schema, "users")} (email) VALUES ('c@example.com')`);
    expect((await admin.query<{ id: number }>(`SELECT max(id) AS id FROM ${q(schema, "users")}`))[0]?.id).toBe(3);
    // geri yüklenen schema'da migrate bir şey yapmaz
    expect(await createRunner(NEW).migrate(m)).toEqual({ dryRun: false, migrations: [] });
  });
});

integration("a backup restores into a different schema name too", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    await exportSchema(m, join(dir, "x"));
    const other = testSchema();
    const target = createTestManagement({ schema: other });
    try {
      await restoreSchema(target, join(dir, "x"), { registry: NEW });
      expect(await dump(admin, other)).toEqual(await dump(admin, schema));
    } finally {
      await target.close();
      await dropSchema(admin, other);
    }
  });
});

integration("restore refuses a schema that already has objects and changes nothing", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    await exportSchema(m, join(dir, "x"));
    const before = await dump(admin, schema);
    expect(await failure(restoreSchema(m, join(dir, "x"), { registry: NEW }))).toBe("SCHEMA_NOT_EMPTY");
    expect(await dump(admin, schema)).toEqual(before);
    expect(await schemaIsEmpty(admin, schema)).toBe(false);
  });
});

integration("an older backup is brought up to date after restore; a newer one than this code is MIGRATION_DRIFT", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin, OLD);
    await exportSchema(m, join(dir, "old"));
    await dropSchema(admin, schema);
    expect(await restoreSchema(m, join(dir, "old"), { registry: NEW })).toMatchObject({ migrationsApplied: ["20260101000002_posts"] });
    await exportSchema(m, join(dir, "new"));
    await dropSchema(admin, schema);
    expect(await failure(restoreSchema(m, join(dir, "new"), { registry: OLD }))).toBe("MIGRATION_DRIFT");
    expect(await schemaExists(admin, schema)).toBe(false);
  });
});

integration("export refuses an existing folder, leaves no .partial behind on failure, and restore needs a real backup", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    await exportSchema(m, join(dir, "x"));
    expect(await failure(exportSchema(m, join(dir, "x")))).toBe("BACKUP_EXISTS");
    expect(await failure(restoreSchema(m, join(dir, "missing"), { registry: NEW }))).toBe("BACKUP_NOT_FOUND");
    // desteklenmeyen nesne (view) → hiçbir dosya kalmaz
    await admin.exec(`CREATE VIEW ${q(schema, "v")} AS SELECT id FROM ${q(schema, "users")}`);
    expect(await failure(exportSchema(m, join(dir, "y")))).toBe("UNSUPPORTED_SCHEMA");
    expect((await readdir(dir)).filter((name) => name.startsWith("y"))).toEqual([]);
  });
});

integration("backup writes a full timestamped set per run, --keep prunes older ones, and restore from the root takes the latest or a chosen set", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await seeded(m, schema, admin);
    const at = (second: number) => () => new Date(Date.UTC(2026, 0, 1, 0, 0, second));
    const ids: string[] = [];
    for (const second of [1, 2, 3]) ids.push((await backupSchema(m, dir, { keep: 2, now: at(second) })).id);
    expect(ids).toEqual(["20260101000001", "20260101000002", "20260101000003"]);
    expect((await readdir(dir)).sort()).toEqual(["20260101000002", "20260101000003"]);
    const before = await dump(admin, schema);
    await dropSchema(admin, schema);
    expect((await restoreSchema(m, dir, { registry: NEW })).restoredFrom).toBe(join(dir, "20260101000003"));
    expect(await dump(admin, schema)).toEqual(before);
    await dropSchema(admin, schema);
    expect((await restoreSchema(m, dir, { set: "20260101000002", registry: NEW })).restoredFrom).toBe(join(dir, "20260101000002"));
    expect(await failure(restoreSchema(m, dir, { set: "20260101000001", registry: NEW }))).toBe("BACKUP_NOT_FOUND");
  });
});

integration("objects owned by an extension in the schema do not block export", async () => {
  await withBackup(async ({ m, schema, admin, dir }) => {
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "t")} (id integer PRIMARY KEY, name text)`);
    await admin.exec(`INSERT INTO ${q(schema, "t")} VALUES (1, 'a')`);
    expect(await exportSchema(m, join(dir, "x"))).toMatchObject({ tables: 1, rows: 1 });
    const meta = (await Bun.file(join(dir, "x", "backup.json")).json()) as { shape: { tables: { name: string }[] } };
    expect(meta.shape.tables.map((table) => table.name)).toEqual(["t"]);
  });
});

`integration/replica-tools.test.ts`:

```ts
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConfig } from "../../core/config";
import { exportSchema } from "../../core/tools/backup";
import { openReplicaSource } from "../../core/tools/replica-source";
import { createTestManagement, failure, integration, pooledConfig } from "./helpers";
import { DEAD_REPLICA_URL, PRIMARY_URL, REPLICA_URL, replicaFixture } from "./replica-fixture";

const management = (schema: string) => createTestManagement({ schema }, createConfig(PRIMARY_URL));

integration("openReplicaSource accepts one direct replica and rejects a pooler, the primary, an unreachable URL and a list", async () => {
  const f = await replicaFixture();
  const m = management(f.schema);
  try {
    const source = await openReplicaSource(m, REPLICA_URL);
    try {
      expect(source.replayLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
      expect(await source.catchUp()).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    } finally {
      await source.close();
    }
    expect(await failure(openReplicaSource(m, pooledConfig().url))).toBe("DIRECT_CONNECTION_REQUIRED");
    expect(await failure(openReplicaSource(m, PRIMARY_URL))).toBe("INVALID_CONFIG");
    expect(await failure(openReplicaSource(m, `${REPLICA_URL},${DEAD_REPLICA_URL}`))).toBe("INVALID_CONFIG");
    expect(await failure(openReplicaSource(m, DEAD_REPLICA_URL))).toBeDefined();
  } finally {
    await m.close();
    await f.close();
  }
});

integration("export --from-replica reads from the replica and records its position", async () => {
  const f = await replicaFixture();
  const m = management(f.schema);
  const dir = await mkdtemp(join(import.meta.dir, "../../../.tmp-replica-"));
  try {
    await f.primary.exec(`INSERT INTO "${f.schema}".notes VALUES (1)`);
    const exported = await exportSchema(m, join(dir, "x"), { replicaUrls: REPLICA_URL });
    expect(exported.rows).toBe(1);
    const meta = (await Bun.file(join(dir, "x", "backup.json")).json()) as { source?: string; replayLsn?: string; schema: string };
    expect(meta).toMatchObject({ source: "replica", schema: f.schema });
    expect(meta.replayLsn).toMatch(/\//);
  } finally {
    await m.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```
`unit/copy.test.ts`: `cp ../db-multi/src/__tests__/unit/copy.test.ts` ve `../../core/tools/copy` içe aktarmalarını (`copySchema`/`fingerprint` kullanan test varsa **silin**, ledger: `Task 3: removed … (R5)`) uyarlayın.

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single
bun test src/__tests__/unit/backup-prune.test.ts 2>&1 | tail -4
RUN_INTEGRATION=1 bun test --timeout 120000 src/__tests__/integration/backup.test.ts 2>&1 | tail -4
```
Expected: `core/tools/backup` yok → **fail**.

- [ ] **Step 3: `copy.ts` (kopya + kırpma)**

```bash
cp ../db-multi/src/core/tools/copy.ts src/core/tools/copy.ts
```
Düzenlemeler:
1. Başlık yorumu: "Schema'yı snapshot'tan okur ve hedefte yeniden kurar; yedek/geri yükleme bunu kullanır. Veri, sürücüden bağımsız toplu JSON ile taşınır (Bun SQL COPY desteklemez): kaynakta cursor ile `row_to_json`, hedefte `json_populate_recordset`. Yalnızca birebir yeniden üretilebilen tablo ve sequence'lar desteklenir."
2. İçe aktarmalar: `import { qualified, quoteIdentifier } from "../identifier";` (`validateSchema` yalnızca `qualified` içinde), `import type { Database }` ve `createHash` **silinir** (yalnızca `fingerprint` kullanıyordu).
3. `unsupported` yardımcısı: `new AppError("UNSUPPORTED_SCHEMA", message)`.
4. `copySchema`, `DEFAULT_COPY_TIMEOUT_MS`, `fingerprint`, `FINGERPRINT_METADATA`, `FINGERPRINT_RELATIONS` ve bölüm başlıkları ("Doğrulama") **silinir**; `transferTimeouts` yalnızca `snapshotTransaction` için kalır.
5. `buildSchema` içinde `CREATE SCHEMA ${quoteIdentifier(schema)}` → `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}` (`public` ya da önceden kurulmuş boş schema).
6. İmleç adları: `"tenant_copy_rows"` → `"copy_rows"`; `export { qualified };` satırı kalır. Yorumlardaki tenant/taşıma sözcükleri (bekçi bildirir) yeniden yazılır.

- [ ] **Step 3b: `SHAPE_RULES` ve katalog sorguları: eklenti nesneleri ve ileti metinleri**

Yönetilen DB'lerde (Neon, RDS) `CREATE EXTENSION` nesneleri çoğunlukla `public` schema'sına koyar (ör. pgcrypto fonksiyonları, `pg_stat_statements` görünümü). Eklenti üyeleri `pg_depend`'te `deptype='e'` ile işaretlidir; paketin yedeği bunlara bakmamalıdır (eklenti hedefte `assertCompatible` ile zaten aranır). `copy.ts` başına ortak parça ekleyin:

```ts
/** Eklentinin üyesi olan nesne (fonksiyon, tür, ilişki …) uygulama verisi değildir: yedek onlara bakmaz. */
const notExtensionMember = (catalog: "pg_class" | "pg_proc" | "pg_type", alias: string) =>
  `NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend x WHERE x.classid='pg_catalog.${catalog}'::pg_catalog.regclass AND x.objid=${alias}.oid AND x.deptype='e')`;
```
ve şu yerlerde (şablon dizesine `${…}` olarak) uygulayın:

1. `SHAPE_RULES` 1. kural: iki `WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I','t')` süzgecine `AND ${notExtensionMember("pg_class", "c")}`.
2. `SHAPE_RULES` 2. kural: `pg_proc p` sorgusuna `AND ${notExtensionMember("pg_proc", "p")}`, `pg_type t` sorgusuna `AND ${notExtensionMember("pg_type", "t")}`.
3. `TABLES_SQL`, `COLUMNS_SQL` ve `SEQUENCES_SQL`: ilişki `c` için `AND ${notExtensionMember("pg_class", "c")}`; `CONSTRAINTS_SQL` ve `INDEXES_SQL`: tabloyu bağlayan `c` (indexte `i.indrelid`'in sınıfı) için aynı süzgeç.

İleti metinlerini tek-schema anlamıyla yeniden yazın (kod sabit kalır, bekçi bunlara bakmaz ama "Move" yanlış anlam taşır): `'Backup supports persistent ordinary tables and sequences without policies, rules, triggers or inheritance'`, `'Custom schema routines/types or cross-schema foreign keys are not supported'`, `'Custom operators, index operator classes and collations are not supported'`, `'Repair invalid indexes before taking a backup'`.

- [ ] **Step 4: `catalog.ts`, `backup.ts`, `replica-source.ts`**

`core/catalog.ts` sonuna ekleyin:

```ts
/** `name` schema'sında hiç tablo, view, sequence ya da yabancı tablo yok mu (schema hiç yoksa da boştur). */
export async function schemaIsEmpty(db: Pick<Connection, "query">, name: string): Promise<boolean> {
  const [row] = await db.query<{ empty: boolean }>(
    "SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f','S')) AS empty",
    [name],
  );
  return row?.empty === true;
}
```

`core/tools/backup.ts`:

```ts
/** Schema dışa aktarma, yedek ve geri yükleme. Sürücüden bağımsızdır (pg_dump gerekmez): veri `row_to_json` satırları olarak gzip'li
 * JSON Lines, şema katalogdan okunan birebir şekil olarak saklanır (kurallar `copy.ts`'te).
 *
 *   <klasör>/backup.json     şekil, sunucu bilgisi, tablo dosyaları ve satır sayıları (en son yazılır: klasör varsa yedek tamdır)
 *   <klasör>/<n>.jsonl.gz    tablo satırları
 *
 * `export <dir>` tam o klasörü yazar (önce `.partial`, bitince yeniden adlandırılır; var olmamalı). `backup <kök>` her çalıştırmada
 * `<kök>/<UTC yyyyMMddHHmmss>` altına tam bir set yazar ve `keep` ile eskileri siler. `restore` boş ya da olmayan schema'ya kurar. */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { schemaIsEmpty } from "../catalog";
import { boundedInteger } from "../config";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { qualified } from "../identifier";
import { MIGRATION_KEY, openManagementSession } from "../locks";
import type { Management } from "../management";
import { type Registry, registry as packageRegistry } from "../migrations/registry";
import { createRunner, noReport, type Report } from "../migrations/runner";
import { migrationPrefix } from "../migrations/source";
import { assertCompatible, buildSchema, insertRows, readRows, readSchema, type SchemaShape, type ServerFacts, serverFacts, snapshotTransaction } from "./copy";
import { batches, openGzipWriter, readLines } from "./jsonl";
import { openReplicaSource, type ReplicaSource } from "./replica-source";

const FORMAT = 1;
const RESTORE_BATCH_ROWS = 500;
/** Tek yedek/geri yükleme için statement timeout'u. */
const TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;
const SET_ID = /^\d{14}$/;
/** Aynı saniyede set varsa sonraki saniyeler için toplam deneme. */
const SET_CLAIM_ATTEMPTS = 3;

type TableFile = { name: string; file: string; rows: number };
/** `backup.json` */
export type BackupMeta = {
  format: number;
  schema: string;
  takenAt: string;
  facts: ServerFacts;
  shape: SchemaShape;
  tables: TableFile[];
  /** Veri replica'dan okunduysa: kaynak ve veri okunmadan önce yetişilen replay konumu. */
  source?: "replica";
  replayLsn?: string;
};

const exists = (path: string) => stat(path).then(() => true, () => false);
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
const totalRows = (tables: readonly TableFile[]) => tables.reduce((n, t) => n + t.rows, 0);
const tableBatches = (file: string) => batches(readLines(file), RESTORE_BATCH_ROWS);

/** Satırları gzip'li JSON Lines dosyasına yazar; satır sayısını döndürür. */
async function writeTable(from: Connection, relation: string, file: string, signal?: AbortSignal) {
  const writer = openGzipWriter(file);
  try {
    return await readRows(from, relation, (rows) => writer.write(rows.join("\n")), signal);
  } finally {
    await writer.close();
  }
}

/** Schema'yı `dir` klasörüne yazar (önce `.partial`, bitince yeniden adlandırılır); hata olursa `.partial` silinir, `dir` var olmamalı. */
async function writeSnapshot(m: Management, dir: string, signal?: AbortSignal, replica?: ReplicaSource): Promise<BackupMeta> {
  // Replica birincilin şu anki konumuna yetişir: okunan şema replica'da vardır ve `replayLsn` bu verinin konumunu tanımlar.
  const replayLsn = replica ? await replica.catchUp() : undefined;
  if (await exists(dir)) throw new AppError("BACKUP_EXISTS", `${dir} already exists`);
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  try {
    const db = replica ? replica.db : m.db;
    const facts = await serverFacts(db);
    const meta = await db.transaction(async (tx): Promise<BackupMeta> => {
      const shape = await readSchema(tx, m.schema);
      const tables: TableFile[] = [];
      for (const [i, table] of shape.tables.entries()) {
        const file = `${i}.jsonl.gz`;
        tables.push({ name: table.name, file, rows: await writeTable(tx, qualified(m.schema, table.name), join(partial, file), signal) });
      }
      return { format: FORMAT, schema: m.schema, takenAt: new Date().toISOString(), facts, shape, tables, ...(replica ? { source: "replica" as const, replayLsn } : {}) };
    }, snapshotTransaction(TRANSFER_TIMEOUT_MS));
    await writeFile(join(partial, "backup.json"), JSON.stringify(meta));
    await rename(partial, dir);
    return meta;
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

/** Replica verilirse veri oradan okunur; kaynak her çağrıdan sonra kapanır. */
async function withSource<T>(m: Management, replicaUrls: string | undefined, work: (replica?: ReplicaSource) => Promise<T>) {
  const replica = replicaUrls ? await openReplicaSource(m, replicaUrls) : undefined;
  try {
    return await work(replica);
  } finally {
    await replica?.close();
  }
}

/** Schema'nın bütün verisi tek seferde: `dir/backup.json` + tablo dosyaları (tutarlı snapshot). `restore` ile geri yüklenir. */
export async function exportSchema(m: Management, dir: string, options: { signal?: AbortSignal; replicaUrls?: string } = {}) {
  return withSource(m, options.replicaUrls, async (replica) => {
    const meta = await writeSnapshot(m, dir, options.signal, replica);
    return { dir, tables: meta.tables.length, rows: totalRows(meta.tables) };
  });
}

/** `<kök>` altındaki tamamlanmış setler (`backup.json` var), eskiden yeniye. */
async function completeSets(root: string) {
  const names = (await readdir(root).catch(() => [] as string[])).filter((name) => SET_ID.test(name)).sort();
  const complete: string[] = [];
  for (const name of names) if (await exists(join(root, name, "backup.json"))) complete.push(name);
  return complete;
}

/** Her çalıştırma yeni bir tam set yazar: `<kök>/<UTC yyyyMMddHHmmss>`; o saniyenin seti varsa sonraki saniye denenir (art arda yedekler). */
export async function backupSchema(m: Management, root: string, options: { keep?: number | string; signal?: AbortSignal; replicaUrls?: string; now?: () => Date } = {}) {
  const keep = options.keep === undefined ? undefined : boundedInteger(options.keep, "keep", 1000);
  const now = options.now ?? (() => new Date());
  await mkdir(root, { recursive: true });
  const result = await withSource(m, options.replicaUrls, async (replica) => {
    for (let attempt = 1; ; attempt++) {
      const id = migrationPrefix(now());
      const dir = join(root, id);
      if (!(await exists(dir))) {
        const meta = await writeSnapshot(m, dir, options.signal, replica);
        return { id, dir, tables: meta.tables.length, rows: totalRows(meta.tables) };
      }
      if (attempt === SET_CLAIM_ATTEMPTS) throw new AppError("BACKUP_EXISTS", `Backup set ${id} already exists; retry in a second`);
      await sleep(1005 - (Date.now() % 1000), undefined, { signal: options.signal });
    }
  });
  const pruned = keep === undefined ? [] : (await pruneBackups(root, keep)).removed;
  return { ...result, pruned };
}

/** Son `keep` tamamlanmış seti tutar; daha eski tamamlanmış setleri siler. Yarım setlere ve başka klasörlere dokunmaz. */
export async function pruneBackups(root: string, keep: number | string) {
  const count = boundedInteger(keep, "keep", 1000);
  const sets = await completeSets(root);
  const kept = sets.slice(-count);
  const removed = sets.filter((id) => !kept.includes(id));
  for (const id of removed) await rm(join(root, id), { recursive: true, force: true });
  return { kept, removed };
}

/** `source`: `export` klasörü (`backup.json` içerir) ya da yedek kökü (son set ya da `set`). */
async function locateBackup(source: string, set?: string): Promise<string> {
  if (await exists(join(source, "backup.json"))) return source;
  const sets = await completeSets(source);
  const id = set === undefined ? sets.at(-1) : sets.find((name) => name === set);
  if (!id) throw new AppError("BACKUP_NOT_FOUND", set ? `Backup set ${set} is missing or incomplete` : "No complete backup found");
  return join(source, id);
}

/** Yedeğin migration ledger'ı bu kodun migration listesinin öneki olmalı (daha yeni kodla alınmış yedek reddedilir). */
async function assertLedgerKnown(dir: string, meta: BackupMeta, registry: Registry) {
  const ledger = meta.tables.find((table) => table.name === "_migrations");
  if (!ledger) throw new AppError("BACKUP_INVALID", "Backup has no migration ledger");
  const applied = new Map<string, string>();
  for await (const rows of tableBatches(join(dir, ledger.file)))
    for (const row of rows) {
      const { id, checksum } = JSON.parse(row) as { id: string; checksum: string };
      applied.set(id, checksum);
    }
  const prefix = registry.migrations.slice(0, applied.size);
  if (prefix.length !== applied.size || prefix.some((migration) => applied.get(migration.id) !== migration.checksum))
    throw new AppError("MIGRATION_DRIFT", "Backup migration history is not a prefix of this code's migrations");
}

/** Tablonun yedek satırlarını batch'ler halinde yükler (her batch öncesi sahiplik doğrulanır) ve satır sayısını denetler. */
async function restoreTableRows(tx: Connection, from: { dir: string; meta: BackupMeta; verify: () => Promise<void> }, relation: string, stored: string[], table: string) {
  const file = from.meta.tables.find((t) => t.name === table);
  if (!file) throw new AppError("BACKUP_INVALID", `Backup has no rows file for ${table}`);
  for await (const rows of tableBatches(join(from.dir, file.file))) {
    await from.verify();
    await insertRows(tx, relation, stored, rows);
  }
  const [count] = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${relation}`);
  if (count?.n !== file.rows) throw new AppError("RESTORE_MISMATCH", `${table}: expected ${file.rows} rows, restored ${count?.n}`);
}

export type RestoreOptions = { set?: string; signal?: AbortSignal; report?: Report; registry?: Registry };

/**
 * Yedekten schema'yı kurar. Hedef schema yok ya da boş olmalı (`SCHEMA_NOT_EMPTY`; hiçbir şey silinmez). Şema ve veri tek transaction'da
 * kurulur (yarıda kalırsa hiçbir şey kalmaz, tekrar denenebilir), satır sayıları doğrulanır; yedek eski migration sürümündeyse bekleyen
 * migration'lar sonra uygulanır. Yedek başka bir schema adına da kurulabilir.
 */
export async function restoreSchema(m: Management, source: string, options: RestoreOptions = {}) {
  const registry = options.registry ?? packageRegistry;
  const dir = await locateBackup(source, options.set);
  const meta = await readJson<BackupMeta>(join(dir, "backup.json"));
  if (meta.format !== FORMAT) throw new AppError("BACKUP_INVALID", "Backup format does not match");
  await assertLedgerKnown(dir, meta, registry);
  const session = await openManagementSession(m, MIGRATION_KEY, { applicationName: "restore", signal: options.signal });
  try {
    const verify = async () => {
      await session.assertOwned();
      options.signal?.throwIfAborted();
    };
    await verify();
    if (!(await schemaIsEmpty(session.db, m.schema))) throw new AppError("SCHEMA_NOT_EMPTY", "Restore needs an empty or missing schema; it never overwrites existing objects");
    assertCompatible(meta.facts, await serverFacts(session.db));
    await session.db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL statement_timeout = ${TRANSFER_TIMEOUT_MS}`);
      const from = { dir, meta, verify };
      await buildSchema(tx, m.schema, meta.shape, (relation, stored, table) => restoreTableRows(tx, from, relation, stored, table), options.signal);
    });
  } finally {
    await session.close();
  }
  const { migrations } = await createRunner(registry).migrate(m, { signal: options.signal, report: options.report ?? noReport });
  return { restoredFrom: dir, migrationsApplied: migrations, rows: totalRows(meta.tables) };
}
```

`core/tools/replica-source.ts`:

```ts
/** `--from-replica` kaynağı: gizli girişten gelen tek doğrudan replica URL'si. Doğrulanır: doğrudan bağlantı (pooler değil), gerçekten
 * replica (`pg_is_in_recovery`), lag eşiğin altında. Veri okuması yalnızca bu replica'dan yapılır. Mesajlar URL, host, kullanıcı içermez. */
import { setTimeout } from "node:timers/promises";
import { createConfig } from "../config";
import { connect, type Database } from "../database";
import { AppError, databaseUnavailable, errorCode } from "../errors";
import type { Management } from "../management";
import { usesTransactionPooler } from "../pooler";
import { probeReplica } from "../replicas";

const DIRECT_PROBE_DEADLINE_MS = 10_000;
/** Standby'ın çakışma sayaçları (örnek başına, replike edilmez): bir okuma sırasında arttıysa bağlantıyı çakışma kesmiştir. */
const CONFLICTS =
  "SELECT (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock)::pg_catalog.text AS n FROM pg_catalog.pg_stat_database_conflicts WHERE datname = pg_catalog.current_database()";
const PRIMARY_LSN = "SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn";
const REPLAYED_UP_TO = "SELECT pg_catalog.pg_last_wal_replay_lsn() >= $1::pg_catalog.pg_lsn AS ok, pg_catalog.pg_last_wal_replay_lsn()::pg_catalog.text AS lsn";
const CATCH_UP_POLL_MS = 100;
const REPLAY_LSN = "SELECT pg_catalog.pg_last_wal_replay_lsn()::text AS lsn";

export interface ReplicaSource {
  /** Mutlak veri kaynağı: çakışma hataları `REPLICA_CONFLICT` olarak eşlenmiş replica bağlantısı. */
  readonly db: Database;
  /** Açılışta replica'nın replay ettiği WAL konumu. */
  readonly replayLsn: string;
  /** Birincilin şu anki WAL konumunu replica replay edene kadar bekler (en çok `replicaMaxLagMs`, sonra `REPLICA_LAG_EXCEEDED`) ve
   * replica'nın o andaki konumunu döndürür: okunan şemanın replica'ya ulaştığını ve verinin tazeliğini kanıtlar. */
  catchUp(): Promise<string>;
  close(): Promise<void>;
}

/** Uzun snapshot'ı replica'da recovery çakışması iptal edebilir (`max_standby_streaming_delay`): SQLSTATE 40001 ve "conflict with recovery". */
export function replicaConflict(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  if (errorCode(error) === "40001" && /conflict with recovery/i.test(message))
    return new AppError("REPLICA_CONFLICT", "The replica canceled the read because of a recovery conflict; retry or take the export from the primary");
  return error;
}

const conflictCount = async (db: Database) => Number((await db.query<{ n: string }>(CONFLICTS))[0]?.n ?? 0);
/** Standby snapshot tutan boştaki bağlantıyı sonlandırdığında sürücüler yalnızca genel bir bağlantı hatası verir (kodsuz ya da
 * `CONNECTION_CLOSED`). Uygulama hataları, dosya sistemi hataları ve anlamlı SQLSTATE'li SQL hataları çakışma sayılmaz. */
const maybeConflict = (error: unknown) => !(error instanceof AppError) && (databaseUnavailable(error) || errorCode(error) === "OPERATION_FAILED");

/** Replica bağlantısı: SQLSTATE 40001 çakışması `REPLICA_CONFLICT` olur (sorgu, exec ve transaction yollarında). Transaction'da ayrıca,
 * başlangıçta okunan standby çakışma sayacı hata anında arttıysa (sürücü SQLSTATE'i vermese de) neden çakışmadır. */
function mapConflicts(db: Database): Database {
  const rethrow = (error: unknown): never => {
    throw replicaConflict(error);
  };
  return {
    ...db,
    query: ((text: string, params?: readonly unknown[]) => db.query(text, params).catch(rethrow)) as Database["query"],
    exec: (sql) => db.exec(sql).catch(rethrow),
    transaction: (async (work, options) => {
      const before = await conflictCount(db).catch(() => undefined);
      try {
        return await db.transaction(work, options);
      } catch (error) {
        const mapped = replicaConflict(error);
        if (mapped === error && before !== undefined && maybeConflict(error) && (await conflictCount(db).catch(() => before)) > before)
          throw replicaConflict(Object.assign(new Error("conflict with recovery"), { code: "40001" }));
        throw mapped;
      }
    }) as Database["transaction"],
  };
}

/** `entry`: tek doğrudan replica URL'si (düz URL; birincil URL'si ve listeler reddedilir). */
export async function openReplicaSource(m: Management, entry: string): Promise<ReplicaSource> {
  // `createConfig` biçimi ve tekrarları doğrular (birincil URL'si replica olarak reddedilir).
  const [url, extra] = createConfig(m.config.url, entry).replicas;
  if (!url || extra) throw new AppError("INVALID_CONFIG", "--from-replica takes exactly one direct replica URL");
  const { migrationStatementTimeoutMs, migrationLockTimeoutMs, replicaMaxLagMs } = m.config;
  if (await usesTransactionPooler(m.driver, url, { deadlineMs: DIRECT_PROBE_DEADLINE_MS }))
    throw new AppError("DIRECT_CONNECTION_REQUIRED", "The replica URL must be a direct connection, not a transaction pooler");
  const db = connect(m.driver(url, { max: 2, idleTimeoutSeconds: 60, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 }), {
    deadlineMs: migrationStatementTimeoutMs,
    timeouts: { statementTimeoutMs: migrationStatementTimeoutMs, lockTimeoutMs: migrationLockTimeoutMs },
    maxPending: 64,
  });
  let replayLsn: string;
  try {
    const probe = await probeReplica(m.db, db);
    if (!probe.inRecovery) throw new AppError("INVALID_CONFIG", "The replica URL does not point at a replica");
    if (probe.lagMs === null || probe.lagMs > replicaMaxLagMs) throw new AppError("REPLICA_LAG_EXCEEDED", `The replica is behind by more than ${replicaMaxLagMs} ms`);
    replayLsn = (await db.query<{ lsn: string }>(REPLAY_LSN))[0]?.lsn ?? "";
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  return {
    db: mapConflicts(db),
    replayLsn,
    async catchUp() {
      const [position] = await m.db.query<{ lsn: string }>(PRIMARY_LSN);
      const deadline = Date.now() + replicaMaxLagMs;
      for (;;) {
        const [row] = await db.query<{ ok: boolean | null; lsn: string }>(REPLAYED_UP_TO, [position?.lsn]);
        if (row?.ok) return row.lsn;
        if (Date.now() >= deadline) throw new AppError("REPLICA_LAG_EXCEEDED", `The replica did not catch up within ${replicaMaxLagMs} ms`);
        await setTimeout(CATCH_UP_POLL_MS);
      }
    },
    close: () => db.close(),
  };
}
```

`core/cli.ts` komut tablosuna ekleyin ve yardımcıları üste ekleyin:

```ts
const REPLICA_URL_QUESTION = "Doğrudan replica URL'si (postgres://…, yazılan görünmez): ";
/** Replica URL'si gizli girişle sorulur; biçim doğrulanır, hata metinleri değeri içermez. */
const askReplicaUrl = async () => {
  const { askSecret, postgresUrl } = await import("./tools/ask-secret");
  return postgresUrl(await askSecret(REPLICA_URL_QUESTION), "Replica URL").href;
};
const backup = () => import("./tools/backup");
```
```ts
  export: {
    usage: "<dir> [--from-replica] [--schema ad]",
    summary: "Schema'nın bütün verisini tek seferde klasöre yazar (klasör var olmamalı; --from-replica: veriyi replica'dan okur, URL gizli girişle sorulur)",
    flags: ["--from-replica", ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ app, options }, dir) => (await backup()).exportSchema(app, dir, { signal: options.signal, replicaUrls: options.fromReplica ? await askReplicaUrl() : undefined }),
  },
  backup: {
    usage: "<dir> [--keep N] [--from-replica] [--schema ad]",
    summary: "<dir>/<UTC zaman> altına tam bir yedek seti yazar; --keep N eskileri siler (--from-replica: veriyi replica'dan okur)",
    flags: ["--keep", "--from-replica", ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ app, options }, dir) => (await backup()).backupSchema(app, dir, { keep: options.keep, signal: options.signal, replicaUrls: options.fromReplica ? await askReplicaUrl() : undefined }),
  },
  "backup prune": {
    usage: "<dir> --keep N",
    summary: "Son N tamamlanmış seti tutar, eskileri siler (yarım setlere dokunmaz)",
    flags: ["--keep"],
    local: async ({ keep }, dir) => {
      if (keep === undefined) throw usage("backup prune needs --keep N");
      return (await backup()).pruneBackups(dir, keep);
    },
  },
  restore: {
    usage: "<dir> [--set ID] [--schema ad]",
    summary: "Yedekten (yedek kökü ya da export klasörü) schema'yı kurar; hedef schema yok ya da boş olmalı, eski yedekte bekleyen migration'lar uygulanır",
    flags: ["--set", ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ app, options }, dir) => (await backup()).restoreSchema(app, dir, { set: options.set, signal: options.signal, report: options.report }),
  },
```

- [ ] **Step 5: Geçiş**

```bash
bun run typecheck && bun run lint && bun test src/__tests__/unit 2>&1 | tail -5
RUN_INTEGRATION=1 bun test --timeout 120000 src/__tests__/integration/backup.test.ts src/__tests__/integration/replica-tools.test.ts 2>&1 | tail -8
```
Expected: birim yeşil; `backup` 7 + `replica-tools` 2 test **pass**; `ls .tmp-* 2>/dev/null | wc -l` `0`. Başarısızlıkta `systematic-debugging`; "başka schema adına restore" testi `columnDefinition`/varsayılan ifade bağlamasından düşerse düzeltme `copy.ts`'tedir (varsayılan `nextval` hedef schema'ya bağlanmalı) ve ledger'a yazılır.

Mutasyon denetimi (ledger'a yazın): `restoreSchema` içindeki `schemaIsEmpty` denetimini geçici silin → "restore refuses a schema that already has objects" **fail** olmalı; geri alın.

- [ ] **Step 6: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: export, backup (+prune), restore and --from-replica sources for a single schema

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `doctor` ve `replicas`

**Files:**
- Create: `core/tools/doctor.ts`, `core/tools/replicas.ts`
- Modify: `core/cli.ts`
- Test: yeni `unit/doctor.test.ts`, `unit/replicas-tool.test.ts`, `integration/doctor.test.ts`

**Interfaces:**
- Consumes: G2 `Management`, `openSession` (`locks.ts`), `pendingIn`/`Registry`/`registry`, `catalog.schemaExists`, `usesTransactionPooler`, `probeReplica`, `runtime.createDb`, `runtimeDatabaseDefaults`.
- Produces:
  - `doctor.ts`: `DoctorOptions { pgbouncerUrl?: string; pooledUrl?: string; consoleDriver?: Driver; registry?: Registry }`, `doctor(m: Management, options?): Promise<{ ok: boolean; checks: { target: string; check: string; ok: boolean; detail: string }[]; externalChecks: { check: string; status: "unverified"; detail: string }[] }>`. Hedefler: `database`, `replica#<n>`, `pgbouncer`. Denetim adları: `direct_connection`, `string_literals`, `runtime_timeouts`, `schema`, `migrations`, `pooled_runtime`, `replica_reachable`, `replica_in_recovery`, `replica_lag`, `replica_runtime_timeouts`, `replica_pooled`, `global_pool_mode`, `inspection`.
  - `replicas.ts`: `replicaReport(m): Promise<{ ok: boolean; maxLagMs: number; replicas: ReplicaReport[] }>`.
  - CLI: `replicas`, `doctor [--pgbouncer-url] [--pooled-url] [--schema ad]` (herhangi bir denetim başarısızsa çıkış kodu 1).

- [ ] **Step 1: Başarısız testler**

`unit/doctor.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import type { Registry } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";
import { doctor } from "../../core/tools/doctor";
import { fakeDriver } from "../fixtures/fake-driver";

const registry: Registry = {
  migrations: compileMigrations([
    ["20260101000001_a", "--up\nCREATE TABLE a (id integer PRIMARY KEY);\n--down\nDROP TABLE a;\n"],
    ["20260101000002_b", "--up\nCREATE TABLE b (id integer PRIMARY KEY);\n--down\nDROP TABLE b;\n"],
  ]),
  seeds: [],
};
const SETTINGS = "statement_timeout=5000,lock_timeout=1000,client_connection_check_interval=1000";

let port = 8000;
let runtimePid = 1000;
type Options = { broken?: boolean; pooled?: boolean; schemaMissing?: boolean; applied?: number; drift?: boolean; timeouts?: string; consoleMode?: string; replicaInRecovery?: boolean; replicaLag?: number };
/** Doctor yalnızca okur: SELECT/SHOW dışındaki her deyim testi düşürür. */
function fixture(options: Options = {}, replicas: string[] = []) {
  const fake = fakeDriver((text, _params, pool) => {
    if (!/^\s*(SELECT|SHOW)\b/.test(text)) throw new Error("Doctor must be read-only");
    if (options.broken) throw new Error(`credentials leaked: ${pool.url}`);
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/1" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: options.replicaInRecovery ?? true, caught_up: false, lag_ms: options.replicaLag ?? 10 }];
    if (text.includes("pg_backend_pid")) {
      if (pool.url.includes("pooler.example")) return [{ pid: 7 }];
      if (pool.url.includes("direct.example")) return [{ pid: ++runtimePid }];
      return [{ pid: options.pooled ? 1 : 100 + pool.index }];
    }
    if (text.includes("set_config")) return [{}];
    if (text.includes("to_regclass")) return [{ exists: true }];
    if (text.includes("_migrations")) return registry.migrations.slice(0, options.applied ?? 2).map(({ id, checksum }) => ({ id, checksum: options.drift ? "edited" : checksum }));
    if (text.includes("pg_namespace")) return [{ exists: !options.schemaMissing }];
    if (text.includes("standard_conforming_strings")) return [{ on: true }];
    if (text.includes("pg_db_role_setting")) return [{ settings: options.timeouts ?? SETTINGS }];
    if (text === "SHOW CONFIG") return [{ key: "unset_option", value: null }, { key: "pool_mode", value: options.consoleMode ?? "transaction" }];
    throw new Error("Unexpected diagnostic query");
  });
  const m = createManagement(createConfig(`postgres://admin:private-secret@localhost:${port++}/app`, replicas), { driver: fake.driver });
  return { m, fake };
}
const byName = (report: Awaited<ReturnType<typeof doctor>>, check: string) => report.checks.find((entry) => entry.check === check);

test("a healthy database passes every check and reports only what SQL cannot prove as unverified", async () => {
  const { m } = fixture();
  const report = await doctor(m, { registry });
  expect(report.ok).toBe(true);
  expect(report.checks.map((c) => [c.target, c.check])).toEqual([
    ["database", "direct_connection"], ["database", "string_literals"], ["database", "runtime_timeouts"], ["database", "schema"], ["database", "migrations"],
  ]);
  expect(report.externalChecks.map((c) => c.check)).toContain("pooled_runtime");
  expect(report.externalChecks.every((c) => c.status === "unverified")).toBe(true);
  await m.close();
});

test("pending migrations, drift, a missing schema, missing timeouts and a pooler in front of management each fail their own check", async () => {
  for (const [options, check] of [
    [{ applied: 1 }, "migrations"],
    [{ drift: true }, "migrations"],
    [{ schemaMissing: true }, "schema"],
    [{ timeouts: "statement_timeout=1" }, "runtime_timeouts"],
    [{ pooled: true }, "direct_connection"],
  ] as const) {
    const { m } = fixture(options);
    const report = await doctor(m, { registry });
    expect(report.ok, check).toBe(false);
    expect(byName(report, check)?.ok, check).toBe(false);
    await m.close();
  }
  const { m } = fixture({ applied: 1 });
  expect(byName(await doctor(m, { registry }), "migrations")?.detail).toContain("20260101000002_b");
  await m.close();
});

test("a failing inspection becomes a check carrying only the error code, never the driver message", async () => {
  const { m } = fixture({ broken: true });
  const report = await doctor(m, { registry });
  expect(report.ok).toBe(false);
  const text = JSON.stringify(report);
  expect(text).toContain("inspection");
  expect(text).not.toContain("credentials leaked");
  expect(text).not.toContain("private-secret");
  await m.close();
});

test("--pooled-url proves a transaction pooler or a direct URL and removes the generic pooled_runtime note", async () => {
  const pooled = await doctor(fixture().m, { registry, pooledUrl: "postgres://u:p@pooler.example/app" });
  expect(byName(pooled, "pooled_runtime")?.ok).toBe(true);
  expect(pooled.externalChecks.map((c) => c.check)).not.toContain("pooled_runtime");
  const direct = await doctor(fixture().m, { registry, pooledUrl: "postgres://u:p@direct.example/app" });
  expect(byName(direct, "pooled_runtime")?.ok).toBe(false);
  expect(direct.ok).toBe(false);
});

test("each replica gets its own targeted checks; a URL that is not a replica fails replica_in_recovery; no URL leaks", async () => {
  const replica = "postgres://admin:replica-secret@replica.example:5432/app";
  const healthy = fixture({}, [replica]);
  const report = await doctor(healthy.m, { registry });
  const mine = report.checks.filter((c) => c.target === "replica#1").map((c) => c.check);
  expect(mine).toEqual(["replica_reachable", "replica_in_recovery", "replica_lag", "replica_runtime_timeouts", "replica_pooled"]);
  expect(report.ok).toBe(true);
  expect(JSON.stringify(report)).not.toContain("replica-secret");
  const primary = fixture({ replicaInRecovery: false }, [replica]);
  const bad = await doctor(primary.m, { registry });
  expect(bad.checks.find((c) => c.target === "replica#1" && c.check === "replica_in_recovery")?.ok).toBe(false);
  expect(bad.ok).toBe(false);
  const lagging = fixture({ replicaLag: 999_999 }, [replica]);
  expect((await doctor(lagging.m, { registry })).checks.find((c) => c.check === "replica_lag")?.ok).toBe(false);
});

test("the PgBouncer console URL must be postgres://…/pgbouncer; the global pool mode must be transaction", async () => {
  const { m } = fixture();
  const consoleDriver = fakeDriver((text) => (text === "SHOW CONFIG" ? [{ key: "pool_mode", value: "session" }] : [])).driver;
  const wrongMode = await doctor(m, { registry, pgbouncerUrl: "postgres://admin:pw@127.0.0.1:6432/pgbouncer", consoleDriver });
  expect(byName(wrongMode, "global_pool_mode")?.ok).toBe(false);
  const badUrl = await doctor(m, { registry, pgbouncerUrl: "postgres://admin:pw@127.0.0.1:6432/app", consoleDriver });
  expect(byName(badUrl, "inspection")).toMatchObject({ target: "pgbouncer", ok: false });
  expect(JSON.stringify(badUrl)).not.toContain("pw@");
  await m.close();
});
```

`unit/replicas-tool.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { replicaReport } from "../../core/tools/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

const REPLICA = "postgres://admin:replica-secret@replica.example:5432/app";
const handler = (lag: number) => (text: string) =>
  text.includes("pg_current_wal_lsn") ? [{ lsn: "0/1" }] : text.includes("pg_is_in_recovery") ? [{ in_recovery: true, caught_up: false, lag_ms: lag }] : [];

test("the report lists each replica's health and lag with no URL, and ok is false when one is unusable", async () => {
  const fine = fakeDriver(handler(10));
  const m = createManagement(createConfig("postgres://admin:p@primary.example/app", [REPLICA]), { driver: fine.driver });
  const report = await replicaReport(m);
  expect(report).toMatchObject({ ok: true, maxLagMs: 5000, replicas: [{ replica: 1, up: true, lagMs: 10, usable: true }] });
  expect(JSON.stringify(report)).not.toContain("replica-secret");
  const lagging = fakeDriver(handler(999_999));
  const slow = await replicaReport(createManagement(createConfig("postgres://admin:p@primary.example/app", [REPLICA]), { driver: lagging.driver }));
  expect(slow.ok).toBe(false);
});

test("the short-lived runtime it opens is closed again; the management pool is left alone", async () => {
  const fake = fakeDriver(handler(10));
  const m = createManagement(createConfig("postgres://admin:p@primary.example/app", [REPLICA]), { driver: fake.driver });
  await replicaReport(m);
  expect(fake.pools.slice(1).every((pool) => pool.closed)).toBe(true);
  expect(fake.pools[0]?.closed).toBe(false);
  await m.close();
});

test("with no replica configured the report is empty and ok", async () => {
  const fake = fakeDriver();
  const m = createManagement(createConfig("postgres://admin:p@primary.example/app"), { driver: fake.driver });
  expect(await replicaReport(m)).toEqual({ ok: true, maxLagMs: 5000, replicas: [] });
});
```

`integration/doctor.test.ts`:

```ts
import { expect } from "bun:test";
import { createConfig } from "../../core/config";
import { createRunner } from "../../core/migrations/runner";
import type { Registry } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";
import { doctor } from "../../core/tools/doctor";
import { createTestManagement, directConfig, dropSchema, integration, pooledConfig, raw, testSchema } from "./helpers";
import { REPLICA_URL, PRIMARY_URL, replicaFixture } from "./replica-fixture";

const registry: Registry = { migrations: compileMigrations([["20260101000001_t", "--up\nCREATE TABLE t (id integer PRIMARY KEY);\n--down\nDROP TABLE t;\n"]]), seeds: [] };
const behind: Registry = { migrations: compileMigrations([["20260101000001_t", "--up\nCREATE TABLE t (id integer PRIMARY KEY);\n--down\nDROP TABLE t;\n"], ["20260101000002_u", "--up\nCREATE TABLE u (id integer PRIMARY KEY);\n--down\nDROP TABLE u;\n"]]), seeds: [] };
const check = (report: Awaited<ReturnType<typeof doctor>>, name: string, target = "database") => report.checks.find((c) => c.check === name && c.target === target);

integration("doctor passes on a migrated schema over a direct URL, flags pending migrations, and proves the pooler URL", async () => {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema });
  try {
    await createRunner(registry).migrate(m);
    const report = await doctor(m, { registry, pooledUrl: pooledConfig().url });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(check(await doctor(m, { registry: behind }), "migrations")?.ok).toBe(false);
    expect(check(await doctor(m, { registry, pooledUrl: directConfig().url }), "pooled_runtime")?.ok).toBe(false);
    expect(check(await doctor(m, { registry, pgbouncerUrl: "postgres://admin:local_admin_password@127.0.0.1:5563/pgbouncer" }), "global_pool_mode", "pgbouncer")?.ok).toBe(true);
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
  }
});

integration("doctor reports a transaction pooler in front of management as a failed direct_connection", async () => {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema }, pooledConfig());
  try {
    expect(check(await doctor(m, { registry }), "direct_connection")?.ok).toBe(false);
  } finally {
    await m.close();
    await admin.close();
  }
});

integration("doctor checks a real replica: reachable, in recovery, lag within the threshold", async () => {
  const f = await replicaFixture();
  const m = createTestManagement({ schema: f.schema, replicaMaxLagMs: 60_000 }, createConfig(PRIMARY_URL, [REPLICA_URL]));
  try {
    const report = await doctor(m, { registry });
    for (const name of ["replica_reachable", "replica_in_recovery", "replica_lag"]) expect(check(report, name, "replica#1")?.ok, name).toBe(true);
    expect(JSON.stringify(report)).not.toContain("127.0.0.1");
  } finally {
    await m.close();
    await f.close();
  }
});
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single
bun test src/__tests__/unit/{doctor,replicas-tool}.test.ts 2>&1 | tail -5
```
Expected: `core/tools/doctor`, `core/tools/replicas` yok → **fail**.

- [ ] **Step 3: `doctor.ts`, `replicas.ts`, CLI**

`core/tools/replicas.ts`:

```ts
/** `replicas` komutu: DATABASE_REPLICA_URLS'teki her replica'nın durumu (sağlık, lag, kullanılabilirlik). Kısa ömürlü bir runtime `Db` açar ve
 * kapatır; yönetim havuzuna dokunmaz. Çıktıda URL yoktur (replica config sırasıyla 1 tabanlı numaralanır). */
import type { Management } from "../management";
import { createDb } from "../runtime";

export async function replicaReport(m: Management) {
  const db = createDb(m.config, { driver: m.driver, poolMax: 2, pooler: "assumed", replicaMaxLagMs: m.config.replicaMaxLagMs });
  try {
    const replicas = await db.replicas();
    return { ok: replicas.every((replica) => replica.usable), maxLagMs: m.config.replicaMaxLagMs, replicas };
  } finally {
    await db.close();
  }
}
```

`core/tools/doctor.ts`:

```ts
/** Salt okunur üretim denetimi: doğrudan yönetim bağlantısı, runtime timeout varsayılanları, schema ve migration durumu, replica'lar ve
 * isteğe bağlı pooler kanıtı ile PgBouncer konsolu. Hiçbir şey yazmaz. */
import { schemaExists } from "../catalog";
import { runtimeDatabaseDefaults } from "../config";
import type { Connection, Driver } from "../driver";
import { AppError, errorCode } from "../errors";
import { qualified } from "../identifier";
import { openSession } from "../locks";
import type { Management } from "../management";
import { pendingIn, type Registry, registry as packageRegistry } from "../migrations/registry";
import { usesTransactionPooler } from "../pooler";
import { probeReplica } from "../replicas";

/** SQL ile kanıtlanamaz; operatör için doğrulanmamış olarak raporlanır. */
const externalChecks = [
  ["pooled_runtime", "Uygulamanın DATABASE_URLS'i transaction-mode pooler'a gitmeli; doctor --pooled-url ile sınayın (ready() de açılışta sınar)."],
  ["effective_pgbouncer_mode", "PgBouncer kullanılıyorsa uygulamanın kullanıcı/DB pool'ları için transaction modunu SHOW POOLS ile doğrulayın."],
  ["hyperdrive_cache", "Hyperdrive kullanılıyorsa bütün bağlantılarda query caching kapalı olmalı; hesap ayarından doğrulayın."],
  ["deployment", "Hedef ortamda /ready, TLS/ağ erişimini ve uygulamanın aynı schema'yı kullandığını doğrulayın."],
].map(([check, detail]) => ({ check: check as string, status: "unverified" as const, detail: detail as string }));

type Add = (check: string, ok: boolean, detail: string) => void;
type Check = { target: string; check: string; ok: boolean; detail: string };

const DATABASE_ROLE_SETTINGS =
  "SELECT pg_catalog.array_to_string(setconfig, ',') AS settings FROM pg_catalog.pg_db_role_setting WHERE setrole=0 AND setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())";

/** `--pooled-url` ve replica pooler sınamaları için üst süre. */
const POOLED_PROBE_DEADLINE_MS = 10_000;

/** Yönetim oturumu açılabiliyorsa doğrudan bağlantıdır; `DIRECT_CONNECTION_REQUIRED` dışındaki hatalar denetimi bozar. */
const isDirectConnection = (m: Management) =>
  openSession(m).then(
    (session) => session.close().then(() => true),
    (error) => {
      if (errorCode(error) !== "DIRECT_CONNECTION_REQUIRED") throw error;
      return false;
    },
  );

/** Ledger bütün listeyi içermeli; bekleyen veya sapmış geçmiş `migrate`/inceleme gerektirir. */
async function checkMigrations(m: Management, add: Add, registry: Registry) {
  try {
    const pending = (await pendingIn(m.db, qualified(m.schema, "_migrations"), registry.migrations, { missingOk: true })).map((migration) => migration.id);
    add("migrations", !pending.length, pending.length ? `Bekleyen migration'lar: ${pending.join(", ")}. bun run cli migrate çalıştırın.` : "Migration'lar güncel.");
  } catch (error) {
    if (errorCode(error) !== "MIGRATION_DRIFT") throw error;
    add("migrations", false, "Migration ledger'ı listeyle uyuşmuyor (MIGRATION_DRIFT); elle inceleyin.");
  }
}

async function inspectDatabase(m: Management, add: Add, registry: Registry) {
  add("direct_connection", await isDirectConnection(m), "Yönetim DATABASE_URLS'i doğrudan (veya session pooling) bağlantı olmalı; transaction pooler advisory lock'ları düşürür.");
  const [strings] = await m.db.query<{ on: boolean }>("SELECT current_setting('standard_conforming_strings')='on' AS on");
  add("string_literals", strings?.on === true, "standard_conforming_strings açık olmalı.");
  const [stored] = await m.db.query<{ settings: string | null }>(DATABASE_ROLE_SETTINGS);
  const expected = runtimeDatabaseDefaults(m.config);
  add("runtime_timeouts", expected.every((setting) => stored?.settings?.split(",").includes(setting)), `Runtime timeout'ları DB varsayılanı olmalı (${expected.join(", ")}); migrate çalıştırın, sonra pooler bağlantılarını yenileyin.`);
  const exists = await schemaExists(m.db, m.schema);
  add("schema", exists, exists ? `Schema ${m.schema} var.` : `Schema ${m.schema} yok; bun run cli migrate onu kurar.`);
  await checkMigrations(m, add, registry);
}

/** `--pooled-url`: runtime URL'si bir transaction-mode pooler'a gitmeli; doğrudan bağlantı runtime'da `POOLER_REQUIRED` verir. */
async function inspectPooled(m: Management, url: string, add: Add) {
  const pooled = await usesTransactionPooler(m.driver, url, { deadlineMs: POOLED_PROBE_DEADLINE_MS });
  add("pooled_runtime", pooled, "Runtime DATABASE_URLS transaction-mode pooler'a gitmeli; doğrudan bağlantı runtime'da POOLER_REQUIRED verir.");
}

/** Replica başına salt okunur denetimler: kısa ömürlü tek bağlantı açılır; replica URL'si hiçbir çıktıya girmez. */
async function inspectReplica(m: Management, url: string, add: Add) {
  const replica = m.driver(url, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  try {
    let probe: Awaited<ReturnType<typeof probeReplica>>;
    try {
      probe = await probeReplica(m.db, replica);
    } catch (error) {
      add("replica_reachable", false, `Replica'ya bağlanılamadı (${errorCode(error)}); URL, ağ ve kimlik bilgilerini kontrol edin.`);
      return;
    }
    add("replica_reachable", true, "Replica erişilebilir.");
    add("replica_in_recovery", probe.inRecovery, "URL gerçekten bir replica'ya gitmeli (pg_is_in_recovery); primary'yi replica diye vermek okuma/yazma ayrımını bozar.");
    const lag = probe.lagMs === null ? "bilinmiyor" : `${probe.lagMs} ms`;
    add("replica_lag", probe.lagMs !== null && probe.lagMs <= m.config.replicaMaxLagMs, `Replica lag'i ${m.config.replicaMaxLagMs} ms eşiğinin altında olmalı (ölçülen: ${lag}).`);
    const [stored] = await replica.query<{ settings: string | null }>(DATABASE_ROLE_SETTINGS);
    const expected = runtimeDatabaseDefaults(m.config);
    add("replica_runtime_timeouts", expected.every((setting) => stored?.settings?.split(",").includes(setting)), `Runtime timeout'ları replika ile gelir (${expected.join(", ")}); primary'de migrate çalıştırın.`);
    const pooled = await usesTransactionPooler(m.driver, url, { deadlineMs: POOLED_PROBE_DEADLINE_MS });
    // Bilgi: runtime replica URL'sinde pooler zorlamaz, bu yüzden doğrudan URL doctor'ı başarısız yapmaz (her zaman ok).
    add("replica_pooled", true, pooled ? "Replica runtime URL'si transaction-mode pooler'a gidiyor." : "Replica runtime URL'si transaction-mode pooler'a gitmiyor (doğrudan); runtime zorlamaz, yalnızca bilgi.");
  } finally {
    await replica.close(1000);
  }
}

async function inspectPgBouncer(adminUrl: string, consoleDriver: Driver | undefined, add: Add) {
  const url = URL.parse(adminUrl);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/pgbouncer" || url.search)
    throw new AppError("INVALID_CONFIG", "PgBouncer admin URL must be postgres://…/pgbouncer");
  // Yönetim konsolu transaction kabul etmez: ham, tek bağlantılı pool.
  const driver = consoleDriver ?? (await import("../drivers/bun")).bunDriver;
  const adminConsole = driver(url.href, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 30, connectTimeoutSeconds: 10 });
  try {
    const settings = await adminConsole.query<{ key: string; value: string | null }>("SHOW CONFIG");
    const mode = settings.find((row) => row.key === "pool_mode")?.value;
    add("global_pool_mode", mode === "transaction", "Genel pool_mode transaction olmalı. DB/user override'ları ayrıca SHOW POOLS üzerinden denetlenmeli.");
  } finally {
    await adminConsole.close(1000);
  }
}

export interface DoctorOptions {
  /** PgBouncer yönetim konsolu URL'si (postgres://…/pgbouncer). */
  pgbouncerUrl?: string;
  /** Uygulamanın runtime URL'si: transaction-mode pooler'a gittiği kanıtlanır. */
  pooledUrl?: string;
  /** PgBouncer konsol istemcisi; varsayılan Bun SQL (araçlar Bun'da çalışır ve postgres.js'in başlangıç tip sorgularını konsol reddeder). */
  consoleDriver?: Driver;
  /** Migration listesi; varsayılan paketin kendi kaydı (testler kendi listesini verir). */
  registry?: Registry;
}

export async function doctor(m: Management, options: DoctorOptions = {}) {
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

  await inspect("database", (add) => inspectDatabase(m, add, options.registry ?? packageRegistry));
  const { pooledUrl, pgbouncerUrl, consoleDriver } = options;
  if (pooledUrl !== undefined) await inspect("database", (add) => inspectPooled(m, pooledUrl, add));
  for (const [index, url] of m.config.replicas.entries()) await inspect(`replica#${index + 1}`, (add) => inspectReplica(m, url, add));
  if (pgbouncerUrl !== undefined) await inspect("pgbouncer", (add) => inspectPgBouncer(pgbouncerUrl, consoleDriver, add));
  return {
    ok: checks.every((c) => c.ok),
    checks,
    externalChecks: pooledUrl === undefined ? externalChecks : externalChecks.filter((item) => item.check !== "pooled_runtime"),
  };
}
```

`core/cli.ts`: üstte yardımcılar ve komutlar (Task 3'ün `backup` import satırının yanına):

```ts
const POOLED_URL_QUESTION = "Runtime URL'si (DATABASE_URLS biçimi, yazılan görünmez): ";
const PGBOUNCER_URL_QUESTION = "PgBouncer konsol URL'si (postgres://…/pgbouncer, yazılan görünmez): ";
/** Parola taşıyan URL gizli girişle sorulur; biçim doğrulanır, hata metinleri değeri içermez. */
const askUrl = async (question: string, subject: string) => {
  const { askSecret, postgresUrl } = await import("./tools/ask-secret");
  return postgresUrl(await askSecret(question), subject).href;
};
```
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
  doctor: {
    usage: "[--pgbouncer-url] [--pooled-url] [--schema ad]",
    summary: "Bağlantı, timeout'lar, schema ve migration durumunu salt okunur denetler (--pgbouncer-url: konsol URL'sini, --pooled-url: runtime URL'sini gizli girişle sorar; başarısız denetimde çıkış kodu 1)",
    flags: ["--pgbouncer-url", "--pooled-url", ...SCHEMA_FLAGS],
    run: async ({ app, options }) => {
      const pgbouncerUrl = options.pgbouncerUrl ? await askUrl(PGBOUNCER_URL_QUESTION, "PgBouncer admin URL") : undefined;
      const pooledUrl = options.pooledUrl ? await askUrl(POOLED_URL_QUESTION, "Runtime URL") : undefined;
      const result = await (await import("./tools/doctor")).doctor(app, { pgbouncerUrl, pooledUrl });
      if (!result.ok) process.exitCode = 1;
      return result;
    },
  },
```
Not: Task 3'te eklenen `askReplicaUrl` aynı `askUrl` ile ifade edilebilir; tekrar varsa `askReplicaUrl`'i `askUrl(REPLICA_URL_QUESTION, "Replica URL")` yapın (daha az kod).

- [ ] **Step 4: Geçiş**

```bash
bun run typecheck && bun run lint && bun test src/__tests__/unit 2>&1 | tail -5
RUN_INTEGRATION=1 bun test --timeout 120000 src/__tests__/integration/doctor.test.ts 2>&1 | tail -6
```
Expected: birim yeşil (doctor 6, replicas-tool 3); `doctor` entegrasyon 3 test **pass**. `unit/cli.test.ts` yardım testine `replicas`, `doctor`, `export`, `backup`, `restore`, `pull` adlarını ekleyin (ilgili görevlerde eklenmediyse şimdi) ve geçtiğini doğrulayın.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: doctor (read-only checks incl. replicas, pooler proof, PgBouncer console) and replicas report

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Neon/Supabase araçları ve sağlayıcı ölçümleri

**Files:**
- Create: `core/tools/neon.ts` (kopya + tek DB), `src/__tests__/provider/{measure,verify}.ts` (kopya + tek DB)
- Modify: `core/cli.ts`, `integration/helpers.ts` (`cliFails`)
- Test: yeni `unit/neon-tools.test.ts`; kopya+uyarlama `unit/{provider-measure,provider-verify}.test.ts`, `integration/provider-verify.test.ts`, `integration/cli.test.ts` (ek test)

**Interfaces:**
- Consumes: Task 3 `exportSchema`, G2 `createManagement`/`Management`, `config.createConfig`.
- Produces (`neon.ts`): `neonApi(apiKey, { fetch?, baseUrl? }): NeonApi`, `NeonApi { request<T>(method: "GET" | "POST", path, options?): Promise<T> }`, `NeonNode { projectId; branchId; endpointId; host; database; role }`, `resolveNode(api, url, { org?, pageSize? }): Promise<NeonNode>`, `NeonToolOptions { org?; now?; pageSize?; pollMs?; timeoutMs?; sleep? }`, `BranchRun { projectId; sourceBranchId; branchId; endpointId; name; host }`, `branchNode(api, node, options & { prefix; timestamp? }): Promise<BranchRun>`, `safetyPoint(m, api, options?)` ve `stageCopy(m, api, options?)` → `{ provider: "neon"; branch: BranchRun }`, `parsePastTimestamp(value, now): string`, `safetyPointProvider(value): "neon" | "supabase" | undefined`, `supabaseSafetyPoint(now?)`, `branchUrl(api, run, node): Promise<string>`, `exportAt(m, api, { dir, at, signal?, ...options }, deps?)`. Hata kodları: `PROVIDER_API_ERROR`, `PROVIDER_NODE_NOT_FOUND`.
- Sağlayıcı ölçümü: `verify(driver, name, managementUrl, runtimeUrl, now?, timing?, replicaUrl?): Promise<{ generatedAt; driver; server; database: { probe; alterDatabase; privileges; deadline; replica? } }>`.

- [ ] **Step 1: Başarısız testler**

`unit/neon-tools.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import type { Management } from "../../core/management";
import { branchNode, branchUrl, exportAt, neonApi, parsePastTimestamp, resolveNode, safetyPoint, safetyPointProvider, stageCopy, supabaseSafetyPoint } from "../../core/tools/neon";

const KEY = "neon-secret-key";
const URL_ = "postgres://app_owner:db-secret@ep-cool-123-pooler.eu-central-1.aws.neon.tech/appdb";
type Route = (init: RequestInit | undefined, url: URL) => unknown;

/** Sahte Neon API'si: `<YÖNTEM> <yol>` → cevap; her çağrı kaydedilir. */
function fake(routes: Record<string, Route>) {
  const calls: { method: string; path: string; query: string; body?: unknown }[] = [];
  const send = async (input: URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = input.pathname.replace(/^\/api\/v2/, "");
    calls.push({ method, path, query: input.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(JSON.stringify({ message: `no route ${method} ${path}` }), { status: 404 });
    const result = route(init, input);
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
  };
  return { api: neonApi(KEY, { fetch: send }), calls };
}
const projects: Route = () => ({ projects: [{ id: "p1" }] });
const endpoints: Route = () => ({ endpoints: [{ id: "ep1", host: "ep-cool-123.eu-central-1.aws.neon.tech", branch_id: "br1" }] });
const created: Route = () => ({ branch: { id: "br2" }, endpoints: [{ id: "ep2", host: "ep-new-9.eu-central-1.aws.neon.tech" }], operations: [{ id: "op1" }] });
const finished: Route = () => ({ operation: { action: "create_branch", status: "finished" } });
const happy = { "GET /projects": projects, "GET /projects/p1/endpoints": endpoints, "POST /projects/p1/branches": created, "GET /projects/p1/operations/op1": finished };
const now = new Date("2026-10-03T10:15:00Z");

test("the API client sends the key but never lets it (or a network detail) reach a message", async () => {
  const unreachable = neonApi(KEY, { fetch: async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); } });
  const down = await unreachable.request("GET", "/projects").catch((e: unknown) => e as Error);
  expect(down).toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(down.message).not.toContain(KEY);
  const denied = neonApi(KEY, { fetch: async () => new Response(JSON.stringify({ message: `bad token ${KEY}` }), { status: 403 }) });
  const error = await denied.request("GET", "/projects").catch((e: unknown) => e as Error);
  expect(error.message).toContain("403");
  expect(error.message).toContain("[hidden]");
  expect(error.message).not.toContain(KEY);
  expect(() => neonApi("")).toThrow(expect.objectContaining({ code: "USAGE" }));
});

test("resolveNode matches the pooled URL to the direct endpoint host and reads database and role from the URL", async () => {
  const { api, calls } = fake(happy);
  expect(await resolveNode(api, URL_)).toEqual({ projectId: "p1", branchId: "br1", endpointId: "ep1", host: "ep-cool-123.eu-central-1.aws.neon.tech", database: "appdb", role: "app_owner" });
  expect(calls[0]?.query).toContain("limit=100");
  const { api: other } = fake(happy);
  const error = (await resolveNode(other, "postgres://u:p@elsewhere.example/app").catch((e: unknown) => e)) as Error;
  expect(error).toMatchObject({ code: "PROVIDER_NODE_NOT_FOUND" });
  expect(error.message).not.toContain("elsewhere");
  expect(await resolveNode(fake(happy).api, URL_, { org: "org-1" }).then(() => true)).toBe(true);
});

test("safetyPoint opens one pre-migrate branch from the source branch's current start and waits for the operation", async () => {
  const { api, calls } = fake(happy);
  const result = await safetyPoint({ config: { url: URL_ } }, api, { now });
  expect(result).toEqual({
    provider: "neon",
    branch: { projectId: "p1", sourceBranchId: "br1", branchId: "br2", endpointId: "ep2", name: "pre-migrate-20261003T101500Z", host: "ep-new-9.eu-central-1.aws.neon.tech" },
  });
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({ branch: { name: "pre-migrate-20261003T101500Z", parent_id: "br1" }, endpoints: [{ type: "read_write" }] });
  expect((await stageCopy({ config: { url: URL_ } }, fake(happy).api, { now })).branch.name).toBe("stage-20261003T101500Z");
});

test("a failed or slow operation is a PROVIDER_API_ERROR that names the branch that was left behind", async () => {
  const failing = fake({ ...happy, "GET /projects/p1/operations/op1": () => ({ operation: { action: "create_branch", status: "failed", error: "boom" } }) });
  const error = (await safetyPoint({ config: { url: URL_ } }, failing.api, { now }).catch((e: unknown) => e)) as Error;
  expect(error).toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(error.message).toContain("ended as failed");
  expect(error.message).toContain("pre-migrate-20261003T101500Z");
  expect(error.message).toContain("not deleted");
  let polls = 0;
  const slow = fake({ ...happy, "GET /projects/p1/operations/op1": () => ({ operation: { action: "create_branch", status: ++polls < 3 ? "running" : "finished" } }) });
  const waits: number[] = [];
  await safetyPoint({ config: { url: URL_ } }, slow.api, { now, pollMs: 7, sleep: async (ms) => void waits.push(ms) });
  expect(waits).toEqual([7, 7]);
  const stuck = fake({ ...happy, "GET /projects/p1/operations/op1": () => ({ operation: { action: "create_branch", status: "running" } }) });
  await expect(safetyPoint({ config: { url: URL_ } }, stuck.api, { now, timeoutMs: 0, sleep: async () => {} })).rejects.toThrow("did not finish within 0 ms");
});

test("branchUrl returns the encrypted connection URI only to the caller and rejects a non-postgres answer", async () => {
  const node = { projectId: "p1", branchId: "br1", endpointId: "ep1", host: "h", database: "appdb", role: "app_owner" };
  const run = { projectId: "p1", sourceBranchId: "br1", branchId: "br2", endpointId: "ep2", name: "n", host: "h2" };
  const { api, calls } = fake({ "GET /projects/p1/connection_uri": () => ({ uri: "postgres://u:pw@h2/appdb" }) });
  expect(await branchUrl(api, run, node)).toBe("postgres://u:pw@h2/appdb");
  expect(calls[0]?.query).toContain("branch_id=br2");
  expect(calls[0]?.query).toContain("endpoint_id=ep2");
  expect(calls[0]?.query).toContain("database_name=appdb");
  expect(calls[0]?.query).toContain("role_name=app_owner");
  await expect(branchUrl(fake({ "GET /projects/p1/connection_uri": () => ({ uri: "mysql://x" }) }).api, run, node)).rejects.toMatchObject({ code: "PROVIDER_API_ERROR" });
});

test("exportAt branches the past moment, exports through a temporary management context and never returns the URI", async () => {
  const { api, calls } = fake({ ...happy, "GET /projects/p1/connection_uri": () => ({ uri: "postgres://u:branch-secret@ep-new-9/appdb" }) });
  let managed: string | undefined;
  let closed = false;
  const m = { config: { url: URL_ }, driver: undefined, schema: "app_x" } as unknown as Management;
  const deps = {
    manage: (config: ReturnType<typeof createConfig>) => ((managed = config.url), { close: async () => void (closed = true) } as unknown as Management),
    export: async (_past: Management, dir: string) => ({ dir, tables: 2, rows: 5 }),
  };
  const result = await exportAt(m, api, { dir: "/tmp/x", at: "2026-10-03T09:30:00.000Z", now }, deps);
  expect(managed).toBe("postgres://u:branch-secret@ep-new-9/appdb");
  expect(closed).toBe(true);
  expect(result).toMatchObject({ dir: "/tmp/x", tables: 2, rows: 5, at: "2026-10-03T09:30:00.000Z", branch: { name: "pitr-20261003T101500Z" } });
  expect(JSON.stringify(result)).not.toContain("branch-secret");
  expect((calls.find((c) => c.method === "POST")?.body as { branch: Record<string, unknown> }).branch.parent_timestamp).toBe("2026-10-03T09:30:00.000Z");
  const failing = { ...deps, export: async () => { throw new Error("driver says branch-secret"); } };
  const error = (await exportAt(m, fake({ ...happy, "GET /projects/p1/connection_uri": () => ({ uri: "postgres://u:branch-secret@ep-new-9/appdb" }) }).api, { dir: "/tmp/x", at: "2026-10-03T09:30:00.000Z", now }, failing).catch((e: unknown) => e)) as Error;
  expect(error.message).toContain("pitr-20261003T101500Z");
  expect(error.message).not.toContain("branch-secret");
});

test("--at must be a past RFC 3339 time with an offset and a real calendar date", () => {
  expect(parsePastTimestamp("2026-10-03T09:30:00Z", now)).toBe("2026-10-03T09:30:00.000Z");
  expect(parsePastTimestamp("2026-10-03T12:30:00+03:00", now)).toBe("2026-10-03T09:30:00.000Z");
  for (const bad of [undefined, "", "2026-10-03T09:30:00", "yesterday", "2026-02-30T09:30:00Z", "2026-10-03T25:00:00Z", "2026-10-03T10:15:00Z", "2026-10-04T09:30:00Z"])
    expect(() => parsePastTimestamp(bad, now), String(bad)).toThrow(expect.objectContaining({ code: "USAGE" }));
});

test("safety point providers: neon, supabase, nothing; Supabase makes no API call and says it is a paid add-on", () => {
  expect([safetyPointProvider(undefined), safetyPointProvider("neon"), safetyPointProvider("supabase")]).toEqual([undefined, "neon", "supabase"]);
  expect(() => safetyPointProvider("aws")).toThrow(expect.objectContaining({ code: "USAGE" }));
  const point = supabaseSafetyPoint(new Date("2026-10-03T10:15:00Z"));
  expect(point).toMatchObject({ provider: "supabase", recoveryTimeTargetUnix: 1791022500 });
  expect(point.note).toContain("No API call was made");
  expect(point.note).toContain("paid add-on");
});
```
(`recoveryTimeTargetUnix`, `2026-10-03T10:15:00Z`'nin epoch saniyesidir.)

`integration/cli.test.ts`'e ek (Task 1'in dosyasına, sonuna):

```ts
integration("migrate --safety-point stops before migrating when the safety point cannot be taken", async () => {
  const copy = await packageCopy("safety");
  const schema = testSchema();
  const admin = raw();
  try {
    const created = (await copy.cli("migration", "create", "add_notes")) as { id: string; path: string };
    await copy.write(created.path, "--up\nCREATE TABLE notes (id integer PRIMARY KEY);\n--down\nDROP TABLE notes;\n");
    await copy.codegen();
    // Gizli giriş boş: API anahtarı yok → nokta alınamaz → migrate hiç çalışmaz.
    const failed = await copy.cliFails("migrate", "--schema", schema, "--safety-point", "neon");
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({ error: "USAGE" });
    expect(await schemaExists(admin, schema)).toBe(false);
    expect((await copy.cliFails("migrate", "--schema", schema, "--org", "org-1")).code).toBe(1); // --org yalnızca neon ile
    expect(await copy.cli("migrate", "--schema", schema, "--dry-run", "--safety-point", "supabase")).toEqual({ dryRun: true, migrations: [created.id] });
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await copy.remove();
  }
});
```
(üst içe aktarmalara `schemaExists` eklenir.) `helpers.ts` `packageCopy`'ye `cliFails` ekleyin:

```ts
    /** Başarısız çıkış beklenen komut: çıkış kodu ve stderr döner. */
    async cliFails(...args: string[]) {
      const child = Bun.spawn([process.execPath, "src/core/cli.ts", ...args, `--driver=${cliDriver}`], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr };
    },
```
Ayrıca Task 1'deki `packageCopy` yardımcısını **temiz kayıtla** başlatın (Task 6 paketin kendi `auth` migration'ını ekleyecek): oluşturma sonunda

```ts
  // Kopya paketin kendi migration/seed/sorgu/tablo kayıtlarıyla değil, boş bir kayıtla başlar: testler yalnızca kendi dosyalarını görür.
  for (const dir of ["migrations", "seeds"])
    for await (const file of new Bun.Glob(`src/${dir}/*`).scan(root)) if (!file.endsWith("index.gen.ts")) await rm(join(root, file));
  await writeGenerated(root);
```
(`writeGenerated` kaynağı kalmayan üretilmiş dosyaları da siler.) Bu satırlar `packageCopy`'de `return` öncesine eklenir.

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single
bun test src/__tests__/unit/neon-tools.test.ts 2>&1 | tail -5
```
Expected: `core/tools/neon` yok → **fail**.

- [ ] **Step 3: `neon.ts`**

```bash
cp ../db-multi/src/core/tools/neon.ts src/core/tools/neon.ts
mkdir -p src/__tests__/provider
cp ../db-multi/src/__tests__/provider/{measure,verify}.ts src/__tests__/provider/
cp ../db-multi/src/__tests__/unit/{provider-measure,provider-verify}.test.ts src/__tests__/unit/
cp ../db-multi/src/__tests__/integration/provider-verify.test.ts src/__tests__/integration/
```

`neon.ts`: şu parçalar **aynen kalır** (kopyadan): `BASE_URL`, `MAX_MESSAGE_CHARS`, `PROJECT_PAGE_SIZE`, `Fetch`, `NeonApi`, `neonApi`, `directHost`, `listEndpoints`, `NeonToolOptions`, `OPERATION_*`, `FAILED_OPERATION`, `wait`, `stamp`, `waitForOperations`, `usage`, `RFC3339`, `realTime`, `parsePastTimestamp`, `safetyPointProvider`, `supabaseSafetyPoint`, `branchUrl`. Aşağıdakiler yeniden yazılır (silinenler: `resolveNodes`, `branchNodes`, `branchTool`'un çoklu hâli, `ConfiguredNodes`, `NeonNode.nodeId`, `BranchRun.nodes`):

```ts
import { createConfig } from "../config";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import type { exportSchema } from "./backup";
```
```ts
export interface NeonNode {
  projectId: string;
  branchId: string;
  endpointId: string;
  host: string;
  database: string;
  role: string;
}
interface EndpointRef {
  projectId: string;
  branchId: string;
  endpointId: string;
  host: string;
}
```
(`listEndpoints` `EndpointRef[]` döndürmeye devam eder.)

```ts
/** `DATABASE_URLS`'in host'unu hesaptaki endpoint'lerle eşleştirir; proje kimliği env gerektirmez. Eşleşme yoksa mesaj URL ya da host içermez. */
export async function resolveNode(api: NeonApi, url: string, { org, pageSize = PROJECT_PAGE_SIZE }: { org?: string; pageSize?: number } = {}): Promise<NeonNode> {
  const parsed = URL.parse(url);
  const endpoint = parsed && (await listEndpoints(api, org, pageSize)).find((candidate) => directHost(candidate.host) === directHost(parsed.hostname));
  if (!parsed || !endpoint)
    throw new AppError("PROVIDER_NODE_NOT_FOUND", "No Neon endpoint matches DATABASE_URLS; check that the API key belongs to the account that owns it (use --org for an organization)");
  return { ...endpoint, database: decodeURIComponent(parsed.pathname.slice(1)), role: decodeURIComponent(parsed.username) };
}

export interface BranchRun {
  projectId: string;
  sourceBranchId: string;
  branchId: string;
  endpointId: string;
  name: string;
  host: string;
}

/** Açılmış ve silinmeyen branch'in adı: kullanıcı konsoldan silebilsin. */
const leftBehind = (run: BranchRun) => `Branch created before the failure (not deleted): ${run.name} (project ${run.projectId}, branch ${run.branchId})`;

/** Düğümün kaynak branch'inden bir branch açar (`timestamp` verilirse o andan) ve operasyonların bitmesini bekler. Açıldıktan sonraki hata
 * branch'i adıyla bildirir; branch asla silinmez. */
export async function branchNode(api: NeonApi, node: NeonNode, options: NeonToolOptions & { prefix: string; timestamp?: string }): Promise<BranchRun> {
  const { prefix, timestamp, now = new Date() } = options;
  const name = `${prefix}-${stamp(now)}`;
  let run: BranchRun | undefined;
  try {
    const response = await api.request<{ branch: { id: string }; endpoints: { id: string; host: string }[]; operations: { id: string }[] }>("POST", `/projects/${node.projectId}/branches`, {
      body: { branch: { name, parent_id: node.branchId, ...(timestamp ? { parent_timestamp: timestamp } : {}) }, endpoints: [{ type: "read_write" }] },
    });
    const endpoint = response.endpoints[0];
    run = { projectId: node.projectId, sourceBranchId: node.branchId, branchId: response.branch.id, endpointId: endpoint?.id ?? "", name, host: endpoint?.host ?? "" };
    if (!endpoint) throw new AppError("PROVIDER_API_ERROR", "Neon created the branch without a compute endpoint");
    await waitForOperations(api, node.projectId, response.operations, options);
    return run;
  } catch (error) {
    if (!run) throw error;
    throw new AppError(error instanceof AppError ? error.code : "PROVIDER_API_ERROR", `${error instanceof Error ? error.message : "Operation failed"}. ${leftBehind(run)}`);
  }
}

type Configured = { config: { url: string } };
const branchTool = (prefix: string) => async (m: Configured, api: NeonApi, options: NeonToolOptions = {}) => ({
  provider: "neon" as const,
  branch: await branchNode(api, await resolveNode(api, m.config.url, options), { ...options, prefix }),
});

/** `migrate` öncesi: kaynak branch'in o anki başlangıcından `pre-migrate-<zaman>` branch'i. */
export const safetyPoint = branchTool("pre-migrate");
/** Migrasyon denemesi için `stage-<zaman>` branch'i; yalnızca branch id'si ve host döner, şifreli URI hiç alınmaz. */
export const stageCopy = branchTool("stage");
```
`ExportDeps`, `defaultDeps`, `exportAt`:

```ts
export interface ExportDeps {
  manage(config: ReturnType<typeof createConfig>): Management;
  export: typeof exportSchema;
}

const defaultDeps = async (m: Management): Promise<ExportDeps> => {
  const [{ createManagement }, { exportSchema: exportOne }] = await Promise.all([import("../management"), import("./backup")]);
  return { manage: (config) => createManagement(config, { driver: m.driver, schema: m.schema }), export: exportOne };
};

/** Schema'nın `at` anındaki halini `dir`'e export eder: kaynak branch'ten o ana geçici branch açılır, bağlantı bilgileriyle geçici bir `Management`
 * kurulur ve mevcut `exportSchema` çalışır. Canlı veriye yazılmaz, branch silinmez; uygulamak `restore` iledir. */
export async function exportAt(
  m: Management,
  api: NeonApi,
  { dir, at, signal, ...options }: NeonToolOptions & { dir: string; at: string; signal?: AbortSignal },
  deps?: ExportDeps,
) {
  const node = await resolveNode(api, m.config.url, options);
  const branch = await branchNode(api, node, { ...options, prefix: "pitr", timestamp: at });
  try {
    const url = await branchUrl(api, branch, node);
    const { manage, export: exportPast } = deps ?? (await defaultDeps(m));
    const past = manage(createConfig(url));
    try {
      const exported = await exportPast(past, dir, { signal });
      return { ...exported, at, branch, note: "The temporary branch was not deleted. Apply the export with `restore <dir>` (the target schema must be empty)." };
    } finally {
      await past.close().catch(() => {});
    }
  } catch (error) {
    // Branch açıldı ve silinmez: adıyla söyle. Sürücü hatalarının metni (host, kullanıcı, parola) mesaja girmez.
    const reason = error instanceof AppError ? error.message : `Neon export failed (${errorCode(error)})`;
    throw new AppError(errorCode(error), `${reason}. ${leftBehind(branch)}`);
  }
}
```
Başlık yorumu: "Neon API ile branch araçları: `migrate` öncesi güvenlik noktası, migrasyon denemesi için staging kopyası ve geçmiş anın export'u. Yalnızca `fetch` kullanır; API anahtarı ve şifreli bağlantı URI'si bellekte tutulur, hiçbir çıktıya veya hata mesajına girmez. Branch'ler asla silinmez."

Sağlayıcı ölçümleri:

- `provider/measure.ts` içe aktarmaları: `usesTransactionPooler` ← `"../../core/pooler"`, `probeReplica` ← `"../../core/replicas"`, `quoteIdentifier` ← `"../../core/identifier"`; yorumdaki `bootstrap` → `migrate`.
- `provider/verify.ts` tek DB'ye indirgenir:

```ts
export interface DatabaseReport {
  probe: { runtime: ProbeResult; management: ProbeResult };
  alterDatabase: AlterDatabaseResult;
  privileges: PrivilegeResult;
  deadline: DeadlineResult;
  replica?: ReplicaResult;
}
export interface Report {
  generatedAt: string;
  driver: string;
  server: string | null;
  database: DatabaseReport;
}

/** Ölçümleri sırayla çalıştırır (paralel değil: ölçümler aynı veritabanı ayarına dokunur). */
export async function verify(
  driver: Driver,
  name: string,
  managementUrl: string,
  runtimeUrl: string,
  now = new Date(),
  timing?: Parameters<typeof deadline>[3] & { gapMs?: number },
  replicaUrl?: string,
): Promise<Report> {
  const ctx: Context = { driver, urls: [managementUrl, runtimeUrl, ...(replicaUrl ? [replicaUrl] : [])] };
  const database: DatabaseReport = {
    probe: { runtime: await probe(ctx, runtimeUrl), management: await probe(ctx, managementUrl) },
    alterDatabase: await alterDatabase(ctx, managementUrl, runtimeUrl),
    privileges: await privileges(ctx, managementUrl),
    deadline: await deadline(ctx, runtimeUrl, managementUrl, timing),
    ...(replicaUrl ? { replica: await replica(ctx, managementUrl, replicaUrl, timing?.gapMs) } : {}),
  };
  return { generatedAt: now.toISOString(), driver: name, server: await serverVersion(driver, managementUrl), database };
}
```
`main()`: `const managementUrl = loadConfig().url; const runtimeUrl = postgresUrl(await askSecret("Runtime URL'si (DATABASE_URLS biçimi, yazılan görünmez): "), "Runtime URL").href;` ve `--replica` için `const replicaUrl = process.argv.includes("--replica") ? createConfig(managementUrl, postgresUrl(await askSecret("Replica URL'si (postgres://…, yazılan görünmez): "), "Replica URL").href).replicas[0] : undefined;`. Başlık yorumunu tek URL anlatacak biçimde yenileyin. `NodeReport` ve çok düğümlü döngü silinir.

Testler: `unit/provider-verify.test.ts` içinde `management`/`runtime` dizileri tek URL'ye, `verify(..., management, runtime, now, timing)` çağrısı tek URL'ye, `report.nodes[0]` → `report.database`, `report.nodes.map(...)` testi silinir (ledger: `Task 5: removed … multi-node report shape`); sır sızıntısı beklentileri (`pw-one`, host adları, `postgres://`) aynı kalır. `unit/provider-measure.test.ts`: yalnızca içe aktarma yolları. `integration/provider-verify.test.ts`: `directConfig().url`, `pooledConfig().url`, `raw()`, `report.database`.

`core/cli.ts`: Neon yardımcıları ve komutlar:

```ts
const NEON_KEY_QUESTION = "Neon API anahtarı (yazılan görünmez): ";
const neon = () => import("./tools/neon");
/** Neon API anahtarı argv'ye veya env'e girmez; gizli girişle sorulur. */
const askNeonApi = async () => {
  const [{ askSecret }, { neonApi }] = await Promise.all([import("./tools/ask-secret"), neon()]);
  return neonApi(await askSecret(NEON_KEY_QUESTION));
};

/** `migrate --safety-point`: migrate'ten ÖNCE sağlayıcıda güvenlik noktası alınır; alınamazsa hata migrate'i hiç başlatmaz. `--dry-run` nokta almaz. */
async function takeSafetyPoint(app: Management, options: Options) {
  if (options.safetyPoint === undefined && options.org === undefined) return;
  const tools = await neon();
  const provider = tools.safetyPointProvider(options.safetyPoint);
  if (options.org !== undefined && provider !== "neon") throw usage("--org applies to --safety-point neon");
  if (!provider || options.dryRun) return;
  return provider === "neon" ? tools.safetyPoint(app, await askNeonApi(), { org: options.org }) : tools.supabaseSafetyPoint();
}
```
(`takeSafetyPoint(app, options)` imzasıyla; `app: Management`.) `migrate` komutu:

```ts
  migrate: {
    usage: "[--dry-run] [--schema ad] [--safety-point neon|supabase] [--org ID]",
    summary: "Bekleyen migration'ları uygular; schema yoksa kurar ve runtime timeout'larını DB varsayılanı olarak yazar (--safety-point: önce sağlayıcıda güvenlik noktası alır)",
    flags: ["--dry-run", "--safety-point", "--org", ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ api, app, options }) => {
      const point = await takeSafetyPoint(app, options);
      if (point) print(point);
      return api.migrate(app, options);
    },
  },
  "neon stage-copy": {
    usage: "[--org ID]",
    summary: "Neon: kaynak branch'ten migrasyon denemesi için branch açar (branch id ve host yazılır, şifreli URI yazılmaz)",
    flags: ["--org"],
    run: async ({ app, options }) => (await neon()).stageCopy(app, await askNeonApi(), { org: options.org }),
  },
  "neon export": {
    usage: "<dir> --at ZAMAN [--org ID] [--schema ad]",
    summary: "Neon: schema'nın geçmiş anını export klasörüne yazar (canlı veriye dokunmaz; uygulamak için restore)",
    flags: ["--at", "--org", ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ app, options }, dir) => {
      const tools = await neon();
      const at = tools.parsePastTimestamp(options.at, new Date());
      return tools.exportAt(app, await askNeonApi(), { dir, at, org: options.org, signal: options.signal });
    },
  },
```
(`neon export` `--at` değerini önce doğrular: API'ye gitmeden.)

- [ ] **Step 4: Geçiş**

```bash
bun run typecheck && bun run lint && bun test src/__tests__/unit 2>&1 | tail -5
RUN_INTEGRATION=1 bun test --timeout 120000 src/__tests__/integration/{provider-verify,cli}.test.ts 2>&1 | tail -6
```
Expected: birim yeşil (neon-tools 8, provider testleri pass); entegrasyon `provider-verify` ve `cli` (3 test) **pass**; `ls .tmp-* 2>/dev/null | wc -l` `0`. **Gerçek Neon/Supabase'e çağrı yapılmaz.**

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: Neon/Supabase tools for one database (safety point before migrate, stage copy, point-in-time export) and provider verification

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Better Auth, temel `auth` migration'ı ve `auth generate`

**Files:**
- Copy+edit: `core/auth-adapter.ts`; create: `core/auth-schema.ts`, `core/auth.ts`, `src/auth.ts`; copy+edit: `core/tools/auth.ts`
- Create: `src/migrations/<UTC>_auth.sql` (CLI ile), `__tests__/fixtures/auth-options.ts`
- Modify: `core/cli.ts`
- Test: yeni `unit/auth.test.ts`; kopya+uyarlama `unit/auth-adapter.test.ts`; yeni `integration/auth.test.ts`

**Interfaces:**
- Consumes: G2 `Db` (`pools.primary`, `schema`), `identifier`, `Management`, `registry`, `codegen.createMigration`, `compiler.prepareMigration`.
- Produces:
  - `auth-schema.ts`: `authTables()`, `twoFactorTables()`, `rateLimitTable()` (auth türü almaz): `users`, `session`, `account`, `verification`, `two_factor`, `rate_limit`; `emailVerified` → `email_verified`; alanlar snake_case.
  - `auth.ts`: `AuthRuntime = Pick<Db, "pools" | "schema">`, `AuthOptions { database: DBAdapterInstance; secret: string; baseURL: string; basePath?: string; advanced: { cookiePrefix: string; database: { generateId: false } } }`, `AuthConfig { secret; baseURL; basePath?; cookiePrefix? }`, `createAuth<A>(runtime, make: (auth: { options: AuthOptions }) => A, config): () => A` (tek örnek, ilk çağrıda kurulur), `importedPasswords`.
  - `tools/auth.ts`: `authSchemaDiff(m, options, { schema })`, `generateAuthMigration({ db: Management, options, name?, root?, now?, registry? })`.
  - `src/auth.ts`: `AuthRuntime`, `createAuth`, `importedPasswords`, `authTables`, `rateLimitTable`, `twoFactorTables`. CLI: `auth generate <optionsModule> [--name better_auth] [--schema ad]`.

- [ ] **Step 1: Başarısız testler**

`unit/auth.test.ts`:

```ts
import { expect, test } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { createAuth, importedPasswords } from "../../core/auth";
import { authTables, rateLimitTable, twoFactorTables } from "../../core/auth-schema";
import { migrations } from "../../core/migrations/registry";
import { foldTables } from "../../core/sql/tables";

const SECRET = "s".repeat(32);
const runtime = { pools: { primary: { query: async () => [], transaction: async () => undefined } }, schema: "app_x" } as never;

test("createAuth builds the options once: schema-bound adapter, secret, base URL, fixed cookie prefix and database-made ids", () => {
  let made = 0;
  let seen: { options: Record<string, unknown> } | undefined;
  const auth = createAuth(
    runtime,
    (input) => {
      made++;
      seen = input as never;
      return { name: "auth" };
    },
    { secret: SECRET, baseURL: "https://app.example.com" },
  );
  expect(auth()).toBe(auth());
  expect(made).toBe(1);
  expect(seen?.options).toMatchObject({ secret: SECRET, baseURL: "https://app.example.com", advanced: { cookiePrefix: "auth", database: { generateId: false } } });
  expect(seen?.options.basePath).toBeUndefined();
  expect(seen?.options.database).toBeDefined();
});

test("basePath and cookiePrefix are passed through; bad values and short secrets are INVALID_CONFIG up front", () => {
  let seen: { options: Record<string, unknown> } | undefined;
  createAuth(runtime, (input) => (seen = input as never), { secret: SECRET, baseURL: "https://a.example", basePath: "/api/auth", cookiePrefix: "my-app" })();
  expect(seen?.options).toMatchObject({ basePath: "/api/auth", advanced: { cookiePrefix: "my-app" } });
  const make = () => ({});
  for (const bad of [{ secret: "short" }, { cookiePrefix: "Bad Prefix" }, { cookiePrefix: "" }, { basePath: "api/auth" }])
    expect(() => createAuth(runtime, make, { secret: SECRET, baseURL: "https://a.example", ...bad }), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

test("authTables, twoFactorTables and rateLimitTable name tables that the shipped migration really creates, with every mapped column", () => {
  const folded = foldTables(migrations.flatMap((migration) => migration.up.statements)).tables;
  const columns = (table: string) => (folded.get(table) ?? []).map((column) => column.name);
  const tables = authTables();
  for (const model of [tables.user, tables.session, tables.account, tables.verification]) {
    expect(columns(model.modelName), model.modelName).not.toEqual([]);
    for (const column of Object.values(model.fields)) expect(columns(model.modelName), `${model.modelName}.${column}`).toContain(column);
  }
  const twoFactor = twoFactorTables();
  expect(columns(twoFactor.twoFactor.modelName)).toEqual(expect.arrayContaining(Object.values(twoFactor.twoFactor.fields)));
  expect(columns("users")).toContain(twoFactor.user.fields.twoFactorEnabled);
  expect(columns(rateLimitTable().modelName)).toEqual(expect.arrayContaining(["key", "count", Object.values(rateLimitTable().fields)[0] as string]));
  expect(tables.user.fields.emailVerified).toBe("email_verified");
});

test("the shipped auth migration uses database-made uuid ids and snake_case columns", () => {
  const sql = migrations.flatMap((migration) => migration.up.bind("app_x")).join("\n");
  expect(sql).toContain('"app_x".users');
  expect(sql).toContain("gen_random_uuid");
  expect(sql).not.toMatch(/\bcreatedAt\b|\bemailVerified\b/);
});

test("importedPasswords verifies Better Auth scrypt, bcrypt and (on Bun) argon2 hashes, and rejects wrong passwords", async () => {
  const bcrypt = await Bun.password.hash("secret", "bcrypt");
  const argon2 = await Bun.password.hash("secret", "argon2id");
  const scrypt = await hashPassword("secret");
  for (const hash of [scrypt, bcrypt, argon2]) {
    expect(await importedPasswords.verify({ hash, password: "secret" }), hash.slice(0, 7)).toBe(true);
    expect(await importedPasswords.verify({ hash, password: "wrong" }), hash.slice(0, 7)).toBe(false);
  }
  expect((await importedPasswords.hash("secret")).startsWith("$")).toBe(false);
});
```

`unit/auth-adapter.test.ts`: adaptör davranışı (operatörler, where, yazma, uuid anahtarları, transaction) tenant'tan bağımsızdır. `db-multi`'nin `unit/auth.test.ts` dosyasından yalnızca şu beş testi (ve dosya başındaki içe aktarma/yardımcı sabitlerini) alın: `adapter where: operators, …`, `adapter writes: …`, `adapter mapping: …`, `adapter transaction: …`, `adapter uuid keys …`. `adapter mapping` testindeki "students-style" `modelName/fields` eşlemesini yeni `authTables()` + `twoFactorTables()` eşlemesiyle değiştirin (aynı davranış: `generateId: false`, twoFactor tablosu, `incrementOne`); içe aktarmalar `../../core/auth-adapter`; tenant/platform sözcüklerini bekçi bildirir.

`integration/auth.test.ts`:

```ts
/** Better Auth uçtan uca: paketin `auth` migration'ı → `createAuth` → gerçek PostgreSQL; CI drift denetimi aynı seçenek nesnesiyle. */
import { expect } from "bun:test";
import { betterAuth } from "better-auth";
import authOptions from "../fixtures/auth-options";
import { migrations, seeds } from "../../core/migrations/registry";
import { createRunner } from "../../core/migrations/runner";
import { createAuth } from "../../core/auth";
import { createDb } from "../../core/runtime";
import { generateAuthMigration } from "../../core/tools/auth";
import { createTestManagement, directConfig, driver, dropSchema, integration, q, raw, testSchema } from "./helpers";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const SECRET = "integration-secret-integration-secret-1";

async function withAuthSchema(work: (ctx: { schema: string; admin: ReturnType<typeof raw>; m: ReturnType<typeof createTestManagement> }) => Promise<void>) {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema });
  try {
    await createRunner({ migrations, seeds }).migrate(m);
    await work({ schema, admin, m });
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
  }
}

integration("sign up, sign in and a wrong password work against the shipped tables in the configured schema", async () => {
  await withAuthSchema(async ({ schema, admin }) => {
    const db = createDb(directConfig(), { driver, schema, pooler: "assumed" });
    try {
      const auth = createAuth(db, ({ options }) => betterAuth({ ...options, ...authOptions, baseURL: "http://localhost:3000" }), { secret: SECRET, baseURL: "http://localhost:3000" })();
      const email = `${crypto.randomUUID()}@example.com`;
      const signedUp = await auth.api.signUpEmail({ body: { email, password: "correct horse battery", name: "Ada" } });
      expect(signedUp.user.email).toBe(email);
      expect(await admin.query(`SELECT email FROM ${q(schema, "users")}`)).toEqual([{ email }]);
      expect(await admin.query(`SELECT provider_id FROM ${q(schema, "account")}`)).toEqual([{ provider_id: "credential" }]);
      const signedIn = await auth.api.signInEmail({ body: { email, password: "correct horse battery" } });
      expect(signedIn.user.id).toBe(signedUp.user.id);
      await expect(auth.api.signInEmail({ body: { email, password: "wrong password!!" } })).rejects.toBeDefined();
      // Kayıt otomatik oturum açar, giriş ikincisini: iki oturum.
      expect((await admin.query(`SELECT count(*)::integer AS n FROM ${q(schema, "session")}`))[0]).toEqual({ n: 2 });
    } finally {
      await db.close();
    }
  });
});

integration("generateAuthMigration finds no difference between the shipped tables and Better Auth's own schema, and writes a migration for a new field", async () => {
  await withAuthSchema(async ({ m }) => {
    const root = await mkdtemp(join(import.meta.dir, "../../../.tmp-auth-"));
    try {
      expect(await generateAuthMigration({ db: m, options: authOptions, root })).toEqual({ created: false });
      const extended = { ...authOptions, user: { ...authOptions.user, additionalFields: { nickname: { type: "string" as const, required: false } } } };
      const result = await generateAuthMigration({ db: m, options: extended, root, now: new Date(Date.UTC(2026, 9, 4, 1, 2, 3)) });
      expect(result).toMatchObject({ created: true, id: "20261004010203_better_auth" });
      const text = await Bun.file(join(root, (result as { path: string }).path)).text();
      expect(text).toContain("--up");
      expect(text).toContain("nickname");
      expect(text).toContain("--down");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```
`fixtures/auth-options.ts`:

```ts
/** Better Auth seçenekleri (veritabanı hariç): `bun run db:generate:auth src/__tests__/fixtures/auth-options.ts` migration'ı bunlardan
 * üretir; entegrasyon testi ve CI drift denetimi aynı nesneyi kullanır. Uygulama kendi seçenek modülünü verir. */
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { authTables, rateLimitTable, twoFactorTables } from "../../core/auth-schema";

export default {
  emailAndPassword: { enabled: true },
  ...authTables(),
  // Açıkça verilmezse yalnızca production'da açık; tablo temel migration'dadır.
  rateLimit: { storage: "database", ...rateLimitTable() },
  plugins: [twoFactor({ schema: twoFactorTables() })],
} satisfies BetterAuthOptions;
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single
bun test src/__tests__/unit/auth.test.ts 2>&1 | tail -5
```
Expected: `core/auth` yok → **fail**.

- [ ] **Step 3: Kaynaklar**

`core/auth-schema.ts`:

```ts
/** Better Auth tablolarının eşlemesi: snake_case sütunlar, `users` tablosu. Seçeneklere yayılır: `betterAuth({ ...options, ...authTables(),
 * plugins: [twoFactor({ schema: twoFactorTables() })] })`. Veritabanı rate limit'i: `rateLimit: { enabled: true, storage: "database",
 * ...rateLimitTable() }`. Tablolar paketin temel `auth` migration'ındadır. */
const stamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

/** Better Auth `user`, `session`, `account`, `verification` seçenekleri. */
export function authTables() {
  return {
    user: { modelName: "users", fields: { emailVerified: "email_verified", ...stamps } },
    session: { modelName: "session", fields: { expiresAt: "expires_at", ipAddress: "ip_address", userAgent: "user_agent", userId: "user_id", ...stamps } },
    account: {
      modelName: "account",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        ...stamps,
      },
    },
    verification: { modelName: "verification", fields: { expiresAt: "expires_at", ...stamps } },
  };
}

/** `twoFactor({ schema })` eklenti eşlemesi. */
export function twoFactorTables() {
  return {
    user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
    twoFactor: {
      modelName: "two_factor",
      fields: { backupCodes: "backup_codes", userId: "user_id", failedVerificationCount: "failed_verification_count", lockedUntil: "locked_until" },
    },
  };
}

/** Better Auth `rateLimit` seçeneğinin tablo eşlemesi (`storage: "database"`). */
export function rateLimitTable() {
  return { modelName: "rate_limit", fields: { lastRequest: "last_request" } };
}
```

`core/auth.ts`:

```ts
/** Better Auth girişi (`@repo/db-single/auth`): motorun DB havuzu üzerinde kendi Better Auth bağdaştırıcımız (`auth-adapter.ts`), uygulama
 * schema'sına bağlı veritabanı, sabit çerez öneki ve tek örnek. `@repo/db-single` runtime girişi bu modülü yüklemez. */
import type { DBAdapterInstance } from "better-auth";
import { engineAdapter } from "./auth-adapter";
import { AppError } from "./errors";
import type { Db } from "./runtime";

/** `createDb` sonucu: birincil havuz ve schema yeter. */
export type AuthRuntime = Pick<Db, "pools" | "schema">;

/** `make`'e verilen güvenli varsayılanlar; Better Auth seçeneklerine olduğu gibi yayılır. Kimlikleri veritabanı üretir
 * (`uuid DEFAULT gen_random_uuid()`), bu yüzden `generateId: false`. */
export interface AuthOptions {
  database: DBAdapterInstance;
  secret: string;
  baseURL: string;
  basePath?: string;
  advanced: { cookiePrefix: string; database: { generateId: false } };
}

export interface AuthConfig {
  /** Better Auth secret'ı (≥ 32 karakter). */
  secret: string;
  baseURL: string;
  /** Yol öneki (örn. `/api/auth`); verilmezse Better Auth varsayılanı kalır ve alan eklenmez. */
  basePath?: `/${string}`;
  /** Çerez öneki; sabit (tenant yok). Varsayılan `auth`. */
  cookiePrefix?: string;
}

const COOKIE_PREFIX = /^[a-z][a-z0-9-]{0,31}$/;

function requireSecret(secret: string): string {
  if (secret.length < 32) throw new AppError("INVALID_CONFIG", "Better Auth secret must have at least 32 characters");
  return secret;
}

/** bcrypt (`$2a$`, `$2b$`, `$2y$`) ve argon2 (`$argon2id$`, `$argon2i$`, `$argon2d$`) hash'leri: başka uygulamalardan aktarılanlar. */
const FOREIGN_HASH = /^\$(?:2[aby]|argon2(?:id|i|d))\$/;

/**
 * Better Auth `emailAndPassword.password`: yeni parolalar Better Auth scrypt ile hash'lenir; başka uygulamadan aktarılmış bcrypt ve argon2
 * hash'leri `Bun.password` ile doğrulanır, böylece kullanıcılar eski parolalarıyla girer. Bun dışında (Workers, Node) bcrypt `bcryptjs`
 * ile doğrulanır; argon2 yalnızca Bun'da.
 */
export const importedPasswords = {
  hash: async (password: string) => (await import("better-auth/crypto")).hashPassword(password),
  verify: async ({ hash, password }: { hash: string; password: string }) => {
    if (!FOREIGN_HASH.test(hash)) return (await import("better-auth/crypto")).verifyPassword({ hash, password });
    if (typeof Bun !== "undefined") return Bun.password.verify(password, hash);
    if (hash.startsWith("$argon2")) throw new AppError("UNSUPPORTED_PASSWORD_HASH", "Imported argon2 hashes need the Bun runtime");
    // $2y$ (PHP) ile $2b$ aynı algoritmadır.
    return (await import("bcryptjs")).compare(password, hash.replace(/^\$2y\$/, "$2b$"));
  },
};

/**
 * Better Auth örneği: tablolar `"<schema>"."users"` … olarak nitelenir (motorun birincil havuzu üzerinden). Tek örnek ilk çağrıda kurulur ve
 * saklanır; `make` `options`'ı yaymalıdır. Workers'ta istek başına kurun.
 */
export function createAuth<A>(runtime: AuthRuntime, make: (auth: { options: AuthOptions }) => A, { secret, baseURL, basePath, cookiePrefix = "auth" }: AuthConfig): () => A {
  if (!COOKIE_PREFIX.test(cookiePrefix)) throw new AppError("INVALID_CONFIG", "cookiePrefix must be 1-32 characters of a-z, 0-9 and hyphens, starting with a letter");
  if (basePath !== undefined && !basePath.startsWith("/")) throw new AppError("INVALID_CONFIG", "basePath must start with /");
  const options: AuthOptions = {
    database: engineAdapter(runtime.pools.primary, runtime.schema),
    secret: requireSecret(secret),
    baseURL,
    ...(basePath ? { basePath } : {}),
    advanced: { cookiePrefix, database: { generateId: false } },
  };
  let auth: A | undefined;
  return () => (auth ??= make({ options }));
}
```
(Birim testteki `runtime` sahte nesnesinde `engineAdapter` çağrısı `pools.primary`'yi yalnızca saklar; `engineAdapter` çağrı anında sorgu yapmaz.)

`core/auth-adapter.ts`:

```bash
cp ../db-multi/src/core/auth-adapter.ts src/core/auth-adapter.ts
```
Düzenlemeler: `import { quoteIdentifier } from "./identifier";`; `adapterName: "@repo/db-single"`; yorumdaki "tenant"/"jamaster students, teachers" ifadeleri tek-schema anlamıyla yeniden yazılır (`modelName` / `fields` eşlemesinden gelir; schema bağdaştırıcıya `engineAdapter(db, schema)` ile verilir). Davranış değişmez.

`core/tools/auth.ts`:

```bash
cp ../db-multi/src/core/tools/auth.ts src/core/tools/auth.ts
```
Düzenlemeler:
1. Başlık yorumu: "Better Auth schema'sı migration olarak. `authSchemaDiff`: Better Auth tablolarını (`getSchema`) bir schema'nın `information_schema` / `pg_index` bilgisiyle karşılaştırır (CI drift denetimi); schema adı bağlı parametredir, `search_path` kullanılmaz. `generateAuthMigration`: geçici schema'ya paketin migration'larını uygular, farkı yeni `--up/--down` dosyasına yazar …"
2. İçe aktarmalar: `PLATFORM_DATABASE_ID`, `tenantMigrations`, `PLATFORM_SCHEMA` çıkar; ekle: `import type { Connection } from "../driver"; import { quoteIdentifier, validateSchema } from "../identifier"; import { registry as packageRegistry, type Registry } from "../migrations/registry";`.
3. `introspect(db: Pick<Connection, "query">, schema)` (parametre türü sadeleşir); `authSchemaDiff`:

```ts
/** `schema` uygulama schema'sıdır. */
export async function authSchemaDiff(m: Pick<Management, "db">, options: BetterAuthOptions, { schema }: { schema: string }) {
  const existing = await introspect(m.db, validateSchema(schema));
  const plan = planDiff(getSchema(options), existing);
  return { ...plan, sql: createSqlWriter(options)(plan) };
}
```
4. `generateAuthMigration`:

```ts
type GenerateOptions = { db: Management; options: BetterAuthOptions; name?: string; root?: string; now?: Date; registry?: Registry };
export async function generateAuthMigration({ db: m, options, name = "better_auth", root, now, registry = packageRegistry }: GenerateOptions) {
  const schema = `auth_generate_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await m.db.exec(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  try {
    for (const migration of registry.migrations) for (const statement of migration.up.bind(schema)) await m.db.exec(statement);
    const diff = await authSchemaDiff(m, options, { schema });
    // Tip uyuşmazlığı SQL'le otomatik düzeltilemez (veri dönüşümü gerekir): dosya yazmak onu gizlerdi.
    if (diff.typeMismatches.length)
      throw new AppError("INVALID_CONFIG", `Better Auth columns have unexpected types: ${diff.typeMismatches.map((x) => `${x.table}.${x.column} (${x.actual}, expected ${x.expected})`).join(", ")}`);
    if (!diff.sql) return { created: false as const };
    const down = downMigration(diff);
    prepareMigration(diff.sql);
    prepareMigration(down);
    return { created: true as const, ...(await createMigration({ name, root, now, source: `--up\n${diff.sql}\n\n--down\n${down}\n` })) };
  } finally {
    await m.db.exec(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
  }
}
```
(Dosyanın gövdesindeki `ManagementPools` tipi `Pick<Management, "db">` olur; `createMigration({ name, root, now, source })` imzası G2'dendir; `db0`/`platform` sözcüklerini bekçi bildirir.)

`src/auth.ts`:

```ts
/** Better Auth girişi (`@repo/db-single/auth`): Better Auth tabloları uygulama schema'sında (`createAuth`); tablo eşlemesi; başka uygulamadan
 * aktarılmış parola hash'lerinin doğrulanması. */
export { type AuthConfig, type AuthOptions, type AuthRuntime, createAuth, importedPasswords } from "./core/auth";
export { authTables, rateLimitTable, twoFactorTables } from "./core/auth-schema";
```

Temel migration (**CLI ile üretilir**, elle `0000` kimliği yazılmaz):

```bash
bun src/core/cli.ts migration create auth
ls src/migrations/*_auth.sql
```
Çıktıdaki dosyanın içeriğini şununla **değiştirin** (Edit/Write):

```sql
--up
-- Better Auth 1.7.5 tabloları: kullanıcı, oturum, hesap, doğrulama, 2FA ve veritabanı rate limit'i. Sütunlar snake_case, kimlikler veritabanında
-- üretilen uuid. Better Auth eşlemesi `authTables()` / `twoFactorTables()` / `rateLimitTable()` (`@repo/db-single/auth`).
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  email varchar NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image varchar,
  two_factor_enabled boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT session_token_unique UNIQUE (token)
);

CREATE TABLE account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE two_factor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);

-- `rateLimit.storage: "database"`: `key` tekildir (Better Auth eşzamanlı ilk isteği çakışmadan ayırt eder); `last_request` epoch
-- milisaniyesidir, süresi geçen satırlar ona göre silinir.
CREATE TABLE rate_limit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL,
  CONSTRAINT rate_limit_key_unique UNIQUE (key)
);
--down
DROP TABLE rate_limit;
DROP TABLE two_factor;
DROP TABLE verification;
DROP TABLE account;
DROP TABLE session;
DROP TABLE users;
```
Sonra `bun run codegen` (tablo tipleri `src/tables/*.gen.ts` ve `src/migrations/index.gen.ts` güncellenir). `DROP TABLE` deyimleri derleyicide tek tek kabul edilmiyorsa (compiler `DROP … CASCADE` kuralı) her tablo için ayrı `DROP TABLE x;` satırı olarak kalır; derleme hatası verirse mesaj hangi kuralı bildirir: kuralı **gevşetmeyin**, `--down` biçimini derleyicinin kabul ettiği hâle getirin.

`core/cli.ts`:

```ts
  "auth generate": {
    usage: "<optionsModule> [--name better_auth] [--schema ad]",
    summary: "Better Auth seçeneklerinden migration (fark yoksa dosya yazmaz)",
    flags: ["--name", ...SCHEMA_FLAGS],
    run: async ({ app, options }, module) => {
      const { generateAuthMigration } = await import("./tools/auth");
      const { resolve } = await import("node:path");
      const authOptions = (await import(resolve(module))).default;
      return generateAuthMigration({ db: app, options: authOptions, name: options.name });
    },
  },
```

- [ ] **Step 4: Geçiş**

```bash
bun run codegen && bun run codegen --check && bun run typecheck && bun run lint && bun test src/__tests__/unit 2>&1 | tail -5
RUN_INTEGRATION=1 bun test --timeout 120000 src/__tests__/integration/auth.test.ts 2>&1 | tail -6
```
Expected: birim yeşil (`auth` 5, `auth-adapter` 5 test; bekçi temiz); `auth` entegrasyon 2 test **pass**. Better Auth API dönüş şekli (`signUpEmail`/`signInEmail`) sürüm farkı gösterirse testi gerçek 1.7.5 şekline uyarlayın (ledger'a yazın), davranış beklentisini (tablolara yazım, parola doğrulama, yanlış parola reddi) gevşetmeyin.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: Better Auth (schema-bound adapter, createAuth, auth tables mapping), shipped auth migration, auth generate

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Araç girişi, derleme ve Workers uyumu

**Files:**
- Create: `src/tools.ts`, `src/__tests__/fixtures/{worker.ts,wrangler.jsonc}`
- Modify: `package.json` (`build:workers`), `core/cli.ts` (`commandNames` dışa aktarımı)
- Test: yeni `unit/tools-entry.test.ts`

**Interfaces:**
- Consumes: Task 2–6 araçları.
- Produces: `@repo/db-single/tools`: `backupSchema`, `doctor`, `exportAt`, `exportSchema`, `neonApi`, `pruneBackups`, `pullSchema`, `replicaReport`, `restoreSchema`, `safetyPoint`, `stageCopy`; `cli.ts`: `commandNames(): string[]`.

- [ ] **Step 1: Başarısız test**

`unit/tools-entry.test.ts`:

```ts
import { expect, test } from "bun:test";
import { commandNames } from "../../core/cli";
import * as tools from "../../tools";

test("the tools entry exposes the backup, doctor, pull, replica and Neon helpers the CLI wraps", () => {
  expect(Object.keys(tools).sort()).toEqual([
    "backupSchema", "doctor", "exportAt", "exportSchema", "neonApi", "pruneBackups", "pullSchema", "replicaReport", "restoreSchema", "safetyPoint", "stageCopy",
  ]);
});

test("the CLI knows every documented operation", () => {
  expect(commandNames().sort()).toEqual([
    "auth generate", "backup", "backup prune", "doctor", "export", "migrate", "migrate-down", "migration baseline", "migration create", "migration-status",
    "neon export", "neon stage-copy", "pull", "replicas", "restore", "seed", "seed create",
  ]);
});
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single && bun test src/__tests__/unit/tools-entry.test.ts 2>&1 | tail -4
```
Expected: `../../tools` yok / `commandNames` yok → **fail**.

- [ ] **Step 3: Kod**

`src/tools.ts`:

```ts
/** Araç girişi (`@repo/db-single/tools`): seyrek kullanılan işlemler; CLI (`bun run tools`) aynılarını sarar. Runtime ve yönetim girişleri
 * bu modülü yüklemez. */
export { backupSchema, exportSchema, pruneBackups, restoreSchema } from "./core/tools/backup";
export { doctor } from "./core/tools/doctor";
export { exportAt, neonApi, safetyPoint, stageCopy } from "./core/tools/neon";
export { pullSchema } from "./core/tools/pull";
export { replicaReport } from "./core/tools/replicas";
```

`core/cli.ts` içinde `commands` tablosunun hemen altına:

```ts
/** Belgelenen komut adları (belge denetimi ve test için). */
export const commandNames = () => Object.keys(commands);
```

Workers fikstürü:

```bash
cp ../db-multi/src/__tests__/fixtures/wrangler.jsonc src/__tests__/fixtures/wrangler.jsonc
```
`src/__tests__/fixtures/worker.ts`:

```ts
/** Cloudflare Workers uyumluluk doğrulaması (`bun run build:workers`): yalnızca runtime girişini ve postgres.js ile Neon serverless sürücülerini kullanır.
 * Hyperdrive ile kullanan bir Worker için başvuru örneğidir; config ve client istek başına kurulur. Bun SQL bundle'a girmez. */
import { neonDriver } from "../../core/drivers/neon";
import { postgresDriver } from "../../core/drivers/postgres";
import { defineQuery } from "../../core/sql/query";
import { createConfig, createDb } from "../../index";

type Env = Record<string, unknown>;

/** Codegen çıktısı biçiminde (parçalar arasına schema gelir) elle yazılmış okuma sorgusu: bundle'a parser girmez. */
const listUsers = defineQuery(["SELECT id::text AS id, name FROM ", '.users ORDER BY created_at, id LIMIT $1::"pg_catalog"."int4"'], false, true);

/** Hyperdrive binding'i `DB` (`connectionString`); düz string değer de kabul edilir. */
export function workerConfig(env: Env) {
  const value = env.DB;
  const url = typeof value === "string" ? value : (value as { connectionString?: unknown } | undefined)?.connectionString;
  return createConfig(typeof url === "string" ? url : "");
}

/** `DRIVER=neon` Neon serverless sürücüsünü (WebSocket), aksi halde Hyperdrive için postgres.js'i seçer. */
const driverFor = (env: Env) => (env.DRIVER === "neon" ? neonDriver : postgresDriver);

export default {
  async fetch(_request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const db = createDb(workerConfig(env), { driver: driverFor(env), poolMax: 1 });
    try {
      return Response.json(await db.read.query(listUsers, [20]));
    } finally {
      // Sockets cannot outlive the request; close after the response is sent.
      ctx.waitUntil(db.close().catch(() => {}));
    }
  },
};
```
`package.json` betiklerine ekleyin: `"build:workers": "wrangler deploy --dry-run --config src/__tests__/fixtures/wrangler.jsonc"`.

- [ ] **Step 4: Geçiş**

```bash
bun test src/__tests__/unit 2>&1 | tail -4 && bun run typecheck && bun run lint
bun run build 2>&1 | tail -4 && ls dist | head
bun run build:workers 2>&1 | tail -6
git status --short | grep -c dist || true
```
Expected: birim yeşil; `bun run build` `dist/`'e tüm girişleri yazar (`index.js`, `management.js`, `middleware.js`, `tools.js`, `auth.js`, `telemetry.js`, `core/cli.js`, `core/drivers/*.js`); `build:workers` dry-run başarılı ("Total Upload"/"--dry-run: exiting now"); `dist` git'te izlenmez (`.gitignore`).

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: tools entry, command-name export, Workers dry-run fixture

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Kalan entegrasyon testleri ve dört sürücülü tam tarama

**Files:**
- Copy+adapt (`db-multi/src/__tests__/integration/` → `db-single/src/__tests__/integration/`): `drivers`, `pooler`, `client-deadline`, `deadline-matrix`, `neon-driver`, `sql-advanced`, `sql-extensions`, `sql-context-regressions`, `review-regressions`, `middleware`
- Modify: `integration/helpers.ts` (`inSchema`)

**Interfaces:**
- Consumes: G2/G3 tüm modüller; `helpers.ts`.
- Produces: `helpers.inSchema(db: Database, schema: string): <T>(work: (ctx: Queryable) => Promise<T>) => Promise<T>`.

- [ ] **Step 1: Yardımcı ve kopyalar**

`helpers.ts`'e ekleyin (içe aktarmalara `type Queryable, runContext` from `"../../core/context"`):

```ts
/** `db`'de verilen schema'ya bağlı sorgu bağlamı: testlerde `createDb` yerine tek bağlantılı kısa yol (`runContext`). */
export const inSchema = (db: Database, schema: string) => <T>(work: (ctx: Queryable) => Promise<T>) => runContext(db, db, schema, work);
```

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
for t in drivers pooler client-deadline deadline-matrix neon-driver sql-advanced sql-extensions sql-context-regressions review-regressions middleware; do
  cp packages/db-multi/src/__tests__/integration/$t.test.ts packages/db-single/src/__tests__/integration/
done
```

- [ ] **Step 2: Uyarlama kuralları (her dosya için `bun run typecheck` yol gösterir; davranış beklentileri aynen kalır)**

Genel (tüm dosyalar): `createDatabase(…)` → `createDb(…)` (`../../core/runtime`); `directConfig().nodes[0]?.url` → `directConfig().url`; `pooledConfig().nodes[0]?.url` → `pooledConfig().url`; `raw(0)` → `raw()`; `bootstrap(management)` → `createRunner(registry).migrate(management)` (kayıt boş ya da kendi test listesi); PgBouncer konsol URL'si `127.0.0.1:5543/pgbouncer` → `127.0.0.1:5563/pgbouncer`; `tenant_${hex}` schema adları → `testSchema()`; `removeTenants`/`provisionTenant`/`tenantId` kullanan her şey silinir ya da `withSchema` (aşağıda) ile değiştirilir. Tenant/platform/placement sözcüklerini bekçi bildirir; metinleri yeniden adlandırın.

| Dosya | Uyarlama |
|---|---|
| `drivers.test.ts` | Dört sürücünün `createDb` + pooled PgBouncer üzerinden aynı JS değerlerini döndürdüğünü sınar. `createManagement`/`migrateTenant`/`openSession` kullanan blok: `openSession(createTestManagement())` ile oturum kilidi davranışı (doğrudan URL'de açılır, pooled URL'de `DIRECT_CONNECTION_REQUIRED`) olarak korunur; `migrateTenant` çağrısı `createRunner(...).migrate` olur. |
| `pooler.test.ts` | `usesTransactionPooler` (`../../core/pooler`) ve `ready()` beklentileri aynı; `doctor(...)` bloğu `doctor(m, { pooledUrl })` imzasına, çıktı `report.checks.find(...)` ile aranır. |
| `client-deadline.test.ts` | `connect(driver(url, …), { deadlineMs: 250, maxPending: 64 })`, `url = pooledConfig().url`; `testSchema()`. |
| `deadline-matrix.test.ts` | `bootstrap` → `createRunner({ migrations: [], seeds: [] }).migrate(createTestManagement())` (runtime DB varsayılanlarını yazar); URL'ler `.url`. |
| `neon-driver.test.ts` | `directConfig().url`, `raw()`. |
| `sql-advanced.test.ts`, `sql-extensions.test.ts` | `context(db, schema)` ve `createWithTenant` kalkar: `const run = inSchema(db, schema)`; `run("sql-advanced", async (tenant) => …)` → `run(async (tenant) => …)`; `schemaName()` → `testSchema()`. **E3 serial kopya testi** (`copySchema`/`fingerprint` kullanan): şema `createRunner({ migrations: compileMigrations([[id, "--up\n<DDL>\n--down\n…"]]), seeds: [] }).migrate(m)` ile kurulur, `exportSchema` → `dropSchema` → `restoreSchema` ile geri yüklenir ve `row_to_json` dökümü (backup testindeki `dump`) önce/sonra eşit doğrulanır (serial dizisi kaldığı yerden sürer). |
| `sql-context-regressions.test.ts` | `context`/`createWithTenant` → `inSchema`; aralık (`interval`) ve diğer derleme regresyonları aynı. |
| `review-regressions.test.ts` | "database-default server timeouts cancel … lock waits" testi: `LOCK TABLE platform.placements` → bir test schema'sında `CREATE TABLE locked (id integer)` + `LOCK TABLE <schema>.locked IN ACCESS EXCLUSIVE MODE`; bekleyen sorgu `createDb` ile pooled URL'den çalışır ve `DATABASE_TIMEOUT` ya da `55P03` beklentisi aynı kalır; `fingerprint` kullanan test `exportSchema`/`restoreSchema` + `dump` eşitliğine çevrilir. |
| `middleware.test.ts` | `dbMiddleware`/`createDbScope` gerçek PostgreSQL'e karşı: `query`, `transaction`, `read.query` (replica yok → birincil `READ ONLY`), `perRequest` kapanışı, geçersiz seçenek `INVALID_CONFIG`; tenant çözümleme, placement önbelleği, `createUser`/`listUsers` tenant sorguları silinir; bunların yerine test schema'sında `notes` tablosu kullanılır. |

Silinen testler `ledger`'a `Task 8: removed <başlık> — only exercised tenant/platform behavior (R19)` olarak yazılır; her silinen davranışın tek-schema karşılığı yukarıdaki tablo ya da önceki görevlerin testleriyle kapsanmalıdır.

- [ ] **Step 3: Tek sürücüde yeşil**

```bash
cd packages/db-single
bun run typecheck && bun run lint
docker compose -p dbsingle up -d --build --wait postgres pgbouncer wsproxy postgres-rp postgres-rp-replica
bun run test:integration 2>&1 | tail -8
```
Expected: bun sürücüsünde tam entegrasyon paketi **0 fail** (sayıyı ledger'a yazın); leak guard temiz.

- [ ] **Step 4: Dört sürücülü tarama**

```bash
for d in bun postgres pg neon; do echo "== $d"; DB_DRIVER=$d bun run test:integration 2>&1 | tail -4; done
```
Expected: dört çalıştırmanın her biri `0 fail` (aynı test sayısı; Neon yalnızca runtime tarafını sürer, yönetim Bun'dur). Bir sürücüde başarısızlık varsa `systematic-debugging`; testi o sürücü için atlayarak geçmeyin — gerçek sürücü farkıysa nedenini ledger'a `Ruling:` olarak yazın.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add -A packages/db-single && git commit -m "$(cat <<'EOF'
db-single: remaining integration suites adapted (drivers, pooler, deadlines, SQL, review regressions, middleware); full run on four drivers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Belgeler, yürütülebilir belge denetimi ve kök betikler

**Files:**
- Create: `packages/db-single/README.md`, `packages/db-single/docs/{README,getting-started,configuration,queries,migrations-and-seeds,middleware-and-jobs,replicas,auth,cli,operations,providers,errors,telemetry,from-multi}.md`, `src/__tests__/unit/docs.test.ts`
- Modify: kök `package.json` (betikler), kök `README.md`, kök `.gitignore` (`.tmp-*`)

**Interfaces:**
- Consumes: tüm önceki görevler.
- Produces: belgeler ve `docs.test.ts` (R18).

- [ ] **Step 1: Başarısız belge testi**

`unit/docs.test.ts`:

```ts
/** Belgeler yürütülebilir denetimle korunur: göreli bağlantılar çözülür, `docs/cli.md` her komutu adlandırır, `docs/errors.md` kaynaktaki
 * hata kodlarıyla birebir aynıdır, kod örneklerindeki import yolları gerçek `exports` anahtarlarıdır. */
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { dirname, join, resolve } from "node:path";
import { commandNames } from "../../core/cli";

const root = join(import.meta.dir, "../../..");
const read = (path: string) => Bun.file(join(root, path)).text();
const markdown = () => ["README.md", ...[...new Glob("docs/*.md").scanSync({ cwd: root })].sort()];

test("every relative link in the README and docs resolves to a file", async () => {
  const broken: string[] = [];
  for (const file of markdown())
    for (const [, target] of (await read(file)).matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)(?:#[^)]*)?\)/g))
      if (!(await Bun.file(resolve(root, dirname(file), target as string)).exists())) broken.push(`${file} -> ${target}`);
  expect(broken).toEqual([]);
});

test("docs/cli.md has a table row for exactly the commands the CLI knows", async () => {
  const documented = [...(await read("docs/cli.md")).matchAll(/^\| `([a-z][a-z -]*)` \|/gm)].map((match) => match[1] as string).sort();
  expect(documented).toEqual(commandNames().sort());
});

test("docs/errors.md lists exactly the error codes the source throws", async () => {
  const thrown = new Set<string>();
  const source = new Map<string, string>();
  for (const file of new Glob("src/**/*.ts").scanSync({ cwd: root })) {
    if (file.includes("__tests__") || file.endsWith(".gen.ts")) continue;
    const text = await read(file);
    source.set(file, text);
    for (const [, code] of text.matchAll(/new AppError\(\s*"([A-Z][A-Z0-9_]+)"/g)) thrown.add(code as string);
  }
  const documented = new Set([...(await read("docs/errors.md")).matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((match) => match[1] as string));
  expect([...thrown].filter((code) => !documented.has(code)).sort()).toEqual([]);
  // Değişkenle atılan kodlar (ör. DriftCode) kaynakta tırnaklı sabit olarak geçer.
  const everywhere = [...source.values()].join("\n");
  expect([...documented].filter((code) => !everywhere.includes(`"${code}"`)).sort()).toEqual([]);
});

test("import paths in code examples are real package exports", async () => {
  const exportsMap = Object.keys(((await Bun.file(join(root, "package.json")).json()) as { exports: Record<string, string> }).exports);
  const matches = (path: string) => exportsMap.some((key) => key === path || (key.endsWith("/*") && path.startsWith(key.slice(0, -1))));
  const bad: string[] = [];
  for (const file of markdown())
    for (const [, spec] of (await read(file)).matchAll(/from "(@repo\/db-single[^"]*)"/g)) {
      const path = spec === "@repo/db-single" ? "." : `.${(spec as string).slice("@repo/db-single".length)}`;
      if (!matches(path)) bad.push(`${file}: ${spec}`);
    }
  expect(bad).toEqual([]);
});

test("the vocabulary guard has a documented reason: docs/from-multi.md explains why tenants do not exist here", async () => {
  expect(await read("docs/from-multi.md")).toMatch(/tenant/i);
});
```

- [ ] **Step 2: Başarısızlığı gör**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example/packages/db-single && bun test src/__tests__/unit/docs.test.ts 2>&1 | tail -6
```
Expected: `README.md`/`docs/` yok → **fail** (dosya okunamaz).

- [ ] **Step 3: Belgeleri yaz**

Her dosya `packages/db-multi/docs/<aynı ad>.md`'nin **tek-schema yeniden yazımıdır**: önce kopyalayın, sonra tenant/placement/platform/node/`rootDomain`/`withTenant`/`provision`/`move`/`adopt` anlatımlarını silin, API adlarını yeni yüzeye çevirin. Dil Türkçe (mevcut belgelerle aynı). Zorunlu içerik:

- `README.md` (paket kökü): ne olduğu (tek DB, tek schema, klasik yönetilen PostgreSQL), 5 dakikalık başlangıç (`cp .env.example .env`, `docker compose -p dbsingle up -d`, `bun run db:migrate`, ilk sorgu), `createDb` örneği, belge dizini bağlantısı, "çok-tenant ihtiyacı için `db-multi`" tek cümle.
- `docs/README.md`: belge dizini (bu listedeki her dosyaya bağlantı).
- `docs/getting-started.md`: kurulum (kopyala ve devam et), `.env` (`DATABASE_URLS`, isteğe bağlı `DATABASE_REPLICA_URLS` düz URL listesi), doğrudan URL ve pooler URL ayrımı, ilk migration/seed/sorgu, `createDb({ schema })`, `db.ready()`.
- `docs/configuration.md`: `createDb` ve `createManagement` seçenekleri ve sınırları tablosu (config.ts `RUNTIME_LIMITS`/`MANAGEMENT_LIMITS` ile aynı değerler), `pooler: "verified|assumed"`, `replicaOnUnavailable`, timeout'ların DB varsayılanı olarak yazılması (R9), `--schema` bayrağı.
- `docs/queries.md`: `db-multi/docs/queries.md`'nin SQL alt kümesi bölümleri (E1/E2/E3 dahil) olduğu gibi; kapsam/tenant bağlama anlatımı yerine `src/queries/<alan>.sql` → `@repo/db-single/queries/<alan>`; `prepareQuery(source, tables?)`; `PreparedQuery = { bind(schema), readOnly, requiresTransaction }`.
- `docs/migrations-and-seeds.md`: dosya biçimi (`--up`/`--down`, UTC kimlik), `_migrations`/`_seeds` ledger'ları, CONCURRENTLY index, drift, baseline, geri alma, seed (SQL ve TS, `SeedContext`), tek advisory lock ve `MIGRATION_RUNNER_BUSY`, `pull` → `baseline` akışı.
- `docs/middleware-and-jobs.md`: `dbMiddleware` (Bun, Workers `perRequest`), `createDbScope`, istek kapsamında read-your-writes ve replica sabitleme, cron/kuyruk için `createDb`.
- `docs/replicas.md`: `DATABASE_REPLICA_URLS`, `db.read.query`, `readOnly` sorgular, ilkeler (`primary`/`error`), lag eşiği, `db.replicas()` raporu, `replicas` komutu, `--from-replica`.
- `docs/auth.md`: `createAuth`, `authTables()`, `twoFactorTables()`, `rateLimitTable()`, temel `auth` migration'ı, `importedPasswords`, `auth generate` ve CI drift denetimi, Workers notu, sürüm 1.7.5 kuralı.
- `docs/cli.md`: tablo `| \`komut\` | kullanım | açıklama |` (her komut bir satır; `docs.test.ts` ilk sütunu okur), seçenekler, çıkış kodları, gizli girişler.
- `docs/operations.md`: `doctor`, `backup`/`export`/`restore` (R11/R12, `public` ve eklenti nesneleri notu, `UNSUPPORTED_SCHEMA`), pooler zorunluluğu, kapanış, ölçüm.
- `docs/providers.md`: Neon/Supabase/RDS tablosu (db-multi'nin `providers.md` doğrulama durumu satırları **olduğu gibi** korunur: `verified`/`unverified` durumu bu pakette yeniden ölçülmediyse `unverified (db-multi ile aynı sürücü, db-single'da ölçülmedi)` yazın), `verify:provider` kullanımı (tek URL), `neon stage-copy`/`neon export`/`migrate --safety-point`, Supabase PITR notu.
- `docs/errors.md`: tablo `| \`KOD\` | anlamı | ne yapılır |`; `docs.test.ts` ilk sütunu okur ve kaynaktaki `new AppError("KOD"` literalleriyle birebir karşılaştırır (değişkenle atılan `MIGRATION_DRIFT`/`SEED_DRIFT` kaynakta tırnaklı geçtiği için belgede de bulunur).
- `docs/telemetry.md`: `onSpan`, `Span` alanları (name/startTime/ms/error/detail), `db.acquire`/`db.query`/`db.transaction`/`migration`/`seed`/`backup` adları, OpenTelemetry/Sentry bağdaştırıcıları.
- `docs/from-multi.md`: bu paketin neden tenant/placement/platform kavramı taşımadığı (tek DB, tek schema; `db-multi` ayrı pakettir), iki paket arasında **otomatik geçiş aracı yoktur**, tam kopya kararının bedeli (derleyici/sürücü düzeltmeleri iki yerde), hangi `db-multi` özelliklerinin burada olmadığı (spec "Silinenler" listesi) ve nedenleri. Bu dosya `tenant` sözcüğünü bilerek içerir.

Kök dosyalar:

```json
    "single": "bun run --cwd packages/db-single",
    "single:migrate": "bun run --cwd packages/db-single db:migrate",
    "single:rollback": "bun run --cwd packages/db-single db:rollback",
    "single:status": "bun run --cwd packages/db-single db:status",
    "single:seed": "bun run --cwd packages/db-single db:seed",
    "single:generate": "bun run --cwd packages/db-single db:generate",
    "single:codegen": "bun run --cwd packages/db-single db:codegen",
    "single:pull": "bun run --cwd packages/db-single db:pull"
```
(kök `package.json` `scripts`'ine, `db:*` betiklerinin ardına). Kök `README.md`: iki paketi anlatır (`packages/db-multi` çok-tenant, `packages/db-single` tek DB), "kopyala ve devam et" ikisi için geçerli. Kök `.gitignore`'a `.tmp-*` satırı.

- [ ] **Step 4: Geçiş**

```bash
bun test src/__tests__/unit 2>&1 | tail -5 && bun run typecheck && bun run lint
cd ../.. && bun run single --help 2>&1 | head -3 && bun run single:status --help 2>&1 | head -2
```
Expected: birim yeşil (`docs` 5 test pass; bekçi `src/` altında temiz); kök betikler CLI yardımını gösterir.

- [ ] **Step 5: Commit**

```bash
git add -A packages/db-single package.json README.md .gitignore && git commit -m "$(cat <<'EOF'
db-single: README and docs with an executable docs check, root scripts, .tmp-* ignored

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Kabul ölçütlerinin kanıtı

**Files:**
- Modify: `docs/superpowers/specs/2026-10-03-db-roadmap-design.md` (G satırı durumu), `docs/superpowers/specs/2026-10-04-db-single-design.md` (durum satırı)

**Interfaces:** yok (yalnızca doğrulama ve rapor).

- [ ] **Step 1: Spec'in beş kabul ölçütü**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example

# (1) db-multi davranışı değişmedi: birim 367, tam entegrasyon 147 (yalıtılmış compose; portlar boş doğrulanmış olmalı)
bun run --cwd packages/db-multi test 2>&1 | tail -4
git log --format=%s -- packages/db-multi | grep -c '^db-single:' || true     # 0 olmalı
(cd packages/db-multi && docker compose -p dbmulti up -d --wait postgres-0 postgres-1 pgbouncer wsproxy postgres-rp postgres-rp-replica \
  && bun src/core/cli.ts bootstrap >/dev/null \
  && RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration 2>&1 | tail -4 \
  ; docker compose -p dbmulti down -v --remove-orphans)

# (2) db-single birim ve entegrasyon, dört sürücüde
bun run --cwd packages/db-single test 2>&1 | tail -4
(cd packages/db-single && docker compose -p dbsingle up -d --build --wait postgres pgbouncer wsproxy postgres-rp postgres-rp-replica \
  && for d in bun postgres pg neon; do echo "== $d"; DB_DRIVER=$d bun run test:integration 2>&1 | tail -3; done)

# (3) çok-tenant sözcüğü yalnızca belgede (kaynakta ve manifestlerde yok)
grep -rniE "tenant|placement|platform" packages/db-single/src packages/db-single/package.json packages/db-single/compose.yaml packages/db-single/.env.example | grep -v "no-multi-tenant.test.ts" | wc -l
grep -rliE "tenant|placement|platform" packages/db-single/README.md packages/db-single/docs

# (4) db-multi'ye bağımlılık yok
grep -rnE "db-multi|@repo/db([^-]|$)" packages/db-single/src packages/db-single/package.json | wc -l
grep -c "db-multi" packages/db-single/package.json || true

# (5) kaynak satır sayıları (testler ve üretilmiş dosyalar hariç)
for p in db-multi db-single; do printf "%s: " $p; find packages/$p/src -name '*.ts' -not -path '*/__tests__/*' -not -name '*.gen.ts' | xargs wc -l | tail -1; done

bun run --cwd packages/db-single typecheck && bun run --cwd packages/db-single lint && bun run --cwd packages/db-single codegen --check && echo static-ok
```
Expected: (1) db-multi birim `367 pass`, `0`, entegrasyon `147 pass`; (2) db-single birim yeşil ve dört sürücüde `0 fail`; (3) ilk komut `0`, ikinci komut yalnızca `docs/from-multi.md` (ve açıklama notu içeren belgeler) listeler; (4) iki sayı `0`; (5) iki satır sayısı. `static-ok` yazılır.

- [ ] **Step 2: Rapor ve durum güncellemesi**

Ledger'a yazın: (1)–(5) çıktıları, `db-single` / `db-multi` kaynak satır oranı, hedef sayısı sözü olmadığı için **ulaşılamadıysa neden** (spec ölçüt 5). Spec'in başlık durumunu "uygulandı (G1–G3)" yapın ve roadmap tablosundaki G satırının durum sütununu güncelleyin (Edit).

- [ ] **Step 3: Altyapıyı kapat ve commit**

```bash
(cd packages/db-single && docker compose -p dbsingle down -v --remove-orphans)
docker ps --format '{{.Names}}' | grep -cE '^(dbsingle|dbmulti)' || true
git add -A docs && git commit -m "$(cat <<'EOF'
docs: sub-project G acceptance recorded (db-multi unchanged, db-single green on four drivers, source size compared)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```
Expected: `0` kalan konteyner; commit tamam. Ardından executing-plans'ın "Final Review" adımı (tüm dalın taze, en yetenekli modelle incelemesi) çalıştırılır; bu görevin parçası değildir.
