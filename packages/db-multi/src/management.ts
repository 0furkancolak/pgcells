/** Management entry point (`@0furkancolak/pgcells/management`): the context factory and the operations the CLI wraps. */
export type { ManagementOptions } from "./core/config";
export { createManagement, type Management } from "./core/management";
export { markMigrationApplied, migrateAll, migrateTenant, migrationStatus, recoverMigrations, rollbackTenant } from "./core/migrations/runner";
export type { SeedContext } from "./core/migrations/source";
export { bootstrap } from "./core/operations/bootstrap";
export { type ProvisionOptions, provisionTenant, resetDemoTenant, seedAll, seedTenant } from "./core/operations/provision";
export type { TenantFields } from "./core/tenants/fields";
import { migrationTables } from "./core/migrations/registry";
import { prepareQuery as compileQuery } from "./core/sql/compiler";
import type { QueryScope } from "./core/sql/query";

/** Same compilation as codegen: `*` expands from the package's own migration tables, and output names become camelCase. */
export const prepareQuery = (source: string, scope: QueryScope = "tenant") => compileQuery(source, scope, migrationTables(scope));
