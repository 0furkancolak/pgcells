#!/usr/bin/env bun
/** `pgcells` (in this repository `bun run cli` and `bun run tools`; the same entry point): validates the arguments, calls the management and tool functions, prints JSON; exit code 1 on an error
 * or incomplete work. The DB modules and the selected driver are loaded lazily; `local` commands (those that generate files) do not connect to the DB. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { boundedInteger, DATABASE_ID, loadConfig, MIGRATION_MAX } from "./config";
import type { Driver } from "./driver";
import { AppError, errorCode } from "./errors";
import type * as ManagementApi from "../management";
import type { Management } from "./management";
import type { MigrationRunOptions } from "./migrations/batch";
import type { SeedProfile } from "./migrations/source";
import { type TenantFields, tenantFieldsSchema } from "./tenants/fields";

export type CliOptions = MigrationRunOptions & {
  steps?: number;
  to?: string;
  scope?: string;
  name?: string;
  out?: string;
  profile?: SeedProfile;
  size?: number;
  capacity?: number;
  keep?: number;
  batchSize?: number;
  reason?: string;
  status?: string;
  set?: string;
  source?: string;
  file?: string;
  query?: string;
  onConflict?: "skip" | "link" | "fail";
  authRuntime?: "bun" | "workers";
  tenants?: string;
  baseline?: string;
  manifest?: string;
  exclude?: string[];
  sourceSchema?: string;
  override?: string;
  tenant?: TenantFields;
  markApplied?: string;
  fromSchema?: string;
  schema?: string[];
  at?: string;
  safetyPoint?: string;
  org?: string;
  check?: string;
  appInstances?: number;
  poolMax?: number;
  poolers?: number;
  defaultPoolSize?: number;
  maxClientConn?: number;
  maxConnections?: number;
  replicasPerNode?: number;
  distinctDbUsers?: number;
  managementConcurrency?: number;
  maintenanceConnections?: number;
  superuserReserved?: number;
  rps?: number;
  latencyMs?: number;
  statementTimeoutMs?: number;
};
/** Options that take no value; `--from-url`, `--pgbouncer-url` and `--pooled-urls` only mean "ask for the URL with hidden input". */
type Switches = {
  demo?: boolean;
  ts?: boolean;
  writersDrained?: boolean;
  fromUrl?: boolean;
  pgbouncerUrl?: boolean;
  pooledUrls?: boolean;
  full?: boolean;
  fromReplica?: boolean;
  noTls?: boolean;
};
type Options = CliOptions & Switches;
interface Command {
  /** `<x>` is a required argument, `[x]` an optional one; `--…` is help text only. */
  usage: string;
  summary: string;
  /** Accepted options. */
  flags?: readonly string[];
  /** SIGINT/SIGTERM stops admitting new work and cancels after the grace period; in local commands it stops the work. */
  cancellable?: boolean;
  local?(options: Options, ...args: string[]): Promise<unknown>;
  run?(context: { api: typeof ManagementApi; app: Management; options: Options }, ...args: string[]): Promise<unknown>;
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const usage = (message: string) => new AppError("USAGE", message);
const MIGRATION_FLAGS = ["--dry-run", "--db", "--concurrency", "--per-db-concurrency", "--continue-on-error"];
const BOOLEAN_FLAGS = ["--dry-run", "--demo", "--ts", "--continue-on-error", "--writers-drained", "--from-url", "--pgbouncer-url", "--pooled-urls", "--full", "--from-replica", "--no-tls"];
/** URLs that carry a password are not put in argv (readable via `ps`); they are asked for with hidden input: [ask-secret.ts](tools/ask-secret.ts). */
const SOURCE_URL_QUESTION = "Source DB URL (postgres://…, input is hidden): ";
const PGBOUNCER_URL_QUESTION = "PgBouncer console URL (postgres://…/pgbouncer, input is hidden): ";
const askUrl = async (question: string, subject: string) => {
  const { askSecret, postgresUrl } = await import("./tools/ask-secret");
  return postgresUrl(await askSecret(question), subject).href;
};
const POOLED_URLS_QUESTION = "Runtime URLs (DATABASE_URLS format, comma-separated, input is hidden): ";
/** A comma-separated URL list is asked for with hidden input; each entry (optionally prefixed `db<N>=`) is validated, and error messages do not contain the value. */
const askUrls = async (question: string, subject: string) => {
  const { askSecret, postgresUrl } = await import("./tools/ask-secret");
  return (await askSecret(question))
    .split(",")
    .map((entry) => {
      const [, id = "", url = entry.trim()] = /^\s*(db(?:0|[1-9]\d?)=)?(.*)$/.exec(entry) ?? [];
      return `${id}${postgresUrl(url.trim(), subject).href}`;
    })
    .join(",");
};
const REPLICA_URLS_QUESTION = "Direct replica URLs (db0=postgres://…, comma-separated, input is hidden): ";
const REPLICA_ENTRY_HINT = "Replica entries look like db0=postgres://… (comma-separated)";
/** `db<N>=postgres://…,…` → validated, normalized text; error messages do not contain the value. */
export function replicaEntries(answer: string): string {
  const entries = answer.split(",").map((entry) => entry.trim());
  if (!answer.trim() || entries.some((entry) => !DATABASE_ID.test(entry.slice(0, Math.max(entry.indexOf("="), 0))))) throw usage(REPLICA_ENTRY_HINT);
  return entries
    .map((entry) => {
      const at = entry.indexOf("=");
      const url = URL.parse(entry.slice(at + 1));
      if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) throw usage(REPLICA_ENTRY_HINT);
      return `${entry.slice(0, at)}=${url.href}`;
    })
    .join(",");
}
const askReplicaUrls = async () => replicaEntries(await (await import("./tools/ask-secret")).askSecret(REPLICA_URLS_QUESTION));
const NEON_KEY_QUESTION = "Neon API key (input is hidden): ";
const neon = () => import("./tools/neon");
/** The Neon API key does not go into argv or env; it is asked for with hidden input. */
const askNeonApi = async () => {
  const [{ askSecret }, { neonApi }] = await Promise.all([import("./tools/ask-secret"), neon()]);
  return neonApi(await askSecret(NEON_KEY_QUESTION));
};
/** Repeatable options: the values (which may also be comma-separated) accumulate in a list. */
const REPEATABLE_FLAGS = ["--exclude", "--schema"];
/** Numeric options → upper limit. */
const INTEGER_FLAGS: Record<string, number> = {
  "--concurrency": MIGRATION_MAX.concurrency,
  "--per-db-concurrency": MIGRATION_MAX.perDatabase,
  "--steps": 10000,
  "--size": 100,
  "--capacity": 1_000_000,
  "--keep": 1000,
  "--batch-size": 10000,
  "--instances": 1_000_000,
  "--pool-max": 100,
  "--poolers": 1000,
  "--default-pool-size": 10_000,
  "--max-client-conn": 1_000_000,
  "--max-connections": 100_000,
  "--replicas": 8,
  "--db-users": 100,
  "--management": 1000,
  "--maintenance": 10_000,
  "--superuser-reserved": 1000,
  "--rps": 100_000_000,
  "--latency-ms": 600_000,
  "--statement-timeout-ms": 300_000,
};
/** Options whose key differs from their camelCase equivalent. */
const FLAG_KEYS: Record<string, string> = {
  "--per-db-concurrency": "perDatabaseConcurrency",
  "--db": "databaseIds",
  "--instances": "appInstances",
  "--replicas": "replicasPerNode",
  "--db-users": "distinctDbUsers",
  "--management": "managementConcurrency",
  "--maintenance": "maintenanceConnections",
};
const HELP_FLAGS = ["--help", "-h"];
const DRIVER_FLAG = "--driver=";
const commaList = (value: string) => value.split(",").map((id) => id.trim()).filter(Boolean);
const optionalCommaList = (value: string | undefined) => (value === undefined ? undefined : commaList(value));
/** Only the selected driver is loaded; since the CLI runs on Bun, the default is Bun SQL. */
const drivers: Record<string, () => Promise<Driver>> = {
  bun: () => import("./drivers/bun").then((m) => m.bunDriver),
  postgres: () => import("./drivers/postgres").then((m) => m.postgresDriver),
  pg: () => import("./drivers/pg").then((m) => m.pgDriver),
};
const exitOnFailure = (summary: { failed: number; incomplete: boolean }) => {
  if (summary.failed || summary.incomplete) process.exitCode = 1;
  return summary;
};
const move = () => import("./tools/move");
const tenancy = () => import("./tools/tenancy");
const backup = () => import("./tools/backup");
const adopt = () => import("./tools/adopt");

