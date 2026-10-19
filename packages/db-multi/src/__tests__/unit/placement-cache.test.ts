/** Süreç içi placement önbelleği: geçersiz kılmadan önce başlamış platform okuması önbelleğe yazılmaz (kontrollü Promise, zamanlayıcı yok). */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDatabase } from "../../core/runtime";
import { fakeDriver } from "../fixtures/fake-driver";

const row = (status: string) => ({ tenantId: "abc", databaseId: "db0", kind: "tenant", schemaName: "tenant_abc", status, schemaVersion: 1, placementVersion: 1 });

/** Her platform okuması elle çözülen bir Promise'e takılır. */
function gatedPlatform() {
  const reads: ((rows: unknown[]) => void)[] = [];
  const fake = fakeDriver((text) => (text.includes("platform.placements") ? new Promise<unknown[]>((resolve) => reads.push(resolve)) : []));
  const db = createDatabase(createConfig(["postgres://h/one"]), { driver: fake.driver });
  /** `count` okuma sürücüye ulaşana kadar mikro görevleri boşaltır. */
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
  db.invalidatePlacement("abc"); // ör. taşıma placement'ı migrating yaptı
  reads[0]?.([row("active")]);
  expect((await inFlight).status).toBe("active"); // eski okuma yalnızca kendi çağıranına döner

  const next = db.placement("abc");
  expect(next).toBeInstanceOf(Promise); // bayat senkron isabet yok
  await started(2);
  reads[1]?.([row("migrating")]);
  expect((await next).status).toBe("migrating");

  const fresh = db.placement("abc");
  await started(3);
  reads[2]?.([row("active")]);
  await fresh;
  expect(db.placement("abc")).toMatchObject({ status: "active" }); // geçersiz kılmadan sonra başlayan okuma önbelleğe girer
  await db.close();
});

test("the invalidation record is bounded and evicting it stays conservative", async () => {
  const { db, reads, started } = gatedPlatform();
  const inFlight = db.placement("abc");
  await started(1);
  db.invalidatePlacement("abc");
  for (let i = 0; i < 20_000; i++) db.invalidatePlacement(`t${i}`); // abc'nin kaydı atılır
  reads[0]?.([row("active")]);
  await inFlight;
  const next = db.placement("abc");
  expect(next).toBeInstanceOf(Promise);
  await started(2);
  reads[1]?.([row("active")]);
  await next;
  expect(db.placement("abc")).toMatchObject({ status: "active" }); // alt sınırdan sonra başlayan okuma önbelleğe girer
  await db.close();
});
