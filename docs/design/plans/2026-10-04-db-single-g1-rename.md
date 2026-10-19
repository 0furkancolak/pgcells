# G1 — `packages/db` → `packages/db-multi` yeniden adı Implementation Plan

> **Durum (2026-10-19): uygulandı.** Onay kutuları işaretlenmedi; gerçek durumun kaynağı koddur, testlerdir ve [yol haritası](2026-10-18-roadmap-remaining.md)dır.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Çok-tenant paketi `packages/db` / `@repo/db` olarak değil `packages/db-multi` / `@repo/db-multi` olarak adlandırmak; davranış değişmez, tüketiciler (`@repo/redis`, `@repo/e2e`) yeni adı kullanır.

**Architecture:** Tek `git mv` (geçmiş korunur), ardından ad bağımlı her yerin (paket adı, kök betikler, import belirteçleri, Docker yolları, belgeler) mekanik güncellenmesi. İki veri-formatı sabiti (HKDF tuzu `"@repo/db/auth"`, `pull` başlık işareti `-- @repo/db pull`) bilerek **değişmez**: değişirlerse türetilmiş secret'lar ve mevcut `pull` migration'ları geçersiz olur.

**Tech Stack:** Bun workspaces, TypeScript, bun:test, git.

**Spec:** `docs/superpowers/specs/2026-10-04-db-single-design.md` (bölüm "`db-multi`: yalnızca yeniden ad").

## Global Constraints

- `search_path` yok; yeni ortam değişkeni yok; daha az kod.
- Davranış değişmez. Kabul: yeniden adın hemen ardından `packages/db-multi` birim paketi **367/367**, tam entegrasyon paketi **147/147** (bun sürücüsü) değişmeden geçer; `tsc`, `eslint`, `codegen --check` temiz.
- `docs/superpowers/specs|plans` altındaki geçmiş belgeler tarihî kayıttır: içlerindeki `packages/db` / `@repo/db` yolları **değiştirilmez** (bu plan dosyası dahil).
- Commit mesajı sonu: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push, PR, merge yok.
- Paylaşılan jamaster docker yığınına (portlar 5540/5541/5543, `jamaster-*` konteynerleri) dokunulmaz. Entegrasyon yalnızca yalıtılmış compose projesinde (`docker compose -p dbmulti …`) ve portlar boş olduğu doğrulandıktan sonra çalışır; doluysa DURUN ve sorun.
- Kod yorumları Türkçe, hata mesajları İngilizce; URL/host/kullanıcı/parola içermez.

## Review Focus

- HKDF tuzu `"@repo/db/auth"` aynı kalmalı: değişirse `perTenantSecret: true` kullanan dağıtımların türetilmiş secret'ı ve dolayısıyla oturumları sessizce değişir. (Mevcut `unit/auth.test.ts` bunu `hkdfSync` ile sabitler; test değişmeden geçmeli.)
- `pull` işareti `-- @repo/db pull structure=…` aynı kalmalı: jamaster'ın depoladığı `pull` migration'ları bu başlıkla tanınır (`pulledMarkerOf`). (`unit/pull.test.ts` sabitler.)
- Bayat `node_modules/@repo/db` sembolik bağı kalırsa `tsc` eski yolu çözmeye çalışır; `bun install` sonrası yalnızca `@repo/db-multi` bağı bulunmalı.
- `bun.lock` güncellenmeli: `packages/e2e/Dockerfile` `--frozen-lockfile` kullanır.
- `docker compose` proje adı ve volume adları `db` kökünden türediği için yalıtılmış proje adı (`-p dbmulti`) zorunlu; aksi halde mevcut jamaster yığınıyla karışır.

## File Structure

- Taşınan: `packages/db/**` → `packages/db-multi/**` (`git mv`; izlenmeyen `.env`, `node_modules`, `dist` aynı dizinle gider).
- Değişen: `package.json` (kök betikler), `packages/db-multi/package.json` (ad), `packages/db-multi/{README.md,docs/*,src/**/*.ts yorumları}`, `packages/redis/{package.json,README.md,docs/*,src/**}`, `packages/e2e/{package.json,Dockerfile,Dockerfile.dockerignore,compose.yaml,eslint.config.js,README.md,docs/*,src/**}`, kök `README.md`, `bun.lock`.
- Değişmeyen (bilinçli): `src/core/auth.ts` HKDF tuzu, `src/core/migrations/source.ts` `pull` işareti, `src/core/auth-adapter.ts` `adapterName`, `src/__tests__/unit/auth.test.ts` ve `unit/pull.test.ts` içindeki aynı sabitler.

