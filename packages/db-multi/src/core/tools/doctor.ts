/** Read-only production check: direct management connection, database identities, runtime timeout defaults, platform state and
 * optional PgBouncer console. */
import { createConfig, type DatabaseNode, runtimeDatabaseDefaults } from "../config";
import type { Connection, Driver } from "../driver";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import { tenantMigrations } from "../migrations/registry";
import { pendingPlatformMigrations, type PlatformScope } from "../operations/bootstrap";
import { openSession } from "../operations/locks";
import { validateRegionName } from "../tenants/model";
import { usesTransactionPooler } from "../tenants/pooler";
import { probeReplica } from "../tenants/replicas";
import { connectionBudget, type ConnectionBudgetInput } from "./pooler-plan";

/** Cannot be proven with SQL; reported to the operator as unverified. */
const externalChecks = [
  ["pooled_runtime", "The application's DATABASE_URLS must go to a transaction-mode pooler; verify with doctor --pooled-urls (ready() also checks at startup)."],
  ["effective_pgbouncer_mode", "If PgBouncer is used, verify transaction mode for the application's user/DB pools with SHOW POOLS."],
  ["hyperdrive_cache", "If Hyperdrive is used, query caching must be off on all connections; verify it in the account settings."],
  ["deployment", "In the target environment, verify /ready, TLS/network access and that the application's DATABASE_URLS order is the same as management's."],
].map(([check, detail]) => ({ check, status: "unverified", detail }));

/** The deployment shape that only the operator knows (`doctor --instances 40 --pool-max 5 --poolers 2`); the sizes come from the pooler and PostgreSQL. */
export type BudgetShape = Pick<ConnectionBudgetInput, "appInstances" | "poolMax" | "poolers" | "replicasPerNode" | "distinctDbUsers" | "rps" | "latencyMs">;
type Add = (check: string, ok: boolean, detail: string) => void;
type Check = { target: string; check: string; ok: boolean; detail: string };

/** Bounded single-row summary of placement state. */
const PLACEMENT_SUMMARY = `SELECT
        count(*) FILTER (WHERE database_id NOT IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb))
          OR status NOT IN ('active','provisioning','maintenance','migrating','failed')
          OR tenant_id !~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' OR length(tenant_id) NOT BETWEEN 3 AND 56
          OR schema_name <> kind||'_'||replace(tenant_id,'-','_')
          OR (status='active' AND (schema_version<>$2 OR move_operation_id IS NOT NULL)))::integer AS invalid,
        count(*) FILTER (WHERE status<>'active')::integer AS inactive,
        count(*) FILTER (WHERE move_operation_id IS NOT NULL)::integer AS moving,
        (SELECT count(*)::integer FROM platform.migration_runner) AS recovery FROM platform.placements`;

const DATABASE_ROLE_SETTINGS =
  "SELECT pg_catalog.array_to_string(setconfig, ',') AS settings FROM pg_catalog.pg_db_role_setting WHERE setrole=0 AND setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())";

/** The DB ledger must contain the whole registry; pending or drifted history needs bootstrap/inspection. */
async function checkPlatformMigrations(add: Add, db: Connection, scope: PlatformScope) {
  try {
    const pending = (await pendingPlatformMigrations(db, scope)).map((m) => m.id);
    const detail = `Pending platform migrations: ${pending.join(", ")}. Run pgcells bootstrap.`;
    add("platform_migrations", !pending.length, pending.length ? detail : "Platform migrations are up to date.");
  } catch (error) {
    if (errorCode(error) !== "MIGRATION_DRIFT") throw error;
    add("platform_migrations", false, "Platform migration ledger does not match the registry (MIGRATION_DRIFT); inspect it manually.");
  }
}

/** Column names on `platform.tenants` that look like personal data (name-based, so it can be wrong in both directions). */
const PERSONAL_COLUMNS =
  "SELECT column_name AS name FROM information_schema.columns WHERE table_schema='platform' AND table_name='tenants' AND column_name ~* '(e_?mail|phone|mobile|gsm|first_?name|last_?name|full_?name|birth|address|ssn|national_?id|passport|tax_?id)' ORDER BY column_name LIMIT 50";
const NODE_REGIONS = "SELECT database_id AS \"databaseId\",region FROM platform.nodes WHERE region IS NOT NULL ORDER BY database_id";

