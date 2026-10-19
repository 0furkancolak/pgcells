# Sağlayıcı araçları (B3) Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Neon branching ile üç araç ve Supabase için PITR kaydı eklemek: `neon export-tenant` (tenant'ın geçmiş anının export klasörü), `migrate-all --safety-point neon|supabase`, `neon stage-copy`.

**Architecture:** `src/core/tools/neon.ts` yalnızca `fetch` kullanır. Neon projesi, hesabın projelerinin endpoint listesiyle düğüm host'ları eşleştirilerek bulunur (env yok). Üç Neon aracı tek çekirdeği paylaşır: düğümler (proje, kaynak branch) çiftine göre gruplanır, her gruptan bir branch açılır (`pre-migrate`, `stage`, `pitr` öneki; `pitr` için `parent_timestamp`). `export-tenant` geçici branch'lerin bağlantı bilgileriyle bir `Management` kurup mevcut `exportTenant`'ı çağırır. Neon API anahtarı gizli girişle sorulur. Hiçbir branch silinmez.

**Tech Stack:** Bun, TypeScript, `fetch`, `bun:test`. Neon API v2 (`https://console.neon.tech/api/v2`).

**Spec:** `docs/superpowers/specs/2026-10-03-neon-supabase-design.md` (bölüm B3)

## Global Constraints

- Neon API anahtarı yalnızca gizli girişle (`askSecret`) alınır; argv, env, dosya ve günlükte bulunmaz, hiçbir hata mesajında veya çıktıda yer almaz.
- Bağlantı URI'si (şifreli) yalnızca bellekte tutulur; hiçbir çıktıya, günlüğe veya hata mesajına girmez.
- Araçlar hiçbir Neon branch'i silmez.
- Sağlayıcı URL'den tahmin edilmez: komut adı (`neon …`) veya `--safety-point neon|supabase` sağlayıcıyı belirler.
- Yeni ortam değişkeni yok.
- Canlı veriye yazma yok: `export-tenant` yalnızca okur; geri yükleme mevcut `restore` ile yapılır (`TENANT_EXISTS` koruması aynen kalır).
- Yeni hata kodları: `PROVIDER_API_ERROR`, `PROVIDER_NODE_NOT_FOUND`.
- Yorumlar Türkçe, hata mesajları İngilizce; yakındaki kodun yorum yoğunluğu ve adlandırması korunur.
- Commit sonuna: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push ve PR yok.
- Neon API alanları (2026-10 belgelerinden): `POST /projects/{id}/branches` gövdesi `{ branch: { name, parent_id, parent_timestamp? }, endpoints: [{ type: "read_write" }] }`, yanıt `{ branch, endpoints, operations, connection_uris }`; `GET /projects` (`limit` 1–400, `cursor`, `org_id`; `projects[].id`, `pagination.cursor`); `GET /projects/{id}/endpoints` (`endpoints[].id|host|branch_id`); `GET /projects/{id}/operations/{op}` (`operation.action|status|error`, durumlar `scheduling|running|finished|failed|error|cancelling|cancelled|skipped`); `GET /projects/{id}/connection_uri` (`database_name`, `role_name` zorunlu; `branch_id`, `endpoint_id`; yanıt `{ uri }`). Supabase PITR: `POST https://api.supabase.com/v1/projects/{ref}/database/backups/restore-pitr`, gövde `{ recovery_time_target_unix }`.

## Review Focus

- Aynı projedeki iki ayrı kaynak branch aynı adı alıp Neon'da çakışmamalı (Task 2 testi).
- İkinci branch açılamazsa ilk branch silinmemeli ve hata, açılmış branch'leri adıyla listelemeli; `migrate-all` hiç başlamamalı (Task 2 ve Task 4 testleri).
- Operasyon `failed` olur veya süre dolarsa araç başarı bildirmemeli (Task 2).
- Hiçbir mesajda API anahtarı, şifreli URI veya host dışında kimlik bilgisi bulunmamalı (Task 1, Task 3 testleri).
- Gelecek veya geçersiz `--at` Neon'a hiç gitmeden `USAGE` vermeli (Task 3, Task 4).

---

## Dosya yapısı

- Create: `src/core/tools/neon.ts`: API istemcisi, düğüm eşleme, branch çekirdeği, üç araç, Supabase kaydı, girdi doğrulayıcıları.
- Create: `src/__tests__/unit/neon-tools.test.ts`.
- Modify: `src/core/cli.ts` (`CliOptions`, iki yeni komut, `migrate-all`), `src/__tests__/unit/cli.test.ts`.
- Modify: `docs/cli.md`, `docs/providers.md`, `docs/errors.md`, `docs/operations.md`.

Tüm yollar `packages/db`'ye göredir; komutlar `packages/db` içinde çalışır. Dal: `feat/provider-support` (B1 ve B2'den devam).

### Task 1: Neon API istemcisi ve düğüm eşleme

**Files:**
- Create: `src/core/tools/neon.ts`
- Test: `src/__tests__/unit/neon-tools.test.ts`

**Interfaces:**
- Produces:
  - `interface NeonApi { request<T>(method: "GET" | "POST", path: string, options?: { query?: Record<string, string>; body?: unknown }): Promise<T> }`
  - `neonApi(apiKey: string, options?: { fetch?: (input: URL, init?: RequestInit) => Promise<Response>; baseUrl?: string }): NeonApi` (boş anahtar `USAGE`)
  - `interface NeonNode { nodeId: string; projectId: string; branchId: string; endpointId: string; host: string; database: string; role: string }`
  - `resolveNodes(api: NeonApi, nodes: readonly DatabaseNode[], options?: { org?: string; pageSize?: number }): Promise<NeonNode[]>`

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/neon-tools.test.ts`:

```ts
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { neonApi, resolveNodes } from "../../core/tools/neon";

const KEY = "neon-key-123";
type Call = { method: string; path: string; query: Record<string, string>; body: unknown; auth: string | null };

/** `routes` her çağrı için gövde döndürür (veya `Response`); çağrılar kaydedilir. */
function fakeNeon(routes: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetch = async (input: URL, init?: RequestInit) => {
    const url = new URL(input);
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v2", ""),
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const result = routes(call);
    return result instanceof Response ? result : Response.json(result);
  };
  return { calls, api: neonApi(KEY, { fetch, baseUrl: "https://neon.test/api/v2" }) };
}

