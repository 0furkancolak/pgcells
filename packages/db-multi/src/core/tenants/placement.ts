/** Placement SQL: reads the tenant database/schema location and lists it in pages (runtime); creation and CAS status/version in management. */
import { boundedInteger } from "../config";
import type { Pools } from "../database";
import type { Connection } from "../driver";
import { AppError, parseDatabaseValue } from "../errors";
import {
  candidateColumns, readTenantColumns, resolveTenantFields, restoredTenantRow, type TenantColumns, tenantInsert, tenantInsertError, type TenantRow,
} from "./fields";
import { type Kind, type Placement, placementColumns, placementSchema, type Status, tenantSchema, validateTenantId } from "./model";

export function createPlatform(pools: Pick<Pools, "platform" | "nodeConfig">) {
  /** Fixed SQL text and bound values; rows are validated as stored state. `from`: the primary by default, or a read replica of it. */
  async function select(clause: string, values: unknown[], from: Pick<Connection, "query"> = pools.platform) {
    const rows = await from.query(`SELECT ${placementColumns} ${clause}`, values);
    return rows.map((row) => parseDatabaseValue(placementSchema, row));
  }
  /** `undefined` if there is no such record (on a replica this can also mean it has not replicated yet). */
  async function find(tenantId: string, from?: Pick<Connection, "query">) {
    return (await select("FROM platform.placements p WHERE p.tenant_id=$1", [validateTenantId(tenantId)], from))[0];
  }
  async function get(tenantId: string) {
    const placement = await find(tenantId);
    if (!placement) throw new AppError("TENANT_NOT_FOUND", "tenant not found");
    return placement;
  }
  /** A keyset page of a database's placements; ordered by tenant ID (`COLLATE "C"`, same as the index). */
  function listPage(databaseId: string, after: string, limit: number) {
    pools.nodeConfig(databaseId);
    return select(
      `FROM platform.placements p WHERE p.database_id=$1 AND p.tenant_id COLLATE "C">$2 ORDER BY p.tenant_id COLLATE "C" LIMIT $3`,
      [databaseId, after, limit],
    );
  }
  return { get, find, listPage };
}

/** Upper bound of a tenant's size (capacity unit). */
const MAX_TENANT_SIZE = 100;

/** Among `active` databases, the one with the lowest (sum of sizes + new size) / capacity ratio that fits; if `$3` is given, only that database. */
const CHOOSE_DATABASE = `SELECT n.database_id FROM platform.nodes n LEFT JOIN platform.placements p ON p.database_id=n.database_id
  WHERE n.status='active' AND n.database_id IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb)) AND ($3::text IS NULL OR n.database_id=$3)
  GROUP BY n.database_id,n.capacity HAVING COALESCE(sum(p.size),0)+$2<=n.capacity
  ORDER BY (COALESCE(sum(p.size),0)+$2)::float8/n.capacity,length(n.database_id),n.database_id LIMIT 1`;

/** Compare-and-set: writes only to the placement version read under the tenant lock. A status change never overwrites a move's
 * placement ownership (`move_operation_id IS NULL`). */
const SET_STATUS = `UPDATE platform.placements AS p SET status=$1 WHERE p.tenant_id=$2 AND p.database_id=$3 AND p.placement_version=$4 AND p.move_operation_id IS NULL RETURNING ${placementColumns}`;
const SET_SCHEMA_VERSION = `UPDATE platform.placements AS p SET schema_version=$1 WHERE p.tenant_id=$2 AND p.database_id=$3 AND p.placement_version=$4 RETURNING ${placementColumns}`;

/** A reserved tenant ID is `TENANT_RESERVED`. */
async function assertNotReserved(db: Pick<Connection, "query">, tenantId: string) {
  const reserved = await db.query("SELECT 1 FROM platform.reserved_tenant_ids WHERE tenant_id=$1", [tenantId]);
  if (reserved.length) throw new AppError("TENANT_RESERVED", "tenant id is reserved");
}

/** The target database via `CHOOSE_DATABASE`; `NO_CAPACITY` if there is no room. */
async function selectDatabase(db: Pick<Connection, "query">, databaseIds: readonly string[], weight: number, databaseId: string | undefined) {
  const [target] = await db.query<{ database_id: string }>(CHOOSE_DATABASE, [JSON.stringify(databaseIds), weight, databaseId ?? null]);
  if (!target) throw new AppError("NO_CAPACITY", `No active database has room for a tenant of size ${weight}`);
  return target.database_id;
}

/** The `platform.tenants` columns are cached per management context; if a looked-up name is not in the cache they are re-read once (an application migration may
 * have added a column after the context was opened). Writes with no fields never read the columns. */
