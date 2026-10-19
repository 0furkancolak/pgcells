/** Read-only production check: direct management connection, database identities, runtime timeout defaults, platform state and
 * optional PgBouncer console. */
import { createConfig, type DatabaseNode, runtimeDatabaseDefaults } from "../config";
import type { Connection, Driver } from "../driver";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import { tenantMigrations } from "../migrations/registry";
import { pendingPlatformMigrations, type PlatformScope } from "../operations/bootstrap";
import { openSession } from "../operations/locks";
import { usesTransactionPooler } from "../tenants/pooler";
import { probeReplica } from "../tenants/replicas";

/** Cannot be proven with SQL; reported to the operator as unverified. */
const externalChecks = [
  ["pooled_runtime", "The application's DATABASE_URLS must go to a transaction-mode pooler; verify with doctor --pooled-urls (ready() also checks at startup)."],
  ["effective_pgbouncer_mode", "If PgBouncer is used, verify transaction mode for the application's user/DB pools with SHOW POOLS."],
  ["hyperdrive_cache", "If Hyperdrive is used, query caching must be off on all connections; verify it in the account settings."],
  ["deployment", "In the target environment, verify /ready, TLS/network access and that the application's DATABASE_URLS order is the same as management's."],
].map(([check, detail]) => ({ check, status: "unverified", detail }));

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

async function inspectPlatform(m: Management, add: Add) {
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
}

/** Upper time limit for the `--pooled-urls` probe. */
const POOLED_PROBE_DEADLINE_MS = 10_000;

/** `--pooled-urls`: runtime URLs, the same number and order as `DATABASE_URLS`. The identity check is `ready()`'s job at runtime. */
function runtimeUrls(m: Management, pooledUrls: string) {
  const { nodes } = createConfig(pooledUrls);
  if (nodes.length !== m.config.nodes.length)
    throw new AppError("INVALID_CONFIG", "--pooled-urls must list one URL per DATABASE_URLS entry, in the same order");
  return nodes.map((node) => node.url);
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

async function inspectPgBouncer(adminUrl: string, consoleDriver: Driver | undefined, add: Add) {
  const url = URL.parse(adminUrl);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/pgbouncer" || url.search)
    throw new AppError("INVALID_CONFIG", "PgBouncer admin URL must be postgres://…/pgbouncer");
  // The admin console does not accept transactions: raw, single-connection pool.
  const driver = consoleDriver ?? (await import("../drivers/bun")).bunDriver;
  const adminConsole = driver(url.href, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 30, connectTimeoutSeconds: 10 });
  try {
    const settings = await adminConsole.query<{ key: string; value: string | null }>("SHOW CONFIG");
    const mode = settings.find((row) => row.key === "pool_mode")?.value;
    const detail = "Global pool_mode must be transaction. DB/user overrides must be checked separately via SHOW POOLS.";
    add("global_pool_mode", mode === "transaction", detail);
  } finally {
    await adminConsole.close(1000);
  }
}

/** `consoleDriver`: PgBouncer admin console client; defaults to Bun SQL (the tools run on Bun and the console rejects postgres.js's
 * startup type queries). */
export async function doctor(m: Management, options: { pgbouncerUrl?: string; pooledUrls?: string; consoleDriver?: Driver } = {}) {
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

  await inspect("platform", (add) => inspectPlatform(m, add));
  for (const [index, node] of m.config.nodes.entries()) {
    await inspect(node.id, (add) => inspectNode(m, node, add));
    const url = pooled?.[index];
    if (url) await inspect(node.id, (add) => inspectPooled(m, url, add));
    for (const [replicaIndex, replicaUrl] of node.replicas.entries())
      await inspect(`${node.id}#${replicaIndex + 1}`, (add) => inspectReplica(m, node, replicaUrl, add));
  }
  const { pgbouncerUrl, consoleDriver } = options;
  if (pgbouncerUrl !== undefined) await inspect("pgbouncer", (add) => inspectPgBouncer(pgbouncerUrl, consoleDriver, add));

  return {
    ok: checks.every((c) => c.ok),
    checks,
    externalChecks: pooled ? externalChecks.filter((item) => item.check !== "pooled_runtime") : externalChecks,
  };
}
