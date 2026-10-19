# Ana yol haritası: kalan ve yapılmayan her şey

Tarih: 2026-10-18 · Tasarım: [`2026-10-18-pgcells-oss-regions-design.md`](../specs/2026-10-18-pgcells-oss-regions-design.md) (**onay bekliyor**) · Konu planları: [bölgeler](2026-10-18-regions-plan.md) · [bağlantı/PgBouncer](2026-10-18-connections-pgbouncer-plan.md) · [OSS paketleme](2026-10-18-oss-packaging-plan.md) · [Go](2026-10-18-go-port-plan.md)

Bu belge bir **dizindir ve sıralamadır**. Her satırın ayrıntısı konu planındadır. Görev düzeyinde (test-önce adımlar, dosya yolları) uygulama planları, ilgili faz onaylandığında `superpowers:writing-plans` ile faz başına ayrı yazılır; burada yazılanlar kilometre taşı ve kabul ölçütü düzeyindedir. Durum: ☐ yapılmadı · ◐ kısmen · ✅ tamam.

## 0. Durumun dürüst dökümü

İlk yazıldığı gün (2026-10-18) ve en son güncelleme (2026-10-19) birlikte. Durum: ☐ yapılmadı · ◐ kısmen · ✅ tamam.

| Alan | Durum | Not |
|---|---|---|
| Çekirdek (runtime, placement, SQL derleyici, sürücüler, deadline) | ✅ | 4 sürücü, 3 kapsam, geniş test |
| Yönetim (migration, provision, move, backup, restore, doctor) | ✅ | Hepsi tekrar çalıştırılabilir |
| Replika okuması (C) | ✅ | Bölge-bilmeyen round-robin (bölge yerelliği F4'te) |
| Neon/Supabase (B) | ◐ | Kod var; sağlayıcı satırlarının çoğu "documented, not verified" (hesap gerekir) |
| Gelişmiş SQL (E) | ✅ | |
| `db-single` (G) | ✅ | |
| Açık kaynak paketleme (F1) | ✅ | Derlenmiş paketler, LICENSE, jamaster ayrımı, İngilizce, yayın hattı; sahip işleri (npm adı/yayın hesabı) kalır |
| Fencing, `db0` dayanıklılığı (F2) | ✅ | 2026-10-19: kaynak schema yeniden adlandırma, bekleme invariantı, dizin replikası, stale-if-error |
| Bağlantı bütçesi/PgBouncer araçları (F3) | ✅ | 2026-10-19: `pooler plan/generate`, `doctor` denetimleri, `stats()`, `close({drain})`, `tenantMaxInflight`, hata sınıflandırma, toxiproxy testleri, PgBouncer 1.21/1.23/1.24 matrisi. Karar: isimli prepared statement **uygulanmıyor** |
| Bölge modeli (F4) | ✅ | 2026-10-19: node `region`/`residency_zone`/etiket, kalıcı ikamet bölgesi, `RESIDENCY_VIOLATION`, `createDatabase({ region })`, `regionGuard`, replika yerelliği (bölge birimiyle), `doctor` denetimleri, iki bölgeli sınama yığını (gecikme simüle) |
| Ölçek (D): kapasite modeli | ✅ | `docs/guides/capacity.md`, `capacity plan`; ölçülen ve varsayılan değerler ayrı etiketli. Backpressure kararı: 64 sabit kalır |
| Kılavuz (F): baştan sona senaryo | ✅ | `docs/guides/walkthrough.md`; her kod bloğu CI'da türleri denetlenir ve çalıştırılır |
| Sağlayıcı doğrulama (F5.3, C11) | ☐ | Gerçek hesap gerekir (sahip işi): komutlar `providers.md` "Verification" bölümünde |
| `db-single` ↔ `db-multi` ortak çekirdek (F5.5) | ✅ | Karar: v0.5'e kadar kopya kalır ([karar notu](2026-10-19-core-extraction-decision.md)) |
| Kesintisiz taşıma ve DR (F6) | ✅ | 2026-10-19: `move --online` (mantıksal replikasyon; 113 MB ve 1,1 GB ölçüldü, 10–50 GB ölçülmedi), sağlayıcı matrisi (yalnız düz PostgreSQL doğrulandı), nedensel okuma belirteci, `cell promote` planı |
| Plan kutuları | ◐ | 398 kutunun hiçbiri işaretli, çoğu iş yapılmış |
| Go (F7) | — | **Yapılmayacak** (sahip kararı, 2026-10-19) |

## 1. Fazlar ve bağımlılıklar

```
F0 kararlar/hijyen ──► F1 yeniden adlandırma+paketleme ──► F2 fencing+kontrol düzlemi ──► v0.1
                                   │                                 │
                                   ├──────────► F3 bağlantı/PgBouncer ──► v0.2
                                   │                                 │
                                   └──────────► F4 bölge modeli ◄────┘ ──► v0.3 (sözleşme dondurma)
                                                          │
                              F5 D+F+sağlayıcı doğrulama (paralel, F2'den sonra)
                                                          │
                                                F6 kesintisiz taşıma + DR ──► v0.4
                                                          ▼
                                                   v1.0 (soak)
```

F1 erkendir: sonraki bütün işler son adlarla (`@pgcells/*`) inmeli. F3 ve F4 F2'ye bağlı değildir ama F4'ün `stale-if-error` kısmı fencing'e bağlıdır. İnsan/hesap işleri (npm organizasyonu, GitHub) F0'da paralel başlar.

## 2. Fazlar

### F0 — Kararlar ve hijyen (1–2 gün; yalnızca sahip + küçük repo işleri)
| ID | İş | Kabul ölçütü | Sahibi |
|---|---|---|---|
| F0.1 | Tasarım belgesini onayla; §10 sorularını yanıtla | Onay kaydı | sahip |
| F0.2 | GitHub org/repo adı ve npm org (`@pgcells`) oluştur | `npm view @pgcells/multi` 404 değil, kapsam sahip hesapta | sahip (benim yapamayacağım hesap işlemi) |
| F0.3 | Geçmiş denetimi: gizli bilgi taraması (gitleaks/trufflehog) tüm geçmişte; `bench/results/*.json` ve `.claude/` içinde host adı/yol sızıntısı | Rapor temiz veya sızıntı giderilmiş (gerekirse geçmiş yeniden yazılır, bu sahip kararıdır) | ben |
| F0.4 | Bağımlılık lisans denetimi | Apache-2.0 ile uyumsuz bağımlılık yok (CI işi olarak kalıcılaşır) | ben |
| F0.5 | Plan kutularını düzelt veya planları "uygulandı" arşivine al | `docs/design/archive/` altında durum satırı | ben |

### F1 — Yeniden adlandırma ve paketleme → [OSS paketleme planı](2026-10-18-oss-packaging-plan.md)
Rename, LICENSE, jamaster ayrımı (D12), derleme hattı (D5), İngilizce çeviri (D3), yayın hattı, topluluk dosyaları. Kalıcı tanımlayıcılar donmuştur (D14). **Çıktı:** `pnpm/bun pack` ile temiz projede kurulup çalışan paketler.

### F2 — Fencing ve kontrol düzlemi dayanıklılığı (v0.1'in kalanı) → [bölgeler planı](2026-10-18-regions-plan.md) R1–R3
| ID | İş | Kabul ölçütü |
|---|---|---|
| F2.1 | Cutover'da kaynak schema'yı yeniden adlandır (D13); `doctor` "tutulan kopya" listesi | Entegrasyon: bayat yazıcı cutover sonrası `42P01` alır; e2e `move` senaryosu bayat-yazıcı kontrolüyle genişler |
| F2.2 | `placementCacheWaitMs ≥ PLACEMENT_CACHE_MAX_MS + replicaMaxLagMs` zorunluluğu | Yapılandırma testi: ihlal `INVALID_CONFIG` |
| F2.3 | Dizin replikası okumaları (D16) | Birim + entegrasyon (replika fixture'ı): yalnızca `active` replikadan; diğerleri primary'den doğrulanır |
| F2.4 | Stale-if-error (fencing sonrası) | Entegrasyon: `db0` durdurulunca süresi dolan `active` placement sınırlı süre kullanılır, sonra `DATABASE_UNAVAILABLE`; taşıma sırasında kullanılmaz |

### F3 — Bağlantı yönetimi ve PgBouncer → [bağlantı planı](2026-10-18-connections-pgbouncer-plan.md) → **v0.2**
Bütçe hesabı/`doctor`, `pooler plan|generate`, adillik, `db.stats()`, zarif kapanış, failover sınıflandırması, toxiproxy'li fault-injection testleri, PgBouncer sürüm matrisi, prepared-statement spike'ı.

### F4 — Bölge modeli → [bölgeler planı](2026-10-18-regions-plan.md) R4–R9 → **v0.3**
Node `region`/`residency_zone`/etiket, `placements.residency_zone`, bölge süzgeçli yer seçimi, `RESIDENCY_VIOLATION`, `createDatabase({ region })`, `regionGuard`, replika yerelliği, dizinden kişisel veriyi ayıran `doctor` uyarısı, iki bölgeli compose + toxiproxy gecikmesi. **Sözleşme dondurma:** `spec/` dosyaları ve uyum fikstürleri mevcut.

### F5 — Orijinal yol haritasının kalanı (paralel)
| ID | İş | Kabul ölçütü |
|---|---|---|
| F5.1 | **D: kapasite modeli.** Ölçülmüş "süreç başına X rps; 1M rps için N örnek, M replika, K hücre" tablosu; `RUNTIME_MAX_PENDING` (64) ötesi backpressure kararı; çok örnekte havuz paylaşımı notları | `docs/guides/capacity.md`, `bench:scale` sonuçlarıyla; varsayımlar etiketli |
| F5.2 | **F: baştan sona kılavuz.** Kurgusal SaaS ile "ilk tenant'tan ikinci bölgeye" senaryosu; kod blokları CI'da derlenerek çalışır | `docs/guides/walkthrough.md` + `bun test docs` |
| F5.3 | Sağlayıcı doğrulama: Neon, Supabase, RDS Proxy, Hyperdrive, Supavisor için `verify:provider` gerçek hesapla | `providers.md` her satırı `verified (tarih, sürücü)` veya açıkça `unsupported` |
| F5.4 | Redis Cluster / çok bölgeli Redis davranışı, soak koşusu | e2e kapsamı listesinden çıkar veya "yapılmadı" olarak kalır |
| F5.5 | `db-single` ↔ `db-multi` ortak çekirdek (`@pgcells/core`) değerlendirmesi | v0.5 kararı; mevcut kopya kararı geçerli |

### F6 — Kesintisiz taşıma ve DR → [bölgeler planı](2026-10-18-regions-plan.md) R10–R12 → **v0.4**
Mantıksal replikasyon spike'ı (D17), `move --online`, sağlayıcı matrisi, DR promote runbook'u ve `doctor` denetimleri, nedensel okuma belirteci.

### F7 — Go: yapılmayacak
Sahip kararı (2026-10-19): Go sürümü kapsam dışıdır. [Go planı](2026-10-18-go-port-plan.md) tarihsel kayıt olarak kalır; `spec/` çıkarımı ve uyum fikstürleri de yapılmayacaktır.

### Sürekli
Çeviri (F1 içinde başlar, bitene kadar sürer), CI matrisi büyümesi, sürüm notları, kılavuzların her özellikle birlikte güncellenmesi ("🔜" → "✅").

## 3. Sürüm kapıları

| Sürüm | Kapı |
|---|---|
| **v0.1** | F0, F1, F2 bitti; paketler yayınlanabilir; tek bölge için her iddia doğrulanmış; README + 2 kılavuz yayında |
| **v0.2** | F3 bitti; toxiproxy testleri CI'da |
| **v0.3** | F4 bitti; `spec/` dondu; iki bölgeli compose testleri CI'da |
| **v0.4** | F6 bitti (veya desteklenmeyen matris satırlarıyla belgelenmiş) |
| **v1.0** | v0.4 + jamaster üretim soak'u + API dondurma |

## 4. Riskler

| Risk | Etki | Azaltma |
|---|---|---|
| Çeviri hacmi (11 bin satır çekirdek + 3.400 satır belge) | F1 uzar | Dizin başına paralel alt ajanlar + insan gözden geçirme; İngilizce kanonik karar bir kez verildi |
| Mantıksal replikasyonun sağlayıcı kısıtları | F6 küçülür | Spike önce, matris dürüst |
| Rename sırasında kalıcı dizge değişmesi | Karışık filo kilitlenmesi | D14 + otomatik test: kilit anahtarları/ledger adları değişmedi |
| Jamaster ayrımı canlı sistemi bozar | Tüketici etkilenir | Ayrım ayrı PR; jamaster eski kopyada kalır (kopyala-ve-devam kararı) |
| "Bölgeli" iddiası gerçek ağda doğrulanmadı | Güven kaybı | Etiketler (⚠️), ikinci bölge compose'u, gerçek sağlayıcı doğrulaması F5.3 |

## 5. Hemen sonraki adım

Onay + §10 yanıtları → F0.2/F0.3 (paralel) → F1 için `writing-plans` ile görev düzeyinde plan → uygulama.
