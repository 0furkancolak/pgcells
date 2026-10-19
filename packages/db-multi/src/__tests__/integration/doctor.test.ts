import { expect } from "bun:test";
import { type Config, createConfig } from "../../core/config";
import type { Database } from "../../core/database";
import { bootstrap, type Management, provisionTenant } from "../../management";
import { nodeMigrations, platformMigrations } from "../../core/migrations/registry";
import { doctor } from "../../core/tools/doctor";
import { startMove } from "../../core/tools/move";
import { createTestManagement, directConfig, integration, q, raw } from "./helpers";

/** CREATE/DROP DATABASE cannot run in a transaction, so they need a session without bootstrap's runtime statement_timeout. */
async function outsideTimeout(admin: Database, sql: string) {
  const connection = await admin.pool.reserve();
  try {
    await connection.exec("SET statement_timeout = 0");
    await connection.exec(sql);
  } finally {
    await connection.exec("RESET statement_timeout").catch(() => {});
    connection.release();
  }
}

const databaseUrl = (url: string, database: string) => {
  const target = new URL(url);
  target.pathname = `/${database}`;
  return target.href;
};

/** Runs against one fresh database per configured server position, so doctor sees only this fixture. */
async function withIsolatedPlatform(count: number, work: (app: Management, config: Config) => Promise<void>) {
  const id = crypto.randomUUID().replaceAll("-", "");
  const servers = directConfig().nodes.slice(0, count);
  if (servers.length !== count) throw new Error(`${count} databases required`);
  const admins = servers.map((node, index) => ({ admin: raw(index), name: `doctor_${index}_${id}`, url: node.url }));
  const config = createConfig(admins.map(({ url, name }) => databaseUrl(url, name)));
  const app = createTestManagement({}, config);
  try {
    for (const { admin, name } of admins) await outsideTimeout(admin, `CREATE DATABASE ${q(name)}`);
    await bootstrap(app);
    await work(app, config);
  } finally {
    await app.close();
    for (const { admin, name } of admins.reverse()) {
      await outsideTimeout(admin, `DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`);
      await admin.close();
    }
  }
}

/** Runs doctor with its own management context, as the CLI does. */
async function diagnose(config: Config) {
  const app = createTestManagement({}, config);
  try {
    return await doctor(app);
  } finally {
    await app.close();
  }
}

integration("doctor accepts a healthy platform with tenants", () =>
  withIsolatedPlatform(1, async (app, config) => {
    await provisionTenant(app, "doctor-fixture", "db0");
    const healthy = await diagnose(config);
    expect(healthy.checks.filter((check) => !check.ok)).toEqual([]);
    expect(healthy.ok).toBe(true);
  }),
);

integration(
  "bootstrap applies platform and node migrations once on db0, queues concurrent runs and rejects ledger drift",
  () =>
    withIsolatedPlatform(1, async (app, config) => {
      const db = app.pools.platform;
      expect(app.pools.node("db0")).toBe(db);
      const ledger = async (table: string) =>
        (await db.query<{ id: string }>(`SELECT id FROM platform.${table} ORDER BY id`)).map((row) => row.id);
      const platformIds = platformMigrations.map((m) => m.id);
      const nodeIds = nodeMigrations.map((m) => m.id);
      expect(await ledger("_migrations")).toEqual(platformIds);
      expect(await ledger("_node_migrations")).toEqual(nodeIds);
      expect(await bootstrap(app)).toEqual({ platform: [], nodes: { db0: [] } });

      // From an empty platform schema, two bootstraps queue on the per-DB lock; exactly one applies.
      await db.exec("DROP SCHEMA platform CASCADE");
      const other = createTestManagement({}, config);
      try {
        const results = await Promise.all([bootstrap(app), bootstrap(other)]);
        expect(results.flatMap((r) => r.platform)).toEqual(platformIds);
        expect(results.flatMap((r) => r.nodes.db0 ?? [])).toEqual(nodeIds);
      } finally {
        await other.close();
      }
      expect((await diagnose(config)).ok).toBe(true);

      await db.exec("UPDATE platform._node_migrations SET checksum='modified'");
      await expect(bootstrap(app)).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });
      expect((await diagnose(config)).checks).toContainEqual(
        expect.objectContaining({ target: "db0", check: "platform_migrations", ok: false }),
      );
      await db.exec("INSERT INTO platform._migrations (id,checksum) VALUES ('9999_unknown','x')");
      expect((await diagnose(config)).checks).toContainEqual(
        expect.objectContaining({ target: "platform", check: "platform_migrations", ok: false }),
      );
    }),
);

integration("database positions are identities: reordered, shrunk or replaced URL lists fail bootstrap and doctor", () =>
  withIsolatedPlatform(2, async (app, config) => {
    const [first, second] = config.nodes.map((node) => node.url) as [string, string];
    const attempt = async (urls: string[]) => {
      const other = createTestManagement({}, createConfig(urls));
      try {
        await expect(bootstrap(other)).rejects.toMatchObject({ code: "DATABASE_ORDER_CHANGED" });
      } finally {
        await other.close();
      }
    };
    await attempt([second, first]);
    await attempt([first]);
    expect((await diagnose(createConfig([second, first]))).checks).toContainEqual(
      expect.objectContaining({ check: "database_identity", ok: false }),
    );
    // A fresh database behind a registered position is not silently adopted.
    const admin = raw(1);
    const fresh = `${new URL(second).pathname.slice(1)}_fresh`;
    try {
      await outsideTimeout(admin, `CREATE DATABASE ${q(fresh)}`);
      await attempt([first, databaseUrl(second, fresh)]);
    } finally {
      await outsideTimeout(admin, `DROP DATABASE IF EXISTS ${q(fresh)} WITH (FORCE)`);
      await admin.close();
    }
    expect(await bootstrap(app)).toEqual({ platform: [], nodes: { db0: [], db1: [] } });
    expect((await diagnose(config)).ok).toBe(true);
  }),
);

integration("doctor passes after a completed move", () =>
  withIsolatedPlatform(2, async (app, config) => {
    await provisionTenant(app, "doctor-moved", "db0");
    const move = await startMove(app, "doctor-moved", "db1", true);
    expect(move.status).toBe("completed");
    const result = await diagnose(config);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.ok).toBe(true);
  }),
);
