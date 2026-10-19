/** Management context: direct connection pools and placement writes. Operations are plain functions that take this context
 * (`@0furkancolak/pgcells/management`: `src/management.ts`). */
import { type Config, loadConfig, type ManagementOptions, managementSettings, MIGRATION_MAX } from "./config";
import { createPools, reportSpan, type SpanHandler, type SpanInput, spanner } from "./database";
import type { Driver } from "./driver";
import { migrationTables } from "./migrations/registry";
import { createManagementPlatform } from "./tenants/placement";

/** Columns that the package's platform migrations define on `platform.tenants` (from the folded DDL); they cannot be written as application fields. */
export const packageTenantColumns = () => (migrationTables("platform").get("tenants") ?? []).map((column) => column.name);

export interface ManagementFactoryOptions extends ManagementOptions {
  driver: Driver;
  /** Called after a placement's state or database has changed (commit); used to invalidate the cached placement (e.g. `@0furkancolak/pgcells-redis`
   * `invalidatePlacement`). An error stops the operation (the move stays resumable). */
  onPlacementChange?: (tenantId: string) => unknown;
  /** Measurement: operation steps (`tenant.lock`, `provision.*`, `migration`, `seed`, `move.*`, `backup.tenant`) and query durations. */
  onSpan?: SpanHandler;
}

/** `DATABASE_URLS` must be direct (or session-pooling) connections; this is validated when the session opens. */
function openManagement(input: Config, { driver, onPlacementChange, onSpan, ...options }: ManagementFactoryOptions) {
  const config = managementSettings(input, options);
  const pools = createPools(config, driver, config.perDatabaseConcurrency, {
    deadlineMs: config.migrationStatementTimeoutMs,
    timeouts: { statementTimeoutMs: config.migrationStatementTimeoutMs, lockTimeoutMs: config.migrationLockTimeoutMs },
    // Leaves room for the largest CLI worker value and for platform jobs on db0.
    maxPending: 2 * MIGRATION_MAX.concurrency,
    onSpan,
  });
  return {
    config,
    driver,
    pools,
    platform: createManagementPlatform(pools, config.nodes.map((node) => node.id), onPlacementChange, packageTenantColumns()),
    close: pools.close,
    span: spanner(onSpan),
    emit: (span: SpanInput) => onSpan && reportSpan(onSpan, { startTime: Date.now() - span.ms, ...span }),
  };
}
export type Management = ReturnType<typeof openManagement>;

/** Management context (direct connections). If no config is given, `DATABASE_URLS` is read: `createManagement({ driver: bunDriver })`. */
export function createManagement(options: ManagementFactoryOptions): Management;
export function createManagement(config: Config, options: ManagementFactoryOptions): Management;
export function createManagement(configOrOptions: Config | ManagementFactoryOptions, options?: ManagementFactoryOptions): Management {
  return "nodes" in configOrOptions ? openManagement(configOrOptions, options as ManagementFactoryOptions) : openManagement(loadConfig(), configOrOptions);
}
