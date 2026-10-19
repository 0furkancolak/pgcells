import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { AppError } from "../../core/errors";
import { branchNodes, branchUrl, type ExportDeps, exportTenantAt, neonApi, type NeonNode, parsePastTimestamp, resolveNodes, safetyPoint, safetyPointProvider, stageCopy, supabaseSafetyPoint } from "../../core/tools/neon";

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
  const error = (await resolveNodes(fake.api, nodes).catch((e: unknown) => e)) as Error & { code: string };
  expect(error).toMatchObject({ code: "PROVIDER_NODE_NOT_FOUND" });
  expect(error.message).toContain("db1");
  expect(error.message).not.toContain("ep-zzz");
  expect(error.message).not.toContain("secret-pw");
});

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
  const error = (await branchNodes(fake.api, [node("db0", "p1", "br-1"), node("db1", "p2", "br-9")], { prefix: "pre-migrate", ...timing }).catch((e: unknown) => e)) as Error & { code: string };
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

test("parsePastTimestamp normalises RFC 3339 times to UTC and rejects missing, malformed and future ones", () => {
  expect(parsePastTimestamp("2026-10-03T12:30:00+03:00", now)).toBe("2026-10-03T09:30:00.000Z");
  expect(parsePastTimestamp("2026-10-03t09:30:00z", now)).toBe("2026-10-03T09:30:00.000Z");
  expect(parsePastTimestamp("2026-10-03T09:30:00.5Z", now)).toBe("2026-10-03T09:30:00.500Z");
  for (const value of [undefined, "", "tomorrow", "2026-10-03", "2026-10-03T10:15:00Z", "2026-10-04T00:00:00Z", "2026-10-03T09:30:00", "2026-10-03T09:30Z", "2026-02-30T00:00:00Z", "2026-10-03T24:00:00Z", "2026-10-03T09:30:00+3"])
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
    note: "No API call was made. Supabase PITR is a paid add-on (Pro, Team or Enterprise); without it this time is not a restore point. PITR restores the whole project in place; restoring one tenant is not possible.",
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
      throw new AppError("TENANT_UNAVAILABLE", "tenant is not active");
    },
  };
  const m = { config: createConfig(["postgres://owner:pw@ep-aaa.eu.neon.tech/app"]) } as never;
  await expect(exportTenantAt(m, fake.api, { tenantId: "acme", dir: "/tmp/x", at: "2026-10-03T09:30:00.000Z", ...timing }, deps)).rejects.toThrow("tenant is not active");
  expect(closed).toBe(1);
});

test("an invalid connection URI from the API is rejected without printing it", async () => {
  const fake = fakeNeon(() => ({ uri: "mysql://leak-pw@host/db" }));
  const run = { nodes: ["db0"], projectId: "p1", sourceBranchId: "br-1", branchId: "br-new", endpointId: "ep-new", name: "pitr", host: "h" };
  const error = (await branchUrl(fake.api, run, node("db0", "p1", "br-1")).catch((e: unknown) => e)) as Error & { code: string };
  expect(error).toMatchObject({ code: "PROVIDER_API_ERROR", message: "Neon returned an invalid connection URI" });
});

const pitrNeon = () =>
  fakeNeon(({ method, path }) => {
    if (path === "/projects") return { projects: [project("p1")], pagination: {} };
    if (path === "/projects/p1/endpoints") return endpointsOf("ep-aaa.eu.neon.tech", "br-1", "ep-aaa");
    if (method === "POST") return { branch: { id: "br-new" }, endpoints: [{ id: "ep-new", host: "ep-new.neon.test" }], operations: [{ id: "op-1" }] };
    if (path.endsWith("/connection_uri")) return { uri: "postgres://owner:pw@ep-new.neon.test/app" };
    return { operation: { action: "create_branch", status: "finished" } };
  });

test("exportTenantAt names the branches it left behind when a later step fails, without echoing driver errors", async () => {
  const m = { config: createConfig(["postgres://owner:pw@ep-aaa.eu.neon.tech/app"]) } as never;
  const detail = "Branches created before the failure (not deleted): pitr-20261003T101500Z (project p1, branch br-new)";
  const failing = (error: Error): ExportDeps => ({ manage: () => ({ close: async () => {} }) as never, export: async () => Promise.reject(error) });
  const app = await exportTenantAt(m, pitrNeon().api, { tenantId: "acme", dir: "/tmp/x", at: "2026-10-03T09:30:00.000Z", ...timing }, failing(new AppError("TENANT_UNAVAILABLE", "Only active tenants can be exported"))).catch((e: unknown) => e as Error & { code: string });
  expect(app).toMatchObject({ code: "TENANT_UNAVAILABLE" });
  expect((app as Error).message).toBe(`Only active tenants can be exported. ${detail}`);
  const driver = await exportTenantAt(m, pitrNeon().api, { tenantId: "acme", dir: "/tmp/x", at: "2026-10-03T09:30:00.000Z", ...timing }, failing(new Error("connect ECONNREFUSED ep-new.neon.test with owner:pw"))).catch((e: unknown) => e as Error & { code: string });
  expect((driver as Error).message).toBe(`Neon export failed (OPERATION_FAILED). ${detail}`);
  expect((driver as Error).message).not.toMatch(/ECONNREFUSED|owner:pw/);
});
