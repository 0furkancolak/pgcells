/** Redis key names. A tenant key is `t:{abc}:part:part`: the `{abc}` hash tag puts all of a tenant's keys in the same Redis
 * Cluster slot (multi-key commands and Lua work). A global key is `g:part`. An optional application prefix is
 * prepended (`app:t:{abc}:…`); the prefix must not contain `{` or `}`, otherwise the hash tag breaks. */
import { validateTenantId } from "@0furkancolak/pgcells";

export type KeyPart = string | number;

export function createKeys(prefix?: string) {
  const head = prefix ? `${prefix}:` : "";
  return {
    /** The tenant ID is validated (`INVALID_TENANT_ID`). */
    tenant: (tenantId: string, ...parts: KeyPart[]) => [`${head}t:{${validateTenantId(tenantId)}}`, ...parts].join(":"),
    global: (...parts: KeyPart[]) => [`${head}g`, ...parts].join(":"),
  };
}

export type Keys = ReturnType<typeof createKeys>;
export const { tenant: tenantKey, global: globalKey } = createKeys();
