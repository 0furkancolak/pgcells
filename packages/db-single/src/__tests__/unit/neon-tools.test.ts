import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSafetyPoint } from "../../core/cli";
import type { createConfig } from "../../core/config";
import type { Management } from "../../core/management";
import { branchUrl, exportAt, neonApi, parsePastTimestamp, resolveNode, safetyPoint, safetyPointProvider, stageCopy, supabaseSafetyPoint } from "../../core/tools/neon";

const KEY = "neon-secret-key";
const URL_ = "postgres://app_owner:db-secret@ep-cool-123-pooler.eu-central-1.aws.neon.tech/appdb";
type Route = (init: RequestInit | undefined, url: URL) => unknown;

/** Sahte Neon API'si: `<YÖNTEM> <yol>` → cevap; her çağrı kaydedilir. */
function fake(routes: Record<string, Route>, apiOptions: { signal?: AbortSignal; timeoutMs?: number } = {}) {
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
  return { api: neonApi(KEY, { fetch: send, ...apiOptions }), calls };
}
const projects: Route = () => ({ projects: [{ id: "p1" }] });
const endpoints: Route = () => ({ endpoints: [{ id: "ep1", host: "ep-cool-123.eu-central-1.aws.neon.tech", branch_id: "br1" }] });
const created: Route = () => ({ branch: { id: "br2" }, endpoints: [{ id: "ep2", host: "ep-new-9.eu-central-1.aws.neon.tech" }], operations: [{ id: "op1" }] });
const finished: Route = () => ({ operation: { action: "create_branch", status: "finished" } });
const happy = { "GET /projects": projects, "GET /projects/p1/endpoints": endpoints, "POST /projects/p1/branches": created, "GET /projects/p1/operations/op1": finished };
const now = new Date("2026-10-03T10:15:00Z");
/** Var olmayan export hedefi (`exportAt` var olan hedefi baştan reddeder). */
const MISSING = join(tmpdir(), `neon-tools-${crypto.randomUUID()}`);

test("the API client sends the key but never lets it (or a network detail) reach a message", async () => {
  const unreachable = neonApi(KEY, { fetch: async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); } });
  const down = await unreachable.request<never>("GET", "/projects").catch((e: unknown) => e as Error);
  expect(down).toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(down.message).not.toContain(KEY);
  const denied = neonApi(KEY, { fetch: async () => new Response(JSON.stringify({ message: `bad token ${KEY}` }), { status: 403 }) });
  const error = await denied.request<never>("GET", "/projects").catch((e: unknown) => e as Error);
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
  const org = fake(happy);
  await resolveNode(org.api, URL_, { org: "org-1" });
  expect(org.calls[0]?.query).toContain("org_id=org-1");
});

test("a 2xx answer that is not JSON or lacks the expected fields is PROVIDER_API_ERROR without its raw text, and names the branch it may have left", async () => {
  const garbled = neonApi(KEY, { fetch: async () => new Response(`<html>${KEY} proxy-token</html>`, { status: 200 }) });
  const error = (await garbled.request<never>("GET", "/projects").catch((e: unknown) => e)) as Error;
  expect(error).toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(error.message).not.toMatch(/proxy-token|html|neon-secret/);
  for (const routes of [{ "POST /projects/p1/branches": () => ({}) }, { "GET /projects/p1/operations/op1": () => ({ nope: 1 }) }]) {
    const shapeless = (await safetyPoint({ config: { url: URL_ } }, fake({ ...happy, ...routes }).api, { now }).catch((e: unknown) => e)) as Error;
    expect(shapeless).toMatchObject({ code: "PROVIDER_API_ERROR" });
    expect(shapeless.message).toContain("pre-migrate-20261003T101500Z");
    expect(shapeless.message).not.toMatch(/undefined|evaluating|is not/);
  }
  await expect(resolveNode(fake({ ...happy, "GET /projects": () => ({ items: [] }) }).api, URL_)).rejects.toMatchObject({ code: "PROVIDER_API_ERROR" });
});

