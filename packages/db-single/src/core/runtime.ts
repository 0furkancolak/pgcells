/** Runtime factory: a single primary pool (+ replica pools), the pooler proof and schema-bound query/transaction/read. It does not load the management, parser,
 * tools or driver modules. */
import { type Config, type DatabaseOptions, loadConfig, replicaPolicy, runtimeSettings } from "./config";
import { createReader, type Queryable, type ReadContext, runContext } from "./context";
import { createPools, type SpanHandler } from "./database";
import type { Driver } from "./driver";
import { AppError, DriverError, errorCode } from "./errors";
import { DEFAULT_SCHEMA, validateSchema } from "./identifier";
import { usesTransactionPooler } from "./pooler";
import { createReplicaRouter } from "./replicas";
import type { PreparedQuery } from "./sql/query";

export interface DbOptions extends DatabaseOptions {
  /** `@0furkancolak/pgcells-single/drivers/bun|postgres|pg|neon`; only the imported driver ends up in the bundle. */
  driver: Driver;
  /** Schema of the application tables; `public` when omitted. Every query is bound as `"<schema>".table`. */
  schema?: string;
  /** Measurement: connection wait, query and transaction durations (see `Span`). No extra cost when omitted. */
  onSpan?: SpanHandler;
  /** `verified` (default): `ready()` checks that the URL is behind a transaction-mode pooler, otherwise `POOLER_REQUIRED`.
   * `assumed`: the check is skipped (environments that cannot be checked, e.g. an unverified Hyperdrive); ensuring a pooler is in place is the application's job. */
  pooler?: "verified" | "assumed";
}

/** Limit on pending connection work; `DATABASE_BUSY` when exceeded. */
const RUNTIME_MAX_PENDING = 64;

/** Bun: once per process. Workers: once per request with `{ poolMax: 1 }` (sockets cannot outlive the request). */
function openDb(input: Config, { driver, schema = DEFAULT_SCHEMA, onSpan, pooler = "verified", replicaOnUnavailable, ...options }: DbOptions) {
  // Options are validated before any pool is opened; the requirement can be skipped only by a deliberate decision.
  if (pooler !== "verified" && pooler !== "assumed") throw new AppError("INVALID_CONFIG", 'pooler must be "verified" or "assumed"');
  validateSchema(schema);
  const onUnavailable = replicaPolicy(replicaOnUnavailable);
  const config = runtimeSettings(input, options);
  // Server-side timeouts are DB defaults (written by `migrate`): a single query is a single round trip.
  const pools = createPools(config, driver, config.poolMax, { deadlineMs: config.statementTimeoutMs, maxPending: RUNTIME_MAX_PENDING, onSpan });
  const router = createReplicaRouter({ pools, maxLagMs: config.replicaMaxLagMs, statusMs: config.replicaStatusMs });
  /** Write context; `onWrite` lets the request scope (`createDbScope`) keep reads on the primary after a write. */
  const run = <T>(work: (db: Queryable) => Promise<T>, onWrite?: () => void) => runContext(pools.primary, pools.primary, schema, work, { onWrite });
  /** Read context: from a replica, otherwise from the primary according to the policy; see `createReader`. */
  const readRun = createReader(pools, router, onUnavailable, schema);

  // A driver message may carry the user/DB name (28P01, 3D000): the engine's own errors (`DATABASE_TIMEOUT`, `POOLER_REQUIRED` …) stay
  // as they are; a driver error (`DriverError` or raw) becomes `DATABASE_UNAVAILABLE` with its code only.
  const notReady = (error: unknown) =>
    error instanceof AppError && !(error instanceof DriverError) ? error : new AppError("DATABASE_UNAVAILABLE", `Database is not reachable (${errorCode(error)})`);
  let poolerCheck: Promise<void> | undefined;
  // Concurrent `ready()` calls await the same result; a successful result is kept, a failed one is discarded.
  const checkPooler = () => {
    if (!poolerCheck) {
      poolerCheck = usesTransactionPooler(driver, config.url, { deadlineMs: config.statementTimeoutMs + 1000 }).then(
        (pooled) => {
          if (!pooled)
            throw new AppError("POOLER_REQUIRED", 'Database is reachable without a transaction pooler; use a transaction-mode pooler URL in DATABASE_URLS or set pooler: "assumed"');
        },
        (error: unknown) => {
          throw notReady(error);
        },
      );
      poolerCheck.catch(() => (poolerCheck = undefined));
    }
    return poolerCheck;
  };
  /** Ready: the database responds; with `pooler: "verified"` the URL goes to a transaction-mode pooler. Otherwise `DATABASE_UNAVAILABLE`,
   * `DATABASE_TIMEOUT` or `POOLER_REQUIRED`. Call it at startup and in the health endpoint (not on the request path). */
  const ready = async () => {
    await pools.primary.query("SELECT 1").catch((error: unknown) => {
      throw notReady(error);
    });
    if (pooler === "verified") await checkPooler();
  };

  return Object.freeze({
    schema,
    config,
    pools,
    run,
    readRun,
    query: ((query: PreparedQuery, values?: readonly unknown[]) => run((db) => db.query(query, values))) as Queryable["query"],
    transaction: <T>(work: (tx: Queryable) => Promise<T>) => run((db) => db.transaction(work)),
    /** Read queries from a replica (`readOnly` queries only; see `docs/replicas.md`). */
    read: Object.freeze<ReadContext>({ query: ((query: PreparedQuery, values?: readonly unknown[]) => readRun((db) => db.query(query, values))) as ReadContext["query"] }),
    /** Replica status (health, lag, availability); probes without consulting the cache. Contains no URL. */
    replicas: () => router.report(),
    ready,
    close: pools.close,
  });
}

export type Db = ReturnType<typeof openDb>;

/** Once per process (`poolMax: 1` per request on Workers). When no config is passed, `DATABASE_URLS` is read:
 *   createDb({ driver: bunDriver })
 *   createDb(createConfig(env.DB.connectionString), { driver: postgresDriver, poolMax: 1 }) */
export function createDb(options: DbOptions): Db;
export function createDb(config: Config, options: DbOptions): Db;
export function createDb(configOrOptions: Config | DbOptions, options?: DbOptions): Db {
  return "url" in configOrOptions ? openDb(configOrOptions, options as DbOptions) : openDb(loadConfig(), configOrOptions);
}