function createTenantColumnCache(pools: Pools, packageOwned: ReadonlySet<string>) {
  let cached: Promise<ReadonlySet<string>> | undefined;
  const load = () => {
    const loading = readTenantColumns(pools.platform);
    cached = loading.catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
  return async (names: readonly string[]): Promise<TenantColumns> => {
    let writable = await (cached ?? load());
    if (names.some((name) => !writable.has(name) && !packageOwned.has(name))) writable = await load();
    return { writable, packageOwned };
  };
}

/** `databaseIds`: the IDs in `DATABASE_URLS` order; placement selection is made only among these. `packageTenantColumns`: the columns the package's
 * migrations define on `platform.tenants` (cannot be written as application fields). */
export function createManagementPlatform(
  pools: Pools,
  databaseIds: readonly string[],
  onChange?: (tenantId: string) => unknown,
  packageTenantColumns: readonly string[] = ["tenant_id"],
) {
  const { get, listPage } = createPlatform(pools);
  const tenantColumns = createTenantColumnCache(pools, new Set(packageTenantColumns));
  /** After the placement status/database is committed (cache invalidation). */
  const changed = async (tenantId: string) => {
    await onChange?.(tenantId);
  };

  /** Validates application fields against the real columns (`INVALID_CONFIG`); does not go to the database if there are no fields. */
  async function tenantFields(fields: unknown): Promise<TenantRow> {
    const keys = typeof fields === "object" && fields !== null ? Object.keys(fields) : [];
    const columns = keys.length ? await tenantColumns(candidateColumns(keys)) : { writable: new Set<string>(), packageOwned: new Set<string>() };
    return resolveTenantFields(fields, columns);
  }

  /** The columns writable in the target from the tenant row in the backup, and the skipped ones. */
  async function restoredTenant(stored: Readonly<Record<string, unknown>>) {
    const keys = Object.keys(stored).filter((key) => key !== "tenant_id");
    if (!keys.length) return { row: {}, skipped: [] };
    return restoredTenantRow(stored, await tenantColumns(keys));
  }

  /** Validates the size (1–100) and checks that the given database is configured. */
  function placementWeight(databaseId: string | undefined, size: number) {
    const weight = boundedInteger(size, "size", MAX_TENANT_SIZE);
    if (databaseId !== undefined) pools.nodeConfig(databaseId);
    return weight;
  }

  /**
   * With the same intent the existing placement is returned (retry); a different database or kind is `TENANT_CONFLICT`. New tenant: a reserved ID is
   * `TENANT_RESERVED`; if `databaseId` is not given, the least full active database for `size` (1–100) is chosen, and a given database must be active and have
   * room (`NO_CAPACITY`). A transaction advisory lock serializes placement choices. `tenant`: application fields validated with `tenantFields` (or
   * `restoredTenant`); written only to a new `platform.tenants` row, in the same statement.
   */
  async function create(tenantId: string, databaseId: string | undefined, kind: Kind = "tenant", size = 1, tenant: TenantRow = {}): Promise<Placement> {
    const schema = tenantSchema(tenantId, kind);
    const weight = placementWeight(databaseId, size);
    return pools.platform.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-placement',0))");
      const [existingRow] = await tx.query(`SELECT ${placementColumns} FROM platform.placements p WHERE p.tenant_id=$1 FOR UPDATE`, [tenantId]);
      if (existingRow) {
        const existing = parseDatabaseValue(placementSchema, existingRow);
        if ((databaseId !== undefined && existing.databaseId !== databaseId) || existing.kind !== kind)
          throw new AppError("TENANT_CONFLICT", "tenant exists with different placement intent");
        return existing;
      }
      await assertNotReserved(tx, tenantId);
      const targetDatabaseId = await selectDatabase(tx, databaseIds, weight, databaseId);
      // A record without a placement (e.g. a deleted tenant that was added without a placement) holds the ID.
      const insert = tenantInsert(tenantId, tenant);
      const inserted = await tx.query(insert.sql, insert.values).catch((error: unknown) => {
        throw tenantInsertError(error);
      });
      if (!inserted.length) throw new AppError("TENANT_EXISTS", "tenant id belongs to a tenant record without a placement");
      const [created] = await tx.query(
        `INSERT INTO platform.placements AS p (tenant_id,database_id,kind,schema_name,status,size) VALUES ($1,$2,$3,$4,'provisioning',$5) RETURNING ${placementColumns}`,
        [tenantId, targetDatabaseId, kind, schema, weight],
      );
      return parseDatabaseValue(placementSchema, created);
    });
  }

  /** Placement selection without writing (`create` repeats the same query under the lock); a reserved ID is `TENANT_RESERVED`, `NO_CAPACITY` if there is no room. */
  async function choose(tenantId: string, databaseId: string | undefined, size = 1): Promise<string> {
    const weight = placementWeight(databaseId, size);
    await assertNotReserved(pools.platform, tenantId);
    return selectDatabase(pools.platform, databaseIds, weight, databaseId);
  }

  /** CAS write; if no row is returned, the placement changed in the meantime (`PLACEMENT_CONFLICT`). */
  async function casUpdate(sql: string, placement: Placement, value: Status | number): Promise<Placement> {
    const [row] = await pools.platform.query(sql, [value, placement.tenantId, placement.databaseId, placement.placementVersion]);
    if (!row) throw new AppError("PLACEMENT_CONFLICT", "Placement changed concurrently; reload and retry");
    return parseDatabaseValue(placementSchema, row);
  }

  async function setStatus(placement: Placement, status: Status) {
    const updated = await casUpdate(SET_STATUS, placement, status);
    await changed(updated.tenantId);
    return updated;
  }

  const setSchemaVersion = (placement: Placement, version: number) => casUpdate(SET_SCHEMA_VERSION, placement, version);

  return { get, listPage, changed, choose, create, setStatus, setSchemaVersion, tenantFields, restoredTenant };
}
export type ManagementPlatform = ReturnType<typeof createManagementPlatform>;
