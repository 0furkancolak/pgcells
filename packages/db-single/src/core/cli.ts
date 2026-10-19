#!/usr/bin/env bun
/** `bun run cli`: validates the arguments, calls the management and tool functions, prints JSON; exit code 1
 * on an error or unfinished work. DB modules and the selected driver are loaded lazily; `local` commands (those that generate files) do not connect to the DB. */
import { boundedInteger } from "./config";
import type { Driver } from "./driver";
import { AppError, errorCode } from "./errors";
import { validateSchema } from "./identifier";
import type { Management } from "./management";
import type * as ManagementApi from "../management";

/** Resolved options; `--pgbouncer-url`, `--pooled-url` and `--from-replica` take no value and only mean "ask for the URL with hidden input". */
type Options = {
  /** Target schema (`--schema`); `public` when omitted. */
  schema?: string;
  steps?: number;
  /** Upper time limit of management statements (ms); 30 s when omitted. */
  statementTimeoutMs?: number;
  to?: string;
  name?: string;
  keep?: number;
  set?: string;
  at?: string;
  org?: string;
  safetyPoint?: string;
  exclude?: string[];
  signal?: AbortSignal;
  report?: (event: Record<string, unknown>) => void;
  dryRun?: boolean;
  ts?: boolean;
  pgbouncerUrl?: boolean;
  pooledUrl?: boolean;
  fromReplica?: boolean;
};
interface Command {
  /** `<x>` is a required, `[x]` an optional argument; `--…` is help text only. */
  usage: string;
  summary: string;
  /** Accepted options. */
  flags?: readonly string[];
  /** SIGINT/SIGTERM stops accepting new work and cancels the job; for local commands it stops the job. */
  cancellable?: boolean;
  local?(options: Options, ...args: string[]): Promise<unknown>;
  run?(context: { api: typeof ManagementApi; app: Management; options: Options }, ...args: string[]): Promise<unknown>;
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const usage = (message: string) => new AppError("USAGE", message);
const BOOLEAN_FLAGS = ["--dry-run", "--ts", "--pgbouncer-url", "--pooled-url", "--from-replica"];
/** Repeatable options: the values (which may also be comma-separated) accumulate in a list. */
const REPEATABLE_FLAGS = ["--exclude"];
/** Numeric options → [lower, upper] bounds. */
const INTEGER_FLAGS: Record<string, readonly [number, number]> = { "--steps": [1, 10000], "--keep": [1, 1000], "--statement-timeout-ms": [1000, 3600000] };
const TIMEOUT_FLAG = ["--statement-timeout-ms"];
const HELP_FLAGS = ["--help", "-h"];
const DRIVER_FLAG = "--driver=";
const SCHEMA_FLAGS = ["--schema"];
const commaList = (value: string) => value.split(",").map((id) => id.trim()).filter(Boolean);
/** Only the selected driver is loaded; since the CLI runs on Bun, the default is Bun SQL (tests add their own driver). */
export const drivers: Record<string, () => Promise<Driver>> = {
  bun: () => import("./drivers/bun").then((m) => m.bunDriver),
  postgres: () => import("./drivers/postgres").then((m) => m.postgresDriver),
  pg: () => import("./drivers/pg").then((m) => m.pgDriver),
};
const REPLICA_URL_QUESTION = "Direct replica URL (postgres://…, typed input is hidden): ";
const POOLED_URL_QUESTION = "Runtime URL (DATABASE_URLS format, typed input is hidden): ";
const PGBOUNCER_URL_QUESTION = "PgBouncer console URL (postgres://…/pgbouncer, typed input is hidden): ";
/** A URL that carries a password is asked for with hidden input; the format is validated, and error texts do not contain the value. */
const askUrl = async (question: string, subject: string) => {
  const { askSecret, postgresUrl } = await import("./tools/ask-secret");
  return postgresUrl(await askSecret(question), subject).href;
};
const askReplicaUrl = () => askUrl(REPLICA_URL_QUESTION, "Replica URL");
const backup = () => import("./tools/backup");
const NEON_KEY_QUESTION = "Neon API key (typed input is hidden): ";
const neon = () => import("./tools/neon");
/** The Neon API key never goes into argv or env; it is asked for with hidden input. */
const askNeonApi = async (signal?: AbortSignal) => {
  const [{ askSecret }, { neonApi }] = await Promise.all([import("./tools/ask-secret"), neon()]);
  return neonApi(await askSecret(NEON_KEY_QUESTION), { signal });
};

/** `migrate --safety-point`: if there are pending migrations, a safety point is taken at the provider BEFORE migrate; if it cannot be taken, the error prevents migrate from starting at all.
 * `--dry-run` and a run with nothing pending take no point (opening a branch on every deployment would use up the provider quota). */
export async function takeSafetyPoint(api: Pick<typeof ManagementApi, "migrate">, app: Management, options: Options, openApi = askNeonApi) {
  if (options.safetyPoint === undefined && options.org === undefined) return;
  const tools = await neon();
  const provider = tools.safetyPointProvider(options.safetyPoint);
  if (options.org !== undefined && provider !== "neon") throw usage("--org applies to --safety-point neon");
  if (!provider || options.dryRun || !(await api.migrate(app, { dryRun: true })).migrations.length) return;
  return provider === "neon" ? tools.safetyPoint(app, await openApi(options.signal), { org: options.org }) : tools.supabaseSafetyPoint();
}

const commands: Record<string, Command> = {
  migrate: {
    usage: "[--dry-run] [--schema name] [--statement-timeout-ms N] [--safety-point neon|supabase] [--org ID]",
    summary: "Applies pending migrations; creates the schema if missing and writes the runtime timeouts as DB defaults (--safety-point: first takes a safety point at the provider)",
    flags: ["--dry-run", "--safety-point", "--org", ...TIMEOUT_FLAG, ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ api, app, options }) => {
      const point = await takeSafetyPoint(api, app, options);
      if (point) print(point);
      return api.migrate(app, options);
    },
  },
  "migrate-down": {
    usage: "[--steps N | --to ID] [--dry-run] [--schema name] [--statement-timeout-ms N]",
    summary: "Rolls back the latest migrations (default 1)",
    flags: ["--steps", "--to", "--dry-run", ...TIMEOUT_FLAG, ...SCHEMA_FLAGS],
    cancellable: true,
    run: ({ api, app, options }) => api.rollback(app, options),
  },
  "migration-status": {
    usage: "[--schema name]",
    summary: "Shows the applied count and the pending migrations (read-only)",
    flags: SCHEMA_FLAGS,
    run: ({ api, app }) => api.migrationStatus(app),
  },
  "migration create": {
    usage: "<name>",
    summary: "Empty --up/--down file (src/migrations/<UTC time>_<name>.sql) and the list",
    local: async (_, name) => (await import("./sql/codegen")).createMigration({ name }),
  },
  "migration baseline": {
    usage: "<migrationId> [--schema name]",
    summary: "Marks migrations as applied without running them (the live schema must contain the migration's tables, columns and enums)",
    flags: SCHEMA_FLAGS,
    cancellable: true,
    run: ({ api, app, options }, migrationId) => api.baseline(app, migrationId, options),
  },
  seed: {
    usage: "[--dry-run] [--schema name] [--statement-timeout-ms N]",
    summary: "Applies pending seeds (migrations must be up to date)",
    flags: ["--dry-run", ...TIMEOUT_FLAG, ...SCHEMA_FLAGS],
    cancellable: true,
    run: ({ api, app, options }) => api.seed(app, options),
  },
  "seed create": {
    usage: "<name> [--ts]",
    summary: "Empty SQL (or --ts) seed file and the list",
    flags: ["--ts"],
    local: async ({ ts }, name) => (await import("./sql/codegen")).createSeed({ name, kind: ts ? "ts" : "sql" }),
  },
  pull: {
    usage: "[schema] [--name init] [--exclude table ...]",
    summary: "Writes a single initial migration from the structure of an existing schema (only reads the DB; the schema defaults to public; followed by migration baseline)",
    flags: ["--name", "--exclude"],
    run: async ({ app, options }, schema) => (await import("./tools/pull")).pullSchema(app, schema || "public", { name: options.name, exclude: options.exclude }),
  },
  export: {
    usage: "<dir> [--from-replica] [--schema name]",
    summary: "Writes all of the schema's data to a directory in one go (the directory must not exist; --from-replica: reads the data from the replica, the URL is asked for with hidden input)",
    flags: ["--from-replica", ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ app, options }, dir) => (await backup()).exportSchema(app, dir, { signal: options.signal, replicaUrls: options.fromReplica ? await askReplicaUrl() : undefined }),
  },
  backup: {
    usage: "<dir> [--keep N] [--from-replica] [--schema name]",
    summary: "Writes a full backup set under <dir>/<UTC time>; --keep N deletes the older ones (--from-replica: reads the data from the replica)",
    flags: ["--keep", "--from-replica", ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ app, options }, dir) => (await backup()).backupSchema(app, dir, { keep: options.keep, signal: options.signal, replicaUrls: options.fromReplica ? await askReplicaUrl() : undefined }),
  },
  "backup prune": {
    usage: "<dir> --keep N",
    summary: "Keeps the last N completed sets and deletes the older ones (leaves partial sets alone)",
    flags: ["--keep"],
    local: async ({ keep }, dir) => {
      if (keep === undefined) throw usage("backup prune needs --keep N");
      return (await backup()).pruneBackups(dir, keep);
    },
  },
  restore: {
    usage: "<dir> [--set ID] [--schema name] [--statement-timeout-ms N]",
    summary: "Builds the schema from a backup (the backup root or an export directory); the target schema must not exist or must be empty, and pending migrations are applied for an older backup",
    flags: ["--set", ...TIMEOUT_FLAG, ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ app, options }, dir) => (await backup()).restoreSchema(app, dir, { set: options.set, signal: options.signal, report: options.report }),
  },
  "auth generate": {
    usage: "<optionsModule> [--name better_auth]",
    summary: "Migration from the Better Auth options (writes no file if there is no difference; the difference is computed in a temporary schema)",
    flags: ["--name"],
    cancellable: true,
    run: async ({ app, options }, module) => {
      const { generateAuthMigration } = await import("./tools/auth");
      const { resolve } = await import("node:path");
      const authOptions = (await import(resolve(module))).default;
      if (!authOptions) throw usage("The options module must export the Better Auth options as its default export");
      return generateAuthMigration({ db: app, options: authOptions, name: options.name, signal: options.signal });
    },
  },
  "neon stage-copy": {
    usage: "[--org ID]",
    summary: "Neon: opens a branch from the source branch for a migration trial (the branch id and host are printed, the URI with the password is not)",
    flags: ["--org"],
    run: async ({ app, options }) => (await neon()).stageCopy(app, await askNeonApi(options.signal), { org: options.org }),
  },
  "neon export": {
    usage: "<dir> --at TIME [--org ID] [--schema name]",
    summary: "Neon: writes a past point in time of the schema to an export directory (does not touch live data; use restore to apply it)",
    flags: ["--at", "--org", ...SCHEMA_FLAGS],
    cancellable: true,
    run: async ({ app, options }, dir) => {
      const tools = await neon();
      const at = tools.parsePastTimestamp(options.at, new Date());
      await (await backup()).assertFree(dir); // before the key is asked for: no branch is opened for a non-empty target
      return tools.exportAt(app, await askNeonApi(options.signal), { dir, at, org: options.org, signal: options.signal });
    },
  },
  replicas: {
    usage: "",
    summary: "Status and lag of the replicas in DATABASE_REPLICA_URLS (exit code 1 if a replica is down or over the threshold)",
    run: async ({ app }) => {
      const result = await (await import("./tools/replicas")).replicaReport(app);
      if (!result.ok) process.exitCode = 1;
      return result;
    },
  },
  doctor: {
    usage: "[--pgbouncer-url] [--pooled-url] [--schema name]",
    summary: "Checks the connection, timeouts, schema and migration status read-only (--pgbouncer-url: asks for the console URL, --pooled-url: asks for the runtime URL, both with hidden input; exit code 1 on a failed check)",
    flags: ["--pgbouncer-url", "--pooled-url", ...SCHEMA_FLAGS],
    run: async ({ app, options }) => {
      const pgbouncerUrl = options.pgbouncerUrl ? await askUrl(PGBOUNCER_URL_QUESTION, "PgBouncer admin URL") : undefined;
      const pooledUrl = options.pooledUrl ? await askUrl(POOLED_URL_QUESTION, "Runtime URL") : undefined;
      const result = await (await import("./tools/doctor")).doctor(app, { pgbouncerUrl, pooledUrl });
      if (!result.ok) process.exitCode = 1;
      return result;
    },
  },
};