test("neonApi sends the bearer key, query and JSON body; a missing key is rejected", async () => {
  const fake = fakeNeon(() => ({ ok: true }));
  await fake.api.request("POST", "/projects/p1/branches", { query: { a: "1" }, body: { x: 2 } });
  expect(fake.calls[0]).toEqual({ method: "POST", path: "/projects/p1/branches", query: { a: "1" }, body: { x: 2 }, auth: `Bearer ${KEY}` });
  expect(() => neonApi("")).toThrow(expect.objectContaining({ code: "USAGE" }));
});

test("neonApi maps API and network failures to PROVIDER_API_ERROR and never echoes the key", async () => {
  const denied = fakeNeon(() => Response.json({ message: `token ${KEY} is invalid` }, { status: 401 }));
  const error = await denied.api.request("GET", "/projects").catch((e: unknown) => e as Error & { code: string });
  expect(error).toMatchObject({ code: "PROVIDER_API_ERROR", message: "Neon API GET /projects failed with 401: token [hidden] is invalid" });
  const offline = neonApi(KEY, {
    fetch: async () => {
      throw new Error(`connect ECONNREFUSED with ${KEY}`);
    },
  });
  const unreachable = await offline.request("GET", "/projects").catch((e: unknown) => e as Error & { code: string });
  expect(unreachable).toMatchObject({ code: "PROVIDER_API_ERROR", message: "Neon API GET /projects could not be reached" });
});

const project = (id: string) => ({ id });
const endpointsOf = (host: string, branch: string, id: string) => ({ endpoints: [{ id, host, branch_id: branch, type: "read_write" }] });

test("resolveNodes pages through projects, matches pooled and direct hosts and reads database and role from the URL", async () => {
  const fake = fakeNeon(({ path, query }) => {
    if (path === "/projects") return query.cursor ? { projects: [project("p3")], pagination: {} } : { projects: [project("p1"), project("p2")], pagination: { cursor: "c1" } };
    if (path === "/projects/p1/endpoints") return endpointsOf("ep-aaa.eu.neon.tech", "br-1", "ep-aaa");
    if (path === "/projects/p2/endpoints") return endpointsOf("ep-bbb.eu.neon.tech", "br-2", "ep-bbb");
    return endpointsOf("ep-ccc.eu.neon.tech", "br-3", "ep-ccc");
  });
  const { nodes } = createConfig(["postgres://owner:pw@ep-aaa-pooler.eu.neon.tech/app?sslmode=require", "postgres://role%20x:pw@ep-ccc.eu.neon.tech/other%20db"]);
  const resolved = await resolveNodes(fake.api, nodes, { org: "org-1", pageSize: 2 });
  expect(resolved).toEqual([
    { nodeId: "db0", projectId: "p1", branchId: "br-1", endpointId: "ep-aaa", host: "ep-aaa.eu.neon.tech", database: "app", role: "owner" },
    { nodeId: "db1", projectId: "p3", branchId: "br-3", endpointId: "ep-ccc", host: "ep-ccc.eu.neon.tech", database: "other db", role: "role x" },
  ]);
  expect(fake.calls.filter((call) => call.path === "/projects").map((call) => call.query)).toEqual([
    { limit: "2", org_id: "org-1" },
    { limit: "2", cursor: "c1", org_id: "org-1" },
  ]);
});

test("resolveNodes names unmatched nodes only by id", async () => {
  const fake = fakeNeon(({ path }) => (path === "/projects" ? { projects: [project("p1")], pagination: {} } : endpointsOf("ep-aaa.eu.neon.tech", "br-1", "ep-aaa")));
  const { nodes } = createConfig(["postgres://owner:secret-pw@ep-aaa.eu.neon.tech/app", "postgres://owner:secret-pw@ep-zzz.eu.neon.tech/app"]);
  const error = await resolveNodes(fake.api, nodes).catch((e: unknown) => e as Error & { code: string });
  expect(error).toMatchObject({ code: "PROVIDER_NODE_NOT_FOUND" });
  expect(error.message).toContain("db1");
  expect(error.message).not.toContain("ep-zzz");
  expect(error.message).not.toContain("secret-pw");
});
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/neon-tools.test.ts`
Expected: FAIL (`Cannot find module '../../core/tools/neon'`).

- [ ] **Step 3: Gerçekle**

`src/core/tools/neon.ts`:

```ts
/** Neon API ile branch araçları: `migrate-all` öncesi güvenlik noktası, migrasyon denemesi için staging kopyası ve tenant'ın geçmiş
 * anının export'u. Yalnızca `fetch` kullanır; API anahtarı ve şifreli bağlantı URI'si bellekte tutulur, hiçbir çıktıya veya hata
 * mesajına girmez. Branch'ler asla silinmez. */
import type { DatabaseNode } from "../config";
import { AppError } from "../errors";

const BASE_URL = "https://console.neon.tech/api/v2";
const MAX_MESSAGE_CHARS = 300;
const PROJECT_PAGE_SIZE = 100;

type Fetch = (input: URL, init?: RequestInit) => Promise<Response>;

export interface NeonApi {
  request<T>(method: "GET" | "POST", path: string, options?: { query?: Record<string, string>; body?: unknown }): Promise<T>;
}

