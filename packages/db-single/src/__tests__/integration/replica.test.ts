import { expect } from "bun:test";
import { prepareQuery } from "../../core/sql/compiler";
import { createDbScope } from "../../middleware";
import { failure, integration } from "./helpers";
import { caughtUp, DEAD_REPLICA_URL, pauseReplay, REPLICA_URL, replicaFixture, resumeReplay } from "./replica-fixture";

const count = prepareQuery("SELECT count(*)::integer AS n FROM notes");
const insert = prepareQuery("INSERT INTO notes (id) VALUES ($1::integer)");

integration("read.query is served by the replica; the request scope sees its own write on the primary", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime();
    await pauseReplay(f.replica);
    await db.query(insert, [1]);
    expect(await db.read.query(count)).toEqual([{ n: 0 }]); // replay duraklatıldı: replica eski veriyi gösterir
    const scope = createDbScope(db);
    await scope.query(insert, [2]);
    expect(await scope.read.query(count)).toEqual([{ n: 2 }]); // aynı istekte yazıdan sonra okuma primary'de
    await resumeReplay(f.replica);
    await caughtUp(f.primary, f.replica);
    expect(await db.read.query(count)).toEqual([{ n: 2 }]);
  } finally {
    await f.close();
  }
});

integration("an unreachable replica falls back to the primary, or fails under the error policy", async () => {
  const f = await replicaFixture();
  try {
    const fallback = f.runtime([DEAD_REPLICA_URL]);
    expect(await fallback.read.query(count)).toEqual([{ n: 0 }]);
    const strict = f.runtime([DEAD_REPLICA_URL], { replicaOnUnavailable: "error" });
    expect(await failure(strict.read.query(count))).toBe("REPLICA_UNAVAILABLE");
  } finally {
    await f.close();
  }
});

integration("replicas() reports health and lag without exposing URLs", async () => {
  const f = await replicaFixture();
  try {
    const report = await f.runtime([REPLICA_URL, DEAD_REPLICA_URL]).replicas();
    expect(report.map((row) => [row.replica, row.usable])).toEqual([[1, true], [2, false]]);
    expect(typeof report[0]?.lagMs).toBe("number");
    expect(JSON.stringify(report)).not.toContain("127.0.0.1");
    expect(JSON.stringify(report)).not.toContain("local_admin_password");
  } finally {
    await f.close();
  }
});