/** Informational (always ok): personal-looking columns on the directory, and, given the application's region, whether any database lives there. */
async function inspectRegions(m: Management, add: Add, appRegion: string | undefined) {
  const columns = (await m.pools.platform.query<{ name: string }>(PERSONAL_COLUMNS)).map((row) => row.name);
  add(
    "directory_pii",
    true,
    columns.length
      ? `platform.tenants has columns that look like personal data (${columns.join(", ")}). The directory lives in db0's region, so this region holds that data whatever the tenant's own residency zone says; keep personal data in the tenant's own cell.`
      : "No personal-data-looking columns on platform.tenants.",
  );
  const regions = await m.pools.platform.query<{ databaseId: string; region: string }>(NODE_REGIONS);
  if (!regions.length) return add("app_region", true, "No database has a region; the region model is not in use.");
  if (appRegion === undefined)
    return add("app_region", true, `Databases have regions (${[...new Set(regions.map((row) => row.region))].join(", ")}). Pass --app-region to check an application's region, and set createDatabase({ region }) in that application: without it nothing stops it from serving tenants of other regions.`);
  validateRegionName(appRegion, "--app-region");
  const local = regions.filter((row) => row.region === appRegion);
  add(
    "app_region",
    local.length > 0,
    local.length
      ? `${local.length} database(s) live in region ${appRegion} (${local.map((row) => row.databaseId).join(", ")}).`
      : `No database lives in region ${appRegion}; an application with createDatabase({ region: "${appRegion}" }) would refuse every tenant (WRONG_REGION).`,
  );
}

async function inspectPlatform(m: Management, add: Add, appRegion?: string) {
  const { nodes } = m.config;
  const db = m.pools.platform;
  await checkPlatformMigrations(add, db, "platform");
  const rows = await db.query<{ database_id: string }>("SELECT database_id FROM platform.nodes ORDER BY database_id LIMIT $1", [nodes.length + 1]);
  const stored = rows.map((row) => row.database_id);
  const sameNodes = stored.length === nodes.length && nodes.every((node) => stored.includes(node.id));
  add("configured_databases", sameNodes, "The DATABASE_URLS list must match the platform.nodes records (the list is only ever appended to).");
  const [summary] = await db.query<{ invalid: number; inactive: number; moving: number; recovery: number }>(PLACEMENT_SUMMARY, [
    JSON.stringify(nodes.map((node) => node.id)),
    tenantMigrations.length,
  ]);
  if (!summary) throw new AppError("INVALID_DATABASE_STATE", "Placement summary unavailable");
  add(
    "active_placements",
    summary.invalid === 0,
    `Invalid (unknown DB, violating the tenant ID/schema rules) or migration-pending records: ${summary.invalid}. Bulk operations stop at these records.`,
  );
  const recovery = `Runner/recovery records: ${summary.recovery}. If no runner is running, inspect the migration-recover prerequisites.`;
  add("migration_recovery", summary.recovery === 0, recovery);
  add("operational_states", true, `Inactive tenants: ${summary.inactive}; those with a move operation: ${summary.moving}. These are not changed automatically.`);
  await inspectRegions(m, add, appRegion);
}

/** Fenced source copies on a node: schemas a completed move renamed to `<schema>__moved_<id>`. */
const RETAINED_COPIES =
  "SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname ~ '^(tenant|demo)_[a-z0-9_]*__moved_[0-9a-f]{8}$' ORDER BY nspname LIMIT 51";
/** Source schemas of completed moves from this node whose tenant now lives elsewhere: candidates for an old copy that kept the tenant's own name. */
const MOVED_AWAY_SCHEMAS =
  "SELECT DISTINCT mv.source->>'schemaName' AS name FROM platform.moves mv JOIN platform.placements p ON p.tenant_id=mv.tenant_id WHERE mv.status='completed' AND mv.source->>'databaseId'=$1 AND p.database_id<>$1 ORDER BY 1 LIMIT 1000";
const EXISTING_SCHEMAS = "SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb)) ORDER BY nspname LIMIT 51";
const LIST_LIMIT = 50;
const preview = (names: string[]) => `${names.slice(0, LIST_LIMIT).join(", ")}${names.length > LIST_LIMIT ? ", …" : ""}`;

/** Informational: fenced copies hold the pre-move data (drop them when no longer needed). Failing: a copy that still carries the tenant's own name
 * means a stale writer could write to it (moves completed before fencing existed, or a copy restored by hand). */
