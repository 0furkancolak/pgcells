/** Branch tools via the Neon API: a safety point before `migrate-all`, a staging copy for a migration trial, and an export of the tenant at a past
 * moment. Uses only `fetch`; the API key and the connection URI with its password are kept in memory and never appear in any output or error
 * message. Branches are never deleted. */
import { type Config, createConfig, type DatabaseNode } from "../config";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import type { exportTenant } from "./backup";

const BASE_URL = "https://console.neon.tech/api/v2";
const MAX_MESSAGE_CHARS = 300;
const PROJECT_PAGE_SIZE = 100;

type Fetch = (input: URL, init?: RequestInit) => Promise<Response>;

export interface NeonApi {
  request<T>(method: "GET" | "POST", path: string, options?: { query?: Record<string, string>; body?: unknown }): Promise<T>;
}

/** Neon API v2 client; error messages do not contain the key. */
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
          // The body is not JSON: only the status code is written.
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

/** The `-pooler` suffix is converted to the direct host: the API lists the endpoint's direct host. */
const directHost = (host: string) => host.toLowerCase().replace(/-pooler(?=\.)/, "");

/** Endpoints of all projects in the account. */
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

/** Matches each node's host with the account's endpoints; the project ID does not need an env var. An unmatched node is reported only by its ID. */
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

export interface NeonToolOptions {
  org?: string;
  now?: Date;
  pageSize?: number;
  /** Operation polling interval and total time (ms); tests supply `sleep`. */
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

/** `20261003T101500Z`: a sortable time with second resolution for branch names. */
const stamp = (now: Date) => now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");

/** Polls until the operations finish; a failed status or a timeout throws an error. */
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

/** Groups the nodes by (project, source branch) pair and creates one branch from each group (from that moment if `timestamp` is given). If one fails
 * the earlier ones are not deleted; the error lists the created branches by name. A second branch in the same project gets `-2`, `-3` … appended to the name. */
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
    throw new AppError(error instanceof AppError ? error.code : "PROVIDER_API_ERROR", `${error instanceof Error ? error.message : "Operation failed"}. ${leftBehind(created)}`);
  }
  return created;
}

/** Names of branches that were created and not deleted: so the user can delete them from the console. */
const leftBehind = (created: readonly BranchRun[]) =>
  `Branches created before the failure (not deleted): ${created.map((run) => `${run.name} (project ${run.projectId}, branch ${run.branchId})`).join("; ")}`;

type ConfiguredNodes = { config: { nodes: readonly DatabaseNode[] } };

const branchTool = (prefix: string) => async (m: ConfiguredNodes, api: NeonApi, options: NeonToolOptions = {}) => {
  const nodes = await resolveNodes(api, m.config.nodes, options);
  return { provider: "neon" as const, branches: await branchNodes(api, nodes, { ...options, prefix }) };
};

/** Before `migrate-all`: a `pre-migrate-<time>` branch from the current point of each source branch. It does not return until all are created. */
export const safetyPoint = branchTool("pre-migrate");
/** `stage-<time>` branches for a migration trial; only the branch ID and host are returned, the URI with its password is never fetched. */
export const stageCopy = branchTool("stage");

const usage = (message: string) => new AppError("USAGE", message);

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The date and time fields must denote a real calendar moment (`2026-02-30` does not roll over to the next month). */
const realTime = ([year, month, day, hour, minute, second]: number[]) => {
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  return date.getUTCMonth() === (month as number) - 1 && date.getUTCDate() === day && (hour as number) < 24 && (minute as number) < 60 && (second as number) < 60;
};

/** `--at`: RFC 3339 (time zone required: it is not silently converted to local time) and must be in the past; validated without going to Neon. The output is UTC ISO. */
export function parsePastTimestamp(value: string | undefined, now: Date): string {
  if (!value) throw usage("--at <RFC 3339 time> is required");
  const text = value.toUpperCase();
  const match = RFC3339.exec(text);
  const time = Date.parse(text);
  if (!match || Number.isNaN(time) || !realTime(match.slice(1, 7).map(Number))) throw usage("--at must be an RFC 3339 time with a UTC offset, such as 2026-10-03T09:30:00Z");
  if (time >= now.getTime()) throw usage("--at must be in the past");
  return new Date(time).toISOString();
}

export function safetyPointProvider(value: string | undefined): "neon" | "supabase" | undefined {
  if (value === undefined) return undefined;
  if (value === "neon" || value === "supabase") return value;
  throw usage("--safety-point must be neon or supabase");
}

/** Supabase: only the PITR second is recorded and the restore request is printed; no API call is made, no key is asked for. */
export function supabaseSafetyPoint(now = new Date()) {
  const recoveryTimeTargetUnix = Math.floor(now.getTime() / 1000);
  return {
    provider: "supabase" as const,
    recoveryTimeTargetUnix,
    restore: { method: "POST", url: "https://api.supabase.com/v1/projects/{ref}/database/backups/restore-pitr", body: { recovery_time_target_unix: recoveryTimeTargetUnix } },
    note: "No API call was made. Supabase PITR is a paid add-on (Pro, Team or Enterprise); without it this time is not a restore point. PITR restores the whole project in place; restoring one tenant is not possible.",
  };
}

/** The branch's connection URI with its password; used only in memory. */
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

/** Exports the tenant as of `at` into `dir`: a temporary branch at that moment is created from each source branch, a temporary `Management` is set up with the
 * connection details (node order is preserved) and the existing `exportTenant` runs. Nothing is written to live data and branches are not deleted; applying it is done with `restore`. */
export async function exportTenantAt(
  m: Management,
  api: NeonApi,
  { tenantId, dir, at, signal, ...options }: NeonToolOptions & { tenantId: string; dir: string; at: string; signal?: AbortSignal },
  deps?: ExportDeps,
) {
  const nodes = await resolveNodes(api, m.config.nodes, options);
  const branches = await branchNodes(api, nodes, { ...options, prefix: "pitr", timestamp: at });
  try {
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
  } catch (error) {
    // The branches were created and are not deleted: say under which names they remain. The text of driver errors (host, user) does not enter the message.
    const reason = error instanceof AppError ? error.message : `Neon export failed (${errorCode(error)})`;
    throw new AppError(errorCode(error), `${reason}. ${leftBehind(branches)}`);
  }
}
