import { expect } from "bun:test";
import { createDbScope } from "../../middleware";
import { createUser, failure, integration, listUsers, uniqueEmail } from "./helpers";
import { caughtUp, DEAD_REPLICA_URL, pauseReplay, REPLICA_URL, replicaFixture, resumeReplay } from "./replica-fixture";

const names = (rows: unknown[]) => (rows as { name: string }[]).map((row) => row.name);

integration("reads come from the replica: a paused replica stays stale while the primary has the row", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime([REPLICA_URL], { replicaMaxLagMs: 3_600_000 });
    await pauseReplay(f.replica);
    await db.withTenant(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "fresh", uniqueEmail()]));
    expect(names(await db.withTenantRead(f.tenantId, (t) => t.query(listUsers, [50, 0])))).not.toContain("fresh"); // replica is stale
    expect(names(await db.withTenant(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toContain("fresh"); // primary
    await resumeReplay(f.replica);
    await caughtUp(f.primary, f.replica);
    expect(names(await db.withTenantRead(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toContain("fresh");
  } finally {
    await f.close();
  }
});

integration("over the lag threshold the read falls back to the primary, or fails under the error policy", async () => {
  const f = await replicaFixture();
  try {
    const primaryPolicy = f.runtime([REPLICA_URL], { replicaMaxLagMs: 200 });
    const errorPolicy = f.runtime([REPLICA_URL], { replicaMaxLagMs: 200, replicaOnUnavailable: "error" });
    await pauseReplay(f.replica);
    await primaryPolicy.withTenant(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "lagged", uniqueEmail()]));
    await Bun.sleep(500);
    expect(names(await primaryPolicy.withTenantRead(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toContain("lagged");
    expect(await failure(errorPolicy.withTenantRead(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toBe("REPLICA_UNAVAILABLE");
  } finally {
    await f.close();
  }
});

integration("an unreachable replica falls back or fails by policy, and ready() does not wait for it", async () => {
  const f = await replicaFixture();
  try {
    const fallback = f.runtime([DEAD_REPLICA_URL]);
    const strict = f.runtime([DEAD_REPLICA_URL], { replicaOnUnavailable: "error" });
    await fallback.ready();
    expect(Array.isArray(await fallback.withTenantRead(f.tenantId, (t) => t.query(listUsers, [10, 0])))).toBe(true);
    expect(await failure(strict.withTenantRead(f.tenantId, (t) => t.query(listUsers, [10, 0])))).toBe("REPLICA_UNAVAILABLE");
  } finally {
    await f.close();
  }
});

integration("a non-read-only query in a read context is rejected", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime();
    expect(await failure(db.withTenantRead(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "x", uniqueEmail()])))).toBe("QUERY_NOT_READ_ONLY");
  } finally {
    await f.close();
  }
});

integration("RequestDb: after a write in the same request the read sees it even though the replica is stale", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime([REPLICA_URL], { replicaMaxLagMs: 3_600_000 });
    const request = createDbScope(db, f.tenantId);
    await pauseReplay(f.replica);
    await request.tenant.query(createUser, [crypto.randomUUID(), "mine", uniqueEmail()]);
    expect(names(await request.tenantRead.query(listUsers, [50, 0]))).toContain("mine");
    const other = createDbScope(db, f.tenantId);
    expect(names(await other.tenantRead.query(listUsers, [50, 0]))).not.toContain("mine"); // another request sees the replica
  } finally {
    await f.close();
  }
});

integration("db.replicas() reports a healthy replica with zero lag and no URL", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime();
    const [row] = await db.replicas();
    expect(row).toMatchObject({ databaseId: "db0", replica: 1, up: true, inRecovery: true, usable: true });
    expect(JSON.stringify(row)).not.toContain("127.0.0.1");
  } finally {
    await f.close();
  }
});
