import { expect } from "bun:test";
import { createManagement } from "../../management";
import { doctor } from "../../core/tools/doctor";
import { usesTransactionPooler } from "../../core/tenants/pooler";
import { createDatabase } from "../../index";
import { directConfig, driver, failure, integration, pooledConfig } from "./helpers";

const urls = (config: ReturnType<typeof directConfig>) => config.nodes.map((node) => node.url);

integration("a direct URL fails the pooler probe and ready(); a transaction pooler passes; 'assumed' skips the probe", async () => {
  const [direct] = urls(directConfig());
  const [pooled] = urls(pooledConfig());
  expect(await usesTransactionPooler(driver, direct as string, { deadlineMs: 10_000 })).toBe(false);
  expect(await usesTransactionPooler(driver, pooled as string, { deadlineMs: 10_000 })).toBe(true);

  const refused = createDatabase(directConfig(), { driver });
  try {
    expect(await failure(refused.ready())).toBe("POOLER_REQUIRED");
  } finally {
    await refused.close();
  }
  const assumed = createDatabase(directConfig(), { driver, pooler: "assumed" });
  try {
    await assumed.ready();
  } finally {
    await assumed.close();
  }
  const accepted = createDatabase(pooledConfig(), { driver });
  try {
    await accepted.ready();
    await accepted.ready(); // saklanan sonuç
  } finally {
    await accepted.close();
  }
});

integration("doctor --pooled-urls: pooled runtime URLs pass pooled_runtime, direct ones fail it", async () => {
  const management = createManagement(directConfig(), { driver });
  try {
    const passing = await doctor(management, { pooledUrls: urls(pooledConfig()).join(",") });
    expect(passing.checks.filter((check) => check.check === "pooled_runtime").every((check) => check.ok)).toBe(true);
    const failing = await doctor(management, { pooledUrls: urls(directConfig()).join(",") });
    expect(failing.checks.filter((check) => check.check === "pooled_runtime").every((check) => !check.ok)).toBe(true);
    expect(failing.ok).toBe(false);
  } finally {
    await management.close();
  }
});
