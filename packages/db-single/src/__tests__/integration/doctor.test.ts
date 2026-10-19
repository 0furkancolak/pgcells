import { expect } from "bun:test";
import { createConfig } from "../../core/config";
import { createRunner } from "../../core/migrations/runner";
import type { Registry } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";
import { doctor } from "../../core/tools/doctor";
import { createTestManagement, directConfig, dropSchema, integration, pooledConfig, raw, testSchema } from "./helpers";
import { PRIMARY_URL, REPLICA_URL, replicaFixture } from "./replica-fixture";

const registry: Registry = { migrations: compileMigrations([["20260101000001_t", "--up\nCREATE TABLE t (id integer PRIMARY KEY);\n--down\nDROP TABLE t;\n"]]), seeds: [] };
const behind: Registry = { migrations: compileMigrations([["20260101000001_t", "--up\nCREATE TABLE t (id integer PRIMARY KEY);\n--down\nDROP TABLE t;\n"], ["20260101000002_u", "--up\nCREATE TABLE u (id integer PRIMARY KEY);\n--down\nDROP TABLE u;\n"]]), seeds: [] };
const check = (report: Awaited<ReturnType<typeof doctor>>, name: string, target = "database") => report.checks.find((c) => c.check === name && c.target === target);

integration("doctor passes on a migrated schema over a direct URL, flags pending migrations, and proves the pooler URL", async () => {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema });
  try {
    await createRunner(registry).migrate(m);
    const report = await doctor(m, { registry, pooledUrl: pooledConfig().url });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(check(await doctor(m, { registry: behind }), "migrations")?.ok).toBe(false);
    expect(check(await doctor(m, { registry, pooledUrl: directConfig().url }), "pooled_runtime")?.ok).toBe(false);
    expect(check(await doctor(m, { registry, pgbouncerUrl: "postgres://admin:local_admin_password@127.0.0.1:5563/pgbouncer" }), "global_pool_mode", "pgbouncer")?.ok).toBe(true);
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
  }
});

integration("doctor reports a transaction pooler in front of management as a failed direct_connection", async () => {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema }, pooledConfig());
  try {
    expect(check(await doctor(m, { registry }), "direct_connection")?.ok).toBe(false);
  } finally {
    await m.close();
    await admin.close();
  }
});

integration("doctor checks a real replica: reachable, in recovery, lag within the threshold", async () => {
  const f = await replicaFixture();
  const m = createTestManagement({ schema: f.schema, replicaMaxLagMs: 60_000 }, createConfig(PRIMARY_URL, [REPLICA_URL]));
  try {
    const report = await doctor(m, { registry });
    for (const name of ["replica_reachable", "replica_in_recovery", "replica_lag"]) expect(check(report, name, "replica#1")?.ok, name).toBe(true);
    expect(JSON.stringify(report)).not.toContain("127.0.0.1");
  } finally {
    await m.close();
    await f.close();
  }
});
