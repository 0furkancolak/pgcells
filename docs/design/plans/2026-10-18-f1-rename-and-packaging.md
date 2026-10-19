# F1: yeniden adlandırma ve paketleme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Depoyu `pgcells` olarak yeniden adlandırmak, jamaster'a özgü araçları çekirdekten ayırmak, paketleri Bun, Node 22 ve Workers tüketicilerine kurulabilir derlenmiş paketler olarak yayına hazırlamak, topluluk/yayın dosyalarını eklemek ve kod/belge dilini İngilizceye çevirmek.

**Architecture:** Kalıcı tanımlayıcılar (ledger özetleri, kilit anahtarları, HKDF tuzu, pull işaretçisi) önce altın dosya testiyle kilitlenir, sonra adlandırma toplu ve otomatik yapılır; derleme `bun build --target node` ile (Bun'ın `with { type: "text" }` SQL importlarını dizgeye gömmesi sayesinde codegen çıktısı değişmez); jamaster araçları `presets/jamaster/` altına taşınır ve yayından dışlanır.

**Tech Stack:** Bun 1.3.14+ (CI) / 1.4.x (yerel), TypeScript 5.9, `bun build`, `tsc --emitDeclarationOnly`, Changesets, GitHub Actions, Node 24 (duman testi).

**Spec:** [`../specs/2026-10-18-pgcells-oss-regions-design.md`](../specs/2026-10-18-pgcells-oss-regions-design.md) (D1–D6, D12, D14, D19); üst plan: [`2026-10-18-oss-packaging-plan.md`](2026-10-18-oss-packaging-plan.md) P0–P7.

## Global Constraints

- Ad: depo/org `pgcells`; paketler `@pgcells/multi`, `@pgcells/single`, `@pgcells/redis`; `@pgcells/e2e` özel (yayınlanmaz). Dizinler (`packages/db-multi`, `db-single`, `redis`, `e2e`) **kalır** (P1.1 kararı).
- Lisans Apache-2.0; belge dili İngilizce kanonik, `README.tr.md` Türkçe (D2, D3).
- **Donmuş (D14), değiştirilmeyecek:** paketle gelen `src/migrations/**/*.sql` ve `src/seeds/**` dosyalarının bayt içeriği (ledger SHA-256); HKDF tuzu `"@repo/db/auth"` (`core/auth.ts`); `pullMarker` metni `-- @repo/db pull structure=…` (`core/migrations/source.ts`); `adapterName: "@repo/db"` / `"@repo/db-single"`; advisory lock anahtarları (`tenant-placement`, `platform-bootstrap`, `migration-runner`, `tenant-operation:<id>`, `tenant-management:<id>`); `platform.*` sütun adları; hata kodları. Çeviri bu dosyalara ve dizgelere dokunmaz.
- **D19 düzeltmesi (keşfedildi):** `core/cli.ts`, `core/sql/codegen.ts`, `core/tools/fetch-dump.ts`, `core/drivers/bun.ts` Bun API'lerini (`Bun.file/write/spawn`, `Glob`, `SQL`) kullanır. v0.1'de **çalışma zamanı girişleri** (`.`, `./middleware`, `./auth`, `./telemetry`, `./drivers/pg|postgres|neon`) Node 22 ve Workers'ta çalışır; **yönetim, araçlar, CLI, codegen Bun ister** (`engines.bun`, belgede açık). Node'da çalışan CLI v0.2 işidir.
- Yeni ortam değişkeni yok. Yeni `search_path` yok. Migration/seed dosyaları yalnızca CLI ile üretilir (bu plan onlara dokunmaz).
- Git: özellik dalı `oss/f1-pgcells`, **aşama (görev) başına tek yerel commit**, push/PR yok. Commit sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Doğrulama komutları (taban çizgisi): birim testleri `--timeout 60000` ile çalıştırılır (yerel diskte CLI-spawn testleri 5 sn'yi aşıyor: taban çizgisinde 8+1 zaman aşımı, 30 sn'de hepsi geçiyor); Docker olan işlerde entegrasyon.

## Review Focus

1. Uygulanmış migration/seed dosyası bir baytı bile değişirse ledger'lı kurulumlarda `MIGRATION_DRIFT` olur → altın dosya testi (T1) her görevden sonra çalışır.
2. Toplu `@repo/` → `@pgcells/` değişimi HKDF tuzunu veya `pullMarker`'ı değiştirirse mevcut oturum çerezleri/2FA secret'ları geçersizleşir → T1 testi ve T2'de dışlama listesi.
3. Derlenmiş paket tarball'ı test/benchmark/sonuç JSON'u taşırsa veya `exports` yolu `dist`'te yoksa tüketici kurulumu kırılır → T6 `npm pack` içerik denetimi ve temiz dizinde import.
4. `workspace:*` bağımlılığı (`redis` → `multi`) paketlenince sürüme çevrilmezse `npm i` başarısız olur → T6 duman testi `redis` tarball'ını da kurar.
5. Çalışma zamanı girişi dolaylı olarak `bun` modülünü çekerse Node/Workers'ta açılışta patlar → T5 Node 24'te her çalışma zamanı girişini import eden test.

---

### Task 1: Dal ve kalıcı tanımlayıcı koruması

**Files:**
- Create: `packages/db-multi/src/__tests__/unit/frozen-identifiers.test.ts`, `packages/db-multi/src/__tests__/unit/frozen-identifiers.golden.json`
- Create: `packages/db-single/src/__tests__/unit/frozen-identifiers.test.ts`, `packages/db-single/src/__tests__/unit/frozen-identifiers.golden.json`

**Interfaces:**
- Produces: her pakette altın dosya `{ files: Record<relativePath, sha256hex>, needles: { file: string; text: string }[] }`; test adları aşağıdadır. Sonraki görevler bu testi değişmeden geçirmek zorundadır.

- [ ] **Step 1: Dalı aç** — `git switch -c oss/f1-pgcells` (çalışma ağacında yeni belgeler untracked; ilk commit onları da alır).
- [ ] **Step 2: Altın dosyayı üret** — tek seferlik betikle (commit edilmez) `src/migrations/**/*.sql` ve `src/seeds/**/*` (gen dosyaları hariç) yollarının SHA-256'sını `files` alanına yaz; `needles`: db-multi için `core/auth.ts` → `salt: text.encode("@repo/db/auth")`, `core/auth-adapter.ts` → `adapterName: "@repo/db"`, `core/migrations/source.ts` → ``-- @repo/db pull structure=``, `core/tenants/placement.ts` → `hashtextextended('tenant-placement',0)`, `core/operations/bootstrap.ts` → `hashtextextended('platform-bootstrap',0)`, `core/operations/locks.ts` → `hashtextextended($1,0)`; db-single için `core/auth-adapter.ts` → `adapterName: "@repo/db-single"` ve `core/locks.ts` → `hashtextextended($1,0)`.
- [ ] **Step 3: Testi yaz** — iki test: `"applied migration and seed files keep their exact bytes"` (golden `files` ile diskteki özetler birebir eşit; dosya eklenmesi serbest, eksilme/değişme hata) ve `"persisted strings are still present in source"` (her `needle` ilgili dosyada `includes`).
- [ ] **Step 4: Çalıştır** — `cd packages/db-multi && bun test src/__tests__/unit/frozen-identifiers.test.ts` ve db-single'da aynısı. Beklenen: PASS (rename öncesi durum doğru kilitlendi).
- [ ] **Step 5: Commit** — `git add docs README.md README.tr.md packages/*/src/__tests__/unit/frozen-identifiers.*` ; `git commit -m "docs: pgcells design, guides and plans; test: freeze persisted identifiers"`.

### Task 2: `@repo/*` → `@pgcells/*`

**Files:**
- Modify: `package.json` (kök: `name: "pgcells-monorepo"`), `packages/{db-multi,db-single,redis,e2e}/package.json`, `bun.lock` (yeniden üretilir), `.github/workflows/checks.yml`, `packages/*/src/**` (import yolları), `packages/*/docs/**`, `packages/*/README.md`, `packages/e2e/**`, `packages/db-single/src/__tests__/unit/docs.test.ts` (satır 62: `"@repo/db-single"` → yeni ad).
- Dışla: `docs/design/**` (tarihçe), `packages/db-multi/src/migrations/**`, `packages/db-single/src/migrations/**`, ve Task 1'deki dört dizge.

**Interfaces:**
- Produces: paket adları `@pgcells/multi`, `@pgcells/single`, `@pgcells/redis`, `@pgcells/e2e`. Eşleme tablosu: `@repo/db-multi`→`@pgcells/multi`, `@repo/db-single`→`@pgcells/single`, `@repo/redis`→`@pgcells/redis`, `@repo/e2e`→`@pgcells/e2e`. `@repo/db` (adsız, tarihçe) yalnızca dışlananlarda kalır.

- [ ] **Step 1: Başarısız denetimi yaz** — `scripts/check-no-legacy-scope.sh` (commit edilir; CI'ya girer): `grep -rnE "@repo/" . --exclude-dir={node_modules,.git,dist} | grep -vE "docs/design|src/migrations|@repo/db/auth|@repo/db pull|adapterName"` çıktısı boş değilse çıkış 1. Şimdi çalıştır: FAIL (modül adları listelenir).
- [ ] **Step 2: Değişimi uygula** — dışlama kurallarına uyan `sed` ile dört eşlemeyi uygula; `adapterName` ve HKDF satırlarına dokunma; `sql-dump.ts` şablonundaki `@repo/db-multi/tools` yeni ada döner (T3'te taşınacak).
- [ ] **Step 3: Kilidi yenile** — `bun install` (workspace adları değişti); `git diff --stat bun.lock` yalnızca ad/çalışma alanı satırları.
- [ ] **Step 4: Doğrula** — `bash scripts/check-no-legacy-scope.sh` PASS; `bun run codegen --check` (db-multi) ve `bun run db:codegen --check` (db-single) PASS (üretilmiş dosyalar kendi import adlarını taşıyorsa yeniden üret: `bun run codegen`); `bun run typecheck && bun run lint` üç pakette; frozen testi PASS; birim testleri `--timeout 60000` PASS.
- [ ] **Step 5: Commit** — `git commit -am "refactor: rename packages to @pgcells/*"` (yeni `scripts/` dahil).

### Task 3: Jamaster'a özgü araçları ayır (D12)

**Files:**
- Move (`git mv`) → `presets/jamaster/src/`: `core/tools/{adopt,app-migration,import-users,platform-merge,platform-move,sql-dump,fetch-dump}.ts` ve `core/tools/schema-references.ts` (yalnızca bu araçlar kullanıyorsa; başka kullanıcı varsa kalır), ilgili testler (`__tests__/unit|integration/{adopt,app-migration,import-users,mark-applied,platform-merge,platform-move?,fetch-dump,sql-dump}*.test.ts`), `packages/db-multi/docs/{jamaster-api,jamaster-migration,data-import}.md` → `presets/jamaster/docs/`.
- Modify: `packages/db-multi/src/tools.ts` (taşınan dışa aktarımları kaldır), `packages/db-multi/src/core/cli.ts` (komutlar `adopt plan|apply|rollback`, `platform-move plan|apply`, `import-users`/`users import`, `dump split|fetch|scaffold`, `app-migrate` kaldırılır; `--help` ve `docs/cli.md` güncellenir), `packages/db-multi/docs/*.md` ve `README.md` (bağlantılar), `packages/db-multi/package.json` (`bin` yok değişir).
- Create: `presets/jamaster/package.json` (`private: true`, `name: "@jamaster/pgcells-preset"`, bağımlılık `@pgcells/multi: workspace:*`), `presets/jamaster/README.md` ("bu klasör özel jamaster-api deposuna taşınmak üzere ayrıştırıldı; yayına girmez"), kök `package.json` `workspaces: ["packages/*", "presets/*"]`.

**Interfaces:**
- Consumes: Task 2 adları. Taşınan kod çekirdeğe önce `@pgcells/multi/*` genel alt yollarıyla, bu yetmezse repo-göreli derin içe aktarmayla (`../../../packages/db-multi/src/core/...`) bağlanır (özel klasör, yayınlanmaz).
- Produces: `@pgcells/multi/tools` yalnızca `backupAll, exportTenant, pruneBackups, restoreTenant, getMove, resumeMove, rollbackMove, startMove, replicaReport, listDatabases, listReservedTenantIds, releaseTenantIds, reserveTenantIds, setDatabase` dışa aktarır.

- [ ] **Step 1: Bağımlılık envanteri** — `rg -l "tools/(adopt|app-migration|import-users|platform-merge|platform-move|sql-dump|fetch-dump|schema-references)" packages` ile çekirdek kodun taşınacak dosyalara bağımlılığını listele; çekirdekte kalması gereken ortak yardımcı varsa (ör. `tools/jsonl.ts`, `schema-references.ts`) yerinde bırak.
- [ ] **Step 2: Başarısız test** — `packages/db-multi/src/__tests__/unit/public-surface.test.ts`: `"tools entry exports only the generic operations"` (`Object.keys(await import("../../tools")).sort()` yukarıdaki listeyle eşit) ve `"cli has no jamaster commands"` (`cli.ts` komut tablosunda `adopt`, `platform-move`, `import-users`, `dump`, `app-migrate` anahtarları yok). Çalıştır: FAIL.
- [ ] **Step 3: Taşı** — `git mv` ile dosyaları taşı; `cli.ts` ve `tools.ts`'ten kaldır; çekirdekte bu araçlara kalan referansları sil.
- [ ] **Step 4: Preset'i derlet** — `cd presets/jamaster && bun test` (taşınan testler; entegrasyon testleri `RUN_INTEGRATION=1` ister, birim testleri burada çalışır); import yollarını düzelt.
- [ ] **Step 5: Hata kodu koruması** — `packages/db-multi/src/__tests__/unit/frozen-identifiers.test.ts`'e `"no error code of the core is removed"` ekle: kaynakta `new AppError("CODE"` ile bulunan kodlar kümesi altın `errorCodes` listesinin üst kümesi (altın liste taşıma sonrası mevcut kümeden üretilir).
- [ ] **Step 6: Doğrula** — `bun run typecheck && bun run lint && bun run test -- --timeout 60000` (db-multi); frozen testi; `rg -il "adopt|platform-move" packages/db-multi/docs` yalnızca açıklayıcı tarihî notlar.
- [ ] **Step 7: Commit** — `git commit -am "refactor: move jamaster-specific tools and docs to presets/jamaster"`.

### Task 4: Belge düzeni ve jamaster ifadelerinin temizliği

**Files:**
- Move: `docs/design/` → `docs/design/` (`specs/`, `plans/`); düzelt: `README.md`, `README.tr.md`, `docs/guides/*.md`, `docs/design/**` içindeki `docs/design` bağlantıları ve `.gitignore`/workflow yolları.
- Create: `docs/design/README.md` (dizin: her spec/plan için durum satırı: eski planlar "implemented"; 2026-10-18 belgeleri "approved / in progress").
- Modify (genelleştir): jamaster geçen, **donmuş olmayan** dosyalar: `packages/db-multi/src/core/{auth-adapter,auth-schema,auth,cli}.ts`, `operations/bootstrap.ts`, `tenants/{fields,model}.ts`, `src/middleware.ts`, `packages/db-multi/README.md`, `docs/*.md` (auth, cli, configuration, errors, getting-started, middleware-and-jobs, migrations-and-seeds, operations, performance, telemetry, tenants, README), `packages/redis/**` (README, docs, `auth-storage.ts`, test), `packages/db-single/docs/from-multi.md`; ifade: "jamaster" → "an existing application" / "the migrating application" veya örneklerde `example.com`. Donmuş SQL/seed dosyaları ve `docs/design/**` tarihçesi dokunulmaz.

- [ ] **Step 1: Başarısız denetim** — `scripts/check-wording.sh`: `grep -rniE "jamaster" . --exclude-dir={node_modules,.git,dist,presets} | grep -vE "docs/design|src/migrations|src/seeds|CHANGELOG"` boş değilse 1. Çalıştır: FAIL.
- [ ] **Step 2: `git mv docs/design docs/design`**, bağlantıları düzelt; `rg "docs/design"` boş.
- [ ] **Step 3: İfadeleri genelleştir** — yalnızca yorum/belge/örnek metni; kod davranışına dokunma; `tenantOf` örneği gibi jamaster'a özgü örnekler genel alan adına çevrilir (`example.com`).
- [ ] **Step 4: Doğrula** — iki denetim betiği PASS; `typecheck`, `lint`, birim testleri, frozen testi PASS; bağlantı denetimi (kök README ve kılavuzlardaki göreli bağlantılar: tek seferlik python betiği).
- [ ] **Step 5: Commit** — `git commit -am "docs: move design history to docs/design, drop jamaster wording from core"`.

### Task 5: Derleme hattı ve yayınlanabilir `package.json`

**Files:**
- Create: `packages/db-multi/tsconfig.build.json`, `packages/db-single/tsconfig.build.json`, `packages/redis/tsconfig.build.json`, `scripts/build-package.ts` (ortak: giriş listesi → `bun build` + `tsc -p tsconfig.build.json`), `packages/*/src/__tests__/unit/node-runtime-entries.test.ts` (Node alt süreciyle import).
- Modify: `packages/{db-multi,db-single,redis}/package.json` (`private` kalkar; `exports`, `files`, `bin`, `engines`, `sideEffects`, `publishConfig`, `repository`, `bugs`, `homepage`, `keywords`, `license`, `scripts.build` ve `scripts.prepack`), `.gitignore` (`dist/` zaten).

**Interfaces:**
- Consumes: Task 3 sonrası `tools.ts` yüzeyi.
- Produces: `dist/` düzeni: giriş başına `dist/<yol>.js` + `dist/<yol>.d.ts`; `exports` anahtarları: `"."`, `"./management"`, `"./middleware"`, `"./tools"`, `"./auth"`, `"./telemetry"`, `"./drivers/*"`, `"./queries/*"`, `"./tables/*"` (her biri `{ types, default }`); `bin: { "pgcells": "./dist/core/cli.js" }` (shebang `#!/usr/bin/env bun`). Node-güvenli girişler: `.`, `./middleware`, `./auth`, `./telemetry`, `./drivers/pg|postgres|neon`, `./queries/*`, `./tables/*`; Bun gerektirenler: `./management`, `./tools`, `./drivers/bun`, `bin`.

- [ ] **Step 1: Spike** — `bun build src/index.ts src/middleware.ts src/auth.ts src/telemetry.ts src/core/drivers/pg.ts --target node --format esm --splitting --outdir /tmp/spike --external pg --external postgres --external better-auth --external @neondatabase/serverless`; `node -e "import('/tmp/spike/index.js')"` ve her giriş için aynısı. Beklenen: hata yok; `.sql` metinleri dizge olarak gömülü. Bulgu bir girişin `bun` modülünü çektiğini gösterirse o girişi Bun-gerektirenler listesine al ve belgele (karar kaydı plan sonuna).
- [ ] **Step 2: Başarısız test** — `node-runtime-entries.test.ts`: `"every node-safe entry of dist imports under node"` (testten önce `bun run build` çalıştırılmış varsayımı: `beforeAll` build'i tetikler; `Bun.spawn(["node", "--input-type=module", "-e", "await import('<dist>/index.js')"])` ve diğer girişler, çıkış kodu 0; `management.js` için çıkış kodunun `bun` modülü yüzünden 0 olması **beklenmez**, test bu girişleri atlar ve `package.json` `exports` anahtarlarının listesiyle belgedeki Bun-gerektirenler listesinin eşleştiğini sınar). Çalıştır: FAIL (build yok).
- [ ] **Step 3: `scripts/build-package.ts`** — imza `async function build(pkgDir: string, entries: string[], external: string[]): Promise<void>`: `dist/`'i temizler, `bun build … --target node --format esm --splitting`, ardından `tsc -p tsconfig.build.json --emitDeclarationOnly --outDir dist` (`noEmit:false`, `declaration:true`, `include: ["src/**/*.ts"]`, `exclude: ["src/__tests__/**"]`); `queries/*`/`tables/*` girişlerini glob'la ekler. Her paketin `scripts.build` bunu çağırır; mevcut `build` (Bun hedefli doğrulama) `build:check` olur.
- [ ] **Step 4: `package.json` alanları** — yukarıdaki arayüz; `files: ["dist","README.md","LICENSE","docs"]` (docs dahil: kullanıcı belgeleri paketle gelir), `engines: { "bun": ">=1.3.14", "node": ">=22" }`, `publishConfig: { "access": "public", "provenance": true }`, `repository: { "type": "git", "url": "git+https://github.com/pgcells/pgcells.git", "directory": "packages/<ad>" }`, `license: "Apache-2.0"`, `peerDependencies` aynı. `redis`'te `@pgcells/multi` `workspace:*` kalır (paketlerken sürüme çevrilir).
- [ ] **Step 5: Çalıştır** — `bun run build && bun test src/__tests__/unit/node-runtime-entries.test.ts` PASS; `node` ile `createConfig(["postgres://u:p@h/db"])` çağrısı çalışır (tek satır doğrulama); `bunx tsc -p tsconfig.build.json` hatasız.
- [ ] **Step 6: Commit** — `git commit -am "build: publishable ESM + d.ts builds and package manifests"`.

### Task 6: Paket duman testi ve CI

**Files:**
- Create: `scripts/smoke-pack.sh`, `docs/design/` karar notu (Task 5 bulguları).
- Modify: `.github/workflows/checks.yml` (yeni iş `pack-smoke`, adımlar `check-no-legacy-scope`, `check-no-jamaster`; mevcut işlerde yol/ad güncellemesi; Bun 1.3.14 sabit kalır; Node 22 kurulum adımı).

**Interfaces:**
- Consumes: Task 5 `dist` ve `exports`.

- [ ] **Step 1: Betik** — `scripts/smoke-pack.sh`: her paket için `bun pm pack --destination $TMP/tarballs` (workspace bağımlılıkları sürüme çevrilir); `tar -tzf` çıktısında `__tests__`, `bench`, `results`, `.env`, `src/` **yok** denetimi; temiz `$TMP/app` dizininde `npm init -y && npm i <multi.tgz> <redis.tgz> pg postgres` (Node), sonra `node smoke.mjs` (`createConfig`, `tenantFromHost`, `createDatabase` yapılandırması `pgDriver` ile, bağlanmadan) ve `bun smoke.ts` (aynı + `@pgcells/multi/management` import'u); `npx tsc --noEmit smoke-types.ts` ile tür çözümlemesi.
- [ ] **Step 2: Çalıştır** — `bash scripts/smoke-pack.sh`. Beklenen: PASS. İlk koşuda başarısızsa nedeni düzelt (eksik `files`, yanlış `exports`).
- [ ] **Step 3: CI** — `pack-smoke` işi: checkout, Bun 1.3.14, Node 22, `bun install --frozen-lockfile`, `bun run --cwd packages/db-multi build`, diğer paketler, `bash scripts/smoke-pack.sh`.
- [ ] **Step 4: Commit** — `git commit -am "ci: pack smoke test across bun and node, scope and wording guards"`.

### Task 7: Topluluk, lisans ve yayın dosyaları

**Files:**
- Create: `LICENSE` (Apache-2.0 tam metin; çalışma alanında bulunan bir Apache-2.0 kopyasından alınır, ağ indirmesi yapılmaz), `NOTICE` (`pgcells` + telif satırı), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, uygulama kanalı: GitHub özel güvenlik bildirimi/maintainer profili), `SECURITY.md` (GitHub private vulnerability reporting; desteklenen sürümler tablosu `0.x`), `.github/ISSUE_TEMPLATE/{bug,feature}.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS` (`* @0furkancolak`), `.github/dependabot.yml` (npm + github-actions haftalık), `.changeset/config.json`, `.changeset/README.md`, `.github/workflows/release.yml`, `CHANGELOG.md` (boş başlık; Changesets doldurur).
- Modify: kök `package.json` (devDependency `@changesets/cli`, script `changeset`, `version-packages`, `release`), her paket `package.json` (`license`, zaten T5'te), kök `README.md` lisans bölümü ("Apache-2.0, see LICENSE").

- [ ] **Step 1: Lisans metni** — çalışma alanında Apache-2.0 metni içeren bir dosya bul (`find ~ -name "LICENSE*" | xargs grep -l "Apache License"` ilk eşleşme; yoksa kullanıcıdan iste, uydurma). Başlık satırlarını kontrol et (`Apache License / Version 2.0, January 2004`).
- [ ] **Step 2: Dosyaları yaz** — CONTRIBUTING: kurulum (Bun, Docker), komutlar (`bun run db test`, entegrasyon, `codegen --check`), kurallar ("migration/seed yalnızca `bun run db:generate:*` ile", "`search_path` yok", "yeni ortam değişkeni yok", "uygulanmış migration/seed dosyasını değiştirme"), commit biçimi ve DCO `Signed-off-by`. SECURITY: özel bildirim yolu, yanıt süresi hedefi (7 gün), kapsam.
- [ ] **Step 3: Release iş akışı** — `release.yml`: `main` push'ta `changesets/action` ile sürüm PR'ı; yayın adımı `bun run release` (`changeset publish`), `permissions: contents: write, pull-requests: write, id-token: write`, `NPM_CONFIG_PROVENANCE=true`; ilk sürüm `0.1.0` `next` dist-tag'i (açıklama, sahibin `NPM_TOKEN`/trusted publishing kurulumu bekleniyor notuyla).
- [ ] **Step 4: Doğrula** — `bunx @changesets/cli status` hata vermez; YAML sözdizimi (`bunx yaml-lint` veya `python -c yaml.safe_load`) geçerli; `README`/`SECURITY` bağlantıları çözülür.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: license, community files, release pipeline"`.

### Task 8: İngilizceye çeviri ve dil denetimi

**Files:**
- Modify: `packages/{db-multi,db-single,redis,e2e}/src/**` (yalnızca yorumlar ve açıklayıcı dizgeler; test adları hariç), `packages/*/docs/*.md`, `packages/*/README.md`, `docs/guides/*` (zaten İngilizce).
- Dokunma: `src/migrations/**`, `src/seeds/**`, `*.gen.ts`, `docs/design/**`, `__tests__/**` (v0.1'de muaf), Task 1'deki dizgeler.
- Create: `scripts/check-english.sh` (Türkçe karakter `[çğıöşüÇĞİÖŞÜ]` taraması; muaf yollar yukarıdakiler + `*.tr.md`).

**Interfaces:**
- Consumes: Task 4 genelleştirilmiş metinler. Terim sözlüğü: `placement`=placement, `tenant`=tenant, "hücre"=cell, "dizin"=directory, "bakım"=maintenance, "taşıma"=move.

- [ ] **Step 1: Başarısız denetim** — `bash scripts/check-english.sh` FAIL ve dosya sayısı raporlar (taban çizgisi sayısı plana not edilir).
- [ ] **Step 2: Paralel çeviri** — dizin başına bağımsız alt ajanlar: `db-multi/src/core/{sql,tenants,operations,migrations,drivers}`, `db-multi/src/core/{tools,cli.ts,auth*.ts,*.ts}` ve `src/*.ts`, `db-multi/docs`, `db-single/src+docs`, `redis/src+docs`, `e2e`; her ajan yalnızca yorum/belge metni çevirir, kod değiştirmez, çevirdiği dosya listesini bildirir; sonuçlar ana oturumda `git diff --stat` ve `tsc` ile doğrulanır.
- [ ] **Step 3: Doğrula** — `check-english.sh` PASS; `typecheck`, `lint`, birim testleri, frozen testi PASS; `git diff` yalnızca yorum/metin satırları (kod belirteçleri değişmedi: `git diff -U0 | rg "^[+-]" | rg -v "^[+-]\s*(//|\*|/\*|#)"` incelenir, kod satırı değişimi yalnızca dizge/yorum içi).
- [ ] **Step 4: Commit** — aşama başına: `git commit -am "docs: translate comments and docs to English"`.

### Task 9: Bütünleşik doğrulama

**Files:** yok (yalnızca doğrulama); sonuç `docs/design/plans/2026-10-18-f1-rename-and-packaging.md` sonuna "Sonuç" bölümü olarak eklenir.

- [ ] **Step 1:** `bun install --frozen-lockfile`; her pakette `typecheck`, `lint`, birim testleri (`--timeout 60000`), `codegen --check`, `build`; `scripts/check-*.sh`; `scripts/smoke-pack.sh`.
- [ ] **Step 2:** Docker varsa `docker compose up -d --wait` (db-multi) ve `DB_DRIVER=pg bun run test:integration` (en az bir sürücü), ardından `docker compose down -v`; yoksa "çalıştırılmadı" kaydı.
- [ ] **Step 3:** `git log --oneline main..HEAD` ve `git status` temiz; sonuç bölümü: geçenler, çalıştırılmayanlar, kalan owner işleri (GitHub org/npm kapsamı, `presets/jamaster` taşıma, trusted publishing, çeviri artığı: test adları).
- [ ] **Step 4: Commit** — `git commit -am "docs: record F1 verification results"`.

## Self-review notları

- Spec kapsamı: D1 (T2), D2/D3 (T7, T8), D5 (T5/T6), D6 (T7), D12 (T3), D14 (T1 + her görev), D19 (düzeltilmiş kısıt, T5), P5/P6/P7 (T7/T6). P0.3 gizli bilgi taraması önceden yapıldı (temiz); geçmiş yeniden yazımı gerekmedi.
- Tür tutarlılığı: `@pgcells/multi/tools` yüzeyi T3'te tanımlı, T5'te tüketilir.
- Orantı: görev başına imzalar/test adları var, gövdeler yok.

## Result (2026-10-19)

Executed inline on branch `oss/f1-pgcells` (one local commit per task; nothing pushed). Differences from the plan, all decided during execution:

- **D12 narrowed:** only `platform-move`/`platform-merge` and the two jamaster runbooks moved to `presets/jamaster`. `adopt`, `users import` and `dump`/`app-migrate` stay: they are generic migration on-ramps, entangled with the runner's adopt scope, `pull` baselines, `importedPasswords` and the e2e suite. Applied migrations and seeds (including the example student/teacher auth tables and the panel auth migration) stay because their bytes are checksum-protected.
- **D19 corrected:** management, tools, CLI and codegen are Bun-only in v0.1 (they call Bun APIs); only `drivers/bun` fails to *import* on Node, the rest imports but is documented as Bun-only.
- **Build:** one `Bun.build` pass (`--target node`, `bun` external, shared chunks) instead of two builds; manifests keep `src/` exports for the workspace and `prepack` rewrites them to `dist`; declaration files are post-processed to NodeNext-valid `.js` specifiers.
- **Publishing:** `bun pm pack` then `npm publish <tarball> --provenance`; 0.x goes to the `next` dist-tag; the release job only runs in `pgcells/pgcells`.
- **Redis** peer-depends on `@pgcells/multi`; `@pgcells/single`'s bin is `pgcells-single`.

Review: a fresh whole-branch review (opus) found one Critical (declaration files unusable under NodeNext, hidden by `skipLibCheck`; the smoke type check could not fail) and five Important findings (release job on the wrong repository, undocumented Bun-only status, undocumented npm-install limits, guards missing from CI, `publish.sh` not re-runnable). All were fixed with a failing check first, plus four re-graded minors. Deferred: see the ledger (not committed) and the final report.

### Follow-up (2026-10-19)

The deferred minors and the unrun suites were closed on the same branch:

- `pack-manifest.ts prepack` restores `package.json` from an existing backup first, so an interrupted pack heals itself on the next run.
- CLI usage and doctor hints name the installed binaries (`pgcells`, `pgcells-single`); the `verify:provider` prompts are English; legacy `aristo`/`uyeler` names are gone from `data-import.md` and the scaffold usage; `cli.md` no longer mentions platform move.
- `check-doc-links.ts` rejects links that leave a published package (they would be dead in the npm tarball); cross-package links are absolute GitHub URLs.
- `smoke-pack.sh` bundles the installed packages for Workers (`wrangler deploy --dry-run`); the frozen error-code check accepts any string literal, not only `AppError("X"`.
- Integration: `@pgcells/single` 107/107 on the bun, postgres.js and Neon drivers (an isolated stack on free ports; the default ports were held by another project's containers). `@pgcells/e2e` 11/11. Two real defects found and fixed: a db-single auth test depended on today's date, and the e2e image did not copy the `db-single` and `presets/jamaster` manifests, so `bun install --frozen-lockfile` failed.
- Still open: CI itself has never run (nothing is pushed); the e2e result files were not refreshed.
