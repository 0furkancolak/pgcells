/** Reserved tenant IDs and DB placement choice settings (`platform.reserved_tenant_ids`, `platform.nodes`). Takes the same
 * transaction lock as placement (`tenant-placement`): reserving and creating a tenant do not race. */
import { boundedInteger } from "../config";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import type { Management } from "../management";
import { validateTenantId } from "../tenants/model";

const DATABASE_STATUSES = ["active", "draining"] as const;
const lockPlacement = (tx: Connection) => tx.query("SELECT pg_advisory_xact_lock(hashtextextended('tenant-placement',0))");
const tenantIdsJson = (ids: readonly string[]) => JSON.stringify([...new Set(ids.map(validateTenantId))]);

/** Reserves the IDs (updates the reason if present); an existing tenant cannot be reserved (`TENANT_EXISTS`). */
export function reserveTenantIds(m: Management, ids: readonly string[], reason = "manual") {
  if (!reason.trim() || reason.length > 200) throw new AppError("USAGE", "reason must be 1-200 characters");
  const list = tenantIdsJson(ids);
  return m.pools.platform.transaction(async (tx) => {
    await lockPlacement(tx);
    const existing = await tx.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM platform.tenants WHERE tenant_id IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb))",
      [list],
    );
    if (existing.length) throw new AppError("TENANT_EXISTS", `Existing tenants cannot be reserved: ${existing.map((row) => row.tenant_id).join(", ")}`);
    const rows = await tx.query<{ tenant_id: string }>(
      `INSERT INTO platform.reserved_tenant_ids (tenant_id,reason) SELECT id,$2 FROM pg_catalog.jsonb_array_elements_text($1::text::jsonb) AS id
       ON CONFLICT (tenant_id) DO UPDATE SET reason=EXCLUDED.reason RETURNING tenant_id`,
      [list, reason.trim()],
    );
    return { reserved: rows.map((row) => row.tenant_id).sort() };
  });
}

/** Removes the reservation; returns the IDs removed. */
export async function releaseTenantIds(m: Management, ids: readonly string[]) {
  const rows = await m.pools.platform.query<{ tenant_id: string }>(
    "DELETE FROM platform.reserved_tenant_ids WHERE tenant_id IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb)) RETURNING tenant_id",
    [tenantIdsJson(ids)],
  );
  return { released: rows.map((row) => row.tenant_id).sort() };
}

/** Reserved IDs and their reasons, in ID order. */
export const listReservedTenantIds = (m: Management) =>
  m.pools.platform.query<{ tenantId: string; reason: string }>(`SELECT tenant_id AS "tenantId",reason FROM platform.reserved_tenant_ids ORDER BY tenant_id`);

/** Per-DB status, capacity, tenant count and size total (`load`); `configured`: whether it is in `DATABASE_URLS`. */
export async function listDatabases(m: Management) {
  const rows = await m.pools.platform.query<{ databaseId: string; status: string; capacity: number; tenants: number; load: number }>(
    `SELECT n.database_id AS "databaseId",n.status,n.capacity,count(p.tenant_id)::integer AS tenants,COALESCE(sum(p.size),0)::integer AS load
     FROM platform.nodes n LEFT JOIN platform.placements p ON p.database_id=n.database_id
     GROUP BY n.database_id,n.status,n.capacity ORDER BY length(n.database_id),n.database_id`,
  );
  const configured = new Set(m.config.nodes.map((node) => node.id));
  return rows.map((row) => ({ ...row, configured: configured.has(row.databaseId) }));
}

/** `draining`: takes no new tenants, existing ones stay. Capacity can fall below the load; then the DB takes no new tenants. */
export async function setDatabase(m: Management, databaseId: string, { status, capacity }: { status?: string; capacity?: number | string }) {
  if (status === undefined && capacity === undefined) throw new AppError("USAGE", "Pass --status active|draining and/or --capacity N");
  if (status !== undefined && !(DATABASE_STATUSES as readonly string[]).includes(status))
    throw new AppError("USAGE", `status must be one of: ${DATABASE_STATUSES.join(", ")}`);
  const capacityLimit = capacity === undefined ? null : boundedInteger(capacity, "capacity", 1_000_000);
  const [row] = await m.pools.platform.query<{ databaseId: string; status: string; capacity: number }>(
    `UPDATE platform.nodes SET status=COALESCE($2,status),capacity=COALESCE($3,capacity) WHERE database_id=$1 RETURNING database_id AS "databaseId",status,capacity`,
    [databaseId, status ?? null, capacityLimit],
  );
  if (!row) throw new AppError("DATABASE_NOT_FOUND", `Database ${databaseId} is not registered`);
  return row;
}
