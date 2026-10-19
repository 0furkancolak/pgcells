/** The directory (db0) can be read from a replica: an `active` placement comes from there, everything else is verified on the primary. */
import { expect } from "bun:test";
import { integration } from "./helpers";
import { caughtUp, DEAD_REPLICA_URL, pauseReplay, REPLICA_URL, replicaFixture, resumeReplay } from "./replica-fixture";

integration("placement reads are served by the db0 replica: a paused replica still shows the old status until it catches up", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime([REPLICA_URL], { replicaMaxLagMs: 3_600_000 });
    await pauseReplay(f.replica);
    const placement = await f.management.platform.get(f.tenantId);
    await f.management.platform.setStatus(placement, "maintenance"); // the primary now says `maintenance`; the paused replica still says `active`
    expect((await db.placement(f.tenantId)).status).toBe("active");
    await resumeReplay(f.replica);
    await caughtUp(f.primary, f.replica);
    db.invalidatePlacement(f.tenantId);
    // The replica now says `maintenance`, which is not `active`, so the primary answers it as well.
    expect((await db.placement(f.tenantId)).status).toBe("maintenance");
  } finally {
    await f.close();
  }
});

integration("an unreachable db0 replica never breaks placement reads, even under the error policy", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime([DEAD_REPLICA_URL], { replicaOnUnavailable: "error" });
    expect(await db.placement(f.tenantId)).toMatchObject({ tenantId: f.tenantId, status: "active" });
  } finally {
    await f.close();
  }
});
