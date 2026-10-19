/** `DATABASE_URLS` (a single URL in this package) and the optional `DATABASE_REPLICA_URLS` are validated; settings are typed options passed to the factories, not env. */
import { AppError } from "./errors";

/** Plain data: from env (`loadConfig`) or directly from URLs (`createConfig`). Error messages never contain a URL. */
export interface Config {
  /** At runtime this must be a transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive); for management it must be a direct (or session pooling) connection. */
  readonly url: string;
  /** Read-only replica URLs. */
  readonly replicas: readonly string[];
}

/** Option → [default, upper bound]. `statementTimeoutMs` is the connection-acquisition deadline at runtime and the DB default written by `migrate` in management. */
const RUNTIME_LIMITS = {
  poolMax: [5, 100],
  statementTimeoutMs: [5000, 300000],
  idleTimeoutSeconds: [20, 300],
  maxLifetimeSeconds: [300, 3600],
  /** Replica reads: a replica whose lag exceeds this is dropped; the status record (health + lag) stays cached for this long. */
  replicaMaxLagMs: [5000, 3_600_000],
  replicaStatusMs: [5000, 60_000],
} as const;
const MANAGEMENT_LIMITS = {
  ...RUNTIME_LIMITS,
  migrationStatementTimeoutMs: [30000, 3600000],
  migrationLockTimeoutMs: [1000, 60000],
} as const;
type Limits = Record<string, readonly [number, number]>;
type Values<T> = { -readonly [K in keyof T]: number };

/** Read when no healthy replica exists (it went down or the lag threshold was exceeded): on the primary (in a `READ ONLY` transaction if a replica is configured) or `REPLICA_UNAVAILABLE`. */
export type ReplicaPolicy = "primary" | "error";
export function replicaPolicy(value: unknown = "primary"): ReplicaPolicy {
  if (value === "primary" || value === "error") return value;
  throw new AppError("INVALID_CONFIG", 'replicaOnUnavailable must be "primary" or "error"');
}
export type DatabaseOptions = Partial<Values<typeof RUNTIME_LIMITS>> & { replicaOnUnavailable?: ReplicaPolicy };
export type ManagementOptions = Partial<Values<typeof MANAGEMENT_LIMITS>>;
export type ManagementSettings = Config & Values<typeof MANAGEMENT_LIMITS>;

/** Accepts a number or a digit string (CLI) in the min..max range (default 1..max). */
export function boundedInteger(value: unknown, name: string, max: number, min = 1) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number === "number" && Number.isInteger(number) && number >= min && number <= max) return number;
  throw new AppError("INVALID_CONFIG", `${name} must be an integer from ${min} to ${max}`);
}

/** URL parameters that route to a schema: the engine picks the schema, not the connection. */
const ROUTING_PARAMETERS = ["options", "search_path"];
const MAX_REPLICAS = 8;

function isDatabaseUrl(entry: string) {
  const url = URL.parse(entry);
  const routesSchema = [...(url?.searchParams.keys() ?? [])].some((key) => ROUTING_PARAMETERS.includes(key.toLowerCase()));
  return !!url && ["postgres:", "postgresql:"].includes(url.protocol) && !routesSchema;
}

/** Comma-separated text or an array → trimmed entries; empty text gives an empty list. */
const entries = (value: string | readonly string[]) => (typeof value === "string" ? (value.trim() ? value.split(",") : []) : value).map((entry) => entry.trim());

/** Exactly one postgres:// URL (no schema routing parameter) and optional replica URLs (at most 8, unique, different from the primary). */
export function createConfig(value: string | readonly string[], replicas: string | readonly string[] = []): Config {
  const urls = entries(value);
  const [url] = urls;
  if (urls.length !== 1 || !url || !isDatabaseUrl(url)) throw new AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_URLS");
  const extra = entries(replicas);
  if (extra.length > MAX_REPLICAS || !extra.every(isDatabaseUrl) || new Set([url, ...extra]).size !== extra.length + 1)
    throw new AppError("INVALID_CONFIG", "Invalid configuration: DATABASE_REPLICA_URLS");
  return { url, replicas: extra };
}

/** Environment: the runtime, CLI, tools and tests read `DATABASE_URLS`; the runtime also reads the optional `DATABASE_REPLICA_URLS`. */
export const loadConfig = (env: Record<string, string | undefined> = process.env) =>
  createConfig(env.DATABASE_URLS ?? "", env.DATABASE_REPLICA_URLS ?? "");

function settings<T extends Limits>(limits: T, config: Config, options: Partial<Values<T>>): Config & Values<T> {
  const values: Record<string, unknown> = { url: config.url, replicas: config.replicas };
  for (const [key, [fallback, max]] of Object.entries(limits)) values[key] = boundedInteger(options[key] ?? fallback, key, max);
  return values as Config & Values<T>;
}
export const runtimeSettings = (config: Config, options: DatabaseOptions = {}) => settings(RUNTIME_LIMITS, config, options);
export const managementSettings = (config: Config, options: ManagementOptions = {}) => settings(MANAGEMENT_LIMITS, config, options);

/** The server cuts the running statement of a session whose client has dropped within this interval at the latest (PostgreSQL 14+). A connection past its deadline is discarded;
 * on a driver that cannot cancel (Bun SQL), this setting ensures the statement does not commit in the background. */
export const CLIENT_CONNECTION_CHECK_MS = 1000;

/** Server-side settings of the runtime: `migrate` writes them as defaults to every DB (lock_timeout at most 1000), `doctor` checks them. */
export const runtimeDatabaseDefaults = ({ statementTimeoutMs }: { statementTimeoutMs: number }) => [
  `statement_timeout=${statementTimeoutMs}`,
  `lock_timeout=${Math.min(statementTimeoutMs, 1000)}`,
  `client_connection_check_interval=${CLIENT_CONNECTION_CHECK_MS}`,
];
