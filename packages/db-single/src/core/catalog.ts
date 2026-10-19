/** Catalog reads: schema state. */
import type { Connection } from "./driver";

/** Whether the `name` schema exists in this DB. */
export async function schemaExists(db: Pick<Connection, "query">, name: string): Promise<boolean> {
  const [row] = await db.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1) AS exists", [name]);
  return !!row?.exists;
}

/** An object that is a member of an extension (function, type, relation …) is not application data: backup and the emptiness check ignore it. */
export const notExtensionMember = (catalog: "pg_class" | "pg_proc" | "pg_type", alias: string) =>
  `NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend x WHERE x.classid='pg_catalog.${catalog}'::pg_catalog.regclass AND x.objid=${alias}.oid AND x.deptype='e')`;

/** Enums of the `$1` schema that do not belong to an extension (ordered by name): the name, the `regtype` text as seen by the reading session
 * (as it appears in catalog expressions) and a JSON array of the ordered labels. Used by backup and `pull`. */
export const ENUMS_SQL = `SELECT t.typname AS name,t.oid::pg_catalog.regtype::text AS reference,pg_catalog.array_to_json(ARRAY(
    SELECT e.enumlabel FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder))::text AS labels
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
  WHERE n.nspname=$1 AND t.typtype='e' AND ${notExtensionMember("pg_type", "t")} ORDER BY t.typname`;

/** Whether the `name` schema contains no non-extension table, view, sequence, foreign table or standalone type (enum, domain, range; excluding
 * relation row types and arrays) (a schema that does not exist at all also counts as empty). */
export async function schemaIsEmpty(db: Pick<Connection, "query">, name: string): Promise<boolean> {
  const [row] = await db.query<{ empty: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f','S') AND ${notExtensionMember("pg_class", "c")})
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=$1 AND t.typrelid=0 AND t.typelem=0 AND ${notExtensionMember("pg_type", "t")}) AS empty`,
    [name],
  );
  return row?.empty === true;
}