/** JSONL lines (empty lines are skipped); malformed JSON gives `USAGE` (with the line number in the file). */
async function readJsonLines(file: string) {
  const { readLines } = await import("./tools/jsonl");
  const rows: unknown[] = [];
  let line = 0;
  for await (const text of readLines(file)) {
    line++;
    if (!text.trim()) continue;
    try {
      rows.push(JSON.parse(text));
    } catch {
      throw usage(`${file}:${line} is not valid JSON`);
    }
  }
  return rows;
}

/** Exit code 1 if any of the results is in a status other than these. */
const exitOnStatus = <T extends { results: { status: string }[] }>(result: T, ok: readonly string[]) => {
  if (result.results.some((row) => !ok.includes(row.status))) process.exitCode = 1;
  return result;
};

/** The `users import` source: `--source` and either `--file` or `--from-url` (the URL is asked for with hidden input) together with `--query`. */
function validateImportSource(options: Options): string {
  if (!options.source) throw usage("users import needs --source");
  if (!!options.file === !!(options.fromUrl || options.query)) throw usage("Pass either --file or --from-url with --query");
  if (!options.file && !(options.fromUrl && options.query)) throw usage("--from-url and --query go together");
  return options.source;
}

/** Does not overwrite an existing file (`USAGE`). */
async function writeNewFile(target: string, code: string) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, code, { flag: "wx" }).catch((error) => {
    throw errorCode(error) === "EEXIST" ? usage(`${target} already exists`) : error;
  });
}

