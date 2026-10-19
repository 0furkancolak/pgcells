/** Provider verification measurements (`bun run verify:provider`); not part of the published package. Each measurement opens and closes its own temporary pool
 * and puts no URL, host, user or password in the output. */
import { CLIENT_CONNECTION_CHECK_MS } from "../../core/config";
import type { Driver, Pool } from "../../core/driver";
import { errorCode } from "../../core/errors";
import { quoteIdentifier } from "../../core/identifier";
import { usesTransactionPooler } from "../../core/pooler";
import { probeReplica } from "../../core/replicas";

/** Context shared by the measurements: the driver and all URLs to be scrubbed from the output (management + runtime). */
export interface Context {
  driver: Driver;
  urls: readonly string[];
}

const MAX_ERROR_CHARS = 300;

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Removes full URLs, the password (raw and decoded), the host and the user name carrying the project ref from the text. The plain `postgres` role
 * stays readable: the meaning of privilege errors depends on it. */
export function scrub(text: string, urls: readonly string[]): string {
  let result = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]");
  for (const raw of urls) {
    const url = URL.parse(raw);
    if (!url) continue;
    const user = decoded(url.username);
    for (const secret of [url.password, decoded(url.password), url.hostname, user === "postgres" ? "" : user])
      if (secret) result = result.split(secret).join("[hidden]");
  }
  return result;
}

