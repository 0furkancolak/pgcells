/** Read-only production check: direct management connection, runtime timeout defaults, schema and migration state, replicas and
 * optional pooler proof, plus the PgBouncer console. Writes nothing. */
import { schemaExists } from "../catalog";
import { runtimeDatabaseDefaults } from "../config";
import type { Driver } from "../driver";
import { AppError, errorCode } from "../errors";
import { qualified } from "../identifier";
import { openSession } from "../locks";
import type { Management } from "../management";
import { registry as packageRegistry, pendingIn, type Registry } from "../migrations/registry";
import { usesTransactionPooler } from "../pooler";
import { probeReplica } from "../replicas";

/** Cannot be proven with SQL; reported as unverified for the operator. */
const externalChecks = [
  ["pooled_runtime", "The application's DATABASE_URLS must go to a transaction-mode pooler; verify with doctor --pooled-url (ready() also checks at startup)."],
  ["effective_pgbouncer_mode", "If PgBouncer is used, verify transaction mode for the application's user/DB pools with SHOW POOLS."],
  ["hyperdrive_cache", "If Hyperdrive is used, query caching must be off on all connections; verify in the account settings."],
  ["deployment", "In the target environment, verify /ready, TLS/network access and that the application uses the same schema."],
].map(([check, detail]) => ({ check: check as string, status: "unverified" as const, detail: detail as string }));

type Add = (check: string, ok: boolean, detail: string) => void;
type Check = { target: string; check: string; ok: boolean; detail: string };

const DATABASE_ROLE_SETTINGS =
  "SELECT pg_catalog.array_to_string(setconfig, ',') AS settings FROM pg_catalog.pg_db_role_setting WHERE setrole=0 AND setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())";

/** Upper time limit for the `--pooled-url` probe. */
const POOLED_PROBE_DEADLINE_MS = 10_000;

/** If a management session can be opened, the connection is direct; errors other than `DIRECT_CONNECTION_REQUIRED` break the check. */
const isDirectConnection = (m: Management) =>
  openSession(m).then(
    (session) => session.close().then(() => true),
    (error) => {
      if (errorCode(error) !== "DIRECT_CONNECTION_REQUIRED") throw error;
      return false;
    },
  );

/** The ledger must contain the whole list; pending or drifted history needs `migrate`/review. */
async function checkMigrations(m: Management, add: Add, registry: Registry) {
  try {
    const pending = (await pendingIn(m.db, qualified(m.schema, "_migrations"), registry.migrations, { missingOk: true })).map((migration) => migration.id);
    add("migrations", !pending.length, pending.length ? `Pending migrations: ${pending.join(", ")}. Run pgcells-single migrate.` : "Migrations are up to date.");
  } catch (error) {
    if (errorCode(error) !== "MIGRATION_DRIFT") throw error;
    add("migrations", false, "The migration ledger does not match the list (MIGRATION_DRIFT); review it manually.");
  }
}

async function inspectDatabase(m: Management, add: Add, registry: Registry) {
  add("direct_connection", await isDirectConnection(m), "The management DATABASE_URLS must be a direct (or session pooling) connection; a transaction pooler drops advisory locks.");
  const [strings] = await m.db.query<{ on: boolean }>("SELECT current_setting('standard_conforming_strings')='on' AS on");
  add("string_literals", strings?.on === true, "standard_conforming_strings must be on.");
  const [stored] = await m.db.query<{ settings: string | null }>(DATABASE_ROLE_SETTINGS);
  const expected = runtimeDatabaseDefaults(m.config);
  add("runtime_timeouts", expected.every((setting) => stored?.settings?.split(",").includes(setting)), `Runtime timeouts must be the DB defaults (${expected.join(", ")}); run migrate, then refresh the pooler connections.`);
  const exists = await schemaExists(m.db, m.schema);
  add("schema", exists, exists ? `Schema ${m.schema} exists.` : `Schema ${m.schema} does not exist; pgcells-single migrate creates it.`);
  await checkMigrations(m, add, registry);
}

/** `--pooled-url`: the runtime URL must go to a transaction-mode pooler; a direct connection gives `POOLER_REQUIRED` at runtime. */
async function inspectPooled(m: Management, url: string, add: Add) {
  const pooled = await usesTransactionPooler(m.driver, url, { deadlineMs: POOLED_PROBE_DEADLINE_MS });
  add("pooled_runtime", pooled, "The runtime DATABASE_URLS must go to a transaction-mode pooler; a direct connection gives POOLER_REQUIRED at runtime.");
}