const commands: Record<string, Command> = {
  bootstrap: {
    usage: "[--mark-applied id,id --from-schema schema]",
    summary: "Platform/node migrations, DB identities and runtime settings (--mark-applied: marks a platform migration generated by pull as applied without running it, if the --from-schema structure on db0 is identical)",
    flags: ["--mark-applied", "--from-schema"],
    run: async ({ api, app, options }) => ({
      ready: true,
      applied: await api.bootstrap(app, { markApplied: optionalCommaList(options.markApplied), fromSchema: options.fromSchema }),
    }),
  },
  status: {
    usage: "<tenant>",
    summary: "Shows the tenant placement",
    run: ({ app }, tenant) => app.platform.get(tenant),
  },
  provision: {
    usage: "<tenant> [dbN] [--size 1-100] [--demo] [--tenant JSON]",
    summary: "Creates a tenant; if no DB is given, the least loaded DB for the size (example: abc --size 20 --tenant '{\"name\":\"Abc\"}')",
    flags: ["--demo", "--size", "--tenant"],
    cancellable: true,
    run: ({ api, app, options }, tenant, databaseId) => api.provisionTenant(app, tenant, databaseId || undefined, options),
  },
  reserve: {
    usage: "<ids> [--reason text]",
    summary: "Reserves tenant IDs, comma-separated (example: www,admin)",
    flags: ["--reason"],
    run: async ({ app, options }, list) => (await tenancy()).reserveTenantIds(app, commaList(list), options.reason),
  },
  unreserve: {
    usage: "<ids>",
    summary: "Removes the reservation",
    run: async ({ app }, list) => (await tenancy()).releaseTenantIds(app, commaList(list)),
  },
  reserved: {
    usage: "",
    summary: "Lists the reserved tenant IDs",
    run: async ({ app }) => (await tenancy()).listReservedTenantIds(app),
  },
  databases: {
    usage: "",
    summary: "Status, capacity, tenant count and load of the DBs",
    run: async ({ app }) => (await tenancy()).listDatabases(app),
  },
  replicas: {
    usage: "",
    summary: "Status and lag of the replicas in DATABASE_REPLICA_URLS (exit code 1 if a replica is down or exceeds the threshold)",
    run: async ({ app }) => {
      const result = await (await import("./tools/replicas")).replicaReport(app);
      if (!result.ok) process.exitCode = 1;
      return result;
    },
  },
  "database set": {
    usage: "<dbN> [--status active|draining] [--capacity N]",
    summary: "Placement: a draining DB takes no new tenants",
    flags: ["--status", "--capacity"],
    run: async ({ app, options }, databaseId) => (await tenancy()).setDatabase(app, databaseId, options),
  },
  backup: {
    usage: "<dir> [--full] [--tenants a,b] [--concurrency N] [--from-replica]",
    summary: "Incremental backup of the active tenants (--full: full set; --from-replica: reads the data from the replica, always a full set, the URLs are asked for with hidden input)",
    flags: ["--full", "--tenants", "--concurrency", "--from-replica"],
    cancellable: true,
    run: async ({ app, options }, dir) => {
      const replicaUrls = options.fromReplica ? await askReplicaUrls() : undefined;
      const result = await (await backup()).backupAll(app, dir, { ...options, tenants: optionalCommaList(options.tenants), replicaUrls });
      if (result.failed) process.exitCode = 1;
      return result;
    },
  },
  "backup prune": {
    usage: "<dir> --keep N",
    summary: "Keeps the last N sets and the sets they refer to, deletes the others",
    flags: ["--keep"],
    local: async ({ keep }, dir) => {
      if (keep === undefined) throw usage("backup prune needs --keep N");
      return (await backup()).pruneBackups(dir, keep);
    },
  },
  export: {
    usage: "<tenant> <dir> [--from-replica]",
    summary: "Writes all of a tenant's data to a directory in one go (--from-replica: reads the data from the replica, the URL is asked for with hidden input)",
    flags: ["--from-replica"],
    cancellable: true,
    run: async ({ app, options }, tenant, dir) =>
      (await backup()).exportTenant(app, tenant, dir, { ...options, replicaUrls: options.fromReplica ? await askReplicaUrls() : undefined }),
  },
  restore: {
    usage: "<tenant> <dir> [dbN] [--set ID] [--size 1-100]",
    summary: "Restores a missing tenant from a backup (root or export directory)",
    flags: ["--set", "--size"],
    cancellable: true,
    run: async ({ app, options }, tenant, dir, databaseId) =>
      (await backup()).restoreTenant(app, tenant, dir, { ...options, databaseId: databaseId || undefined }),
  },
  "neon stage-copy": {
    usage: "[--org ID]",
    summary: "Neon: creates a branch from each source branch for a migration trial (the branch id and host are printed, the URI with the password is not)",
    flags: ["--org"],
    run: async ({ app, options }) => (await neon()).stageCopy(app, await askNeonApi(), { org: options.org }),
  },
  "neon export-tenant": {
    usage: "<tenant> <dir> --at TIME [--org ID]",
    summary: "Neon: writes a tenant's past point in time to an export directory (does not touch live data; use restore to apply it)",
    flags: ["--at", "--org"],
    cancellable: true,
    run: async ({ app, options }, tenant, dir) => {
      const tools = await neon();
      const at = tools.parsePastTimestamp(options.at, new Date());
      return tools.exportTenantAt(app, await askNeonApi(), { tenantId: tenant, dir, at, org: options.org, signal: options.signal });
    },
  },
  "adopt plan": {
    usage: "<rows.jsonl> [--baseline migrationId]",
    summary: "Plan for adopting existing schemas as tenants (read-only; exit code 1 if any row is blocked)",
    flags: ["--baseline"],
    run: async ({ app, options }, file) => {
      const plan = await (await adopt()).planAdoption(app, await readJsonLines(file), options);
      if (plan.rows.some((row) => row.status === "blocked")) process.exitCode = 1;
      return plan;
    },
  },
  "adopt apply": {
    usage: "<rows.jsonl> [--baseline migrationId] [--manifest file.json]",
    summary: "Adopts the ready rows: placement, ALTER SCHEMA RENAME, activation (safe to re-run)",
    flags: ["--baseline", "--manifest"],
    cancellable: true,
    run: async ({ app, options }, file) => {
      const result = await (await adopt()).adoptSchemas(app, await readJsonLines(file), options);
      if (options.manifest) await writeFile(options.manifest, `${JSON.stringify(result.manifest, null, 2)}\n`);
      return exitOnStatus({ ...result, manifestFile: options.manifest }, ["adopted", "alreadyAdopted"]);
    },
  },
  "adopt rollback": {
    usage: "<manifest.json>",
    summary: "Rolls back the adoption: the schema goes back to its old name, the placement is deleted (a moved tenant is rejected)",
    cancellable: true,
    run: async ({ app, options }, file) => {
      const manifest: unknown = await Bun.file(file).json().catch(() => {
        throw usage(`${file} is not a JSON manifest`);
      });
      return exitOnStatus(await (await adopt()).rollbackAdoption(app, manifest, options), ["rolledBack", "alreadyRolledBack"]);
    },
  },
  "users import": {
    usage: "<tenant> --source name (--file users.jsonl | --from-url --query SQL) [--on-conflict skip|link|fail] [--auth-runtime bun|workers] [--dry-run] [--batch-size N]",
    summary: "Imports users from another application/DB (--from-url: asks for the source DB URL with hidden input; safe to re-run)",
    flags: ["--source", "--file", "--from-url", "--query", "--on-conflict", "--auth-runtime", "--dry-run", "--batch-size"],
    cancellable: true,
    run: async ({ app, options }, tenant) => {
      const source = validateImportSource(options);
      const { importUsers, jsonLinesSource, sqlSource } = await import("./tools/import-users");
      const rows = options.file
        ? jsonLinesSource(options.file)
        : sqlSource(app.driver, await askUrl(SOURCE_URL_QUESTION, "Source database URL"), options.query as string);
      return importUsers(app, tenant, rows, { ...options, source });
    },
  },
  "dump split": {
    usage: "<backup.sql> <dir>",
    summary: "Splits another application's SQL backup table by table and writes analysis.json (no DB needed)",
    local: async (_, file, dir) => {
      const { tables, dialect } = await (await import("./tools/sql-dump")).splitSqlDump(file, dir);
      const tableSummaries = Object.entries(tables).map(([name, table]) => [name, { rows: table.rows, columns: table.columns.length }]);
      return { dir, dialect, tables: Object.fromEntries(tableSummaries) };
    },
  },
  "dump fetch": {
    usage: "<out.sql.gz> [--schema name ...]",
    summary: "Downloads a plain-text backup of a remote PostgreSQL (e.g. staging) with pg_dump in Docker (asks for the DB URL with hidden input; only reads the DB)",
    flags: ["--schema"],
    cancellable: true,
    local: async ({ schema, signal }, file) => {
      const { askSecret } = await import("./tools/ask-secret");
      const { fetchDump } = await import("./tools/fetch-dump");
      return fetchDump(file, { url: () => askSecret(SOURCE_URL_QUESTION), schemas: schema, signal });
    },
  },
  "dump scaffold": {
    usage: "<dir> --name legacy2app --source legacy [--out file.ts]",
    summary: "Generates a scaffold of an import module from the parts",
    flags: ["--name", "--source", "--out"],
    local: async ({ name, source, out }, dir) => {
      if (!name || !/^[a-z][a-z0-9_-]*$/i.test(name) || !source) throw usage("dump scaffold needs --name (e.g. legacy2app) and --source");
      const { readAnalysis, scaffoldAppMigration } = await import("./tools/sql-dump");
      const target = out ?? `src/app-migrations/${name}.ts`;
      const importFrom = out ? undefined : "../tools";
      await writeNewFile(target, scaffoldAppMigration(await readAnalysis(dir), { name, source, importFrom }));
      return { file: target };
    },
  },
  "app-migrate": {
    usage: "<tenant> <dir|backup.sql> --file src/app-migrations/name.ts [--auth-runtime bun|workers] [--dry-run] [--batch-size N]",
    summary: "Imports another application's data into a tenant with a defineAppMigration module (safe to re-run)",
    flags: ["--file", "--auth-runtime", "--dry-run", "--batch-size"],
    cancellable: true,
    run: async ({ app, options }, tenant, input) => {
      if (!options.file) throw usage("app-migrate needs --file");
      const migration = (await import(pathToFileURL(resolve(options.file)).href)).default;
      if (typeof migration !== "function" || !migration.definition) throw usage(`${options.file} must default-export defineAppMigration(...)`);
      return migration(app, tenant, input, options);
    },
  },
  seed: {
    usage: "<tenant> [--profile install|demo] [--dry-run]",
    summary: "Applies the pending seeds (default install)",
    flags: ["--profile", "--dry-run"],
    cancellable: true,
    run: ({ api, app, options }, tenantId) => api.seedTenant(app, tenantId, options),
  },
  "seed-all": {
    usage: "[--profile install|demo] [--options]",
    summary: "Applies the pending seeds to the active tenants",
    flags: ["--profile", ...MIGRATION_FLAGS],
    cancellable: true,
    run: async ({ api, app, options }) => exitOnFailure(await api.seedAll(app, options)),
  },
  "seed create": {
    usage: "<name> --profile install|demo [--ts]",
    summary: "An empty SQL (or --ts) seed file and the profile list",
    flags: ["--profile", "--ts"],
    local: async ({ profile, ts }, name) => (await import("./sql/codegen")).createSeed({ name, profile, kind: ts ? "ts" : "sql" }),
  },
  "demo-reset": {
    usage: "<tenant>",
    summary: "Drops and recreates the demo tenant and seeds it",
    cancellable: true,
    run: ({ api, app, options }, tenantId) => api.resetDemoTenant(app, tenantId, options),
  },
  "migration-status": {
    usage: "<tenant>",
    summary: "Shows the pending migrations",
    run: ({ api, app }, tenantId) => api.migrationStatus(app, tenantId),
  },
  "migration-recover": {
    usage: "",
    summary: "Recovers a half-finished migration state",
    run: async ({ api, app }) => ({
      ...(await api.recoverMigrations(app)),
      next: "Rerun migration; each schema ledger and concurrent index will be inspected",
    }),
  },
  migrate: {
    usage: "<tenant> [--options]",
    summary: "Migrates a single tenant",
    flags: MIGRATION_FLAGS,
    cancellable: true,
    run: ({ api, app, options }, tenantId) => api.migrateTenant(app, tenantId, options),
  },
  "migrate-all": {
    usage: "[--options] [--safety-point neon|supabase] [--org ID]",
    summary: "Migrates the tenants that are not up to date in bulk (--safety-point: first takes a safety point at the provider)",
    flags: [...MIGRATION_FLAGS, "--safety-point", "--org"],
    cancellable: true,
    run: async ({ api, app, options }) => {
      const tools = options.safetyPoint === undefined && options.org === undefined ? undefined : await neon();
      const provider = tools?.safetyPointProvider(options.safetyPoint);
      if (options.org !== undefined && provider !== "neon") throw usage("--org applies to --safety-point neon");
      if (tools && provider)
        print(provider === "neon" ? await tools.safetyPoint(app, await askNeonApi(), { org: options.org }) : tools.supabaseSafetyPoint());
      return exitOnFailure(await api.migrateAll(app, options));
    },
  },
  "migrate-down": {
    usage: "<tenant> [--steps N | --to ID] [--dry-run]",
    summary: "Rolls back the last migrations (default 1)",
    flags: ["--steps", "--to", "--dry-run"],
    cancellable: true,
    run: ({ api, app, options }, tenantId) => api.rollbackTenant(app, tenantId, options),
  },
  "migration create": {
    usage: "<name> [--scope tenant|platform|node]",
    summary: "An empty --up/--down file and the scope list",
    flags: ["--scope"],
    local: async ({ scope }, name) => (await import("./sql/codegen")).createMigration({ name, scope }),
  },
  "migration baseline": {
    usage: "<tenant> <migrationId> [--db dbN]",
    summary: "Marks as applied without running (the live schema must match)",
    flags: ["--db"],
    cancellable: true,
    run: ({ api, app, options }, tenantId, migrationId) => {
      if ((options.databaseIds?.length ?? 0) > 1) throw usage("--db takes one database ID");
      return api.markMigrationApplied(app, tenantId, migrationId, { ...options, databaseId: options.databaseIds?.[0] });
    },
  },
  "auth generate": {
    usage: "<optionsModule> [--name better_auth]",
    summary: "A tenant migration from the Better Auth options (writes no file if there is no difference)",
    flags: ["--name"],
    run: async ({ app, options }, module) => {
      const { generateAuthMigration } = await import("./tools/auth");
      const authOptions = (await import(resolve(module))).default;
      return generateAuthMigration({ db: app, options: authOptions, name: options.name });
    },
  },
  pull: {
    usage: "<schema> [--db dbN] [--scope tenant|platform] [--name init] [--exclude table ...]",
    summary: "Writes a single initial migration from the structure of an existing schema (only reads the DB)",
    flags: ["--db", "--scope", "--name", "--exclude"],
    run: async ({ app, options }, schema) => {
      if ((options.databaseIds?.length ?? 0) > 1) throw usage("--db takes one database ID");
      const { pullSchema } = await import("./tools/pull");
      return pullSchema(app, schema, { databaseId: options.databaseIds?.[0], scope: options.scope, name: options.name, exclude: options.exclude });
    },
  },
  "pooler plan": {
    usage: "--instances N --pool-max N --poolers N --default-pool-size N --max-client-conn N --max-connections N",
    summary:
      "Connection budget of one cell: client connections, server connections and statement flow against the pooler and PostgreSQL limits (no DB needed; exit code 1 on a violation). Optional: --replicas N --db-users N --management N --maintenance N --superuser-reserved N --rps N --latency-ms N",
    flags: [
      "--instances", "--pool-max", "--poolers", "--default-pool-size", "--max-client-conn", "--max-connections",
      "--replicas", "--db-users", "--management", "--maintenance", "--superuser-reserved", "--rps", "--latency-ms",
    ],
    local: async (options) => {
      const missing = (["appInstances", "poolMax", "poolers", "defaultPoolSize", "maxClientConn", "maxConnections"] as const).filter((key) => options[key] === undefined);
      if (missing.length) throw usage(`pooler plan needs ${missing.join(", ")} (flags: --instances, --pool-max, --poolers, --default-pool-size, --max-client-conn, --max-connections)`);
      const { connectionBudget } = await import("./tools/pooler-plan");
      const plan = connectionBudget({
        appInstances: options.appInstances as number,
        poolMax: options.poolMax as number,
        poolers: options.poolers as number,
        defaultPoolSize: options.defaultPoolSize as number,
        maxClientConn: options.maxClientConn as number,
        maxConnections: options.maxConnections as number,
        replicasPerNode: options.replicasPerNode,
        distinctDbUsers: options.distinctDbUsers,
        managementConcurrency: options.managementConcurrency,
        maintenanceConnections: options.maintenanceConnections,
        superuserReserved: options.superuserReserved,
        rps: options.rps,
        latencyMs: options.latencyMs,
      });
      if (!plan.ok) process.exitCode = 1;
      return plan;
    },
  },
  "pooler generate": {
    usage: "[--poolers N] [--default-pool-size N] [--max-client-conn N] [--statement-timeout-ms N] [--no-tls] [--out dir | --check dir]",
    summary:
      "PgBouncer pgbouncer.ini and a userlist.txt skeleton for the nodes in DATABASE_URLS/DATABASE_REPLICA_URLS (no DB needed, no secrets in the output). Without --out the files are printed; --out writes them (never replacing a different file); --check compares an existing pgbouncer.ini and exits 1 on a difference",
    flags: ["--poolers", "--default-pool-size", "--max-client-conn", "--statement-timeout-ms", "--out", "--check", "--no-tls"],
    local: async (options) => {
      if (options.out && options.check) throw usage("Pass either --out or --check");
      const { generatePoolerFiles } = await import("./tools/pooler-generate");
      const files = generatePoolerFiles({ nodes: loadConfig().nodes, ...options, tls: !options.noTls });
      if (options.check) {
        const actual = await readFile(`${options.check}/pgbouncer.ini`, "utf8").catch(() => {
          throw usage(`${options.check}/pgbouncer.ini cannot be read`);
        });
        const { compareLines } = await import("./tools/pooler-generate");
        const differences = compareLines(files["pgbouncer.ini"], actual);
        if (differences.length) process.exitCode = 1;
        return { ok: differences.length === 0, file: `${options.check}/pgbouncer.ini`, differences };
      }
      if (!options.out) return { files };
      const written: string[] = [];
      for (const [name, text] of Object.entries(files)) {
        const target = `${options.out}/${name}`;
        const existing = await readFile(target, "utf8").catch(() => undefined);
        if (existing === text) continue;
        await writeNewFile(target, text);
        written.push(target);
      }
      return { written };
    },
  },
  doctor: {
    usage: "[--pgbouncer-url] [--pooled-urls] [--instances N --pool-max N --poolers N]",
    summary:
      "Checks the connection, DB identity, timeouts and platform state read-only (--pgbouncer-url: asks for the console URL, --pooled-urls: asks for the runtime URLs, with hidden input; with --pgbouncer-url, --instances/--pool-max/--poolers also check the connection budget against the pooler's and PostgreSQL's real limits, optionally --replicas N --db-users N --rps N --latency-ms N)",
    flags: ["--pgbouncer-url", "--pooled-urls", "--instances", "--pool-max", "--poolers", "--replicas", "--db-users", "--rps", "--latency-ms"],
    run: async ({ app, options }) => {
      const shape = (["appInstances", "poolMax", "poolers"] as const).map((key) => options[key]);
      const wantsBudget = [...shape, options.replicasPerNode, options.distinctDbUsers, options.rps, options.latencyMs].some((value) => value !== undefined);
      if (wantsBudget && shape.some((value) => value === undefined)) throw usage("The connection budget needs --instances, --pool-max and --poolers together");
      if (wantsBudget && !options.pgbouncerUrl) throw usage("The connection budget reads the pooler's sizes: pass --pgbouncer-url as well");
      const pgbouncerUrl = options.pgbouncerUrl ? await askUrl(PGBOUNCER_URL_QUESTION, "PgBouncer admin URL") : undefined;
      const pooledUrls = options.pooledUrls ? await askUrls(POOLED_URLS_QUESTION, "Runtime URL") : undefined;
      const budget = wantsBudget
        ? {
            appInstances: options.appInstances as number,
            poolMax: options.poolMax as number,
            poolers: options.poolers as number,
            replicasPerNode: options.replicasPerNode,
            distinctDbUsers: options.distinctDbUsers,
            rps: options.rps,
            latencyMs: options.latencyMs,
          }
        : undefined;
      const result = await (await import("./tools/doctor")).doctor(app, { pgbouncerUrl, pooledUrls, budget });
      if (!result.ok) process.exitCode = 1;
      return result;
    },
  },
  move: {
    usage: "<tenant> <databaseId> --writers-drained",
    summary: "Moves a tenant (example: abc db1)",
    flags: ["--writers-drained"],
    run: async ({ app, options }, tenant, databaseId) =>
      (await move()).startMove(app, tenant, databaseId, options.writersDrained, (started) => print({ moveId: started.id })),
  },
  "move-status": {
    usage: "<moveId>",
    summary: "Shows the move status",
    run: async ({ app }, id) => (await move()).getMove(app, id),
  },
  "resume-move": {
    usage: "<moveId> --writers-drained",
    summary: "Resumes a half-finished move",
    flags: ["--writers-drained"],
    run: async ({ app, options }, id) => (await move()).resumeMove(app, id, options.writersDrained),
  },
  "rollback-move": {
    usage: "<moveId> --writers-drained",
    summary: "Rolls back a move that stopped before the DB switch",
    flags: ["--writers-drained"],
    run: async ({ app, options }, id) => {
      await (await move()).rollbackMove(app, id, options.writersDrained);
      return { rolledBack: true };
    },
  },
};

