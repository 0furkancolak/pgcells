import { expect } from "bun:test";
import { bootstrap, migrateAll } from "../../management";
import { tenantMigrations } from "../../core/migrations/registry";
import { tenantSchema } from "../../core/tenants/model";
import { createTestManagement, integration, q } from "./helpers";

integration(
  "1000 real schemas across two databases complete bounded migration chains",
  async () => {
    const app = createTestManagement();
    const nodes = app.config.nodes.slice(0, 2);
    if (nodes.length !== 2) throw new Error("Two integration databases required");
    const prefix = `scale-${crypto.randomUUID().replaceAll("-", "")}-`;
    const groups = nodes.map((node, index) => ({
      node,
      rows: Array.from({ length: 500 }, (_, i) => {
        const id = `${prefix}${index}-${String(i).padStart(4, "0")}`;
        return { tenant_id: id, schema_name: tenantSchema(id) };
      }),
    }));
    // Fixture setup is bounded too; no Promise.all over the full target collection.
    async function schemas(drop: boolean) {
      for (const { node, rows } of groups) {
        const db = app.pools.node(node.id);
        let next = 0;
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            for (let row = rows[next++]; row; row = rows[next++])
              await db.exec(drop ? `DROP SCHEMA IF EXISTS ${q(row.schema_name)} CASCADE` : `CREATE SCHEMA ${q(row.schema_name)}`);
          }),
        );
      }
    }
    try {
      await bootstrap(app);
      for (const { node, rows } of groups) {
        const fixture = JSON.stringify(rows);
        const records = "jsonb_to_recordset($1::text::jsonb) AS x(tenant_id text,schema_name text)";
        await app.pools.platform.query(`INSERT INTO platform.tenants(tenant_id) SELECT tenant_id FROM ${records}`, [fixture]);
        await app.pools.platform.query(
          `INSERT INTO platform.placements(tenant_id,database_id,schema_name,status) SELECT tenant_id,$2,schema_name,'active' FROM ${records}`,
          [fixture, node.id],
        );
      }
      await schemas(false);
      // The second pass trusts schema_version: current schemas cost no session or lock.
      for (const pass of [1, 2]) {
        const done = new Set<string>();
        const sessions = new Map<string, Set<number>>();
        let migrationsStarted = 0;
        const summary = await migrateAll(app, {
          databaseIds: nodes.map((node) => node.id),
          concurrency: 8,
          perDatabaseConcurrency: 4,
          report: (event) => {
            const { tenantId, databaseId, status, migration, backendPid } = event as {
              tenantId?: string;
              databaseId?: string;
              status?: string;
              migration?: string;
              backendPid?: number;
            };
            if (status === "session-acquired") {
              if (!databaseId || !backendPid) throw new Error("Missing physical worker session identity");
              sessions.set(databaseId, (sessions.get(databaseId) ?? new Set<number>()).add(backendPid));
            }
            if (!tenantId?.startsWith(prefix)) return;
            if (status === "started" && migration) migrationsStarted++;
            if (status === "succeeded" && !migration) done.add(tenantId);
          },
        });
        expect(summary.failed).toBe(0);
        // Other fixtures may be inactive; count only this fixture's active schemas.
        expect(done.size).toBe(1000);
        expect(sessions.size).toBe(pass === 1 ? 2 : 0);
        expect([...sessions.values()].reduce((n, pids) => n + pids.size, 0)).toBeLessThanOrEqual(8);
        for (const pids of sessions.values()) expect(pids.size).toBeLessThanOrEqual(4);
        expect(migrationsStarted).toBe(pass === 1 ? 1000 * tenantMigrations.length : 0);
        // Successful finalization must actually close every worker backend.
        for (const node of nodes) {
          const pids = [...(sessions.get(node.id) ?? [])];
          const [remaining] = await app.pools
            .node(node.id)
            .query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE pid IN (SELECT jsonb_array_elements_text($1::text::jsonb)::integer)",
              [JSON.stringify(pids)],
            );
          expect(remaining?.count).toBe(0);
        }
      }
      for (const { node, rows } of groups)
        for (const row of [rows[0], rows.at(-1)]) {
          if (!row) throw new Error("Missing fixture row");
          expect(await app.pools.node(node.id).query(`SELECT id FROM ${q(row.schema_name, "_migrations")}`)).toHaveLength(tenantMigrations.length);
        }
    } finally {
      await schemas(true);
      for (const { rows } of groups) {
        const ids = JSON.stringify(rows.map((row) => row.tenant_id));
        for (const table of ["placements", "tenants"])
          await app.pools.platform.query(
            `DELETE FROM platform.${table} WHERE tenant_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
            [ids],
          );
      }
      await app.close();
    }
  },
  300000,
);
