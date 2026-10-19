/** Validates the `DATABASE_URLS` list and derives ids from the order; settings are typed options passed to the factories, not env. */
import { AppError } from "./errors";

/** The order is the identity: `DATABASE_URLS[i]` → `db<i>`. The first DB is the platform database (and tenant DB #0). The list grows only by appending at the end. */
export const PLATFORM_DATABASE_ID = "db0";
export const DATABASE_ID = /^db(?:0|[1-9]\d?)$/;

export interface DatabaseNode {
  id: string;
  /** At runtime this must be a transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive); for management it must be a direct (or session-pooling) connection. */
  url: string;
  /** Read-only replica URLs (`DATABASE_REPLICA_URLS`). They are only validated here; their use is in the replica work. Management ignores them. */
  replicas: readonly string[];
}
/** Plain data: from env (`loadConfig`) or directly from a URL array (`createConfig`). */
export type Config = { nodes: DatabaseNode[] };

/** Upper limits shared by option validation, CLI flags and the batch scheduler. */
export const MIGRATION_MAX = { concurrency: 128, perDatabase: 64 } as const;
/** The longest staleness allowed for the placement cache (e.g. `@0furkancolak/pgcells-redis`). After `migrating` is written, a move waits
 * `placementCacheWaitMs` (default 30 s) before copying data; every process with a cache drops the old record within that time. */
export const PLACEMENT_CACHE_MAX_MS = 25_000;

/** Option → [default, upper limit]. `poolMax` is per DB (on db0 it is shared with platform reads); `statementTimeoutMs`
 * is the connection-acquisition deadline at runtime, and in management it is the DB default that `bootstrap` writes. */
const RUNTIME_LIMITS = {
  poolMax: [5, 100],
  statementTimeoutMs: [5000, 300000],
  idleTimeoutSeconds: [20, 300],
  maxLifetimeSeconds: [300, 3600],
  /** In-process placement cache (`active` only); a move waits for this limit. */
  placementCacheMs: [5000, PLACEMENT_CACHE_MAX_MS],
  /** Replica reads: a replica whose lag exceeds this is excluded; the status record (health + lag) stays cached for this long. */
  replicaMaxLagMs: [5000, 3_600_000],
  replicaStatusMs: [5000, 60_000],
} as const;
const MANAGEMENT_LIMITS = {
  ...RUNTIME_LIMITS,
  migrationConcurrency: [16, MIGRATION_MAX.concurrency],
  perDatabaseConcurrency: [4, MIGRATION_MAX.perDatabase],
  migrationStatementTimeoutMs: [30000, 3600000],
  migrationLockTimeoutMs: [1000, 60000],
  shutdownGraceMs: [10000, 300000],
  placementCacheWaitMs: [30000, 300000],
  pageSize: [100, 1000],
} as const;
type Limits = Record<string, readonly [number, number]>;
type Values<T> = { -readonly [K in keyof T]: number };
/** Read behavior when there is no healthy replica (down or lag threshold exceeded): a `READ ONLY` transaction on the primary, or `REPLICA_UNAVAILABLE`. */
export type ReplicaPolicy = "primary" | "error";
export function replicaPolicy(value: unknown = "primary"): ReplicaPolicy {
  if (value === "primary" || value === "error") return value;
  throw new AppError("INVALID_CONFIG", 'replicaOnUnavailable must be "primary" or "error"');
}
export type DatabaseOptions = Partial<Values<typeof RUNTIME_LIMITS>> & { replicaOnUnavailable?: ReplicaPolicy };
export type ManagementOptions = Partial<Values<typeof MANAGEMENT_LIMITS>>;
export type ManagementSettings = Config & Values<typeof MANAGEMENT_LIMITS>;

/** Accepts a number or a digit string (CLI) in the range 1..max. */
export function boundedInteger(value: unknown, name: string, max: number) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= max) return number;
  throw new AppError("INVALID_CONFIG", `${name} must be an integer from 1 to ${max}`);
}

const MAX_DATABASES = 100;
/** URL parameters that route the schema: the engine selects the tenant schema. */
const ROUTING_PARAMETERS = ["options", "search_path"];