/** On short lines the summary is at column 40; on long lines it is on the next line in the same column. */
const helpLine = ([name, command]: [string, Command]) => {
  const line = `${name} ${command.usage}`.trim();
  return line.length < 40 ? `  ${line.padEnd(40)}${command.summary}` : `  ${line}\n  ${" ".repeat(40)}${command.summary}`;
};

const help = `Multi-tenant database management tool

Usage:
  pgcells <command> [arguments] [options] [--driver=bun|postgres|pg]

Commands:
${Object.entries(commands).map(helpLine).join("\n")}

Options (migrate, migrate-all, seed-all): --dry-run, --db db0,db1, --concurrency N (total), --per-db-concurrency N,
  --continue-on-error (continue with the other tenants after an error). An option value is given as --name value or --name=value.

move, resume-move and rollback-move require --writers-drained, which confirms that the writers have been stopped (docs/operations.md#tenant-move).
Environment: DATABASE_URLS (required; direct or session-pooling connections; the first URL is the platform DB, or name the nodes: db0=url,db1=url).
Driver: --driver (default bun). See the README for detailed setup.`;

const camelCase = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

function databaseIdList(value: string) {
  const databaseIds = value.split(",").map((id) => id.trim());
  if (!databaseIds.every((id) => DATABASE_ID.test(id)) || new Set(databaseIds).size !== databaseIds.length)
    throw usage("--db needs a comma-separated list of unique database IDs (db0, db1, …)");
  return databaseIds;
}

