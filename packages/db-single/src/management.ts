/** Management entry point (`@0furkancolak/pgcells-single/management`): the context factory and the operations the CLI wraps. */
import { migrationTables, registry } from "./core/migrations/registry";
import { createRunner } from "./core/migrations/runner";
import { prepareQuery as compileQuery } from "./core/sql/compiler";

export type { ManagementOptions } from "./core/config";
export { createManagement, type Management } from "./core/management";
export type { SeedContext } from "./core/migrations/source";

/** Operations that run with the package's own migration and seed lists. */
export const { baseline, migrate, migrationStatus, rollback, seed } = createRunner(registry);

/** Same compilation as codegen: `*` expands from the package's own migration tables, and output names become camelCase. */
export const prepareQuery = (source: string) => compileQuery(source, migrationTables());
