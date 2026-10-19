# Açık kaynak paketleme ve yeniden adlandırma planı

Tarih: 2026-10-18 · Tasarım: [`2026-10-18-pgcells-oss-regions-design.md`](../specs/2026-10-18-pgcells-oss-regions-design.md) D1–D6, D12, D14, D19 · Ana yol: [roadmap](2026-10-18-roadmap-remaining.md) F0–F1

Durum: **onay bekliyor**; kod/dosya taşıma işleri onaydan sonra başlar. Ön denetim bulguları (bu oturumda yapıldı): geçmişte `.env` hiç commit edilmemiş, gizli bilgi desenleri bulunamadı; `LICENSE` yok; her iki paketin `package.json`'ı `private: true` ve ham `src/*.ts` dışa aktarıyor; migration/seed/sorgu listeleri `with { type: "text" }` ile `.sql` import ediyor (Bun'a özgü); 24 dosyada "jamaster" geçiyor; 252 commit'lik geçmiş; CI yalnızca `db-multi` ve `db-single`; kök README "paketler birbirine bağımlı değil" diyordu (düzeltildi).

## P0 — Önkoşullar (F0)
| ID | İş | Not |
|---|---|---|
| P0.1 | Sahip kararları: D12, org adı, güvenlik adresi | tasarım §10 |
| P0.2 | npm organizasyonu `@pgcells`, GitHub org/repo `pgcells`; repo yeniden adlandırması (GitHub eski adı yönlendirir) | sahip hesabı gerekir |
| P0.3 | Geçmiş gizli bilgi taraması (tüm dallar) + `bench/results/*.json`, `.claude/`, `.superpowers/`, `.wrangler/` içeriği incelemesi | rapor; gerekirse `git filter-repo` (sahip kararı) |
| P0.4 | Lisans uyumu: `license-checker`/`bun pm` ile bağımlılık lisansları; peer'lar (better-auth MIT, pg MIT, postgres Unlicense) | CI'da kalıcı iş |
| P0.5 | Marka: `pgcells` ticari marka/alan adı çakışması hızlı kontrolü | sahip |

## P1 — Yeniden adlandırma (F1) — kalıcı tanımlayıcılar **değişmez** (D14)
| ID | İş | Ayrıntı |
|---|---|---|
| P1.1 | Dizin adları: `packages/db-multi`→`packages/multi`, `db-single`→`single` (isteğe bağlı; yalnızca npm adı yeterliyse dizin kalır) | Karar: **dizinler kalır** (daha az değişiklik, daha az kırık bağlantı); yalnızca `package.json` `name` değişir. Gerekirse sonra |
| P1.2 | `@repo/db-multi`→`@pgcells/multi`, `@repo/db-single`→`@pgcells/single`, `@repo/redis`→`@pgcells/redis` | Kaynakta, testte, belgede, `package.json`, `tsconfig` yolları, CI'da toplu ve otomatik (betik + `rg` doğrulaması) |
| P1.3 | **Değişmeyecekler** için otomatik koruma testi: advisory lock anahtar dizgeleri, ledger tablo adları, `platform.*` sütun adları, hata kodları listesi, türetilmiş secret HKDF bağlam dizgesi ("Türetilmiş secret'lar ve `pull` migration başlıkları değişmez") | `__tests__/unit/frozen-identifiers.test.ts` altın dosya; yanlışlıkla değişirse CI kırılır |
| P1.4 | Kök `package.json` adı `pgcells-monorepo`, `db:*` kısayolları korunur (geri uyumlu), yeni `multi:*` takma adları isteğe bağlı | |
| P1.5 | Git: uzak depo adı, README rozetleri, `.github` yolları | P0.2 sonrası |