/** Documented command names (for the docs check and tests). */
export const commandNames = () => Object.keys(commands);

/** On short lines the summary is at column 40; on long lines it goes on the next line at the same column. */
const helpLine = ([name, command]: [string, Command]) => {
  const line = `${name} ${command.usage}`.trim();
  return line.length < 40 ? `  ${line.padEnd(40)}${command.summary}` : `  ${line}\n  ${" ".repeat(40)}${command.summary}`;
};

const help = `Single-database management tool

Usage:
  pgcells-single <command> [arguments] [options] [--driver=bun|postgres|pg]

Commands:
${Object.entries(commands).map(helpLine).join("\n")}

An option value is given as --name value or --name=value. The target schema is given with --schema (default public).
Environment: DATABASE_URLS (required; a single URL in this package; a direct or session pooling connection).
Driver: --driver (default bun). See the README for detailed setup.`;

const camelCase = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Resolves the value of an option that takes a value according to its type: a bounded integer or text. */
function optionValue(flag: string, value: string): unknown {
  const range = INTEGER_FLAGS[flag];
  return range === undefined ? value : boundedInteger(value, flag.slice(2), range[1], range[0]);
}

/** `--option value` or `--option=value`; an unaccepted, repeated or valueless option is `USAGE`. */
export function parseOptions(args: readonly string[], allowed: readonly string[] = []): Options {
  const options: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const [flag = "", inline] = (args[i] ?? "").split(/=(.*)/s);
    // The argument text may be secret (a URL with a password): only text shaped like an option name is printed.
    if (!allowed.includes(flag))
      throw usage(/^--[a-z][a-z0-9-]*$/.test(flag) ? `Unknown option: ${flag}` : "Unexpected argument: values are given as --option value, and URL options ask for the value with hidden input");
    const repeatable = REPEATABLE_FLAGS.includes(flag);
    if (seen.has(flag) && !repeatable) throw usage(`Repeated option: ${flag}`);
    seen.add(flag);
    const key = camelCase(flag.slice(2));
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

const requiredCount = (command: Pick<Command, "usage">) => command.usage.split("<").length - 1;

/** Positional arguments may come before or after options (scripts put the option first: `migration create --x name`).
 * The argument following an accepted option that takes a value (`--name value`) is its value. At most the required + optional number of positional arguments
 * is taken; any extra falls into the option list and yields `USAGE`. `[x]` is an optional positional argument, `[--x]` does not count. */
export function splitArguments(command: Pick<Command, "usage" | "flags">, rest: readonly string[]) {
  const max = requiredCount(command) + (command.usage.match(/\[(?!-)/g)?.length ?? 0);
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

/** On cancellable commands SIGINT/SIGTERM calls `stop`. */
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
    // The command name is not echoed: a URL typed in the wrong place would leak its password.
    console.error(`Unknown command\n\n${help}`);
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
    // The target schema is validated without touching the DB or the environment.
    if (options.schema !== undefined) validateSchema(options.schema);
    const positional = split.positional;
    if (positional.length < requiredCount(command)) throw usage(`Usage: ${name} ${command.usage}`.trim());
    onCancelSignals(command, stop);
    if (command.local) return print(await command.local({ ...options, signal: cancellation.signal }, ...positional));
    const [api, { loadConfig }] = await Promise.all([import("../management"), import("./config")]);
    app = api.createManagement(loadConfig(), { driver: await driver(), schema: options.schema, migrationStatementTimeoutMs: options.statementTimeoutMs });
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
