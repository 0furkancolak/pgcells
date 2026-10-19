import { expect } from "bun:test";
import { createDb } from "../../core/runtime";
import { doctor } from "../../core/tools/doctor";
import { usesTransactionPooler } from "../../core/pooler";
import { createTestManagement, directConfig, driver, failure, integration, pooledConfig } from "./helpers";

integration("a direct URL fails the pooler probe and ready(); a transaction pooler passes; 'assumed' skips the probe", async () => {
  const [direct, pooled] = [directConfig().url, pooledConfig().url];
  expect(await usesTransactionPooler(driver, direct, { deadlineMs: 10_000 })).toBe(false);
  expect(await usesTransactionPooler(driver, pooled, { deadlineMs: 10_000 })).toBe(true);

  const refused = createDb(directConfig(), { driver });
  try {
    expect(await failure(refused.ready())).toBe("POOLER_REQUIRED");
  } finally {
    await refused.close();
  }
  const assumed = createDb(directConfig(), { driver, pooler: "assumed" });
  try {
    await assumed.ready();
  } finally {
    await assumed.close();
  }
  const accepted = createDb(pooledConfig(), { driver });
  try {
    await accepted.ready();
    await accepted.ready(); // stored result
  } finally {
    await accepted.close();
  }
});

integration("doctor --pooled-url: a pooled runtime URL passes pooled_runtime, a direct one fails it", async () => {
  const m = createTestManagement();
  try {
    const passing = await doctor(m, { pooledUrl: pooledConfig().url });
    expect(passing.checks.find((check) => check.check === "pooled_runtime")).toMatchObject({ ok: true });
    const failing = await doctor(m, { pooledUrl: directConfig().url });
    expect(failing.checks.find((check) => check.check === "pooled_runtime")).toMatchObject({ ok: false });
    expect(failing.ok).toBe(false);
  } finally {
    await m.close();
  }
});