## P2 — Jamaster ayrımı (D12; varsayılan: özel katmana taşı)
Taşınacaklar (çekirdekten çıkar; **ledger'a girmeyen** her şey): `adopt`, `platform-merge`, `platform-move`, `import-users`, `app-migration` ve jamaster'a özgü `dump` araçları (genel "dump→tenant" aracı kalacaksa `@pgcells/multi/tools` altında genelleştirilir; jamaster'a özgü alan adları çıkar), `createPlatformAuth` jamaster varsayılanları, `jamaster-api.md`, `jamaster-migration.md`, `data-import.md`'nin jamaster bölümleri. **Kalacaklar (ledger'lı dosyalar):** `…_auth.sql` (user/student/teacher), `user_imports`, `auth_rate_limits`, `panel_auth` platform migration'ı, demo seed.
- **Yöntem:** önce jamaster'ın kullandığı yüzeyin envanteri (hangi export'lar, hangi migration kimlikleri); sonra ayrı PR'lar: (1) araçları `presets/jamaster/` altına taşı (aynı repo, henüz yayına çıkmaz), (2) çekirdek testlerinin geçtiğini doğrula, (3) `presets/jamaster/`'ı özel depoya taşı, (4) kalan migration/seed dosyalarına **dokunulmaz**.
- **Risk (doğrulandı):** ledger her migration/seed dosyasının SHA-256 özetini saklar (`core/migrations/registry.ts`); uygulanmış dosyanın içeriğini bölmek, çevirmek veya yeniden biçimlendirmek `MIGRATION_DRIFT`/`SEED_DRIFT` üretir. Bu yüzden v0.1'de auth migration dosyası **bölünmez**; student/teacher tabloları çekirdekte kalır ve D12 yalnızca araç/belge/seed taşır. Tablo bölme v0.2 sonrası ileri migration olarak (D15) ayrıca ele alınır. Demo seed'i taşınırken de yeni kurulumların ledger'ı yalnızca *çıkarılan* seed'i görmez (yeni kurulum); mevcut ledger'da zaten uygulanmış seed girdisi kalırsa `SEED_DRIFT` "bilinmeyen seed" verir: bu yüzden demo seed'i **çıkarılmaz, belgede "örnek, kendi kurulumunuzda silin" notuyla kalır** (taşınması D15 uyumluluk penceresinde ele alınır).
- **Kabul:** çekirdek paketlerde `rg -i jamaster` yalnızca tarihî CHANGELOG/atıf satırlarında; tüm testler geçer.

## P3 — Derleme ve yayın biçimi (D5)
| ID | İş | Ayrıntı |
|---|---|---|
| P3.1 | SQL gömme | Codegen `index.gen.ts` dosyalarını `with { type: "text" }` yerine dizge sabiti olarak üretir (`export default "…"`); `sql.d.ts` kalkar. Kod üretimi deterministik, `codegen --check` korunur |
| P3.2 | Derleme | `tsdown` veya `bun build` + `tsc --emitDeclarationOnly`: giriş başına ESM + `.d.ts`; `external`: `pg`, `postgres`, `better-auth`, `@neondatabase/serverless`, `ioredis`, `bullmq` |
| P3.3 | `package.json` | `private` kalkar; `exports` (`types`, `import`, `default`), `files: ["dist", "README.md", "LICENSE"]`, `sideEffects: false`, `engines` (`bun >=1.3.14`, `node >=22`), `publishConfig: { access: "public", provenance: true }`, `repository`, `bugs`, `homepage`, `keywords`, `bin: { "pgcells": "dist/cli.js" }`, `peerDependencies` aynı |
| P3.4 | CLI | Node ve Bun'da çalışan derlenmiş `bin` (shebang `#!/usr/bin/env node`); Bun'a özgü API'ler (varsa `Bun.password` yalnızca auth/import yolunda, tembel) korunur |
| P3.5 | `queries/*`, `tables/*` alt yolları | Paketin kendi üretilmiş dosyaları `dist` içinde; **tüketicinin** kodu kendi codegen'ini çalıştırır (`pgcells codegen` komutu `bin` ile gelir) |
| P3.6 | Duman testleri | CI: `npm pack` → temiz geçici proje → `bun add`/`npm i` tarball → (a) Bun betiği `createDatabase` + `ready()`, (b) Node 22 aynı, (c) `wrangler deploy --dry-run` Workers paketi, (d) tür testi (`tsc` tüketici projesi) |
| P3.7 | `bun.lock` | Çalışma alanı kilidi kalır; paketler için kilit yayınlanmaz |

## P4 — Çeviri (D3) — paralel, F1 boyunca
- Kapsam: kod yorumları (`core/**`), `docs/*.md` (paket başına ~3.400 satır), CLI yardım/hata metinleri (zaten İngilizce olanlar hariç), plan/spec belgeleri **çevrilmez** (tasarım geçmişi, `docs/design/` altında Türkçe kalabilir; İngilizce özetle bağlanır).
- **Dokunulmaz:** `src/migrations/**/*.sql`, `src/seeds/**` (ledger özeti, D14). Yorumları Türkçe kalır; CI'daki Türkçe karakter denetimi bu yollar için muaftır. `frozen-identifiers` testi (P1.3) bu dosyaların SHA-256 özetlerini altın dosyada tutar; çeviri betiği bu yolları dışarıda bırakır.
- Yöntem: dizin başına paralel alt ajan çevirisi + dil denetimi betiği (`rg "[çğıöşüÇĞİÖŞÜ]"` listesi CI'da uyarı → hata), terim sözlüğü (`placement`, `cell`, `directory`, `fencing`) tek dosyada.
- Kabul: `docs/` ve `src/` altında Türkçe karakter yalnızca açıkça işaretli `*.tr.md` ve fixture/test verilerinde; belge bağlantı denetimi (`lychee`) temiz.

## P5 — Depo yapısı ve topluluk dosyaları
| Dosya | İçerik |
|---|---|
| `LICENSE` | Apache-2.0 tam metin; `NOTICE` gerekirse |
| `README.md`, `README.tr.md` | ✅ yazıldı (bu tur); rozetler P1.5 sonrası |
| `CONTRIBUTING.md` | Kurulum (Bun, Docker), test komutları, "migration/seed yalnızca CLI ile", "yeni `search_path` kullanımı reddedilir", DCO (`Signed-off-by`) |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 |
| `SECURITY.md` | GitHub private vulnerability reporting + (sahip adresi) |
| `CHANGELOG.md` | Changesets üretir |
| `.github/ISSUE_TEMPLATE/*`, `PULL_REQUEST_TEMPLATE.md`, `CODEOWNERS`, `dependabot.yml` veya Renovate | |
| `docs/design/` → `docs/design/{specs,plans}/` | Araç adı sızmaz; bağlantılar güncellenir; arşiv durumları (F0.5) |
| `.gitignore` | `.superpowers/`, `.claude/`, `.wrangler/` zaten; `dist/` zaten |
| Kök `package.json` | `name`, `private: true` (çalışma alanı kökü), `workspaces`, `engines` |

## P6 — Sürüm hattı
- Changesets (`@changesets/cli`): bağlantılı sürümler (`multi`, `single`, `redis` birlikte `0.x`), `release.yml`: `main`'e birleşince sürüm PR'ı, etiket → `npm publish --provenance` (GitHub OIDC trusted publishing), `contents: write`, `id-token: write` yalnızca bu işte.
- CI'ya ekler: paket duman testleri (P3.6), lisans denetimi, `lychee` bağlantı denetimi, Türkçe karakter denetimi (P4), `frozen-identifiers` (P1.3), PostgreSQL 14–17 ve PgBouncer sürüm matrisi (bağlantı planı C9), Node/Bun matrisi (D19), CodeQL.
- Sürüm politikası: D6, D15. Erken yayın `0.1.0` etiketi `next` dist-tag'iyle; `latest` v0.1 kapısından sonra.

## P7 — Yayın öncesi kontrol listesi (v0.1 kapısı)
- [ ] P0 tamam, sahip onayları kayıtlı
- [ ] `rg -i "@repo/"` boş; `rg -i jamaster` yalnızca izin verilen satırlar
- [ ] `npm pack --dry-run` her pakette yalnızca `dist`, README, LICENSE listeler (kaynak testi/benchmark sızmaz)
- [ ] Temiz makinede README "Quick start" komut dizisi çalışır (CI işi olarak otomatik)
- [ ] `docs/guides/*` bağlantıları ve diyagramlar GitHub'da render olur (Mermaid)
- [ ] `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` var
- [ ] İlk sürüm notları: bilinen sınırlar (tek bölge doğrulanmış, bölge özellikleri planlı) açık yazılı

## Sıra
P0 → P1 (+P1.3 koruma testi ilk) → P3 (derleme/gömme) ∥ P4 (çeviri) → P2 (ayrım; çekirdek testleri yeşil kalmak zorunda) → P5 → P6 → P7. P1 ve P3 bitmeden P2 başlamaz (aynı dosyalar).
