import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { openReplicaSource } from "../../core/tools/replica-source";
import { fakeDriver } from "../fixtures/fake-driver";

test("a failing pooler probe surfaces only the driver code, never a message carrying host or password", async () => {
  const fake = fakeDriver(() => {
    throw Object.assign(new Error("password authentication failed for user app at replica.internal.example"), { code: "28P01" });
  });
  const m = createManagement(createConfig("postgres://admin@127.0.0.1:7901/app"), { driver: fake.driver });
  const error = await openReplicaSource(m, "postgres://app:secret@replica.internal.example/app").then(
    () => undefined,
    (caught: Error) => caught,
  );
  expect(error).toMatchObject({ code: "28P01", message: "Database operation failed (28P01)" });
  await m.close();
});

test("--from-replica given the primary URL or a list says what it takes instead of naming DATABASE_REPLICA_URLS", async () => {
  const m = createManagement(createConfig("postgres://admin@127.0.0.1:7901/app"), { driver: fakeDriver().driver });
  for (const entry of ["postgres://admin@127.0.0.1:7901/app", "postgres://r1/app,postgres://r2/app", "postgres://r1/app, postgres://admin@127.0.0.1:7901/app"])
    await expect(openReplicaSource(m, entry)).rejects.toMatchObject({ code: "INVALID_CONFIG", message: "--from-replica takes exactly one direct replica URL, not the primary's" });
  // Bozuk ya da schema yönlendiren URL kendi doğrulama hatasıyla çıkar (o mesaj yutulmaz).
  for (const entry of ["mysql://r1/app", "postgres://r1/app?options=-c%20x"])
    await expect(openReplicaSource(m, entry)).rejects.toMatchObject({ code: "INVALID_CONFIG", message: expect.not.stringContaining("--from-replica") });
  await m.close();
});
