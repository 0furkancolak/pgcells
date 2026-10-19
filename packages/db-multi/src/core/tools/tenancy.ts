/** Reserved tenant IDs and DB placement choice settings (`platform.reserved_tenant_ids`, `platform.nodes`). Takes the same
 * transaction lock as placement (`tenant-placement`): reserving and creating a tenant do not race. */
import { boundedInteger } from "../config";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import type { Management } from "../management";
import { validateLabels, validateRegionName, validateTenantId } from "../tenants/model";

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

/** Per-DB status, capacity, tenant count and size total (`load`); `configured`: whether it is in `DATABASE_URLS`. `region`, `residencyZone` and `labels` are
 * the region model's node metadata (`null` / `{}` when never set). */
export async function listDatabases(m: Management) {
  const rows = await m.pools.platform.query<{
    databaseId: string;
    status: string;
    capacity: number;
    region: string | null;
    residencyZone: string | null;
    labels: Record<string, string>;
    tenants: number;
    load: number;
  }>(
    `SELECT n.database_id AS "databaseId",n.status,n.capacity,n.region,n.residency_zone AS "residencyZone",n.labels,count(p.tenant_id)::integer AS tenants,COALESCE(sum(p.size),0)::integer AS load
     FROM platform.nodes n LEFT JOIN platform.placements p ON p.database_id=n.database_id
     GROUP BY n.database_id,n.status,n.capacity,n.region,n.residency_zone,n.labels ORDER BY length(n.database_id),n.database_id`,
  );
  const configured = new Set(m.config.nodes.map((node) => node.id));
  return rows.map((row) => ({ ...row, configured: configured.has(row.databaseId) }));
}

export interface DatabaseSettings {
  status?: string;
  capacity?: number | string;
  /** The region the database lives in; `"none"` clears it. */
  region?: string;
  /** The residency zone the database belongs to; `"none"` clears it. Refused while it would strand a tenant bound to another zone. */
  zone?: string;
  /** Labels to set (merged into the existing ones). */
  labels?: Readonly<Record<string, string>>;
  /** Label keys to remove. */
  unlabel?: readonly string[];
}

const CLEAR = "none";
const regionValue = (value: string | undefined, what: string) => (value === undefined ? undefined : value === CLEAR ? null : validateRegionName(value, what));

/** `draining`: takes no new tenants, existing ones stay. Capacity can fall below the load; then the DB takes no new tenants. `region`, `zone` and `labels` describe the
 * database for placement: a zone change is refused (`RESIDENCY_VIOLATION`) while tenants bound to a different zone live on it. */
export async function setDatabase(m: Management, databaseId: string, settings: DatabaseSettings) {
  const { status, capacity, labels, unlabel } = settings;
  const region = regionValue(settings.region, "region");
  const zone = regionValue(settings.zone, "zone");
  if ([status, capacity, region, zone, labels, unlabel].every((value) => value === undefined))
    throw new AppError("USAGE", "Pass --status active|draining, --capacity N, --region, --zone, --label k=v and/or --unlabel key");
  if (status !== undefined && !(DATABASE_STATUSES as readonly string[]).includes(status))
    throw new AppError("USAGE", `status must be one of: ${DATABASE_STATUSES.join(", ")}`);
  const capacityLimit = capacity === undefined ? null : boundedInteger(capacity, "capacity", 1_000_000);
  const add = validateLabels(labels ?? {});
  const remove = [...(unlabel ?? [])];
  for (const key of remove) validateLabels({ [key]: "x" });
  if (Object.keys(add).some((key) => remove.includes(key))) throw new AppError("USAGE", "A label cannot be set and removed in the same call");
  return m.pools.platform.transaction(async (tx) => {
    await lockPlacement(tx);
    const [node] = await tx.query<{ zone: string | null }>("SELECT residency_zone AS zone FROM platform.nodes WHERE database_id=$1 FOR UPDATE", [databaseId]);
    if (!node) throw new AppError("DATABASE_NOT_FOUND", `Database ${databaseId} is not registered`);
    if (zone !== undefined && zone !== node.zone) {
      const [stranded] = await tx.query<{ count: number; zone: string }>(
        "SELECT count(*)::integer AS count,min(residency_zone) AS zone FROM platform.placements WHERE database_id=$1 AND residency_zone IS NOT NULL AND residency_zone IS DISTINCT FROM $2::text",
        [databaseId, zone],
      );
      if (stranded && stranded.count > 0)
        throw new AppError("RESIDENCY_VIOLATION", `${stranded.count} tenant(s) bound to residency zone ${stranded.zone} live on ${databaseId}; move them before changing its zone`);
    }
    const [row] = await tx.query<{ databaseId: string; status: string; capacity: number; region: string | null; residencyZone: string | null; labels: Record<string, string> }>(
      `UPDATE platform.nodes SET status=COALESCE($2,status),capacity=COALESCE($3,capacity),
         region=CASE WHEN $4::boolean THEN $5::text ELSE region END,
         residency_zone=CASE WHEN $6::boolean THEN $7::text ELSE residency_zone END,
         labels=(labels || $8::text::jsonb) - ARRAY(SELECT pg_catalog.jsonb_array_elements_text($9::text::jsonb))
       WHERE database_id=$1 RETURNING database_id AS "databaseId",status,capacity,region,residency_zone AS "residencyZone",labels`,
      [databaseId, status ?? null, capacityLimit, region !== undefined, region ?? null, zone !== undefined, zone ?? null, JSON.stringify(add), JSON.stringify(remove)],
    );
    return row as NonNullable<typeof row>;
  });
}