/** Malformed JSON gives `undefined` (schema validation rejects it). */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** `--tenant '{"name":"…"}'`: a JSON object with plain values; the columns are validated during the operation against the real `platform.tenants` columns. */
function tenantFieldsOption(value: string): TenantFields {
  const fields = tenantFieldsSchema.safeParse(parseJson(value));
  if (!fields.success) throw usage("--tenant needs a JSON object of string, number, boolean or null values");
  return fields.data;
}

/** Parses the value of an option that takes a value according to its type: a bounded integer, a DB ID list, tenant fields or text. */
function optionValue(flag: string, value: string): unknown {
  const max = INTEGER_FLAGS[flag];
  if (max !== undefined) return boundedInteger(value, flag.slice(2), max);
  if (flag === "--db") return databaseIdList(value);
  if (flag === "--tenant") return tenantFieldsOption(value);
  return value;
}

/** `--option value` or `--option=value`; an unaccepted, repeated or valueless option gives `USAGE`. */
export function parseOptions(args: readonly string[], allowed: readonly string[] = MIGRATION_FLAGS): Options {
  const options: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const [flag = "", inline] = (args[i] ?? "").split(/=(.*)/s);
    // The argument text may be secret (a URL with a password): only option names are printed.
    if (!allowed.includes(flag))
      throw usage(flag.startsWith("--") ? `Unknown option: ${flag}` : "Unexpected argument: values are given as --option value, and URL options ask for the value with hidden input");
    const repeatable = REPEATABLE_FLAGS.includes(flag);
    if (seen.has(flag) && !repeatable) throw usage(`Repeated option: ${flag}`);
    seen.add(flag);
    const key = FLAG_KEYS[flag] ?? camelCase(flag.slice(2));
    if (BOOLEAN_FLAGS.includes(flag)) {
      if (inline !== undefined) throw usage(`${flag} takes no value`);
      options[key] = true;
      continue;
    }
    const value = inline ?? args[++i];
    if (!value || value.startsWith("--")) throw usage(`${flag} needs a value`);
    options[key] = repeatable ? [...((options[key] as string[] | undefined) ?? []), ...commaList(value)] : optionValue(flag, value);
  }
  return options;
}

