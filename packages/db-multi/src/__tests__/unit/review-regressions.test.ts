import { expect, test } from "bun:test";
import { createPlatform } from "../../core/tenants/placement";

test("corrupt persisted placement is a server error rather than client validation", async () => {
  const platform = { query: async () => [{ tenantId: "demo-tenant", schemaName: "invalid" }] };
  const placements = createPlatform({ platform } as never);
  await expect(placements.get("demo-tenant")).rejects.toMatchObject({ code: "INVALID_DATABASE_STATE" });
});
