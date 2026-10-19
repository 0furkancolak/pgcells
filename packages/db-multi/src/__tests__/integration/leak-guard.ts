/** `test:integration` preload: the suite leaves no trace in the shared DBs. At the start a snapshot of tenant, move, schema and database names
 * is taken; at the end every newly remaining name is listed and the run fails. Leaked tenants fill placement capacity and
 * later runs fail with `NO_CAPACITY`. */
import { afterAll, beforeAll } from "bun:test";
import { createTestManagement, enabled } from "./helpers";

type Snapshot = Record<string, string[]>;
let before: Snapshot | undefined;

async function snapshot(): Promise<Snapshot> {
  const m = createTestManagement();
  try {
    const names = async (db: typeof m.pools.platform, sql: string) => (await db.query<{ name: string }>(sql)).map((row) => row.name);
    const result: Snapshot = {
      "platform.tenants": await names(m.pools.platform, "SELECT tenant_id AS name FROM platform.tenants"),
      "platform.moves": await names(m.pools.platform, "SELECT tenant_id || ' ' || id::text AS name FROM platform.moves"),
      "platform.move_targets": await names(m.pools.platform, "SELECT tenant_id AS name FROM platform.move_targets"),
    };
    for (const node of m.config.nodes) {
      const db = m.pools.node(node.id);
      result[`${node.id} schemas`] = await names(db, "SELECT nspname AS name FROM pg_catalog.pg_namespace");
      result[`${node.id} databases`] = await names(db, "SELECT datname AS name FROM pg_catalog.pg_database");
    }
    return result;
  } finally {
    await m.close();
  }
}

beforeAll(async () => {
  if (enabled) before = await snapshot();
});

afterAll(async () => {
  if (!before) return;
  const after = await snapshot();
  const leaks = Object.entries(after).flatMap(([what, names]) => {
    const known = new Set(before?.[what]);
    const added = names.filter((name) => !known.has(name)).sort();
    return added.length ? [`${what}: ${added.join(", ")}`] : [];
  });
  if (leaks.length) throw new Error(`Integration tests left objects behind in the shared databases:\n${leaks.join("\n")}`);
});