/** Neon API v2 istemcisi; hata mesajları anahtarı içermez. */
export function neonApi(apiKey: string, { fetch: send = fetch, baseUrl = BASE_URL }: { fetch?: Fetch; baseUrl?: string } = {}): NeonApi {
  if (!apiKey) throw new AppError("USAGE", "Neon API key was not entered");
  const hide = (text: string) => text.split(apiKey).join("[hidden]");
  return {
    async request<T>(method: "GET" | "POST", path: string, { query, body }: { query?: Record<string, string>; body?: unknown } = {}) {
      const url = new URL(`${baseUrl}${path}`);
      for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
      let response: Response;
      try {
        response = await send(url, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new AppError("PROVIDER_API_ERROR", `Neon API ${method} ${path} could not be reached`);
      }
      const text = await response.text();
      if (!response.ok) {
        let message = "";
        try {
          message = String((JSON.parse(text) as { message?: unknown }).message ?? "");
        } catch {
          // Gövde JSON değil: yalnızca durum kodu yazılır.
        }
        throw new AppError("PROVIDER_API_ERROR", hide(`Neon API ${method} ${path} failed with ${response.status}${message ? `: ${message}` : ""}`).slice(0, MAX_MESSAGE_CHARS));
      }
      return (text ? JSON.parse(text) : {}) as T;
    },
  };
}

export interface NeonNode {
  nodeId: string;
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

/** `-pooler` son eki doğrudan host'a çevrilir: API endpoint'in doğrudan host'unu listeler. */
const directHost = (host: string) => host.toLowerCase().replace(/-pooler(?=\.)/, "");

/** Hesaptaki bütün projelerin endpoint'leri. */
async function listEndpoints(api: NeonApi, org: string | undefined, pageSize: number): Promise<EndpointRef[]> {
  const found: EndpointRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.request<{ projects: { id: string }[]; pagination?: { cursor?: string } }>("GET", "/projects", {
      query: { limit: String(pageSize), ...(cursor ? { cursor } : {}), ...(org ? { org_id: org } : {}) },
    });
    for (const { id } of page.projects) {
      const { endpoints } = await api.request<{ endpoints: { id: string; host: string; branch_id: string }[] }>("GET", `/projects/${id}/endpoints`);
      for (const endpoint of endpoints) found.push({ projectId: id, branchId: endpoint.branch_id, endpointId: endpoint.id, host: endpoint.host });
    }
    cursor = page.projects.length === pageSize ? page.pagination?.cursor : undefined;
  } while (cursor);
  return found;
}

/** Her düğümün host'unu hesaptaki endpoint'lerle eşleştirir; proje kimliği env gerektirmez. Eşleşmeyen düğüm yalnızca kimliğiyle raporlanır. */
export async function resolveNodes(api: NeonApi, nodes: readonly DatabaseNode[], { org, pageSize = PROJECT_PAGE_SIZE }: { org?: string; pageSize?: number } = {}): Promise<NeonNode[]> {
  const byHost = new Map((await listEndpoints(api, org, pageSize)).map((endpoint) => [directHost(endpoint.host), endpoint]));
  const resolved: NeonNode[] = [];
  const missing: string[] = [];
  for (const node of nodes) {
    const url = URL.parse(node.url);
    const endpoint = url && byHost.get(directHost(url.hostname));
    if (!url || !endpoint) {
      missing.push(node.id);
      continue;
    }
    resolved.push({ nodeId: node.id, ...endpoint, database: decodeURIComponent(url.pathname.slice(1)), role: decodeURIComponent(url.username) });
  }
  if (missing.length)
    throw new AppError("PROVIDER_NODE_NOT_FOUND", `No Neon endpoint matches ${missing.join(", ")}; check that the API key belongs to the account that owns them (use --org for an organization)`);
  return resolved;
}
```

- [ ] **Step 4: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/neon-tools.test.ts && bun run typecheck && bun run lint`
Expected: PASS 4/4; typecheck ve lint temiz.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/neon.ts src/__tests__/unit/neon-tools.test.ts
git commit -m "neon tools: API client and node-to-endpoint resolution (no env, key never echoed)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 2: Branch çekirdeği, güvenlik noktası ve staging kopyası

**Files:**
- Modify: `src/core/tools/neon.ts`
- Test: `src/__tests__/unit/neon-tools.test.ts`

**Interfaces:**
- Consumes: `NeonApi`, `NeonNode`, `resolveNodes` (Task 1).
- Produces:
  - `interface NeonToolOptions { org?: string; now?: Date; pageSize?: number; pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }`
  - `interface BranchRun { nodes: string[]; projectId: string; sourceBranchId: string; branchId: string; endpointId: string; name: string; host: string }`
  - `branchNodes(api: NeonApi, nodes: readonly NeonNode[], options: NeonToolOptions & { prefix: string; timestamp?: string }): Promise<BranchRun[]>`
  - `safetyPoint(m: { config: { nodes: readonly DatabaseNode[] } }, api: NeonApi, options?: NeonToolOptions): Promise<{ provider: "neon"; branches: BranchRun[] }>`
  - `stageCopy(...)`: `safetyPoint` ile aynı imza ve biçim; önek `stage`.

- [ ] **Step 1: Başarısız testleri yaz**

`neon-tools.test.ts`'e ekle (importlara `branchNodes, safetyPoint, stageCopy` ve `type NeonNode`):

```ts
import { branchNodes, type NeonNode, safetyPoint, stageCopy } from "../../core/tools/neon";

const now = new Date("2026-10-03T10:15:00.000Z");
const node = (nodeId: string, projectId: string, branchId: string): NeonNode => ({ nodeId, projectId, branchId, endpointId: `ep-${nodeId}`, host: `ep-${nodeId}.neon.test`, database: "app", role: "owner" });
const sleeps: number[] = [];
const timing = { now, pollMs: 7, timeoutMs: 1000, sleep: async (ms: number) => void sleeps.push(ms) };

/** Her `POST /branches` yeni bir branch+endpoint+operasyon döndürür; operasyon ilk sorguda `running`, ikincide `finished`. */
function branchingNeon(options: { failProject?: string; operationStatus?: string } = {}) {
  const polls = new Map<string, number>();
  return fakeNeon(({ method, path }) => {
    const create = path.match(/^\/projects\/([^/]+)\/branches$/);
    if (method === "POST" && create) {
      if (create[1] === options.failProject) return Response.json({ message: "branch limit reached" }, { status: 422 });
      return { branch: { id: `br-new-${create[1]}-${polls.size}` }, endpoints: [{ id: `ep-new-${create[1]}`, host: `ep-new-${create[1]}.neon.test` }], operations: [{ id: `op-${create[1]}-${polls.size}` }] };
    }
    const operation = path.match(/^\/projects\/[^/]+\/operations\/(.+)$/);
    if (operation) {
      const count = (polls.get(operation[1] as string) ?? 0) + 1;
      polls.set(operation[1] as string, count);
      return { operation: { action: "create_branch", status: count < 2 ? "running" : (options.operationStatus ?? "finished"), error: options.operationStatus ? "compute failed" : null } };
    }
    return {};
  });
}

test("branchNodes opens one branch per (project, source branch), names them with the prefix and time, and waits for the operations", async () => {
  const fake = branchingNeon();
  const runs = await branchNodes(fake.api, [node("db0", "p1", "br-1"), node("db1", "p1", "br-1"), node("db2", "p2", "br-9"), node("db3", "p1", "br-2")], { prefix: "pre-migrate", ...timing });
  expect(runs.map((run) => [run.nodes, run.projectId, run.sourceBranchId, run.name])).toEqual([
    [["db0", "db1"], "p1", "br-1", "pre-migrate-20261003T101500Z"],
    [["db2"], "p2", "br-9", "pre-migrate-20261003T101500Z"],
    [["db3"], "p1", "br-2", "pre-migrate-20261003T101500Z-2"],
  ]);
  const posts = fake.calls.filter((call) => call.method === "POST");
  expect(posts).toHaveLength(3);
  expect(posts[0]?.body).toEqual({ branch: { name: "pre-migrate-20261003T101500Z", parent_id: "br-1" }, endpoints: [{ type: "read_write" }] });
  expect(fake.calls.filter((call) => call.path.includes("/operations/")).length).toBe(6);
  expect(sleeps).toContain(7);
});

test("branchNodes sends parent_timestamp only when a time is given", async () => {
  const fake = branchingNeon();
  await branchNodes(fake.api, [node("db0", "p1", "br-1")], { prefix: "pitr", timestamp: "2026-10-03T09:30:00.000Z", ...timing });
  expect((fake.calls.find((call) => call.method === "POST")?.body as { branch: Record<string, unknown> }).branch).toEqual({ name: "pitr-20261003T101500Z", parent_id: "br-1", parent_timestamp: "2026-10-03T09:30:00.000Z" });
});

test("a failing second branch leaves the first one alone and the error lists what was created", async () => {
  const fake = branchingNeon({ failProject: "p2" });
  const error = await branchNodes(fake.api, [node("db0", "p1", "br-1"), node("db1", "p2", "br-9")], { prefix: "pre-migrate", ...timing }).catch((e: unknown) => e as Error & { code: string });
  expect(error).toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(error.message).toContain("branch limit reached");
  expect(error.message).toContain("pre-migrate-20261003T101500Z (project p1, branch br-new-p1-0)");
  expect(fake.calls.every((call) => ["GET", "POST"].includes(call.method))).toBe(true);
});

test("a failed operation or a timeout is an error, never a success", async () => {
  const failed = branchingNeon({ operationStatus: "failed" });
  await expect(branchNodes(failed.api, [node("db0", "p1", "br-1")], { prefix: "stage", ...timing })).rejects.toMatchObject({
    code: "PROVIDER_API_ERROR",
    message: expect.stringContaining("create_branch ended as failed: compute failed"),
  });
  const slow = fakeNeon(({ method, path }) =>
    method === "POST" ? { branch: { id: "br-x" }, endpoints: [{ id: "ep-x", host: "ep-x.neon.test" }], operations: [{ id: "op-x" }] } : path.includes("/operations/") ? { operation: { action: "create_branch", status: "running" } } : {},
  );
  await expect(branchNodes(slow.api, [node("db0", "p1", "br-1")], { prefix: "stage", ...timing, timeoutMs: 0 })).rejects.toMatchObject({ message: expect.stringContaining("did not finish within 0 ms") });
});

test("safetyPoint and stageCopy resolve the nodes first and print branch ids and hosts, never connection URIs", async () => {
  const fake = fakeNeon(({ method, path }) => {
    if (path === "/projects") return { projects: [project("p1")], pagination: {} };
    if (path === "/projects/p1/endpoints") return endpointsOf("ep-aaa.eu.neon.tech", "br-1", "ep-aaa");
    if (method === "POST") return { branch: { id: "br-new" }, endpoints: [{ id: "ep-new", host: "ep-new.neon.test" }], operations: [{ id: "op-1" }] };
    return { operation: { action: "create_branch", status: "finished" } };
  });
  const m = { config: createConfig(["postgres://owner:secret-pw@ep-aaa-pooler.eu.neon.tech/app"]) };
  const safety = await safetyPoint(m, fake.api, timing);
  expect(safety).toEqual({ provider: "neon", branches: [{ nodes: ["db0"], projectId: "p1", sourceBranchId: "br-1", branchId: "br-new", endpointId: "ep-new", name: "pre-migrate-20261003T101500Z", host: "ep-new.neon.test" }] });
  const staged = await stageCopy(m, fake.api, timing);
  expect(staged.branches[0]?.name).toBe("stage-20261003T101500Z");
  expect(JSON.stringify([safety, staged])).not.toMatch(/postgres:\/\/|secret-pw/);
});
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/neon-tools.test.ts`
Expected: FAIL (`branchNodes`/`safetyPoint`/`stageCopy` dışa aktarılmamış).

- [ ] **Step 3: Gerçekle**

`neon.ts`'e ekle:

```ts
export interface NeonToolOptions {
  org?: string;
  now?: Date;
  pageSize?: number;
  /** Operasyon yoklama aralığı ve toplam süre (ms); testler `sleep` verir. */
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BranchRun {
  nodes: string[];
  projectId: string;
  sourceBranchId: string;
  branchId: string;
  endpointId: string;
  name: string;
  host: string;
}

const OPERATION_POLL_MS = 1000;
const OPERATION_TIMEOUT_MS = 120_000;
const FAILED_OPERATION = new Set(["failed", "error", "cancelled", "skipped"]);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `20261003T101500Z`: branch adlarında saniye çözünürlüklü, sıralanabilir zaman. */
const stamp = (now: Date) => now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");

/** Operasyonlar bitene kadar yoklar; başarısız durum veya süre aşımı hata verir. */
async function waitForOperations(api: NeonApi, projectId: string, operations: readonly { id: string }[], { pollMs = OPERATION_POLL_MS, timeoutMs = OPERATION_TIMEOUT_MS, sleep = wait }: NeonToolOptions) {
  const started = Date.now();
  for (const { id } of operations)
    for (;;) {
      const { operation } = await api.request<{ operation: { action: string; status: string; error?: string | null } }>("GET", `/projects/${projectId}/operations/${id}`);
      if (operation.status === "finished") break;
      if (FAILED_OPERATION.has(operation.status))
        throw new AppError("PROVIDER_API_ERROR", `Neon operation ${operation.action} ended as ${operation.status}${operation.error ? `: ${operation.error}` : ""}`.slice(0, MAX_MESSAGE_CHARS));
      if (Date.now() - started >= timeoutMs) throw new AppError("PROVIDER_API_ERROR", `Neon operation ${operation.action} did not finish within ${timeoutMs} ms`);
      await sleep(pollMs);
    }
}

/** Düğümleri (proje, kaynak branch) çiftine göre gruplar ve her gruptan bir branch açar (`timestamp` verilirse o andan). Biri başarısız
 * olursa öncekiler silinmez; hata açılmış branch'leri adıyla listeler. Aynı projede ikinci branch adın sonuna `-2`, `-3` … alır. */
export async function branchNodes(api: NeonApi, nodes: readonly NeonNode[], options: NeonToolOptions & { prefix: string; timestamp?: string }): Promise<BranchRun[]> {
  const { prefix, timestamp, now = new Date() } = options;
  const groups = new Map<string, NeonNode[]>();
  for (const node of nodes) {
    const key = `${node.projectId}/${node.branchId}`;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  const created: BranchRun[] = [];
  const perProject = new Map<string, number>();
  try {
    for (const group of groups.values()) {
      const first = group[0] as NeonNode;
      const count = (perProject.get(first.projectId) ?? 0) + 1;
      perProject.set(first.projectId, count);
      const name = `${prefix}-${stamp(now)}${count > 1 ? `-${count}` : ""}`;
      const response = await api.request<{ branch: { id: string }; endpoints: { id: string; host: string }[]; operations: { id: string }[] }>("POST", `/projects/${first.projectId}/branches`, {
        body: { branch: { name, parent_id: first.branchId, ...(timestamp ? { parent_timestamp: timestamp } : {}) }, endpoints: [{ type: "read_write" }] },
      });
      const endpoint = response.endpoints[0];
      created.push({ nodes: group.map((member) => member.nodeId), projectId: first.projectId, sourceBranchId: first.branchId, branchId: response.branch.id, endpointId: endpoint?.id ?? "", name, host: endpoint?.host ?? "" });
      if (!endpoint) throw new AppError("PROVIDER_API_ERROR", "Neon created the branch without a compute endpoint");
      await waitForOperations(api, first.projectId, response.operations, options);
    }
  } catch (error) {
    if (!created.length) throw error;
    const detail = `Branches created before the failure (not deleted): ${created.map((run) => `${run.name} (project ${run.projectId}, branch ${run.branchId})`).join("; ")}`;
    throw new AppError(error instanceof AppError ? error.code : "PROVIDER_API_ERROR", `${error instanceof Error ? error.message : "Operation failed"}. ${detail}`);
  }
  return created;
}

type ConfiguredNodes = { config: { nodes: readonly DatabaseNode[] } };

const branchTool = (prefix: string) => async (m: ConfiguredNodes, api: NeonApi, options: NeonToolOptions = {}) => {
  const nodes = await resolveNodes(api, m.config.nodes, options);
  return { provider: "neon" as const, branches: await branchNodes(api, nodes, { ...options, prefix }) };
};

/** `migrate-all` öncesi: her kaynak branch'in o anki başlangıcından `pre-migrate-<zaman>` branch'i. Hepsi açılmadan dönmez. */
export const safetyPoint = branchTool("pre-migrate");
/** Migrasyon denemesi için `stage-<zaman>` branch'leri; yalnızca branch id'si ve host döner, şifreli URI hiç alınmaz. */
export const stageCopy = branchTool("stage");
```

- [ ] **Step 4: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/neon-tools.test.ts && bun run typecheck && bun run lint`
Expected: PASS (toplam 9); typecheck ve lint temiz.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/neon.ts src/__tests__/unit/neon-tools.test.ts
git commit -m "neon tools: branch core, pre-migrate safety point and stage copy

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 3: Tenant'ın geçmiş anı, Supabase kaydı ve girdi doğrulayıcıları

**Files:**
- Modify: `src/core/tools/neon.ts`
- Test: `src/__tests__/unit/neon-tools.test.ts`

**Interfaces:**
- Consumes: `branchNodes`, `resolveNodes`, `NeonApi`, `BranchRun`, `NeonNode` (Task 1–2); `Management`, `createManagement` (`src/core/management.ts`); `exportTenant` (`src/core/tools/backup.ts`); `createConfig`.
- Produces:
  - `parsePastTimestamp(value: string | undefined, now: Date): string` (UTC ISO; eksik, RFC 3339 değil veya gelecekse `USAGE`)
  - `safetyPointProvider(value: string | undefined): "neon" | "supabase" | undefined`
  - `supabaseSafetyPoint(now?: Date)`
  - `branchUrl(api: NeonApi, run: BranchRun, node: NeonNode): Promise<string>`
  - `exportTenantAt(m: Management, api: NeonApi, options: NeonToolOptions & { tenantId: string; dir: string; at: string; signal?: AbortSignal }, deps?: ExportDeps)` ve `interface ExportDeps { manage(config: Config): Management; export: typeof exportTenant }`

- [ ] **Step 1: Başarısız testleri yaz**

```ts
import { exportTenantAt, parsePastTimestamp, safetyPointProvider, supabaseSafetyPoint, type ExportDeps } from "../../core/tools/neon";

test("parsePastTimestamp normalises RFC 3339 times to UTC and rejects missing, malformed and future ones", () => {
  expect(parsePastTimestamp("2026-10-03T12:30:00+03:00", now)).toBe("2026-10-03T09:30:00.000Z");
  for (const value of [undefined, "", "tomorrow", "2026-10-03", "2026-10-03T10:15:00Z", "2026-10-04T00:00:00Z"])
    expect(() => parsePastTimestamp(value, now), String(value)).toThrow(expect.objectContaining({ code: "USAGE" }));
});

test("safetyPointProvider accepts neon and supabase only", () => {
  expect(safetyPointProvider(undefined)).toBeUndefined();
  expect(safetyPointProvider("neon")).toBe("neon");
  expect(safetyPointProvider("supabase")).toBe("supabase");
  expect(() => safetyPointProvider("mysql")).toThrow(expect.objectContaining({ code: "USAGE" }));
});

test("supabaseSafetyPoint records the PITR second and prints the restore request without calling anything", () => {
  expect(supabaseSafetyPoint(now)).toEqual({
    provider: "supabase",
    recoveryTimeTargetUnix: 1791022500,
    restore: { method: "POST", url: "https://api.supabase.com/v1/projects/{ref}/database/backups/restore-pitr", body: { recovery_time_target_unix: 1791022500 } },
    note: "No API call was made. Supabase PITR restores the whole project in place; restoring one tenant is not possible.",
  });
});

test("exportTenantAt opens branches at the time, builds a management over their URIs in node order, exports and closes it", async () => {
  const uris = new Map([["ep-new-p1", "postgres://owner:branch-pw-1@ep-new-p1.neon.test/app"], ["ep-new-p2", "postgres://owner:branch-pw-2@ep-new-p2.neon.test/app"]]);
  const fake = fakeNeon(({ method, path, query }) => {
    if (path === "/projects") return { projects: [project("p1"), project("p2")], pagination: {} };
    if (path === "/projects/p1/endpoints") return endpointsOf("ep-aaa.eu.neon.tech", "br-1", "ep-aaa");
    if (path === "/projects/p2/endpoints") return endpointsOf("ep-bbb.eu.neon.tech", "br-2", "ep-bbb");
    if (method === "POST") {
      const id = path.split("/")[2];
      return { branch: { id: `br-new-${id}` }, endpoints: [{ id: `ep-new-${id}`, host: `ep-new-${id}.neon.test` }], operations: [{ id: `op-${id}` }] };
    }
    if (path.endsWith("/connection_uri")) return { uri: uris.get(query.endpoint_id as string) };
    return { operation: { action: "create_branch", status: "finished" } };
  });
  const seen: { urls?: string[]; tenant?: string; dir?: string; closed: number } = { closed: 0 };
  const deps: ExportDeps = {
    manage: (config) => {
      seen.urls = config.nodes.map((n) => n.url);
      return { close: async () => void seen.closed++ } as never;
    },
    export: async (_m, tenant, dir) => {
      seen.tenant = tenant;
      seen.dir = dir;
      return { tenantId: tenant, dir, tables: 3, rows: 42 };
    },
  };
  const m = { config: createConfig(["postgres://owner:live-pw@ep-bbb.eu.neon.tech/app", "postgres://owner:live-pw@ep-aaa.eu.neon.tech/app"]) } as never;
  const result = await exportTenantAt(m, fake.api, { tenantId: "acme", dir: "/tmp/acme-at", at: "2026-10-03T09:30:00.000Z", ...timing }, deps);
  expect(seen).toEqual({ urls: ["postgres://owner:branch-pw-2@ep-new-p2.neon.test/app", "postgres://owner:branch-pw-1@ep-new-p1.neon.test/app"], tenant: "acme", dir: "/tmp/acme-at", closed: 1 });
  expect(fake.calls.filter((call) => call.method === "POST").every((call) => (call.body as { branch: { parent_timestamp?: string } }).branch.parent_timestamp === "2026-10-03T09:30:00.000Z")).toBe(true);
  expect(result).toMatchObject({ tenantId: "acme", dir: "/tmp/acme-at", rows: 42, at: "2026-10-03T09:30:00.000Z" });
  expect(result.branches.map((run) => run.name)).toEqual(["pitr-20261003T101500Z", "pitr-20261003T101500Z"]);
  expect(JSON.stringify(result)).not.toMatch(/postgres:\/\/|branch-pw|live-pw/);
});

test("exportTenantAt closes the branch management even when the export fails", async () => {
  const fake = fakeNeon(({ method, path }) => {
    if (path === "/projects") return { projects: [project("p1")], pagination: {} };
    if (path === "/projects/p1/endpoints") return endpointsOf("ep-aaa.eu.neon.tech", "br-1", "ep-aaa");
    if (method === "POST") return { branch: { id: "br-new" }, endpoints: [{ id: "ep-new", host: "ep-new.neon.test" }], operations: [{ id: "op-1" }] };
    if (path.endsWith("/connection_uri")) return { uri: "postgres://owner:pw@ep-new.neon.test/app" };
    return { operation: { action: "create_branch", status: "finished" } };
  });
  let closed = 0;
  const deps: ExportDeps = {
    manage: () => ({ close: async () => void closed++ }) as never,
    export: async () => {
      throw new Error("tenant is not active");
    },
  };
  const m = { config: createConfig(["postgres://owner:pw@ep-aaa.eu.neon.tech/app"]) } as never;
  await expect(exportTenantAt(m, fake.api, { tenantId: "acme", dir: "/tmp/x", at: "2026-10-03T09:30:00.000Z", ...timing }, deps)).rejects.toThrow("tenant is not active");
  expect(closed).toBe(1);
});

test("an invalid connection URI from the API is rejected without printing it", async () => {
  const fake = fakeNeon(() => ({ uri: "mysql://leak-pw@host/db" }));
  const run = { nodes: ["db0"], projectId: "p1", sourceBranchId: "br-1", branchId: "br-new", endpointId: "ep-new", name: "pitr", host: "h" };
  const error = await branchUrl(fake.api, run, node("db0", "p1", "br-1")).catch((e: unknown) => e as Error & { code: string });
  expect(error).toMatchObject({ code: "PROVIDER_API_ERROR", message: "Neon returned an invalid connection URI" });
});
```

(`branchUrl` importu ekle.)

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/neon-tools.test.ts`
Expected: FAIL (yeni dışa aktarımlar yok).

- [ ] **Step 3: Gerçekle**

`neon.ts`'e ekle (importlar: `import { type Config, createConfig, type DatabaseNode } from "../config";` ve `import type { Management } from "../management";`, `import type { exportTenant } from "./backup";`):

```ts
const usage = (message: string) => new AppError("USAGE", message);

/** `--at`: RFC 3339 ve geçmişte olmalı; Neon'a gitmeden doğrulanır. Çıktı UTC ISO'dur. */
export function parsePastTimestamp(value: string | undefined, now: Date): string {
  if (!value) throw usage("--at <RFC 3339 time> is required");
  const time = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(time)) throw usage("--at must be an RFC 3339 time such as 2026-10-03T09:30:00Z");
  if (time >= now.getTime()) throw usage("--at must be in the past");
  return new Date(time).toISOString();
}

export function safetyPointProvider(value: string | undefined): "neon" | "supabase" | undefined {
  if (value === undefined) return undefined;
  if (value === "neon" || value === "supabase") return value;
  throw usage("--safety-point must be neon or supabase");
}

/** Supabase: yalnızca PITR saniyesi kaydedilir ve geri yükleme isteği yazdırılır; API çağrısı yapılmaz, anahtar istenmez. */
export function supabaseSafetyPoint(now = new Date()) {
  const recoveryTimeTargetUnix = Math.floor(now.getTime() / 1000);
  return {
    provider: "supabase" as const,
    recoveryTimeTargetUnix,
    restore: { method: "POST", url: "https://api.supabase.com/v1/projects/{ref}/database/backups/restore-pitr", body: { recovery_time_target_unix: recoveryTimeTargetUnix } },
    note: "No API call was made. Supabase PITR restores the whole project in place; restoring one tenant is not possible.",
  };
}

/** Branch'in şifreli bağlantı URI'si; yalnızca bellekte kullanılır. */
export async function branchUrl(api: NeonApi, run: BranchRun, node: NeonNode): Promise<string> {
  const { uri } = await api.request<{ uri: string }>("GET", `/projects/${run.projectId}/connection_uri`, {
    query: { database_name: node.database, role_name: node.role, branch_id: run.branchId, endpoint_id: run.endpointId },
  });
  const url = URL.parse(uri);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) throw new AppError("PROVIDER_API_ERROR", "Neon returned an invalid connection URI");
  return uri;
}

export interface ExportDeps {
  manage(config: Config): Management;
  export: typeof exportTenant;
}

const defaultDeps = async (m: Management): Promise<ExportDeps> => {
  const [{ createManagement }, { exportTenant: exportOne }] = await Promise.all([import("../management"), import("./backup")]);
  return { manage: (config) => createManagement(config, { driver: m.driver }), export: exportOne };
};

/** Tenant'ın `at` anındaki halini `dir`'e export eder: her kaynak branch'ten o ana geçici branch açılır, bağlantı bilgileriyle (düğüm sırası
 * korunur) geçici bir `Management` kurulur ve mevcut `exportTenant` çalışır. Canlı veriye yazılmaz, branch'ler silinmez; uygulamak `restore` iledir. */
export async function exportTenantAt(
  m: Management,
  api: NeonApi,
  { tenantId, dir, at, signal, ...options }: NeonToolOptions & { tenantId: string; dir: string; at: string; signal?: AbortSignal },
  deps?: ExportDeps,
) {
  const nodes = await resolveNodes(api, m.config.nodes, options);
  const branches = await branchNodes(api, nodes, { ...options, prefix: "pitr", timestamp: at });
  const urls = await Promise.all(nodes.map((node) => branchUrl(api, branches.find((run) => run.nodes.includes(node.nodeId)) as BranchRun, node)));
  const { manage, export: exportAt } = deps ?? (await defaultDeps(m));
  const past = manage(createConfig(urls));
  try {
    const exported = await exportAt(past, tenantId, dir, { signal });
    return {
      ...exported,
      at,
      branches,
      note: "Temporary branches were not deleted. Apply the export with `restore <tenant> <dir>` (the tenant must be missing).",
    };
  } finally {
    await past.close().catch(() => {});
  }
}
```

`branches` çıktısında bağlantı URI'si yoktur (`BranchRun` yalnızca kimlik ve host taşır).

- [ ] **Step 4: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/neon-tools.test.ts && bun run typecheck && bun run lint`
Expected: PASS (toplam 15); typecheck ve lint temiz.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/neon.ts src/__tests__/unit/neon-tools.test.ts
git commit -m "neon tools: point-in-time tenant export, Supabase PITR record and input validators

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 4: CLI bağlantısı

**Files:**
- Modify: `src/core/cli.ts`
- Test: `src/__tests__/unit/cli.test.ts`

**Interfaces:**
- Consumes: `askSecret` (`src/core/tools/ask-secret.ts`), Task 1–3'ün dışa aktarımları.
- Produces: komutlar `neon stage-copy [--org ID]`, `neon export-tenant <tenant> <dir> --at ZAMAN [--org ID]` (usage metninde `<zaman>` yazılmaz: `requiredCount` `<` sayar); `migrate-all --safety-point neon|supabase [--org ID]`.

- [ ] **Step 1: Başarısız testleri yaz**

`src/__tests__/unit/cli.test.ts` sonuna ekle:

```ts
const DB = { DATABASE_URLS: "postgres://owner:pw@127.0.0.1:1/app" };
const failureOf = (stderr: string) => JSON.parse(stderr.trim().split("\n").at(-1) ?? "") as { error: string; message: string };

test.each([
  { args: ["neon", "export-tenant", "acme", "out"], message: "--at" },
  { args: ["neon", "export-tenant", "acme", "out", "--at", "tomorrow"], message: "RFC 3339" },
  { args: ["neon", "export-tenant", "acme", "out", "--at", "2999-01-01T00:00:00Z"], message: "past" },
  { args: ["migrate-all", "--safety-point", "mysql"], message: "neon or supabase" },
  { args: ["migrate-all", "--org", "org-1"], message: "--org" },
  { args: ["migrate-all", "--org", "org-1", "--safety-point", "supabase"], message: "--org" },
])("provider options are validated before anything is contacted or asked: %p", async ({ args, message }) => {
  const result = await runCli(args, DB);
  expect(result.exitCode).toBe(1);
  const failure = failureOf(result.stderr);
  expect(failure.error).toBe("USAGE");
  expect(failure.message).toContain(message);
});

test("neon commands ask for the API key with hidden input and stop when nothing is entered", async () => {
  const result = await runCli(["neon", "stage-copy"], DB);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Neon API anahtarı");
  expect(failureOf(result.stderr).error).toBe("USAGE");
});
```

- [ ] **Step 2: Çalıştır, başarısız olduğunu gör**

Run: `bun test src/__tests__/unit/cli.test.ts`
Expected: FAIL (`Bilinmeyen komut: neon stage-copy` ve `Unknown option: --safety-point` / `--org`).

- [ ] **Step 3: Gerçekle**

`src/core/cli.ts`:

1. `CliOptions`'a `at?: string; safetyPoint?: string; org?: string;` ekle.
2. Yardımcıları (`askUrls`'in yanına) ekle:

```ts
const NEON_KEY_QUESTION = "Neon API anahtarı (yazılan görünmez): ";
const neon = () => import("./tools/neon");
/** Neon API anahtarı argv'ye veya env'e girmez; gizli girişle sorulur. */
const askNeonApi = async () => {
  const [{ askSecret }, { neonApi }] = await Promise.all([import("./tools/ask-secret"), neon()]);
  return neonApi(await askSecret(NEON_KEY_QUESTION));
};
```

3. `migrate-all` komutunu şöyle değiştir:

```ts
  "migrate-all": {
    usage: "[--seçenekler] [--safety-point neon|supabase] [--org ID]",
    summary: "Güncel olmayan tenant'ları topluca migrate eder (--safety-point: önce sağlayıcıda güvenlik noktası alır)",
    flags: [...MIGRATION_FLAGS, "--safety-point", "--org"],
    cancellable: true,
    run: async ({ api, app, options }) => {
      const tools = options.safetyPoint === undefined && options.org === undefined ? undefined : await neon();
      const provider = tools?.safetyPointProvider(options.safetyPoint);
      if (options.org !== undefined && provider !== "neon") throw usage("--org applies to --safety-point neon");
      if (tools && provider)
        print(provider === "neon" ? await tools.safetyPoint(app, await askNeonApi(), { org: options.org }) : tools.supabaseSafetyPoint());
      return exitOnFailure(await api.migrateAll(app, options));
    },
  },
```

4. İki yeni komutu (`export`/`restore` komutlarının yanına) ekle:

```ts
  "neon stage-copy": {
    usage: "[--org ID]",
    summary: "Neon: her kaynak branch'ten migrasyon denemesi için branch açar (branch id ve host yazılır, şifreli URI yazılmaz)",
    flags: ["--org"],
    run: async ({ app, options }) => (await neon()).stageCopy(app, await askNeonApi(), { org: options.org }),
  },
  "neon export-tenant": {
    usage: "<tenant> <dir> --at ZAMAN [--org ID]",
    summary: "Neon: tenant'ın geçmiş anını export klasörüne yazar (canlı veriye dokunmaz; uygulamak için restore)",
    flags: ["--at", "--org"],
    cancellable: true,
    run: async ({ app, options }, tenant, dir) => {
      const tools = await neon();
      const at = tools.parsePastTimestamp(options.at, new Date());
      return tools.exportTenantAt(app, await askNeonApi(), { tenantId: tenant, dir, at, org: options.org, signal: options.signal });
    },
  },
```

`neon` iki kelimeli komut adıdır (`resolveCommand` iki kelimeliyi önce eşler).

- [ ] **Step 4: Çalıştır, geçtiğini gör**

Run: `bun test src/__tests__/unit/cli.test.ts src/__tests__/unit/tools-cli.test.ts && bun run test && bun run typecheck && bun run lint`
Expected: yeni testler dahil tüm birim paketi yeşil; typecheck ve lint temiz.

- [ ] **Step 5: Commit**

```bash
git add src/core/cli.ts src/__tests__/unit/cli.test.ts
git commit -m "cli: neon stage-copy, neon export-tenant and migrate-all --safety-point

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 5: Belgeler

**Files:**
- Modify: `docs/cli.md`, `docs/providers.md`, `docs/errors.md`, `docs/operations.md`

- [ ] **Step 1: `docs/cli.md` ve `docs/errors.md`**

`cli.md` komut tablosuna ekle: `neon stage-copy [--org ID]`, `neon export-tenant <tenant> <dir> --at <zaman> [--org ID]` ve `migrate-all`'a `--safety-point neon|supabase [--org ID]`; hepsi için ortak not: Neon API anahtarı gizli girişle sorulur (argv/env yok), `--org` yalnızca kimlik bir organizasyona bağlıysa. `errors.md`'ye `PROVIDER_API_ERROR` (Neon API hatası veya erişilemedi; durum kodu ve Neon mesajı) ve `PROVIDER_NODE_NOT_FOUND` (bir düğümün host'u hesaptaki endpoint'lerle eşleşmedi) satırlarını ekle.

- [ ] **Step 2: `docs/providers.md` ve `docs/operations.md`**

`providers.md`'ye "Sağlayıcı araçları" bölümü: (a) üç Neon aracı (ne açar, ne yazdırır, branch'lerin silinmediği ve ücretsiz plan branch limiti, geçmiş saklama süresinin sınırı), (b) `export-tenant` akışı örnek komutlarla (`neon export-tenant acme ./acme-at --at 2026-10-03T09:30:00Z`, sonra tenant eksikse `restore acme ./acme-at`; tenant canlıysa `TENANT_EXISTS` koruması), (c) Supabase güvenlik noktası: yalnızca saniye kaydı + `restore-pitr` isteği (yer tutucu `{ref}`), PITR'ın tüm projeyi yerinde ve kesintiyle geri yüklediği, tenant bazında geri yükleme olmadığı. `operations.md`'de migrasyon bölümüne "Yönetilen sağlayıcıda `migrate-all --safety-point` ile önce güvenlik noktası alın; geri dönüş Neon'da branch'i inceleyip `export`/`restore` ile, Supabase'de PITR ile" notunu ekle.

