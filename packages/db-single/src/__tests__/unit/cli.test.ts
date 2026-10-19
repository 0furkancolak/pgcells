import { afterEach, expect, test } from "bun:test";
import { drivers, main, parseOptions, splitArguments } from "../../core/cli";
import { fakeDriver } from "../fixtures/fake-driver";

afterEach(() => {
  process.exitCode = 0;
});

/** `console.log`/`console.error` çıktısını yakalar. */
async function capture(work: () => Promise<unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (message?: unknown) => void out.push(String(message));
  console.error = (message?: unknown) => void err.push(String(message));
  try {
    await work();
  } finally {
    [console.log, console.error] = [log, error];
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("parseOptions takes --option value and --option=value, switches and repeatable lists", () => {
  expect(parseOptions(["--schema", "app_x", "--dry-run"], ["--schema", "--dry-run"])).toEqual({ schema: "app_x", dryRun: true });
  expect(parseOptions(["--steps=3"], ["--steps"])).toEqual({ steps: 3 });
  expect(parseOptions(["--exclude", "a,b", "--exclude", "c"], ["--exclude"])).toEqual({ exclude: ["a", "b", "c"] });
});

test("unknown, repeated, valueless and out-of-range options are usage errors that never echo an argument", () => {
  expect(() => parseOptions(["--bogus"], ["--schema"])).toThrow("Unknown option: --bogus");
  expect(() => parseOptions(["--schema", "a", "--schema", "b"], ["--schema"])).toThrow("Repeated option: --schema");
  expect(() => parseOptions(["--schema"], ["--schema"])).toThrow("--schema needs a value");
  expect(() => parseOptions(["--dry-run=1"], ["--dry-run"])).toThrow("takes no value");
  for (const bad of ["0", "x", "10001"]) expect(() => parseOptions(["--steps", bad], ["--steps"])).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  const error = (() => {
    try {
      parseOptions(["postgres://admin:secret-pw@host/db"], []);
    } catch (e) {
      return e as Error;
    }
  })();
  expect(error?.message).toContain("Unexpected argument");
  expect(error?.message).not.toContain("secret-pw");
});

test("splitArguments takes positional arguments before or after options and sends extras to the option list", () => {
  const command = { usage: "<migrationId> [--schema ad]", flags: ["--schema"] };
  expect(splitArguments(command, ["--schema", "app_x", "20260101000001_x"])).toEqual({ positional: ["20260101000001_x"], options: ["--schema", "app_x"] });
  expect(splitArguments(command, ["20260101000001_x", "--schema", "app_x"])).toEqual({ positional: ["20260101000001_x"], options: ["--schema", "app_x"] });
  expect(splitArguments(command, ["a", "extra"]).options).toEqual(["extra"]);
});

test("--help lists the migration, seed and tool commands; an unknown command fails with exit code 1", async () => {
  const help = await capture(() => main(["--help"]));
  for (const name of ["migrate", "migrate-down", "migration-status", "migration create", "migration baseline", "seed", "seed create", "pull", "export", "backup", "backup prune", "restore", "replicas", "doctor", "neon stage-copy", "neon export"])
    expect(help.out).toContain(name);
  const unknown = await capture(() => main(["frobnicate"]));
  expect(unknown.err).toContain("Unknown command");
  expect(process.exitCode).toBe(1);
});

test("an unknown command is never echoed back: a URL typed in its place keeps its password out of the output", async () => {
  const { out, err } = await capture(() => main(["postgres://admin:argv-secret@host/db"]));
  expect(err).toContain("Unknown command");
  expect(err).toContain("Commands:");
  expect(out + err).not.toContain("argv-secret");
  expect(out + err).not.toContain("postgres://");
  expect(process.exitCode).toBe(1);
});

test("a bad option or a bad schema fails before any database is touched, as a JSON error line without secrets", async () => {
  const bad = await capture(() => main(["migrate", "--steps", "1"]));
  expect(JSON.parse(bad.err)).toMatchObject({ error: "USAGE" });
  const schema = await capture(() => main(["migrate", "--schema", 'x"; DROP', "--dry-run"]));
  expect(JSON.parse(schema.err)).toMatchObject({ error: "INVALID_SCHEMA" });
  const required = await capture(() => main(["migration", "baseline"]));
  expect(JSON.parse(required.err).message).toContain("Usage: migration baseline");
});

test("doctor URL switches take no value: a URL given on the command line is a usage error that never echoes it", async () => {
  for (const args of [["doctor", "--pooled-url=postgres://admin:argv-secret@host/db"], ["doctor", "--pgbouncer-url", "postgres://admin:argv-secret@host/pgbouncer"]]) {
    const { err } = await capture(() => main(args));
    expect(JSON.parse(err)).toMatchObject({ error: "USAGE" });
    expect(err).not.toContain("argv-secret");
    expect(process.exitCode).toBe(1);
  }
});

test("provider options are validated before any prompt or provider call: bad --at, --org without neon, unknown provider", async () => {
  const saved = process.env.DATABASE_URLS;
  process.env.DATABASE_URLS = "postgres://admin:argv-secret@127.0.0.1:1/app";
  try {
    for (const [option, ...args] of [
      ["--at", "neon", "export", "/tmp/never", "--at", "yesterday"],
      ["--at", "neon", "export", "/tmp/never"],
      ["--org", "migrate", "--org", "org-1"],
      ["--org", "migrate", "--org", "org-1", "--safety-point", "supabase"],
      ["--safety-point", "migrate", "--safety-point", "aws"],
    ] as string[][]) {
      const { err } = await capture(() => main(args));
      expect(JSON.parse(err), args.join(" ")).toMatchObject({ error: "USAGE", message: expect.stringContaining(option ?? "") });
      expect(err).not.toContain("argv-secret");
      expect(process.exitCode).toBe(1);
    }
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URLS;
    else process.env.DATABASE_URLS = saved;
  }
});

test("neon export refuses an existing target before it asks for the API key", async () => {
  const saved = process.env.DATABASE_URLS;
  process.env.DATABASE_URLS = "postgres://admin:argv-secret@127.0.0.1:1/app";
  try {
    const { err } = await capture(() => main(["neon", "export", import.meta.dir, "--at", "2026-10-03T09:30:00Z"]));
    expect(JSON.parse(err)).toMatchObject({ error: "BACKUP_EXISTS" });
    expect(process.exitCode).toBe(1);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URLS;
    else process.env.DATABASE_URLS = saved;
  }
});

test("--statement-timeout-ms is a bounded integer (1000..3600000) on the commands that run management work", async () => {
  expect(parseOptions(["--statement-timeout-ms", "120000"], ["--statement-timeout-ms"])).toEqual({ statementTimeoutMs: 120000 });
  for (const bad of ["999", "3600001", "x", "1.5"]) expect(() => parseOptions(["--statement-timeout-ms", bad], ["--statement-timeout-ms"])).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  for (const command of [["migrate"], ["migrate-down"], ["seed"], ["restore", "/tmp/never"]]) {
    const { err } = await capture(() => main([...command, "--statement-timeout-ms", "5"]));
    expect(JSON.parse(err), command[0]).toMatchObject({ error: "INVALID_CONFIG" });
  }
  const { err } = await capture(() => main(["doctor", "--statement-timeout-ms", "5000"]));
  expect(JSON.parse(err)).toMatchObject({ error: "USAGE" });
});

test("--statement-timeout-ms reaches the management context as the migration statement timeout", async () => {
  const fake = fakeDriver(() => [{ exists: false }]);
  const saved = process.env.DATABASE_URLS;
  process.env.DATABASE_URLS = "postgres://admin:argv-secret@127.0.0.1:1/app";
  drivers.fake = async () => fake.driver;
  try {
    await capture(() => main(["migrate", "--dry-run", "--driver=fake", "--statement-timeout-ms", "120000"]));
    expect(fake.commands[0]?.text).toContain("SET LOCAL statement_timeout = 120000");
    fake.commands.length = 0;
    await capture(() => main(["migrate", "--dry-run", "--driver=fake"]));
    expect(fake.commands[0]?.text).toContain("SET LOCAL statement_timeout = 30000");
  } finally {
    delete drivers.fake;
    if (saved === undefined) delete process.env.DATABASE_URLS;
    else process.env.DATABASE_URLS = saved;
  }
});

test("auth generate takes no --schema (the diff always runs in a throwaway schema)", async () => {
  const { err } = await capture(() => main(["auth", "generate", "./options.ts", "--schema", "app_x"]));
  expect(JSON.parse(err)).toMatchObject({ error: "USAGE", message: "Unknown option: --schema" });
});