async function checkMovedCopies(m: Management, node: DatabaseNode, add: Add) {
  const db = m.pools.node(node.id);
  const retained = (await db.query<{ name: string }>(RETAINED_COPIES)).map((row) => row.name);
  add(
    "retained_moved_copies",
    true,
    retained.length
      ? `Fenced source copies from completed moves (${retained.length > LIST_LIMIT ? `more than ${LIST_LIMIT}` : retained.length}): ${preview(retained)}. They hold the pre-move data; run DROP SCHEMA … CASCADE once you no longer need them.`
      : "No fenced source copies are retained.",
  );
  const candidates = (await m.pools.platform.query<{ name: string }>(MOVED_AWAY_SCHEMAS, [node.id])).map((row) => row.name);
  const unfenced = candidates.length ? (await db.query<{ name: string }>(EXISTING_SCHEMAS, [JSON.stringify(candidates)])).map((row) => row.name) : [];
  add(
    "unfenced_moved_copies",
    unfenced.length === 0,
    unfenced.length
      ? `Schemas of tenants that moved away still carry the tenant's own name: ${preview(unfenced)}. A process with a stale placement could still write to them; fence each with ALTER SCHEMA "<name>" RENAME TO "<name>__moved_00000000", or drop it.`
      : "No old source copy keeps a tenant's own schema name.",
  );
}

/** If a management session can be opened it is a direct connection; errors other than `DIRECT_CONNECTION_REQUIRED` break the check. */
const isDirectConnection = (m: Management, databaseId: string) =>
  openSession(m, databaseId).then(
    (session) => session.close().then(() => true),
    (error) => {
      if (errorCode(error) !== "DIRECT_CONNECTION_REQUIRED") throw error;
      return false;
    },
  );

async function inspectNode(m: Management, node: DatabaseNode, add: Add) {
  const db = m.pools.node(node.id);
  const directDetail = "The management DATABASE_URLS must be a direct (or session pooling) connection; a transaction pooler drops advisory locks.";
  add("direct_connection", await isDirectConnection(m, node.id), directDetail);
  const identity = await db.query<{ database_id: string }>("SELECT database_id FROM platform.node_identity");
  const sameIdentity = identity.length === 1 && identity[0]?.database_id === node.id;
  add("database_identity", sameIdentity, `The DB at this URL must be registered as ${node.id}; if the order changed, revert the DATABASE_URLS order.`);
  const [strings] = await db.query<{ on: boolean }>("SELECT current_setting('standard_conforming_strings')='on' AS on");
  add("string_literals", strings?.on === true, "standard_conforming_strings must be on.");
  const [stored] = await db.query<{ settings: string | null }>(DATABASE_ROLE_SETTINGS);
  const expected = runtimeDatabaseDefaults(m.config);
  add(
    "runtime_timeouts",
    expected.every((setting) => stored?.settings?.split(",").includes(setting)),
    `Runtime timeouts must be the DB defaults (${expected.join(", ")}); run bootstrap, then refresh the pooler connections.`,
  );
  await checkPlatformMigrations(add, db, "node");
  await checkMovedCopies(m, node, add);
}

/** Upper time limit for the `--pooled-urls` probe. */
const POOLED_PROBE_DEADLINE_MS = 10_000;

/** `--pooled-urls`: runtime URLs for the same node ids as `DATABASE_URLS` (by position, or by `dbN=` prefix). Returned in management order.
 * The identity check is `ready()`'s job at runtime. */
function runtimeUrls(m: Management, pooledUrls: string) {
  const { nodes } = createConfig(pooledUrls);
  const byId = new Map(nodes.map((node) => [node.id, node.url]));
  if (nodes.length !== m.config.nodes.length || !m.config.nodes.every((node) => byId.has(node.id)))
    throw new AppError("INVALID_CONFIG", "--pooled-urls must list one URL per DATABASE_URLS entry, in the same order (or with the same db<N>= ids)");
  return m.config.nodes.map((node) => byId.get(node.id) ?? "");
}

/** The runtime URL must go to a transaction-mode pooler; a direct connection gives `POOLER_REQUIRED` at runtime. */
async function inspectPooled(m: Management, url: string, add: Add) {
  const pooled = await usesTransactionPooler(m.driver, url, { deadlineMs: POOLED_PROBE_DEADLINE_MS });
  add("pooled_runtime", pooled, "Runtime DATABASE_URLS must go to a transaction-mode pooler; a direct connection gives POOLER_REQUIRED at runtime.");
}