- [ ] **Step 3: Doğrula ve commit**

Run: `grep -n "safety-point" docs/cli.md docs/providers.md docs/operations.md && grep -n "PROVIDER_API_ERROR" docs/errors.md && bun run lint`
Expected: üç belgede `safety-point`, `errors.md`'de iki kod geçer; lint temiz.

```bash
git add docs
git commit -m "docs: neon tools, safety point and the two provider error codes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 6: Gerçek Neon koşusu (sahibe bağlı)

Bu görev sahibin ücretsiz Neon hesabını ve içinde en az bir tenant olan bir projeyi gerektirir; plan burada durur ve sahibe sorar.

- [ ] **Step 1: Sahibe talimat ver**

Mesaj: Neon ücretsiz projenizde (`DATABASE_URLS` Neon direct URL'leriniz), API anahtarını gizli istemde girerek sırayla:

```bash
bun run cli neon stage-copy
bun run cli migrate-all --safety-point neon --dry-run
bun run cli neon export-tenant <tenant> ./tenant-at --at <geçmişte, geçmiş saklama süresi içinde bir zaman>
```

Çıktılardaki JSON'u (branch id'leri ve host'lar; şifre yok) yapıştırın. Sonra Neon konsolundan `stage-…`, `pre-migrate-…` ve `pitr-…` branch'lerini silin (araçlar silmez). Organizasyon hesabıysanız komutlara `--org <id>` ekleyin. Başarısız olursa hata mesajını (anahtar içermez) yapıştırın.

- [ ] **Step 2: Sonucu işle**

`docs/providers.md`'ye gerçek çalıştırmadan öğrenilenleri ekle: ücretsiz planın geçmiş saklama süresi, branch limiti, `--org` gerekip gerekmediği, branch'in hazır olma süresi. Beklenmeyen API davranışı (ör. `endpoints` listesinde host eşleşmemesi, `connection_uri` hatası) varsa önce plana bir görev ve RED testi ekle, sonra düzelt.

- [ ] **Step 3: Doğrula ve commit**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: yeşil.

```bash
git add docs/providers.md
git commit -m "docs: neon tools results from a real project

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