/** Separates the `--driver=` arguments; the rest are the command and options. */
function takeDriverFlag(argv: readonly string[]) {
  const isDriverFlag = (arg: string) => arg.startsWith(DRIVER_FLAG);
  return {
    driverNames: argv.filter(isDriverFlag).map((arg) => arg.slice(DRIVER_FLAG.length)),
    args: argv.filter((arg) => !isDriverFlag(arg)),
  };
}

function selectDriver(driverNames: readonly string[]) {
  const driver = drivers[driverNames.at(-1) ?? "bun"];
  if (driverNames.length > 1 || !driver) throw usage("--driver must be one of: bun, postgres, pg");
  return driver;
}

/** Two-word commands (`migration create`) match before single-word ones. */
function resolveCommand(args: readonly string[]) {
  const words = Object.hasOwn(commands, args.slice(0, 2).join(" ")) ? 2 : 1;
  const name = args.slice(0, words).join(" ");
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  return { name, command, rest: args.slice(words) };
}

const requiredCount = (command: Command) => command.usage.split("<").length - 1;

/** Positional arguments may come before or after the options (scripts put the option first: `migration create --scope tenant name`).
 * The argument after an accepted option that takes a value (`--name value`) is its value. At most the required + optional number of positional arguments
 * are taken; any extra falls into the option list and gives `USAGE`. `[x]` is an optional positional argument, `[--x]` does not count. */
