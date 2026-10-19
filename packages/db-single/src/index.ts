/** Runtime entry point (`@0furkancolak/pgcells-single`): the small surface an application needs. It does not load the management, parser, tools or driver modules;
 * drivers are in `@0furkancolak/pgcells-single/drivers/bun|postgres|pg|neon`, request scope in `@0furkancolak/pgcells-single/middleware`, telemetry in `@0furkancolak/pgcells-single/telemetry`
 * entries. */
export type { Config, DatabaseOptions } from "./core/config";
export { createConfig, loadConfig } from "./core/config";
export type { Queryable, ReadContext } from "./core/context";
export type { Span, SpanHandler } from "./core/database";
export type { Driver } from "./core/driver";
export { AppError, databaseUnavailable, errorCode } from "./core/errors";
export { DEFAULT_SCHEMA } from "./core/identifier";
export { createDb, type Db, type DbOptions } from "./core/runtime";
export type { PreparedQuery } from "./core/sql/query";