test("project paging stops after a bounded number of pages even if the API keeps returning a cursor", async () => {
  const { api, calls } = fake({ ...happy, "GET /projects": () => ({ projects: [{ id: "p1" }], pagination: { cursor: "same" } }), "GET /projects/p1/endpoints": () => ({ endpoints: [] }) });
  await expect(resolveNode(api, URL_, { pageSize: 1 })).rejects.toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(calls.filter((call) => call.path === "/projects").length).toBe(100);
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
  const result = await exportAt(m, api, { dir: MISSING, at: "2026-10-03T09:30:00.000Z", now }, deps);
  expect(managed).toBe("postgres://u:branch-secret@ep-new-9/appdb");
  expect(closed).toBe(true);
  expect(result).toMatchObject({ dir: MISSING, tables: 2, rows: 5, at: "2026-10-03T09:30:00.000Z", branch: { name: "pitr-20261003T101500Z" } });
  expect(JSON.stringify(result)).not.toContain("branch-secret");
  expect((calls.find((c) => c.method === "POST")?.body as { branch: Record<string, unknown> }).branch.parent_timestamp).toBe("2026-10-03T09:30:00.000Z");
  const failing = { ...deps, export: async () => { throw new Error("driver says branch-secret"); } };
  const error = (await exportAt(m, fake({ ...happy, "GET /projects/p1/connection_uri": () => ({ uri: "postgres://u:branch-secret@ep-new-9/appdb" }) }).api, { dir: MISSING, at: "2026-10-03T09:30:00.000Z", now }, failing).catch((e: unknown) => e)) as Error;
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

/** Asılı kalan sunucu: yanıt vermez, yalnızca istekteki sinyal kesilince reddeder. */
const hung = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

test("a hung request times out, and Ctrl-C (the cancel signal) stops it at once; neither message carries the key or a URL", async () => {
  const slow = neonApi(KEY, { fetch: async (_url, init) => hung(init), timeoutMs: 20 });
  const timedOut = (await slow.request<never>("GET", "/projects").catch((e: unknown) => e)) as Error;
  expect(timedOut).toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(timedOut.message).toContain("timed out after 20 ms");
  const controller = new AbortController();
  const waiting = neonApi(KEY, { fetch: async (_url, init) => hung(init), signal: controller.signal }).request<never>("GET", "/projects").catch((e: unknown) => e as Error);
  setTimeout(() => controller.abort(), 5);
  const cancelled = await waiting;
  expect(cancelled).toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(cancelled.message).toContain("was cancelled");
  for (const error of [timedOut, cancelled]) expect(error.message).not.toMatch(new RegExp(`${KEY}|https?:`));
});

test("cancelling while polling an operation stops the wait promptly and still names the branch that was left behind", async () => {
  const controller = new AbortController();
  const { api } = fake({ ...happy, "GET /projects/p1/operations/op1": () => ({ operation: { action: "create_branch", status: "running" } }) }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  const error = (await safetyPoint({ config: { url: URL_ } }, api, { now, pollMs: 60_000 }).catch((e: unknown) => e)) as Error;
  expect(Date.now() - started).toBeLessThan(2000);
  expect(error).toMatchObject({ code: "PROVIDER_API_ERROR" });
  expect(error.message).toContain("cancelled");
  expect(error.message).toContain("pre-migrate-20261003T101500Z");
});

test("exportAt refuses an existing target before any Neon call, so a retry never leaves a billed branch behind", async () => {
  const { api, calls } = fake(happy);
  const m = { config: { url: URL_ }, driver: undefined, schema: "app_x" } as unknown as Management;
  const error = (await exportAt(m, api, { dir: import.meta.dir, at: "2026-10-03T09:30:00.000Z", now }).catch((e: unknown) => e)) as Error;
  expect(error).toMatchObject({ code: "BACKUP_EXISTS" });
  expect(calls).toEqual([]);
});

test("migrate --safety-point opens exactly one branch when migrations are pending and none when nothing is pending or on a dry run", async () => {
  const app = { config: { url: URL_ } } as Management;
  const pending = (migrations: string[]) => ({ migrate: async () => ({ dryRun: true as const, migrations }) });
  const run = async (migrations: string[], options: { dryRun?: boolean } = {}) => {
    const { api, calls } = fake(happy);
    const point = await takeSafetyPoint(pending(migrations), app, { safetyPoint: "neon", ...options }, async () => api);
    return { point, branches: calls.filter((call) => call.method === "POST").length };
  };
  expect(await run([])).toEqual({ point: undefined, branches: 0 });
  expect((await run(["20261005000000_x"])).branches).toBe(1);
  expect(await run(["20261005000000_x"], { dryRun: true })).toEqual({ point: undefined, branches: 0 });
  // Supabase noktası API çağrısı yapmaz ama bekleyen yoksa onu da üretmez.
  expect(await takeSafetyPoint(pending([]), app, { safetyPoint: "supabase" })).toBeUndefined();
  expect(await takeSafetyPoint(pending(["20261005000000_x"]), app, { safetyPoint: "supabase" })).toMatchObject({ provider: "supabase" });
  // Geçersiz sağlayıcı ya da --org, bekleyen denetiminden (DB'den) önce reddedilir.
  const never = { migrate: async () => Promise.reject(new Error("database touched")) };
  await expect(takeSafetyPoint(never as never, app, { safetyPoint: "aws" })).rejects.toMatchObject({ code: "USAGE" });
  await expect(takeSafetyPoint(never as never, app, { org: "org-1" })).rejects.toMatchObject({ code: "USAGE" });
});
