import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../core/cli.ts");
const scratch = join(import.meta.dir, "../../..");

async function runCli(args: string[], env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(scratch, ".tmp-cli-"));
  try {
    const subprocess = Bun.spawn([process.execPath, cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test.each([
  { args: [] },
  { args: ["help"] },
  { args: ["--help"] },
  { args: ["-h"] },
  { args: ["migrate", "--help"] },
])("help works without configuration: %p", async ({ args }) => {
  const result = await runCli(args);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Usage:");
  expect(result.stdout).toContain("DATABASE_URLS");
  expect(result.stdout).toContain("README");
});

test.each([
  { args: ["wat"] },
  { args: ["wat", "--help"] },
  { args: ["wat", "-h"] },
])(
  "unknown commands fail with usage before configuration is loaded: %p",
  async ({ args }) => {
    const result = await runCli(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: wat");
    expect(result.stderr).toContain("Usage:");
    expect(result.stderr).not.toContain('"error"');
  },
);

test("invalid configuration is redacted and does not print a stack or secret", async () => {
  const secret = "super-secret-password";
  const url = `postgres://admin:${secret}@localhost/app`;
  const result = await runCli(["status", "acme"], {
    DATABASE_URLS: `${url},${url}`,
  });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: "INVALID_CONFIG" });
  expect(result.stderr).not.toContain(secret);
  expect(result.stderr).not.toContain(" at ");
});

test("an unknown driver is a usage error before configuration is loaded", async () => {
  const result = await runCli(["status", "acme", "--driver=mysql"]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: "USAGE" });
});

test("tools commands share the CLI entry; usage and option errors happen before configuration is loaded", async () => {
  const help = await runCli(["doctor", "--help"]);
  expect(help.exitCode).toBe(0);
  for (const text of ["rollback-move <moveId>", "--pgbouncer-url", "--pooled-urls", "--writers-drained"]) expect(help.stdout).toContain(text);
  for (const args of [
    ["move-status"],
    ["doctor", "--foo"],
    ["doctor", "--pgbouncer-url=postgres://admin:pw@h:5432/pgbouncer"],
    ["doctor", "--pooled-urls=postgres://admin:pw@h:5432/app"],
    ["move", "acme", "db1", "--writers-drainde"],
    ["move-status", "--writers-drained", "id"],
  ]) {
    const result = await runCli(args);
    expect(result.exitCode, args.join(" ")).toBe(1);
    expect(JSON.parse(result.stderr), args.join(" ")).toMatchObject({ error: "USAGE" });
  }
});

test("offline authoring commands run without configuration; DB commands validate options first", async () => {
  const help = await runCli(["--help"]);
  for (const text of ["migrate-down <tenant>", "migration create <name>", "migration baseline <tenant> <migrationId>", "pull <schema>"])
    expect(help.stdout).toContain(text);
  expect(help.stdout).not.toContain("drizzle import");
  const created = await runCli(["migration", "create", "add_email", "--scope", "platform"]);
  expect(created.exitCode).toBe(0);
  expect(JSON.parse(created.stdout).path).toMatch(/^src\/migrations\/platform\/\d{14}_add_email\.sql$/);
  const seed = await runCli(["seed", "create", "demo_users", "--profile", "demo", "--ts"]);
  expect(seed.exitCode).toBe(0);
  expect(JSON.parse(seed.stdout).path).toMatch(/^src\/seeds\/demo\/\d{14}_demo_users\.ts$/);
  for (const text of [
    "provision <tenant> [dbN] [--size 1-100] [--demo]",
    "seed <tenant>",
    "seed create <name>",
    "demo-reset <tenant>",
    "seed-all",
    "reserve <ids>",
    "database set <dbN>",
    "backup <dir>",
    "backup prune <dir> --keep N",
    "export <tenant> <dir>",
    "restore <tenant> <dir>",
    "users import <tenant>",
    "dump split <backup.sql> <dir>",
    "dump scaffold <dir>",
    "app-migrate <tenant> <dir|backup.sql>",
  ])
    expect(help.stdout).toContain(text);
  for (const args of [
    ["seed", "create", "x"],
    ["seed", "acme", "--demo"],
    ["provision", "acme", "db0", "db1"],
    ["provision", "--demo"],
    ["migration", "create", "Bad-Name"],
    ["migration", "create", "x", "--scope"],
    ["migration", "baseline", "acme"],
    ["migrate-down", "acme", "--scope", "tenant"],
    ["migrate-down", "acme", "--steps", "0"],
    ["provision", "acme", "db0", "--dry-run"],
  ]) {
    const result = await runCli(args);
    expect(result.exitCode, args.join(" ")).toBe(1);
    expect(JSON.parse(result.stderr).error, args.join(" ")).toMatch(/USAGE|INVALID_CONFIG/);
  }
});

/** `ps` çıktısındaki argümanlar: makinedeki her kullanıcı okuyabilir. */
async function processArguments(pid: number) {
  const ps = Bun.spawn(["ps", "-ww", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const [text] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  return text;
}

/** Akışı `needle` görünene kadar okur; `rest()` kalanını toplar. */
async function readUntil(stream: ReadableStream<Uint8Array>, needle: string) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const rest = async () => {
    let more = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return more;
      more += decoder.decode(value, { stream: true });
    }
  };
  return { text, rest };
}

test("the PgBouncer admin URL is read from hidden input and never appears in the command's argv", async () => {
  const cwd = await mkdtemp(join(scratch, ".tmp-cli-"));
  try {
    const secret = "postgres://admin:hunter2@127.0.0.1:1/notpgbouncer";
    const child = Bun.spawn([process.execPath, cli, "doctor", "--pgbouncer-url"], {
      cwd,
      env: { PATH: process.env.PATH ?? "", DATABASE_URLS: "postgres://admin:hunter2@127.0.0.1:1/app,postgres://admin:hunter2@127.0.0.1:2/app" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const question = await readUntil(child.stderr as ReadableStream<Uint8Array>, "PgBouncer");
    const argv = await processArguments(child.pid);
    expect(argv).toContain("--pgbouncer-url");
    expect(argv).not.toContain("postgres://");
    child.stdin.write(`${secret}\n`);
    await child.stdin.flush();
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), question.rest()]);
    expect(exitCode).toBe(1);
    // Girilen URL gerçekten kullanılır: `/notpgbouncer` yolu doctor'ın INVALID_CONFIG denetimini düşürür.
    expect(JSON.parse(stdout).checks).toContainEqual({ target: "pgbouncer", check: "inspection", ok: false, detail: expect.stringContaining("INVALID_CONFIG") });
    expect(`${question.text}${stderr}${stdout}`).not.toContain("hunter2");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the runtime URLs of doctor --pooled-urls are read from hidden input; a wrong count is INVALID_CONFIG and nothing is echoed", async () => {
  const cwd = await mkdtemp(join(scratch, ".tmp-cli-"));
  try {
    const secret = "postgres://admin:hunter2@127.0.0.1:1/app"; // DATABASE_URLS iki girdi, burada bir tane
    const child = Bun.spawn([process.execPath, cli, "doctor", "--pooled-urls"], {
      cwd,
      env: { PATH: process.env.PATH ?? "", DATABASE_URLS: "postgres://admin:hunter2@127.0.0.1:1/app,postgres://admin:hunter2@127.0.0.1:2/app" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const question = await readUntil(child.stderr as ReadableStream<Uint8Array>, "Runtime");
    const argv = await processArguments(child.pid);
    expect(argv).toContain("--pooled-urls");
    expect(argv).not.toContain("postgres://");
    child.stdin.write(`${secret}\n`);
    await child.stdin.flush();
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), question.rest()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("INVALID_CONFIG");
    expect(`${question.text}${stderr}${stdout}`).not.toContain("hunter2");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("URL options take no value from argv: the old --from-url/--pgbouncer-url forms are refused", async () => {
  const url = "postgres://admin:hunter2@127.0.0.1:1/app";
  for (const args of [
    ["doctor", `--pgbouncer-url=${url}`],
    ["doctor", "--pgbouncer-url", url],
    ["doctor", `--pooled-urls=${url}`],
    ["doctor", "--pooled-urls", url],
    ["users", "import", "acme", "--source", "eski", "--from-url", url, "--query", "SELECT 1"],
    ["users", "import", "acme", "--source", "eski", `--from-url=${url}`, "--query", "SELECT 1"],
  ]) {
    const result = await runCli(args);
    expect(result.exitCode, args.join(" ")).toBe(1);
    expect(JSON.parse(result.stderr), args.join(" ")).toMatchObject({ error: "USAGE" });
    expect(result.stderr, args.join(" ")).not.toContain("hunter2");
  }
});

test("a signal while dump fetch asks for the URL exits with USAGE and leaves no half file behind", async () => {
  const cwd = await mkdtemp(join(scratch, ".tmp-cli-"));
  try {
    const child = Bun.spawn([process.execPath, cli, "dump", "fetch", "staging.sql.gz"], {
      cwd,
      env: { PATH: process.env.PATH ?? "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const question = await readUntil(child.stderr as ReadableStream<Uint8Array>, "URL");
    child.kill("SIGTERM");
    const [exitCode, stderr] = await Promise.all([child.exited, question.rest()]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.slice(stderr.indexOf("{")))).toMatchObject({ error: "USAGE" });
    expect(await readdir(cwd)).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

const DB = { DATABASE_URLS: "postgres://owner:pw@127.0.0.1:1/app" };
const failureOf = (stderr: string) => JSON.parse(stderr.trim().split("\n").at(-1) ?? "") as { error: string; message: string };

test.each([
  { args: ["neon", "export-tenant", "acme", "out"], message: "--at" },
  { args: ["neon", "export-tenant", "acme", "out", "--at", "tomorrow"], message: "RFC 3339" },
  { args: ["neon", "export-tenant", "acme", "out", "--at", "2999-01-01T00:00:00Z"], message: "past" },
  { args: ["migrate-all", "--safety-point", "mysql"], message: "neon or supabase" },
  { args: ["migrate-all", "--org", "org-1"], message: "--org" },
  { args: ["migrate-all", "--org", "org-1", "--safety-point", "supabase"], message: "--org" },
])("provider options are validated before anything is contacted or asked: %p", async ({ args, message }) => {
  const result = await runCli(args, DB);
  expect(result.exitCode).toBe(1);
  const failure = failureOf(result.stderr);
  expect(failure.error).toBe("USAGE");
  expect(failure.message).toContain(message);
});

test("neon commands ask for the API key with hidden input and stop when nothing is entered", async () => {
  const result = await runCli(["neon", "stage-copy"], DB);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Neon API key");
  expect(failureOf(result.stderr).error).toBe("USAGE");
});
