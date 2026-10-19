/** Read your own write across requests: a write token (primary WAL position) makes a later read wait for the replica, or fall back to the primary. */
import { expect } from "bun:test";
import { createDbScope } from "../../middleware";
import { createUser, integration, listUsers, uniqueEmail } from "./helpers";
import { caughtUp, pauseReplay, REPLICA_URL, replicaFixture, resumeReplay } from "./replica-fixture";

const names = (rows: unknown[]) => (rows as { name: string }[]).map((row) => row.name);

integration("a read with a write token sees the write: it waits for a lagging replica, falls back to the primary after causalWaitMs, and uses the replica once it caught up", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime([REPLICA_URL], { replicaMaxLagMs: 3_600_000, causalWaitMs: 200 });
    const first = createDbScope(db, f.tenantId);
    expect(await first.lastWriteToken()).toBeUndefined(); // nothing written yet

    await pauseReplay(f.replica);
    await first.tenant.query(createUser, [crypto.randomUUID(), "fresh", uniqueEmail()]);
    const token = await first.lastWriteToken();
    expect(token).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);

    // A later request (a new scope). Without a token the lagging replica answers and does not have the row.
    const later = () => createDbScope(db, f.tenantId);
    expect(names(await later().tenantRead.query(listUsers, [50, 0]))).not.toContain("fresh");
    // With the token the read waits for the replica, gives up after causalWaitMs and the primary answers.
    const start = performance.now();
    expect(names(await later().tenantRead.query(listUsers, [50, 0], { after: token as string }))).toContain("fresh");
    const waited = performance.now() - start;
    expect(waited).toBeGreaterThanOrEqual(180);
    expect(waited).toBeLessThan(2000);
    expect(db.stats().databases["db0#1"]?.acquireP50Ms ?? null).not.toBeNull(); // the replica was asked (the replay check)

    // Once the replica has replayed the write the token read is served at once.
    await resumeReplay(f.replica);
    await caughtUp(f.primary, f.replica);
    const quick = performance.now();
    expect(names(await later().tenantRead.query(listUsers, [50, 0], { after: token as string }))).toContain("fresh");
    expect(performance.now() - quick).toBeLessThan(150);
    // A malformed token is refused.
    await expect(later().tenantRead.query(listUsers, [50, 0], { after: "not-a-token" })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  } finally {
    await f.close();
  }
});