---

### Task 1: Yeniden ad ve tüketiciler

**Files:**
- Move: `packages/db` → `packages/db-multi`
- Modify: bkz. File Structure
- Test: mevcut paketler (yeni test yazılmaz: kabul "değişmeden geçer"dir)

**Interfaces:**
- Consumes: yok.
- Produces: `@repo/db-multi` (aynı `exports` haritası: `.`, `./management`, `./middleware`, `./tools`, `./auth`, `./telemetry`, `./drivers/*`, `./queries/*`, `./tables/*`). G2/G3 bu adı bilmez; `db-single` bağımsızdır.

- [ ] **Step 1: Başlangıç tabanı: dal, portlar, temel sayılar**

```bash
cd /Volumes/DEVNAFRU/Projects/nafru/multi-tenant-example
git branch --show-current          # feat/db-single olmalı
git status --short                 # temiz olmalı
for p in 5540 5541 5543 5545 5546 5488; do lsof -nP -iTCP:$p -sTCP:LISTEN | sed "s/^/port $p: /"; done
```
Expected: dal `feat/db-single`; çalışma ağacı temiz. Port satırları **yazdırılırsa** o port doludur (muhtemelen jamaster yığını): **DURUN ve kullanıcıya sorun**, entegrasyon adımlarını (Step 8) çalıştırmayın. Hiç satır yoksa devam.

```bash
bun run --cwd packages/db test 2>&1 | tail -4
bun run --cwd packages/redis test 2>&1 | tail -4
bun run --cwd packages/redis typecheck 2>&1 | tail -3
bun run --cwd packages/e2e typecheck 2>&1 | tail -3
```
Expected: db birim `367 pass`, redis birim geçer, iki `tsc` çıktısı boş. Sayıları ledger'a yazın (taban).

- [ ] **Step 2: Dizini taşı ve paket adını değiştir**

```bash
git mv packages/db packages/db-multi
```
`packages/db-multi/package.json` içinde `"name": "@repo/db"` → `"name": "@repo/db-multi"` (Edit).

- [ ] **Step 3: Kök betikler**

`package.json` içindeki her `--cwd packages/db` → `--cwd packages/db-multi` (betik adları aynı kalır: jamaster `bun run db:*` kullanıyor):

```bash
perl -pi -e 's#--cwd packages/db(?![\w-])#--cwd packages/db-multi#g' package.json
grep -n "packages/db" package.json
```
Expected: 16 satırın hepsi `packages/db-multi`; `packages/db ` (tire/kelime olmayan) kalmaz.

- [ ] **Step 4: Ad ve yol güncellemesi (belgeler, yorumlar, tüketiciler)**

`@repo/db` yalnızca ardından kelime karakteri ya da `-` gelmiyorsa, `packages/db` aynı kural ile değişir. Testler ve bench sonuç dosyaları hariç:

