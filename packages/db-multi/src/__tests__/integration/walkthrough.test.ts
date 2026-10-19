/** docs/guides/walkthrough.md is executable: every `ts walkthrough` block is type-checked and run, in order, against real databases (db0, db1 and a temporary third one).
 * If the guide and the package drift apart, this test fails. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { directConfig, enabled, raw, removeTenants } from "./helpers";
import { createManagement } from "../../management";
import { bunDriver } from "../../core/drivers/bun";
import { setDatabase } from "../../core/tools/tenancy";

// The guide drives the Bun driver itself; one pass per CI run is enough.
const active = enabled && (process.env.DB_DRIVER ?? "bun") === "bun";
const integration = active ? test : test.skip;
const packageRoot = join(import.meta.dir, "../../..");
const guide = join(packageRoot, "../../docs/guides/walkthrough.md");
const thirdDatabase = `ledgerly_us_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
let directory = "";
let urls: string[] = [];

/** The `ts walkthrough` fenced blocks of the guide, in order. */
export const blocks = (markdown: string) => [...markdown.matchAll(/^```ts walkthrough\n([\s\S]*?)^```$/gm)].map((match) => match[1] ?? "");

async function run(file: string, timeoutMs: number) {
  const child = Bun.spawn([process.execPath, file], { cwd: directory, env: { ...process.env, DATABASE_URLS: urls.join(",") }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  if (!active) return;
  const admin = raw(1);
  await admin.pool.exec(`CREATE DATABASE ${thirdDatabase}`);
  await admin.close();
  const nodes = directConfig().nodes;
  const second = new URL(nodes[1]?.url as string);
  second.pathname = `/${thirdDatabase}`;
  urls = [...nodes.map((node) => node.url), second.href];
  directory = await mkdtemp(join(packageRoot, ".tmp-walkthrough-"));
});

afterAll(async () => {
  if (!active) return;
  const m = createManagement(directConfig(), { driver: bunDriver, placementCacheWaitMs: 1, unsafePlacementCacheWait: true });
  try {
    await removeTenants(m, "ledgerly");
    for (const id of ["db0", "db1"]) await setDatabase(m, id, { region: "none", zone: "none" }).catch(() => {});
    await m.pools.platform.query("DELETE FROM platform.nodes WHERE database_id='db2'");
  } finally {
    await m.close();
    const admin = raw(1);
    await admin.pool.exec(`DROP DATABASE IF EXISTS ${thirdDatabase} WITH (FORCE)`).catch(() => {});
    await admin.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const expected = [
  ["db0 eu-west eu", "db1 eu-central eu", "db2 us-east us"],
  ["ledgerly-acme lives on db0 in eu-west bound to zone eu"],
  ["acme has 1 user: Ada"],
  ["ledgerly-globex lives on db2 in us-east"],
  ["WRONG_REGION"],
  ["RESIDENCY_VIOLATION"],
  ["without the flag: CROSS_REGION_MOVE", "move completed - acme now on db1 in eu-central still bound to zone eu"],
  ["connection budget ok: true server connections 64 of 177", "100k statements/s needs 12 instances and 2 cells with 4 replicas each"],
];

integration("the walkthrough guide's code type-checks and runs, step by step, and prints what the guide says", async () => {
  const steps = blocks(await readFile(guide, "utf8"));
  expect(steps.length).toBe(expected.length);
  const files: string[] = [];
  for (const [index, source] of steps.entries()) {
    const file = join(directory, `step-${index + 1}.ts`);
    await writeFile(file, source);
    files.push(file);
  }
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ extends: "../tsconfig.json", include: ["*.ts", "../src/core/migrations/sql.d.ts"] }));
  const tsc = Bun.spawn([join(packageRoot, "node_modules/.bin/tsc"), "-p", directory], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" });
  const [tscCode, tscOut] = await Promise.all([tsc.exited, new Response(tsc.stdout).text()]);
  expect(tscOut, "the guide's code must type-check").toBe("");
  expect(tscCode).toBe(0);

  for (const [index, file] of files.entries()) {
    const result = await run(file, 120_000);
    expect(result.code, `step ${index + 1} failed:\n${result.stderr}\n${result.stdout}`).toBe(0);
    for (const line of expected[index] ?? []) expect(result.stdout, `step ${index + 1} output`).toContain(line);
  }
}, 600_000);
