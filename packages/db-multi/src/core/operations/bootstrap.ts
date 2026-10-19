/** Platform migrations (platform + node), database IDs and runtime timeout defaults. Uses transaction-level locks. */
import { PLATFORM_DATABASE_ID, runtimeDatabaseDefaults } from "../config";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import type { Management } from "../management";
import { createLedger, nodeMigrations, pendingIn, platformMigrations } from "../migrations/registry";
import { PLATFORM_SCHEMA } from "../sql/compiler";
import { quoteIdentifier } from "../tenants/model";

/** db0 holds both ledgers; each scope has its own fixed table inside `platform`. */
const scopes = {
  platform: { registry: platformMigrations, ledger: "platform._migrations" },
  node: { registry: nodeMigrations, ledger: "platform._node_migrations" },
};
export type PlatformScope = keyof typeof scopes;

/** Applied platform migration IDs (per database); lists nothing on a re-run. `markedApplied`: those written without being run. */
export type BootstrapResult = { platform: string[]; nodes: Record<string, string[]>; markedApplied?: string[] };

export interface BootstrapOptions {
  /** Platform migrations produced by `pull`: written to the ledger without being run when their turn comes. For existing databases
   * whose objects arrived another way (e.g. the tables of a `panel` schema are moved with the application's own tool). `fromSchema` is required. */
  markApplied?: readonly string[];
  /** The schema on db0 the migration was `pull`ed from (e.g. `panel`). The structure digest of every migration to be marked must match
   * the current catalog of this schema; otherwise `SCHEMA_DRIFT` is raised and nothing is written. */
  fromSchema?: string;
}

/**
 * Before any work: only `pull`-marked platform migrations in this code can be marked, and the source schema's structure must equal each
 * one's structure digest; a wrong database or schema cannot be written to the ledger. The target `platform` is not compared: in the existing application the
 * objects of `panel_init` arrive via the application's own tool after marking.
 */
async function markableIds(m: Management, ids: readonly string[], fromSchema: string | undefined) {
  const pulled = ids.map((id) => {
    const marker = platformMigrations.find((migration) => migration.id === id)?.pulled;
    if (!marker) throw new AppError("MIGRATION_NOT_PENDING", `${id} is not a pulled platform migration in this code; only pull output can be marked applied`);
    return { id, ...marker };
  });
  if (!pulled.length) return new Set<string>();
  if (!fromSchema) throw new AppError("USAGE", "--mark-applied needs --from-schema <schema>: the db0 schema the migration was pulled from, compared before marking");
  const { pullStructure } = await import("../tools/pull");
  for (const { id, structure, exclude } of pulled) {
    const actual = await pullStructure(m.pools.platform, fromSchema, exclude);
    if (actual.structure !== structure)
      throw new AppError("SCHEMA_DRIFT", `schema ${fromSchema} on db0 does not match ${id} (expected sha256 ${structure}, found ${actual.structure}); nothing was marked`);
  }
  return new Set(ids);
}

/**
 * Idempotent: safe on every deploy, including managed PostgreSQL (e.g. Railway). Each database first proves its position identity;
 * a reordered DATABASE_URLS fails before any platform write.
 */