/** Read-only checks per replica: a single short-lived connection is opened; the replica URL never appears in any output. */
async function inspectReplica(m: Management, node: DatabaseNode, url: string, add: Add) {
  const replica = m.driver(url, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  try {
    let probe: Awaited<ReturnType<typeof probeReplica>>;
    try {
      probe = await probeReplica(m.pools.node(node.id), replica);
    } catch (error) {
      add("replica_reachable", false, `Could not connect to the replica (${errorCode(error)}); check the URL, network and credentials.`);
      return;
    }
    add("replica_reachable", true, "Replica is reachable.");
    add("replica_in_recovery", probe.inRecovery, "The URL must really go to a replica (pg_is_in_recovery); passing the primary as a replica breaks the read/write separation.");
    const lag = probe.lagMs === null ? "unknown" : `${probe.lagMs} ms`;
    add("replica_lag", probe.lagMs !== null && probe.lagMs <= m.config.replicaMaxLagMs, `Replica lag must be below the ${m.config.replicaMaxLagMs} ms threshold (measured: ${lag}).`);
    const [identity] = await replica.query<{ database_id: string }>("SELECT database_id FROM platform.node_identity");
    add("replica_identity", identity?.database_id === node.id, `This replica must be a copy of ${node.id}; a URL pointing at another cluster leads reads to wrong data.`);
    const [stored] = await replica.query<{ settings: string | null }>(DATABASE_ROLE_SETTINGS);
    const expected = runtimeDatabaseDefaults(m.config);
    const present = expected.every((setting) => stored?.settings?.split(",").includes(setting));
    add("replica_runtime_timeouts", present, `Runtime timeouts come with the replica (${expected.join(", ")}); run bootstrap on the primary.`);
    const pooled = await usesTransactionPooler(m.driver, url, { deadlineMs: POOLED_PROBE_DEADLINE_MS });
    // Informational: the runtime does not enforce a pooler on the replica URL, so a direct URL does not fail doctor (always ok).
    add("replica_pooled", true, pooled ? "Replica runtime URL goes to a transaction-mode pooler." : "Replica runtime URL does not go to a transaction-mode pooler (direct); the runtime does not enforce it, informational only.");
  } finally {
    await replica.close(1000);
  }
}

/** PgBouncer's `query_wait_timeout` default (seconds) when the console does not list it. */
const PGBOUNCER_QUERY_WAIT_DEFAULT_S = 120;
/** Slack above `statementTimeoutMs` that the answer deadline adds (1 s) plus the margin before the client sees the error (0.5 s). */
const ANSWER_DEADLINE_SLACK_MS = 1500;

type PgBouncerSettings = ReadonlyMap<string, string | null>;

/** Reads the pooler console once; returns its settings so that other checks (timeouts, connection budget) reuse them. */
/** Informational (always ok): where the directory says this replica lives, with a warning when that differs from its node's region (a regional application reads only from replicas in its own region). */
async function inspectReplicaRegion(m: Management, node: DatabaseNode, ordinal: number, add: Add) {
  const [row] = await m.pools.platform.query<{ nodeRegion: string | null; region: string | null }>(
    `SELECT n.region AS "nodeRegion",r.region FROM platform.nodes n LEFT JOIN platform.replicas r ON r.database_id=n.database_id AND r.ordinal=$2 WHERE n.database_id=$1`,
    [node.id, ordinal],
  );
  const region = row?.region ?? row?.nodeRegion ?? null;
  const detail =
    region === null
      ? "No region is recorded for this replica or its database."
      : `Replica region: ${region}${row?.region ? " (from the directory)" : " (its database's region)"}.`;
  add("replica_region", true, row?.region && row.nodeRegion && row.region !== row.nodeRegion ? `${detail} Warning: its database is in ${row.nodeRegion}; applications in ${row.nodeRegion} will not read from it.` : detail);
}

async function inspectPgBouncer(m: Management, adminUrl: string, consoleDriver: Driver | undefined, add: Add): Promise<PgBouncerSettings> {
  const url = URL.parse(adminUrl);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/pgbouncer" || url.search)
    throw new AppError("INVALID_CONFIG", "PgBouncer admin URL must be postgres://…/pgbouncer");
  // The admin console does not accept transactions: raw, single-connection pool.
  const driver = consoleDriver ?? (await import("../drivers/bun")).bunDriver;
  const adminConsole = driver(url.href, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 30, connectTimeoutSeconds: 10 });
  try {
    const rows = await adminConsole.query<{ key: string; value: string | null }>("SHOW CONFIG");
    const settings = new Map(rows.map((row) => [row.key, row.value]));
    const detail = "Global pool_mode must be transaction. DB/user overrides must be checked separately via SHOW POOLS.";
    add("global_pool_mode", settings.get("pool_mode") === "transaction", detail);
    // 0 disables the wait limit: the application's own deadline then always comes first.
    const wait = Number(settings.get("query_wait_timeout") ?? PGBOUNCER_QUERY_WAIT_DEFAULT_S);
    const minimum = m.config.statementTimeoutMs + ANSWER_DEADLINE_SLACK_MS;
    add(
      "timeout_alignment",
      wait === 0 || wait * 1000 > minimum,
      `PgBouncer query_wait_timeout (${wait} s) must exceed the application's answer deadline (statementTimeoutMs ${m.config.statementTimeoutMs} ms + 1.5 s), otherwise clients see pooler resets (08P01) instead of DATABASE_TIMEOUT. The database's statement_timeout is checked by runtime_timeouts.`,
    );
    return settings;
  } finally {
    await adminConsole.close(1000);
  }
}

