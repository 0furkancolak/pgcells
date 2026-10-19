import { expect } from "bun:test";
import { verify } from "../provider/verify";
import { directConfig, driver, integration, pooledConfig, raw } from "./helpers";

const STORED = "SELECT s AS stored FROM pg_catalog.pg_db_role_setting r, pg_catalog.unnest(r.setconfig) AS s WHERE r.setrole=0 AND r.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND s LIKE 'statement_timeout=%'";

integration("verify:provider against local PgBouncer: probes, ALTER DATABASE round trip restores the stored value, deadline drops the backend", async () => {
  const management = directConfig().url;
  const runtime = pooledConfig().url;
  const db = raw();
  const before = await db.query(STORED);
  try {
    const report = await verify(driver, "test", management, runtime);
    const first = report.database;
    expect(first?.probe.runtime).toEqual({ transactionPooler: true });
    expect(first?.probe.management).toEqual({ transactionPooler: false });
    expect(first?.alterDatabase).toMatchObject({ allowed: true, newSession: true });
    expect(first?.alterDatabase.restoreSql).toBeUndefined();
    expect(first?.privileges).toMatchObject({ createSchema: true });
    expect(first?.deadline).toMatchObject({ observedRunning: true });
    expect(first?.deadline.serverStoppedAfterMs).not.toBeNull();
    expect(await db.query(STORED)).toEqual(before);
    const text = JSON.stringify(report);
    for (const url of [management, runtime]) expect(text).not.toContain(new URL(url).password);
  } finally {
    await db.close();
  }
});