/** `<code>: <scrubbed message>`; driver errors may contain credentials and the host. */
export function describe(error: unknown, urls: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${errorCode(error)}: ${scrub(message, urls)}`.slice(0, MAX_ERROR_CHARS);
}

// Bun SQL also counts a running query as idle and drops it at `idleTimeout`; the timeout is kept long for the long `pg_sleep` measurement (the pool is closed after every measurement).
const POOL = { max: 1, idleTimeoutSeconds: 60, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 } as const;

const withPool = async <T>(driver: Driver, url: string, work: (pool: Pool) => Promise<T>): Promise<T> => {
  const pool = driver(url, POOL);
  try {
    return await work(pool);
  } finally {
    await pool.close(1000);
  }
};

const SETTING = "statement_timeout";
const PROBE_VALUE = "7777ms";
const STORED_SETTING = `SELECT pg_catalog.current_database() AS name,
  (SELECT s FROM pg_catalog.pg_db_role_setting r, pg_catalog.unnest(r.setconfig) AS s
    WHERE r.setrole=0 AND r.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
      AND s LIKE '${SETTING}=%') AS stored`;
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface AlterDatabaseResult {
  /** Whether `ALTER DATABASE … SET` was accepted. */
  allowed: boolean;
  /** Whether the setting was seen in a new direct session. */
  newSession?: boolean;
  /** Whether it was seen on the runtime (pooler) URL; the pooler may reuse existing server connections, so `false` alone is not an error. */
  throughRuntime?: boolean;
  error?: string;
  /** SQL to run by hand if the original value could not be written back (contains no URL or password). */
  restoreSql?: string;
}

const seesProbe = (driver: Driver, url: string) =>
  withPool(driver, url, async (pool) => (await pool.query<{ value: string }>(`SELECT current_setting('${SETTING}') AS value`))[0]?.value === PROBE_VALUE);

/** Tries the `ALTER DATABASE … SET` that `migrate` does with a temporary value, measures that it shows up in new sessions, and writes the original value
 * (or its absence) back. The write-back runs even if the measurement fails. */
export async function alterDatabase({ driver, urls }: Context, managementUrl: string, runtimeUrl: string): Promise<AlterDatabaseResult> {
  try {
    return await withPool(driver, managementUrl, (admin) => alterWith(admin, { driver, urls }, managementUrl, runtimeUrl));
  } catch (error) {
    return { allowed: false, error: describe(error, urls) };
  }
}

async function alterWith(admin: Pool, { driver, urls }: Context, managementUrl: string, runtimeUrl: string): Promise<AlterDatabaseResult> {
  const [row] = await admin.query<{ name: string; stored: string | null }>(STORED_SETTING);
  if (!row) return { allowed: false, error: "OPERATION_FAILED: current database name unavailable" };
  const database = quoteIdentifier(row.name);
  const original = row.stored?.slice(SETTING.length + 1);
  const restore = original === undefined ? `ALTER DATABASE ${database} RESET ${SETTING}` : `ALTER DATABASE ${database} SET ${SETTING} TO ${quoted(original)}`;
  try {
    await admin.exec(`ALTER DATABASE ${database} SET ${SETTING} TO ${quoted(PROBE_VALUE)}`);
  } catch (error) {
    return { allowed: false, error: describe(error, urls) };
  }
  const result: AlterDatabaseResult = { allowed: true };
  try {
    result.newSession = await seesProbe(driver, managementUrl);
    result.throughRuntime = await seesProbe(driver, runtimeUrl);
  } catch (error) {
    result.error = describe(error, urls);
  } finally {
    try {
      await admin.exec(restore);
    } catch {
      result.restoreSql = restore;
    }
  }
  return result;
}

const EXTENSIONS = ["citext", "pg_trgm", "pgcrypto"];

export interface PrivilegeResult {
  createSchema: boolean;
  superuser: boolean;
  /** A `CREATE EXTENSION` attempt for the first suitable extension that is not installed (the transaction is rolled back); absent if there is no candidate. */
  extension?: { name: string; allowed: boolean; error?: string };
  error?: string;
}

/** The `CREATE` privilege and role kind that `migrate` needs; the extension privilege is tried in a transaction that is rolled back. */
export async function privileges({ driver, urls }: Context, managementUrl: string): Promise<PrivilegeResult> {
  try {
    return await withPool(driver, managementUrl, async (pool) => {
      const [row] = await pool.query<{ create_schema: boolean; superuser: boolean }>(
        "SELECT pg_catalog.has_database_privilege(pg_catalog.current_database(),'CREATE') AS create_schema, COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user),false) AS superuser",
      );
      const result: PrivilegeResult = { createSchema: row?.create_schema === true, superuser: row?.superuser === true };
      const candidate = await pool.query<{ name: string }>(
        `SELECT name FROM pg_catalog.pg_available_extensions WHERE name IN (${EXTENSIONS.map(quoted).join(",")}) AND installed_version IS NULL ORDER BY name LIMIT 1`,
      );
      const name = candidate[0]?.name;
      if (!name) return result;
      const session = await pool.reserve();
      try {
        await session.exec("BEGIN");
        await session.exec(`CREATE EXTENSION ${quoteIdentifier(name)}`);
        result.extension = { name, allowed: true };
      } catch (error) {
        result.extension = { name, allowed: false, error: describe(error, urls) };
      } finally {
        await session.exec("ROLLBACK").catch(() => {});
        session.release();
      }
      return result;
    });
  } catch (error) {
    return { createSchema: false, superuser: false, error: describe(error, urls) };
  }
}

const PROBE_DEADLINE_MS = 15_000;

export type ProbeResult = { transactionPooler: boolean } | { error: string };

/** A's `pg_backend_pid` probe: `true` is expected for the runtime URL and `false` for the management URL. */
export async function probe({ driver, urls }: Context, url: string): Promise<ProbeResult> {
  try {
    return { transactionPooler: await usesTransactionPooler(driver, url, { deadlineMs: PROBE_DEADLINE_MS }) };
  } catch (error) {
    return { error: describe(error, urls) };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SLEEP_SECONDS = 120;

export interface DeadlineResult {
  /** Whether the tagged long query was seen in `pg_stat_activity`; if not, the "server stopped" measurement is meaningless. */
  observedRunning: boolean;
  /** Whether the driver defines `cancel` (`neonDriver` and Bun SQL do not). */
  cancelDefined: boolean;
  /** Time for the server-side query to finish after the connection was discarded; `null` if it did not finish in time. */
  serverStoppedAfterMs: number | null;
  error?: string;
}

/** Starts a long query on a reserved connection on the runtime URL, discards the connection after `afterMs` (`release(true)`, `cancel` if present)
 * and watches via the management URL when the server-side query ends. `client_connection_check_interval` is `migrate`'s default. */
export async function deadline(
  { driver, urls }: Context,
  runtimeUrl: string,
  managementUrl: string,
  { afterMs = 2000, waitMs = 20_000, pollMs = 500 } = {},
): Promise<DeadlineResult> {
  const tag = `verify-provider-${crypto.randomUUID()}`;
  const running = (monitor: Pool) =>
    monitor
      .query<{ n: number }>("SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND query LIKE $1", [`%${tag}%`])
      .then(([row]) => row?.n ?? 0);
  try {
    return await withPool(driver, managementUrl, (monitor) =>
      withPool(driver, runtimeUrl, async (pool) => {
        const reserved = await pool.reserve();
        let startError: string | undefined;
        let dropped = false;
        /** Discards the connection once; even if the measurement fails midway, no 120 s query stays open on the server. */
        const drop = () => {
          if (dropped) return;
          dropped = true;
          reserved.cancel?.();
          reserved.release(true);
        };
        void reserved
          .exec(`BEGIN; SET LOCAL statement_timeout = 0; SET LOCAL client_connection_check_interval = ${CLIENT_CONNECTION_CHECK_MS}; SELECT pg_sleep(${SLEEP_SECONDS}) /* ${tag} */`)
          .catch((error: unknown) => {
            startError = describe(error, urls);
          });
        try {
          await sleep(afterMs);
          const observedRunning = (await running(monitor)) > 0;
          const cancelDefined = typeof reserved.cancel === "function";
          drop();
          if (!observedRunning) return { observedRunning, cancelDefined, serverStoppedAfterMs: null, ...(startError ? { error: startError } : {}) };
          const started = performance.now();
          while (performance.now() - started < waitMs) {
            await sleep(pollMs);
            if ((await running(monitor)) === 0) return { observedRunning, cancelDefined, serverStoppedAfterMs: Math.max(1, Math.round(performance.now() - started)) };
          }
          return { observedRunning, cancelDefined, serverStoppedAfterMs: null };
        } finally {
          drop();
        }
      }),
    );
  } catch (error) {
    return { observedRunning: false, cancelDefined: false, serverStoppedAfterMs: null, error: describe(error, urls) };
  }
}

export type ReplicaResult =
  | { inRecovery: boolean; lagMs: (number | null)[]; maxStandbyStreamingDelay: string | null; hotStandbyFeedback: string | null }
  | { error: string };

const SAMPLES = 3;

/** The replica's real behavior: lag (by replay LSN) in three samples and the two settings that decide recovery conflicts. Read-only. */
export async function replica({ driver, urls }: Context, primaryUrl: string, replicaUrl: string, gapMs = 1000): Promise<ReplicaResult> {
  try {
    return await withPool(driver, primaryUrl, (primary) =>
      withPool(driver, replicaUrl, async (standby) => {
        const lagMs: (number | null)[] = [];
        let inRecovery = false;
        for (let sample = 0; sample < SAMPLES; sample++) {
          if (sample) await sleep(gapMs);
          const probed = await probeReplica(primary, standby);
          inRecovery = probed.inRecovery;
          lagMs.push(probed.lagMs);
        }
        const setting = async (name: string) => (await standby.query<Record<string, string>>(`SHOW ${name}`))[0]?.[name] ?? null;
        return { inRecovery, lagMs, maxStandbyStreamingDelay: await setting("max_standby_streaming_delay"), hotStandbyFeedback: await setting("hot_standby_feedback") };
      }),
    );
  } catch (error) {
    return { error: describe(error, urls) };
  }
}