export function splitArguments(command: Pick<Command, "usage" | "flags">, rest: readonly string[]) {
  const max = requiredCount(command as Command) + (command.usage.match(/\[(?!-)/g)?.length ?? 0);
  const positional: string[] = [];
  const options: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    const next = rest[i + 1];
    if (arg.startsWith("--")) {
      options.push(arg);
      const takesValue = !arg.includes("=") && !BOOLEAN_FLAGS.includes(arg) && (command.flags ?? []).includes(arg);
      if (takesValue && next !== undefined && !next.startsWith("--")) options.push(rest[++i] ?? "");
    } else if (positional.length < max) positional.push(arg);
    else options.push(arg);
  }
  return { positional, options };
}

const CANCEL_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** In cancellable commands, SIGINT/SIGTERM calls `stop`. */
function onCancelSignals(command: Command, stop: () => void) {
  if (command.cancellable) for (const signal of CANCEL_SIGNALS) process.once(signal, stop);
}

const wantsHelp = (name: string, command: Command | undefined, rest: readonly string[]) =>
  ["", "help", ...HELP_FLAGS].includes(name) || (command !== undefined && rest.some((arg) => HELP_FLAGS.includes(arg)));

export async function main(argv = process.argv.slice(2)) {
  const { driverNames, args } = takeDriverFlag(argv);
  const { name, command, rest } = resolveCommand(args);
  if (wantsHelp(name, command, rest)) return console.log(help);
  if (!command) {
    console.error(`Unknown command: ${name}\n\n${help}`);
    process.exitCode = 1;
    return;
  }
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  let app: Management | undefined;
  try {
    const driver = selectDriver(driverNames);
    const split = splitArguments(command, rest);
    const options = parseOptions(split.options, command.flags ?? []);
    const positional = split.positional;
    if (positional.length < requiredCount(command)) throw usage(`Usage: ${name} ${command.usage}`.trim());
    onCancelSignals(command, stop);
    if (command.local) return print(await command.local({ ...options, signal: cancellation.signal }, ...positional));
    const [api, { loadConfig }] = await Promise.all([import("../management"), import("./config")]);
    app = api.createManagement(loadConfig(), { driver: await driver() });
    print(await command.run?.({ api, app, options: { ...options, signal: cancellation.signal, report: print } }, ...positional));
  } catch (error) {
    // Driver errors may contain credentials: only AppError messages are printed.
    const message = error instanceof AppError ? error.message : "Operation failed; inspect PostgreSQL availability";
    console.error(JSON.stringify({ error: errorCode(error), message }));
    process.exitCode = 1;
  } finally {
    for (const signal of CANCEL_SIGNALS) process.removeListener(signal, stop);
    if (cancellation.signal.aborted) process.exitCode = 1;
    await app?.close().catch(() => {});
  }
}

if (import.meta.main) await main();
