/** Management context: a direct-connection pool (each job runs in a transaction with `SET LOCAL` timeouts) and the schema. Operations are plain
 * functions that take this context (`@0furkancolak/pgcells-single/management`: `src/management.ts`). */
import { type Config, loadConfig, type ManagementOptions, managementSettings } from "./config";
import { createPools, type SpanHandler, spanner } from "./database";
import type { Driver } from "./driver";
import { DEFAULT_SCHEMA, validateSchema } from "./identifier";

/** One run uses a single lock session and a few side queries. */
const MANAGEMENT_POOL_MAX = 4;
const MANAGEMENT_MAX_PENDING = 64;

export interface ManagementFactoryOptions extends ManagementOptions {
  driver: Driver;
  /** Target schema of migrations and seeds; `public` when omitted. */
  schema?: string;
  /** Measurement: operation steps (`migration`, `rollback`, `seed`) and query durations. */
  onSpan?: SpanHandler;
}

/** `DATABASE_URLS` must be a direct (or session pooling) connection; this is verified when the lock session is opened. */
function openManagement(input: Config, { driver, schema = DEFAULT_SCHEMA, onSpan, ...options }: ManagementFactoryOptions) {
  validateSchema(schema);
  const config = managementSettings(input, options);
  const pools = createPools(config, driver, MANAGEMENT_POOL_MAX, {
    deadlineMs: config.migrationStatementTimeoutMs,
    timeouts: { statementTimeoutMs: config.migrationStatementTimeoutMs, lockTimeoutMs: config.migrationLockTimeoutMs },
    maxPending: MANAGEMENT_MAX_PENDING,
    onSpan,
  });
  return {
    config,
    driver,
    schema,
    pools,
    db: pools.primary,
    close: pools.close,
    span: spanner(onSpan),
  };
}
export type Management = ReturnType<typeof openManagement>;

/** Management context (direct connection). When no config is passed, `DATABASE_URLS` is read: `createManagement({ driver: bunDriver })`. */
export function createManagement(options: ManagementFactoryOptions): Management;
export function createManagement(config: Config, options: ManagementFactoryOptions): Management;
export function createManagement(configOrOptions: Config | ManagementFactoryOptions, options?: ManagementFactoryOptions): Management {
  return "url" in configOrOptions ? openManagement(configOrOptions, options as ManagementFactoryOptions) : openManagement(loadConfig(), configOrOptions);
}
