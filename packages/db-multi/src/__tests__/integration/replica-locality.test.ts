/** A regional application reads only from replicas in its own region; the directory says where a replica lives. */
import { expect } from "bun:test";
import { setDatabase } from "../../core/tools/tenancy";
import { replicaReport, setReplicaRegion } from "../../core/tools/replicas";
import { failure, integration, listUsers } from "./helpers";
import { REPLICA_URL, replicaFixture } from "./replica-fixture";

integration("a replica in another region is not used by a regional application; one in its own region (or the node's) is", async () => {
  const f = await replicaFixture();
  try {
    await setDatabase(f.management, "db0", { region: "eu-west" });
    const read = (db: ReturnType<typeof f.runtime>) => db.withTenantRead(f.tenantId, (t) => t.query(listUsers, [5, 0]));
    const strict = f.runtime([REPLICA_URL], { region: "eu-west", replicaOnUnavailable: "error" });
    // No row: the replica lives in its node's region, so it serves the application.
    expect(Array.isArray(await read(strict))).toBe(true);
    expect((await replicaReport(f.management)).replicas[0]).toMatchObject({ region: "eu-west", usable: true });

    // The directory says the replica is in us-east: eu-west application must not read from it (the error policy shows that nothing else served the read).
    await setReplicaRegion(f.management, "db0#1", "us-east");
    const fresh = f.runtime([REPLICA_URL], { region: "eu-west", replicaOnUnavailable: "error" });
    expect(await failure(read(fresh))).toBe("REPLICA_UNAVAILABLE");
    expect((await replicaReport(f.management)).replicas[0]).toMatchObject({ region: "us-east" });
    // Under the default policy the same read falls back to the primary, and an application in us-east or with no region still uses the replica.
    expect(Array.isArray(await read(f.runtime([REPLICA_URL], { region: "eu-west" })))).toBe(true);
    const farOk = f.runtime([REPLICA_URL], { region: "us-east", replicaOnUnavailable: "error" });
    // us-east application: the tenant's node is in eu-west, so the tenant itself is refused before any read.
    expect(await failure(read(farOk))).toBe("WRONG_REGION");
    expect(Array.isArray(await read(f.runtime([REPLICA_URL], { replicaOnUnavailable: "error" })))).toBe(true);

    await setReplicaRegion(f.management, "db0#1", "none");
  } finally {
    await setDatabase(f.management, "db0", { region: "none" }).catch(() => {});
    await f.close();
  }
});
