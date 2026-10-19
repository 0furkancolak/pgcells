import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConfig } from "../../core/config";
import { exportSchema } from "../../core/tools/backup";
import { openReplicaSource } from "../../core/tools/replica-source";
import { createTestManagement, failure, integration, pooledConfig } from "./helpers";
import { DEAD_REPLICA_URL, PRIMARY_URL, REPLICA_URL, replicaFixture } from "./replica-fixture";

const management = (schema: string) => createTestManagement({ schema }, createConfig(PRIMARY_URL));

integration("openReplicaSource accepts one direct replica and rejects a pooler, the primary, an unreachable URL and a list", async () => {
  const f = await replicaFixture();
  const m = management(f.schema);
  try {
    const source = await openReplicaSource(m, REPLICA_URL);
    try {
      expect(await source.catchUp()).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    } finally {
      await source.close();
    }
    expect(await failure(openReplicaSource(m, pooledConfig().url))).toBe("DIRECT_CONNECTION_REQUIRED");
    expect(await failure(openReplicaSource(m, PRIMARY_URL))).toBe("INVALID_CONFIG");
    expect(await failure(openReplicaSource(m, `${REPLICA_URL},${DEAD_REPLICA_URL}`))).toBe("INVALID_CONFIG");
    expect(await failure(openReplicaSource(m, DEAD_REPLICA_URL))).toBeDefined();
  } finally {
    await m.close();
    await f.close();
  }
});

integration("export --from-replica reads from the replica and records its position", async () => {
  const f = await replicaFixture();
  const m = management(f.schema);
  const dir = await mkdtemp(join(import.meta.dir, "../../../.tmp-replica-"));
  try {
    await f.primary.exec(`INSERT INTO "${f.schema}".notes VALUES (1)`);
    const exported = await exportSchema(m, join(dir, "x"), { replicaUrls: REPLICA_URL });
    expect(exported.rows).toBe(1);
    const meta = (await Bun.file(join(dir, "x", "backup.json")).json()) as { source?: string; replayLsn?: string; schema: string };
    expect(meta).toMatchObject({ source: "replica", schema: f.schema });
    expect(meta.replayLsn).toMatch(/\//);
  } finally {
    await m.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