export async function bootstrap(m: Management, options: BootstrapOptions = {}): Promise<BootstrapResult> {
  const markApplied = await markableIds(m, options.markApplied ?? [], options.fromSchema);
  const registered = await registeredDatabases(m.pools.platform);
  const result: BootstrapResult = { platform: [], nodes: {} };
  for (const node of m.config.nodes)
    result.nodes[node.id] = await withBootstrapLock(m, node.id, async (tx) => {
      const { applied } = await migratePlatform(tx, "node");
      await claimIdentity(tx, node.id, registered.includes(node.id));
      await applyRuntimeDefaults(m, tx);
      return applied;
    });
  const platform = await withBootstrapLock(m, PLATFORM_DATABASE_ID, async (tx) => {
    const migrated = await migratePlatform(tx, "platform", markApplied);
    const ids = m.config.nodes.map((node) => node.id);
    const removed = (await registeredDatabases(tx)).filter((id) => !ids.includes(id));
    if (removed.length)
      throw new AppError("DATABASE_ORDER_CHANGED", `Registered databases ${removed.join(", ")} are missing from DATABASE_URLS; the list is append-only`);
    for (const id of ids) await tx.query("INSERT INTO platform.nodes (database_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    return migrated;
  });
  result.platform = platform.applied;
  if (markApplied.size) result.markedApplied = platform.marked;
  return result;
}

/** Read-only: the pending suffix of the scope registry in this database's ledger; drift throws MIGRATION_DRIFT. */
export const pendingPlatformMigrations = (db: Connection, scope: PlatformScope) => pendingIn(db, scopes[scope].ledger, scopes[scope].registry);

/** IDs registered in the platform database; none before the first bootstrap. */
async function registeredDatabases(db: Connection): Promise<string[]> {
  const [table] = await db.query<{ exists: boolean }>("SELECT pg_catalog.to_regclass('platform.nodes') IS NOT NULL AS exists");
  if (!table?.exists) return [];
  const rows = await db.query<{ database_id: string }>("SELECT database_id FROM platform.nodes ORDER BY database_id");
  return rows.map((row) => row.database_id);
}

/** Pending platform migrations and ledger rows are committed with the caller's transaction; those in `markApplied` are not run. */
async function migratePlatform(tx: Connection, scope: PlatformScope, markApplied: ReadonlySet<string> = new Set()) {
  const { ledger } = scopes[scope];
  // Keep repeated deploys quiet: "already exists, skipping" notices are expected.
  await tx.exec(`SET LOCAL client_min_messages TO warning; CREATE SCHEMA IF NOT EXISTS platform; ${createLedger(ledger)}`);
  const pending = await pendingPlatformMigrations(tx, scope);
  const applied: string[] = [];
  const marked: string[] = [];
  for (const migration of pending) {
    if (markApplied.has(migration.id)) marked.push(migration.id);
    else {
      for (const statement of migration.up.bind(PLATFORM_SCHEMA)) await tx.exec(statement);
      applied.push(migration.id);
    }
    await tx.query(`INSERT INTO ${ledger} (id,checksum) VALUES ($1,$2)`, [migration.id, migration.checksum]);
  }
  return { applied, marked };
}

/** The first bootstrap writes the position ID; later ones must find the same ID (the URL list is append-only). */
async function claimIdentity(tx: Connection, id: string, registered: boolean) {
  const [identity] = await tx.query<{ database_id: string }>("SELECT database_id FROM platform.node_identity");
  if (identity?.database_id === id) return;
  const moved = `DATABASE_URLS position ${id} points at database ${identity?.database_id}; restore the original order (the list is append-only)`;
  if (identity) throw new AppError("DATABASE_ORDER_CHANGED", moved);
  if (registered) throw new AppError("DATABASE_ORDER_CHANGED", `Database ${id} is registered but this URL points at an unregistered database`);
  await tx.query("INSERT INTO platform.node_identity (database_id) VALUES ($1)", [id]);
}

/** Runtime timeouts are database defaults: new backends get them behind every pooler (existing ones when they reconnect). */
async function applyRuntimeDefaults(m: Management, tx: Connection) {
  const [database] = await tx.query<{ name: string }>("SELECT pg_catalog.current_database() AS name");
  for (const setting of runtimeDatabaseDefaults(m.config))
    await tx.exec(`ALTER DATABASE ${quoteIdentifier(database?.name ?? "")} SET ${setting.replace("=", " = ")}`);
}

/** A single transaction holding the database's `platform-bootstrap` advisory lock; concurrent bootstraps queue instead of racing. */
function withBootstrapLock<T>(m: Management, databaseId: string, work: (tx: Connection) => Promise<T>) {
  return m.pools.node(databaseId).transaction(async (tx) => {
    // The management lock_timeout would drop a waiting bootstrap; the wait is still bounded by statement_timeout.
    await tx.exec("SET LOCAL lock_timeout = 0");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('platform-bootstrap',0))");
    await tx.exec(`SET LOCAL lock_timeout = ${m.config.migrationLockTimeoutMs}`);
    return work(tx);
  });
}