function isDatabaseUrl(entry: string) {
  const url = URL.parse(entry);
  const routesSchema = [...(url?.searchParams.keys() ?? [])].some((key) => ROUTING_PARAMETERS.includes(key.toLowerCase()));
  return !!url && ["postgres:", "postgresql:"].includes(url.protocol) && !routesSchema;
}

/** Maximum number of replicas per node. */
const MAX_REPLICAS_PER_DATABASE = 8;
/** `db0=postgres://…`: the key extends only up to the first `=`; any `=` inside the URL and the query string are preserved. */
const REPLICA_ENTRY = /^(db(?:0|[1-9]\d?))=(.+)$/;

interface MutableNode extends Omit<DatabaseNode, "replicas"> {
  replicas: string[];
}

/** `db0=urlA,db0=urlB,db1=urlC` (comma-separated text or array) → the nodes' `replicas` lists. Empty text means no replicas.
 * Errors never contain the value. */
function addReplicas(nodes: MutableNode[], value: string | readonly string[]) {
  const entries = typeof value === "string" ? (value.trim() ? value.split(",").map((entry) => entry.trim()) : []) : [...value];
  const known = new Set(nodes.map((node) => node.url));
  for (const entry of entries) {
    const [, id, url] = REPLICA_ENTRY.exec(entry) ?? [];
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node || !url || !isDatabaseUrl(url) || known.has(url) || node.replicas.length >= MAX_REPLICAS_PER_DATABASE)
      throw new AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_REPLICA_URLS");
    known.add(url);
    node.replicas.push(url);
  }
}

/** Comma-separated text or array → non-empty (at most 100), unique postgres:// URLs without schema-routing parameters.
 * `replicas`: optional `db0=url` entries (see `addReplicas`). Errors never contain the value. */
export function createConfig(value: string | readonly string[], replicas: string | readonly string[] = []): Config {
  const urls = typeof value === "string" ? value.split(",").map((entry) => entry.trim()) : [...value];
  if (!urls.length || urls.length > MAX_DATABASES || !urls.every(isDatabaseUrl) || new Set(urls).size !== urls.length)
    throw new AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_URLS");
  const nodes: MutableNode[] = urls.map((url, index) => ({ id: `db${index}`, url, replicas: [] }));
  addReplicas(nodes, replicas);
  return { nodes };
}

/** Environment: runtime, CLI, tools and tests read `DATABASE_URLS`; the runtime also reads the optional `DATABASE_REPLICA_URLS`. */
export const loadConfig = (env: Record<string, string | undefined> = process.env) =>
  createConfig(env.DATABASE_URLS ?? "", env.DATABASE_REPLICA_URLS ?? "");

function settings<T extends Limits>(limits: T, config: Config, options: Partial<Values<T>>): Config & Values<T> {
  const values: Record<string, unknown> = { nodes: config.nodes };
  for (const [key, [fallback, max]] of Object.entries(limits)) values[key] = boundedInteger(options[key] ?? fallback, key, max);
  return values as Config & Values<T>;
}
export const runtimeSettings = (config: Config, options: DatabaseOptions = {}) => settings(RUNTIME_LIMITS, config, options);
export const managementSettings = (config: Config, options: ManagementOptions = {}) => settings(MANAGEMENT_LIMITS, config, options);

/** The server stops the running statement of a session whose client has gone away within this interval at the latest (PostgreSQL 14+). A connection whose deadline expires is discarded;
 * on a driver that cannot cancel (Bun SQL), this setting ensures the statement does not commit in the background. */
export const CLIENT_CONNECTION_CHECK_MS = 1000;

/** The runtime's server-side settings: `bootstrap` writes them to every DB as defaults (lock_timeout at most 1000), and `doctor` checks them. */
export const runtimeDatabaseDefaults = ({ statementTimeoutMs }: { statementTimeoutMs: number }) => [
  `statement_timeout=${statementTimeoutMs}`,
  `lock_timeout=${Math.min(statementTimeoutMs, 1000)}`,
  `client_connection_check_interval=${CLIENT_CONNECTION_CHECK_MS}`,
];