/** Connection budget of one node from the pooler's own settings and PostgreSQL's `max_connections`; the deployment shape comes from the operator. */
async function inspectBudget(m: Management, node: DatabaseNode, settings: PgBouncerSettings, shape: BudgetShape, add: Add) {
  const [server] = await m.pools.node(node.id).query<{ max_connections: number; reserved: number }>(
    "SELECT pg_catalog.current_setting('max_connections')::integer AS max_connections, pg_catalog.current_setting('superuser_reserved_connections')::integer AS reserved",
  );
  const number = (key: string) => Number(settings.get(key));
  if (!server || !Number.isInteger(number("max_client_conn")) || !Number.isInteger(number("default_pool_size")))
    throw new AppError("INVALID_DATABASE_STATE", "PgBouncer or PostgreSQL did not report the sizes needed for the budget");
  const plan = connectionBudget({
    ...shape,
    replicasPerNode: shape.replicasPerNode ?? node.replicas.length,
    maxClientConn: number("max_client_conn"),
    defaultPoolSize: number("default_pool_size"),
    maxConnections: server.max_connections,
    superuserReserved: server.reserved,
    managementConcurrency: m.config.perDatabaseConcurrency,
  });
  add(
    "connection_budget",
    plan.ok,
    plan.ok
      ? `Within budget: ${plan.clients.load}/${plan.clients.limit} client connections, ${plan.servers.load}/${plan.servers.limit} server connections${plan.flow ? `, ${plan.flow.needed}/${plan.flow.available} concurrent statements` : ""}. Uses the pooler's global default_pool_size; per-database pool_size overrides are not read.`
      : plan.violations.join("; "),
  );
}

/** `consoleDriver`: PgBouncer admin console client; defaults to Bun SQL (the tools run on Bun and the console rejects postgres.js's
 * startup type queries). */
export async function doctor(m: Management, options: { pgbouncerUrl?: string; pooledUrls?: string; consoleDriver?: Driver; budget?: BudgetShape; appRegion?: string } = {}) {
  const pooled = options.pooledUrls === undefined ? undefined : runtimeUrls(m, options.pooledUrls);
  const checks: Check[] = [];
  /** Checks a single target; since driver errors can contain credentials, an error becomes a check with its details hidden. */
  async function inspect(target: string, run: (add: Add) => Promise<void>) {
    const add: Add = (check, ok, detail) => checks.push({ target, check, ok, detail });
    try {
      await run(add);
    } catch (error) {
      add("inspection", false, `Inspection could not be completed (${errorCode(error)}). Check the connection and privileges.`);
    }
  }

  await inspect("platform", (add) => inspectPlatform(m, add, options.appRegion));
  for (const [index, node] of m.config.nodes.entries()) {
    await inspect(node.id, (add) => inspectNode(m, node, add));
    const url = pooled?.[index];
    if (url) await inspect(node.id, (add) => inspectPooled(m, url, add));
    for (const [replicaIndex, replicaUrl] of node.replicas.entries()) {
      await inspect(`${node.id}#${replicaIndex + 1}`, (add) => inspectReplica(m, node, replicaUrl, add));
      await inspect(`${node.id}#${replicaIndex + 1}`, (add) => inspectReplicaRegion(m, node, replicaIndex + 1, add));
    }
  }
  const { pgbouncerUrl, consoleDriver, budget } = options;
  if (budget && pgbouncerUrl === undefined) throw new AppError("USAGE", "The connection budget reads the pooler's sizes: pass --pgbouncer-url as well");
  if (pgbouncerUrl !== undefined) {
    let settings: PgBouncerSettings | undefined;
    await inspect("pgbouncer", async (add) => {
      settings = await inspectPgBouncer(m, pgbouncerUrl, consoleDriver, add);
    });
    const known = settings;
    if (budget && known) for (const node of m.config.nodes) await inspect(node.id, (add) => inspectBudget(m, node, known, budget, add));
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    externalChecks: pooled ? externalChecks.filter((item) => item.check !== "pooled_runtime") : externalChecks,
  };
}
