/** Runtime entry point (`@0furkancolak/pgcells`): the small surface an application needs. It does not load the management, parser, tools or driver modules;
 * drivers are in `@0furkancolak/pgcells/drivers/bun|postgres|pg`, the request context in `@0furkancolak/pgcells/middleware`, telemetry in `@0furkancolak/pgcells/telemetry`. */
export { type Config, createConfig, type DatabaseOptions, loadConfig, PLACEMENT_CACHE_MAX_MS } from "./core/config";
export type { Span, SpanHandler } from "./core/database";
export type { Driver } from "./core/driver";
export { AppError, databaseUnavailable, errorCode } from "./core/errors";
export { type FailoverClass, failoverClass, retryable } from "./core/failover";
export { createDatabase, createRotatingDatabase, type Database, type RotatingDatabase, type RuntimeOptions } from "./core/runtime";
export type { PreparedQuery } from "./core/sql/query";
export type { ReadContext, TenantContext } from "./core/tenants/context";
export { normalizeTenantId, type Placement, placementSchema, tenantFromHost, validateTenantId } from "./core/tenants/model";