/** Read-only checks per replica: a single short-lived connection is opened; the replica URL never appears in any output. */
async function inspectReplica(m: Management, url: string, add: Add) {
  const replica = m.driver(url, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  try {
    let probe: Awaited<ReturnType<typeof probeReplica>>;
    try {
      probe = await probeReplica(m.db, replica);
    } catch (error) {
      add("replica_reachable", false, `Could not connect to the replica (${errorCode(error)}); check the URL, network and credentials.`);
      return;
    }
    add("replica_reachable", true, "Replica is reachable.");
    add("replica_in_recovery", probe.inRecovery, "The URL must really go to a replica (pg_is_in_recovery); giving the primary as a replica breaks the read/write split.");
    const lag = probe.lagMs === null ? "unknown" : `${probe.lagMs} ms`;
    add("replica_lag", probe.lagMs !== null && probe.lagMs <= m.config.replicaMaxLagMs, `Replica lag must be below the ${m.config.replicaMaxLagMs} ms threshold (measured: ${lag}).`);
    const [stored] = await replica.query<{ settings: string | null }>(DATABASE_ROLE_SETTINGS);
    const expected = runtimeDatabaseDefaults(m.config);
    add("replica_runtime_timeouts", expected.every((setting) => stored?.settings?.split(",").includes(setting)), `Runtime timeouts come with the replica (${expected.join(", ")}); run migrate on the primary.`);
  } finally {
    await replica.close(1000);
  }
}

async function inspectPgBouncer(adminUrl: string, consoleDriver: Driver | undefined, add: Add) {
  const url = URL.parse(adminUrl);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/pgbouncer" || url.search)
    throw new AppError("INVALID_CONFIG", "PgBouncer admin URL must be postgres://…/pgbouncer");
  // The admin console does not accept transactions: a raw, single-connection pool.
  const driver = consoleDriver ?? (await import("../drivers/bun")).bunDriver;
  const adminConsole = driver(url.href, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 30, connectTimeoutSeconds: 10 });
  try {
    const settings = await adminConsole.query<{ key: string; value: string | null }>("SHOW CONFIG");
    const mode = settings.find((row) => row.key === "pool_mode")?.value;
    add("global_pool_mode", mode === "transaction", "The global pool_mode must be transaction. DB/user overrides must be checked separately via SHOW POOLS.");
  } finally {
    await adminConsole.close(1000);
  }
}

export interface DoctorOptions {
  /** PgBouncer admin console URL (postgres://…/pgbouncer). */
  pgbouncerUrl?: string;
  /** The application's runtime URL: proven to go to a transaction-mode pooler. */
  pooledUrl?: string;
  /** PgBouncer console client; defaults to Bun SQL (the tools run on Bun, and the console rejects postgres.js's startup type queries). */
  consoleDriver?: Driver;
  /** Migration list; defaults to the package's own registry (tests pass their own list). */
  registry?: Registry;
}

export async function doctor(m: Management, options: DoctorOptions = {}) {
  const checks: Check[] = [];
  /** Checks a single target; since driver errors can contain credentials, an error becomes a check with its details hidden. */
  async function inspect(target: string, run: (add: Add) => Promise<void>) {
    const add: Add = (check, ok, detail) => checks.push({ target, check, ok, detail });
    try {
      await run(add);
    } catch (error) {
      add("inspection", false, `The check could not be completed (${errorCode(error)}). Check the connection and permissions.`);
    }
  }

  await inspect("database", (add) => inspectDatabase(m, add, options.registry ?? packageRegistry));
  const { pooledUrl, pgbouncerUrl, consoleDriver } = options;
  if (pooledUrl !== undefined) await inspect("database", (add) => inspectPooled(m, pooledUrl, add));
  for (const [index, url] of m.config.replicas.entries()) await inspect(`replica#${index + 1}`, (add) => inspectReplica(m, url, add));
  if (pgbouncerUrl !== undefined) await inspect("pgbouncer", (add) => inspectPgBouncer(pgbouncerUrl, consoleDriver, add));
  return {
    ok: checks.every((c) => c.ok),
    checks,
    externalChecks: pooledUrl === undefined ? externalChecks : externalChecks.filter((item) => item.check !== "pooled_runtime"),
  };
}
