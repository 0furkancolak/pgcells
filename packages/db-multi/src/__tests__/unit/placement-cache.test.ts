/** In-process placement cache: a platform read that started before invalidation is not written to the cache (controlled Promise, no timer). */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDatabase } from "../../core/runtime";
import { fakeDriver } from "../fixtures/fake-driver";

const row = (status: string) => ({ tenantId: "abc", databaseId: "db0", kind: "tenant", schemaName: "tenant_abc", status, schemaVersion: 1, placementVersion: 1 });

/** Every platform read is held on a manually resolved Promise. */
function gatedPlatform() {
  const reads: ((rows: unknown[]) => void)[] = [];
  const fake = fakeDriver((text) => (text.includes("platform.placements") ? new Promise<unknown[]>((resolve) => reads.push(resolve)) : []));
  const db = createDatabase(createConfig(["postgres://h/one"]), { driver: fake.driver });
  /** Drains microtasks until `count` reads have reached the driver. */
  async function started(count: number) {
    for (let i = 0; i < 1000 && reads.length < count; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(reads.length).toBe(count);
  }
  return { db, reads, started };
}

test("an in-flight platform read that resolves after invalidation never refills the cache", async () => {
  const { db, reads, started } = gatedPlatform();
  const inFlight = db.placement("abc");
  await started(1);
  db.invalidatePlacement("abc"); // e.g. a move set the placement to migrating
  reads[0]?.([row("active")]);
  expect((await inFlight).status).toBe("active"); // the old read returns only to its own caller

  const next = db.placement("abc");
  expect(next).toBeInstanceOf(Promise); // no stale synchronous hit
  await started(2);
  reads[1]?.([row("migrating")]);
  expect((await next).status).toBe("migrating");

  const fresh = db.placement("abc");
  await started(3);
  reads[2]?.([row("active")]);
  await fresh;
  expect(db.placement("abc")).toMatchObject({ status: "active" }); // a read that started after invalidation enters the cache
  await db.close();
});

test("the invalidation record is bounded and evicting it stays conservative", async () => {
  const { db, reads, started } = gatedPlatform();
  const inFlight = db.placement("abc");
  await started(1);
  db.invalidatePlacement("abc");
  for (let i = 0; i < 20_000; i++) db.invalidatePlacement(`t${i}`); // abc's entry is evicted
  reads[0]?.([row("active")]);
  await inFlight;
  const next = db.placement("abc");
  expect(next).toBeInstanceOf(Promise);
  await started(2);
  reads[1]?.([row("active")]);
  await next;
  expect(db.placement("abc")).toMatchObject({ status: "active" }); // a read that started after the lower bound enters the cache
  await db.close();
});
