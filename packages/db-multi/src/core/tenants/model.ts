/** Tenant ID = subdomain label (`abc.example.com` → `abc`): valid both as a DNS label and as a schema name. Validation,
 * the ID from the `Host` header, the deterministic schema name, a safe identifier and the schema of the placement record. */
import { z } from "zod";
import { AppError } from "../errors";

/** The `tenant_` prefix is 7 bytes; the schema name fits PostgreSQL's 63-byte limit. */
export const TENANT_ID_MAX = 56;
/** Starts with a lowercase letter; `[a-z0-9]` and a single `-` (not at the start, at the end or repeated), 3–56 characters. There is no `_` or `.`: so
 * `-` → `_` is one-to-one and `xn--` (IDN) labels are not accepted. */
const tenantIdPattern = /^(?=.{3,56}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A safe tenant schema name: `tenant_` or `demo_` + `[a-z0-9_]`, at most 63 bytes (those derived from an ID are a subset of this). */
const schemaPattern = /^(?=.{1,63}$)(?:tenant|demo)_[a-z0-9_]+$/;

export const kindSchema = z.enum(["tenant", "demo"]);
export type Kind = z.infer<typeof kindSchema>;

/** A stored ID is strict: uppercase letters and spaces are rejected; correct user input first with `normalizeTenantId`. */
export function validateTenantId(value: string): string {
  if (!tenantIdPattern.test(value))
    throw new AppError("INVALID_TENANT_ID", "tenant id must be 3-56 characters of a-z, 0-9 and single hyphens, starting with a letter (e.g. abc)");
  return value;
}
/** Fixes whitespace and uppercase, then validates. */
export const normalizeTenantId = (value: string) => validateTenantId(value.trim().toLowerCase());

/** `Host` → tenant ID: the port is dropped and it is lowercased; the host must be exactly `<id>.<root domain>` (a single label). Root
 * domains are tried in order (e.g. `["example.com", "localhost"]`). A missing host, one under another domain or a multi-label host is `INVALID_TENANT_ID`. */
export function tenantFromHost(host: string | null | undefined, rootDomains: string | readonly string[]): string {
  const name = (host ?? "").replace(/:\d*$/, "").replace(/\.$/, "").toLowerCase();
  for (const root of typeof rootDomains === "string" ? [rootDomains] : rootDomains) {
    const suffix = `.${root.toLowerCase().replace(/^\.|\.$/g, "")}`;
    if (suffix.length > 1 && name.endsWith(suffix)) return validateTenantId(name.slice(0, -suffix.length));
  }
  throw new AppError("INVALID_TENANT_ID", "host is not a tenant subdomain of a configured root domain");
}

export function validateSchema(value: string): string {
  if (!schemaPattern.test(value)) throw new AppError("INVALID_SCHEMA", "invalid tenant schema");
  return value;
}

/** `tenant_` / `demo_` + ID, `-` → `_` (`abc-shop` → `tenant_abc_shop`). The mapping is one-to-one because an ID contains no `_`. */
export const tenantSchema = (tenantId: string, kind: Kind = "tenant"): string => `${kind}_${validateTenantId(tenantId).replaceAll("-", "_")}`;

/** The two possible schema names of the same ID; an ID must not already exist in any database under either of them. */
export const tenantSchemas = (tenantId: string) => kindSchema.options.map((kind) => tenantSchema(tenantId, kind));

/** Marks a source schema that a completed move fenced off: `<schema>__moved_<first 8 hex of the move id>`. */
export const MOVED_SCHEMA_PATTERN = /^(?:tenant|demo)_[a-z0-9_]*__moved_[0-9a-f]{8}$/;
const MOVED_MARKER = "__moved_";

/** The name a move gives the source schema at cutover. Tenant IDs hold no `_`, so no real tenant schema contains `__`; a schema that would
 * overflow 63 bytes is shortened before the marker, which keeps the move id and so the name unique. */
export function movedSchemaName(schema: string, operationId: string): string {
  const suffix = `${MOVED_MARKER}${operationId.replaceAll("-", "").slice(0, 8)}`;
  return `${validateSchema(schema).slice(0, 63 - suffix.length)}${suffix}`;
}

/** SQL identifiers are never value parameters. */
export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0") || new TextEncoder().encode(value).length > 63)
    throw new AppError("INVALID_IDENTIFIER", "Invalid PostgreSQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

/** Region and residency zone names: lowercase DNS-like labels (`eu-west`, `us-east-1`, `eu`), the same shape the platform tables check. */
const regionNamePattern = /^[a-z][a-z0-9-]{0,62}$/;
export function validateRegionName(value: string, what = "region"): string {
  if (!regionNamePattern.test(value)) throw new AppError("INVALID_CONFIG", `${what} must be 1-63 characters of a-z, 0-9 and hyphens, starting with a letter (e.g. eu-west)`);
  return value;
}
/** Node labels: `key=value` pairs; keys and values are short lowercase tokens so they are safe to store and to compare. */
const labelPattern = /^[a-z][a-z0-9_.-]{0,62}$/;
export function validateLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  for (const [key, value] of Object.entries(labels))
    if (!labelPattern.test(key) || !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(value)) throw new AppError("INVALID_CONFIG", `label ${key}=${value} must use lowercase letters, digits, "_", "." and "-" (at most 63 characters)`);
  return { ...labels };
}
/** Where a tenant may live: any of these narrows automatic placement, and `zone` is written to the placement as its residency. */
export interface PlacementRequest {
  region?: string;
  zone?: string;
  labels?: Readonly<Record<string, string>>;
}

export const statusSchema = z.enum(["provisioning", "active", "maintenance", "migrating", "failed"]);
/** The stored placement; the schema name must be the name derived from the tenant ID and kind. */
export const placementSchema = z
  .object({
    tenantId: z.string().regex(tenantIdPattern),
    databaseId: z.string().min(1),
    kind: kindSchema,
    schemaName: z.string().regex(schemaPattern),
    status: statusSchema,
    schemaVersion: z.number().int().nonnegative(),
    placementVersion: z.number().int().positive(),
    /** The residency zone the tenant is bound to (`null`: unrestricted). */
    residencyZone: z.string().nullable().optional(),
    /** The region of the node the tenant lives on (`null`: the node has no region). Absent in placements cached before regions existed. */
    region: z.string().nullable().optional(),
  })
  .refine((value) => value.schemaName === tenantSchema(value.tenantId, value.kind));
/** Columns matching `placementSchema`; queries give the platform.placements table the alias `p`. */
export const placementColumns = `p.tenant_id AS "tenantId", p.database_id AS "databaseId", p.kind, p.schema_name AS "schemaName", p.status, p.schema_version AS "schemaVersion", p.placement_version AS "placementVersion", p.residency_zone AS "residencyZone", (SELECT n.region FROM platform.nodes n WHERE n.database_id=p.database_id) AS "region"`;

export type Status = z.infer<typeof statusSchema>;
export type Placement = z.infer<typeof placementSchema>;

/** `"schema"."name"`: the schema is validated and both are quoted. */
export const qualified = (schema: string, name: string) => `${quoteIdentifier(validateSchema(schema))}.${quoteIdentifier(name)}`;

/** `TENANT_UNAVAILABLE` if the placement is not `active` (the message describes the caller's context). */
export function requireActive<P extends Pick<Placement, "status">>(placement: P, message = "Tenant is not active"): P {
  if (placement.status !== "active") throw new AppError("TENANT_UNAVAILABLE", message);
  return placement;
}