```bash
FILES=$(grep -rIl -e '@repo/db' -e 'packages/db' \
  README.md packages/db-multi packages/redis packages/e2e \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=results --exclude-dir=__tests__ || true)
echo "$FILES" | wc -l
perl -pi -e 's#\@repo/db(?![\w-])#\@repo/db-multi#g; s#packages/db(?![\w-])#packages/db-multi#g' $FILES
```
`packages/redis/src/__tests__/**` ve `packages/e2e/src/e2e.test.ts` testtir ama `@repo/db` importu içerir; onlar da güncellenmelidir (yukarıdaki `--exclude-dir=__tests__` yalnızca `db-multi`/`redis`'teki testleri dışlar). Ayrı komut:

```bash
perl -pi -e 's#\@repo/db(?![\w-])#\@repo/db-multi#g; s#packages/db(?![\w-])#packages/db-multi#g' \
  $(grep -rIl -e '@repo/db' -e 'packages/db' packages/redis/src/__tests__ packages/e2e/src/e2e.test.ts)
```
`packages/db-multi/src/__tests__` içine **dokunulmaz** (iki sabit orada kalmalı; başka `@repo/db` içermezler).

- [ ] **Step 5: Veri-formatı sabitlerini geri koy (Edit ile)**

Adım 4'ün perl'ü şu üç yeri de değiştirdi; hepsi **orijinal değerlerine** döner:

1. `packages/db-multi/src/core/auth.ts`: `salt: text.encode("@repo/db-multi/auth")` → `salt: text.encode("@repo/db/auth")` ve satırın üstüne yorum ekleyin: `// KDF tuzu sabit veridir: paket adıyla değişirse türetilen secret'lar ve oturumlar geçersiz olur.`
2. `packages/db-multi/src/core/migrations/source.ts`: `pullMarker` içindeki `-- @repo/db-multi pull` → `-- @repo/db pull`; üstüne yorum: `// Başlık biçimi sabit veridir: depolanmış pull migration'ları bu işaretle tanınır.`
3. `packages/db-multi/src/core/auth-adapter.ts`: `adapterName: "@repo/db-multi"` → `adapterName: "@repo/db"`.

```bash
grep -rn '"@repo/db/auth"\|-- @repo/db pull\|adapterName: "@repo/db"' packages/db-multi/src
grep -rn '@repo/db-multi/auth"\|-- @repo/db-multi pull' packages/db-multi/src
```
Expected: ilk komut 5 eşleşme (auth.ts, source.ts, auth-adapter.ts + testlerdeki iki sabit), ikinci komut **boş**.

- [ ] **Step 6: `sql-dump` iskelet çıktısındaki import**

`packages/db-multi/src/core/tools/sql-dump.ts` içindeki `options.importFrom ?? "@repo/db/tools"` Step 4'te `"@repo/db-multi/tools"` olmuş olmalı (üretilen iskelet kodu yeni paketi import eder). Test varsa güncelleyin:

```bash
grep -rn '@repo/db/tools' packages/db-multi/src packages/e2e/src
```
Expected: boş. Bir birim testi eski dizgeyi bekliyorsa (`unit/sql-dump.test.ts`) beklentiyi `@repo/db-multi/tools` yapın.

- [ ] **Step 7: Bağımlılık ağacı ve bayat bağ**

```bash
ls -l node_modules/@repo/ 
```
`db -> ../../packages/db` (kırık) görünürse kaldırın (yalnızca `node_modules` içindeki sembolik bağ):

```bash
rm node_modules/@repo/db
bun install
ls -l node_modules/@repo/
git diff --stat bun.lock
```
Expected: `db-multi`, `e2e`, `redis` bağları; `db` yok. `bun.lock` `@repo/db-multi` ile güncellenmiş (`grep -n '"@repo/db"' bun.lock` boş).

- [ ] **Step 8: Kabul: birim, tür, lint, codegen, tüketiciler**

```bash
bun run --cwd packages/db-multi test 2>&1 | tail -4
bun run --cwd packages/db-multi typecheck && bun run --cwd packages/db-multi lint && bun run --cwd packages/db-multi codegen --check
bun run --cwd packages/redis test 2>&1 | tail -4
bun run --cwd packages/redis typecheck && bun run --cwd packages/e2e typecheck
bun run db --help 2>&1 | head -3
```
Expected: db-multi birim **367 pass**; hiçbir komut hata vermez; redis birim Step 1'deki sayıyla aynı; `bun run db --help` CLI yardımını yazdırır (kök betik yeni yolu çözer).

Entegrasyon (yalnızca Step 1'de portlar boşsa):

```bash
cd packages/db-multi
docker compose -p dbmulti up -d --wait postgres-0 postgres-1 pgbouncer wsproxy postgres-rp postgres-rp-replica
bun src/core/cli.ts bootstrap
RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration 2>&1 | tail -6
docker compose -p dbmulti down -v --remove-orphans
cd ../..
```
Expected: `147 pass`, `0 fail`; ardından `docker ps --format '{{.Names}}' | grep -c '^dbmulti'` `0`.

- [ ] **Step 9: Not ve commit**

`packages/db-multi/docs/jamaster-api.md` başına (başlıktan sonra) şu not eklenir (Edit):

```markdown
> **Paket adı değişti:** bu paket `@repo/db`'den `@repo/db-multi`'ye (`packages/db` → `packages/db-multi`) yeniden adlandırıldı; davranış aynıdır. jamaster-api'de `@repo/db` import belirteçlerini `@repo/db-multi` yapın (alt yollar aynı: `/management`, `/middleware`, `/tools`, `/auth`, `/telemetry`, `/drivers/*`, `/queries/*`, `/tables/*`). Türetilmiş secret'lar ve `pull` migration başlıkları değişmez.
```

```bash
git add -A
git commit -m "$(cat <<'EOF'
rename packages/db to packages/db-multi (@repo/db-multi); consumers and docs follow, KDF salt and pull marker stay

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
git log --oneline -1 && git status --short | wc -l
```
Expected: tek commit, çalışma ağacı temiz (`0`).
