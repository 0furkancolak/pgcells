/** Connection budget: the three inequalities of docs/guides/connections.md (section 3), as a pure function. No I/O; `doctor` and `pooler plan` both use it. */
import { AppError } from "../errors";

export interface ConnectionBudgetInput {
  /** Application processes that open pools (count the rolling-deploy overlap in the limit, not here). */
  appInstances: number;
  /** `poolMax` of each process, per database. */
  poolMax: number;
  /** Read replicas per node that are served by the same pooler; each has its own pool in every process. Default 0. */
  replicasPerNode?: number;
  /** PgBouncer instances in front of the node. */
  poolers: number;
  defaultPoolSize: number;
  maxClientConn: number;
  /** PostgreSQL `max_connections` of the node. */
  maxConnections: number;
  /** PostgreSQL `superuser_reserved_connections` (default 3). */
  superuserReserved?: number;
  /** Distinct (database, user) pairs, each with its own server pool in every pooler (default 1). */
  distinctDbUsers?: number;
  /** Direct management connections (`perDatabaseConcurrency`, default 4). */
  managementConcurrency?: number;
  /** Monitoring, replication slots, maintenance sessions (default 20). */
  maintenanceConnections?: number;
  /** Statements per second the node must serve and their average duration; both are needed for the flow check. */
  rps?: number;
  latencyMs?: number;
}

export interface ConnectionBudget {
  ok: boolean;
  /** (1) application client connections against the pooler limit (half of `max_client_conn` × poolers, so a rolling deploy can overlap). */
  clients: { load: number; limit: number };
  /** (2) server connections against `max_connections` minus the reserve and 10 % headroom. */
  servers: { load: number; limit: number; application: number; management: number; maintenance: number };
  /** (3) Little's law: busy server connections needed against the pooled ones available; absent without `rps` and `latencyMs`. */
  flow?: { needed: number; available: number; ceilingRps: number };
  violations: string[];
}

const positive = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new AppError("INVALID_CONFIG", `${name} must be a positive number`);
  return value;
};
const whole = (value: unknown, name: string): number => {
  const number = positive(value, name);
  if (!Number.isInteger(number)) throw new AppError("INVALID_CONFIG", `${name} must be a whole number`);
  return number;
};
const nonNegative = (value: number | undefined, name: string, fallback: number): number => {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < 0) throw new AppError("INVALID_CONFIG", `${name} must be a whole number, zero or more`);
  return number;
};

export function connectionBudget(input: ConnectionBudgetInput): ConnectionBudget {
  const appInstances = whole(input.appInstances, "appInstances");
  const poolMax = whole(input.poolMax, "poolMax");
  const poolers = whole(input.poolers, "poolers");
  const defaultPoolSize = whole(input.defaultPoolSize, "defaultPoolSize");
  const maxClientConn = whole(input.maxClientConn, "maxClientConn");
  const maxConnections = whole(input.maxConnections, "maxConnections");
  const replicas = nonNegative(input.replicasPerNode, "replicasPerNode", 0);
  const reserved = nonNegative(input.superuserReserved, "superuserReserved", 3);
  const dbUsers = input.distinctDbUsers === undefined ? 1 : whole(input.distinctDbUsers, "distinctDbUsers");
  const management = nonNegative(input.managementConcurrency, "managementConcurrency", 4);
  const maintenance = nonNegative(input.maintenanceConnections, "maintenanceConnections", 20);
  if (maxConnections <= reserved) throw new AppError("INVALID_CONFIG", "maxConnections must be above superuserReserved");
  const rps = input.rps === undefined ? undefined : positive(input.rps, "rps");
  const latencyMs = input.latencyMs === undefined ? undefined : positive(input.latencyMs, "latencyMs");

  const clients = { load: appInstances * poolMax * (1 + replicas), limit: Math.floor(maxClientConn * poolers * 0.5) };
  const application = poolers * defaultPoolSize * dbUsers;
  const servers = {
    load: application + management + maintenance,
    limit: Math.floor((maxConnections - reserved) * 0.9),
    application,
    management,
    maintenance,
  };
  const flow =
    rps !== undefined && latencyMs !== undefined
      ? {
          needed: Math.ceil((rps * latencyMs) / 1000),
          available: poolers * defaultPoolSize,
          ceilingRps: Math.floor((poolers * defaultPoolSize * 1000) / latencyMs),
        }
      : undefined;

  const violations: string[] = [];
  if (clients.load > clients.limit)
    violations.push(`client connections ${clients.load} exceed ${clients.limit} (half of max_client_conn x poolers, so a rolling deploy can overlap); add poolers, raise max_client_conn or lower poolMax`);
  if (servers.load > servers.limit)
    violations.push(
      `server connections ${servers.load} (${application} pooled + ${management} management + ${maintenance} maintenance) exceed ${servers.limit} (max_connections minus the reserve, 10 % headroom); lower default_pool_size or poolers, or raise max_connections`,
    );
  if (flow && flow.needed > flow.available)
    violations.push(`${flow.needed} concurrent statements are needed at ${rps} statements/s and ${latencyMs} ms, but the pooled server connections are ${flow.available}; raise default_pool_size or add poolers`);
  return { ok: violations.length === 0, clients, servers, ...(flow ? { flow } : {}), violations };
}
