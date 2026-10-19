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

/** SQL identifiers are never value parameters. */
export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0") || new TextEncoder().encode(value).length > 63)
    throw new AppError("INVALID_IDENTIFIER", "Invalid PostgreSQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
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
  })
  .refine((value) => value.schemaName === tenantSchema(value.tenantId, value.kind));
/** Columns matching `placementSchema`; queries give the platform.placements table the alias `p`. */
export const placementColumns = `p.tenant_id AS "tenantId", p.database_id AS "databaseId", p.kind, p.schema_name AS "schemaName", p.status, p.schema_version AS "schemaVersion", p.placement_version AS "placementVersion"`;

export type Status = z.infer<typeof statusSchema>;
export type Placement = z.infer<typeof placementSchema>;

/** `"schema"."name"`: the schema is validated and both are quoted. */
export const qualified = (schema: string, name: string) => `${quoteIdentifier(validateSchema(schema))}.${quoteIdentifier(name)}`;

/** `TENANT_UNAVAILABLE` if the placement is not `active` (the message describes the caller's context). */
export function requireActive<P extends Pick<Placement, "status">>(placement: P, message = "Tenant is not active"): P {
  if (placement.status !== "active") throw new AppError("TENANT_UNAVAILABLE", message);
  return placement;
}
