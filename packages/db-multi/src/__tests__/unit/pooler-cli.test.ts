import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../core/cli.ts");
const scratch = join(import.meta.dir, "../../..");
const env = {
  DATABASE_URLS: "postgres://admin:s3cret-pw@pg0.internal:5432/app,postgres://admin:s3cret-pw@pg1.internal:5432/app",
  DATABASE_REPLICA_URLS: "db1=postgres://admin:s3cret-pw@pg1-ro.internal:5432/app",
};

async function run(args: string[], directory?: string) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd: directory, env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}
async function withDirectory<T>(work: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(scratch, ".tmp-pooler-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const planArgs = ["pooler", "plan", "--instances", "40", "--pool-max", "5", "--poolers", "2", "--default-pool-size", "20", "--max-client-conn", "1000", "--max-connections", "200"];

test("pooler plan prints the budget and exits 0 when every inequality holds", async () => {
  const result = await run([...planArgs, "--rps", "5000", "--latency-ms", "2"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, clients: { load: 200, limit: 1000 }, flow: { needed: 10, available: 40, ceilingRps: 20000 } });
});

test("pooler plan exits 1 and says what is violated", async () => {
  const result = await run(["pooler", "plan", ...planArgs.slice(2).map((arg) => (arg === "40" ? "400" : arg))]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, violations: [expect.stringContaining("client connections")] });
});

test("pooler plan needs the six sizing flags and needs no database or DATABASE_URLS", async () => {
  const result = await run(["pooler", "plan", "--instances", "3"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: "USAGE", message: expect.stringContaining("poolMax") });
});

test("pooler generate prints deterministic files built from the configured nodes, without any password", async () => {
  const first = await run(["pooler", "generate", "--poolers", "3"]);
  const second = await run(["pooler", "generate", "--poolers", "3"]);
  expect(first.exitCode).toBe(0);
  expect(first.stdout).toBe(second.stdout);
  expect(first.stdout).not.toContain("s3cret-pw");
  const { files } = JSON.parse(first.stdout);
  expect(files["pgbouncer.ini"]).toContain("db1_ro1 = host=pg1-ro.internal port=5432 dbname=app");
  expect(files["pgbouncer.ini"]).toContain("Sized for 3 PgBouncer");
});

test("pooler generate --out writes the files once and refuses to replace a different file; --check finds drift", async () =>
  withDirectory(async (directory) => {
    const target = join(directory, "out");
    const written = await run(["pooler", "generate", "--out", target]);
    expect(written.exitCode).toBe(0);
    expect(JSON.parse(written.stdout).written).toHaveLength(2);
    expect(await readFile(join(target, "pgbouncer.ini"), "utf8")).toContain("[databases]");

    const again = await run(["pooler", "generate", "--out", target]);
    expect(JSON.parse(again.stdout)).toEqual({ written: [] }); // identical files are left alone

    const clean = await run(["pooler", "generate", "--check", target]);
    expect(clean.exitCode).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ ok: true, differences: [] });

    await writeFile(join(target, "pgbouncer.ini"), (await readFile(join(target, "pgbouncer.ini"), "utf8")).replace("max_client_conn = 2000", "max_client_conn = 99"));
    const drift = await run(["pooler", "generate", "--check", target]);
    expect(drift.exitCode).toBe(1);
    expect(JSON.parse(drift.stdout).differences).toEqual([expect.objectContaining({ expected: "max_client_conn = 2000", actual: "max_client_conn = 99" })]);

    const refused = await run(["pooler", "generate", "--out", target]);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ error: "USAGE", message: expect.stringContaining("already exists") });
  }));

test("pooler generate takes either --out or --check", async () => {
  const result = await run(["pooler", "generate", "--out", "a", "--check", "b"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr).error).toBe("USAGE");
});
