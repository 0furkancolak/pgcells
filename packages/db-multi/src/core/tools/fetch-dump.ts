/** `dump fetch`: downloads a plain-text backup of a remote PostgreSQL (e.g. staging) as `.sql.gz`. No pg_dump is needed on the host: the
 * pg_dump from the `postgres:<version>-alpine` image matching the server's major version runs in Docker. The DB is only read. The URL is asked
 * from the user in the CLI (not visible in the terminal), is not written to the command line or the shell environment, reaches the container
 * only through that process's environment, and the password is redacted in error messages. The output is read with `dump split` / `app-migrate` and psql. */
import { link, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { SQL } from "bun";
import { AppError, errorCode } from "../errors";
import { postgresUrl } from "./ask-secret";

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
/** Name by which a container reaches the host machine on Docker Desktop. */
const DOCKER_HOST = "host.docker.internal";
const STDERR_TAIL = 2000;
const usage = (message: string) => new AppError("USAGE", message);

/** If `url` is a function it is called after the file and schema checks (a hidden prompt in the CLI). `signal`: SIGINT/SIGTERM stops the download
 * and deletes this run's partial file. */
export type FetchDumpOptions = { url: string | (() => Promise<string>); schemas?: readonly string[]; signal?: AbortSignal };

export const sourceUrl = (value: string | undefined): URL => postgresUrl(value, "Source database URL");

/** The URL the container will connect to and the network options. A DB on the host machine (localhost): host network on Linux (a port bound to 127.0.0.1 is
 * also visible), `host.docker.internal` on Docker Desktop (macOS, Windows). */
export function dockerTarget(url: URL, platform: string = process.platform): { url: string; flags: string[] } {
  if (!LOCAL_HOSTS.includes(url.hostname)) return { url: url.href, flags: [] };
  if (platform === "linux") return { url: url.href, flags: ["--network=host"] };
  const target = new URL(url.href);
  target.hostname = DOCKER_HOST;
  return { url: target.href, flags: [] };
}

/** pg_dump arguments; schema names are validated (the shell does not interpret them, they are passed as separate arguments). */
export function dumpArguments(schemas: readonly string[] = []): string[] {
  for (const schema of schemas) if (!SCHEMA_NAME.test(schema)) throw usage(`--schema needs a plain lower-case schema name: ${schema}`);
  return ["--no-owner", "--no-privileges", ...schemas.map((schema) => `--schema=${schema}`)];
}

/** The raw value for an undecodable percent escape (e.g. `local%admin`): redaction never throws on any input, otherwise it would swallow the real error. */
const percentDecoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** The password in the text (raw and URL-encoded) and URLs with credentials are redacted. */
export function redact(text: string, url: URL): string {
  let result = text.replace(/(postgres(?:ql)?:\/\/[^:@/\s]*:)[^@\s]*@/g, "$1***@");
  for (const secret of new Set([url.password, percentDecoded(url.password)])) if (secret) result = result.replaceAll(secret, "***");
  return result;
}

/** The client is also built inside the try: the driver parses the URL itself, so an invalid percent escape throws here and becomes DUMP_FETCH_FAILED. */
async function serverMajor(url: URL): Promise<number> {
  let sql: SQL | undefined;
  try {
    sql = new SQL(url.href, { max: 1 });
    const [row] = await sql`SELECT pg_catalog.current_setting('server_version_num')::int AS num`;
    return Math.floor(Number(row.num) / 10000);
  } catch (error) {
    throw new AppError("DUMP_FETCH_FAILED", redact(`Cannot connect to the source database: ${error instanceof Error ? error.message : String(error)}`, url));
  } finally {
    await sql?.close({ timeout: 0 }).catch(() => {});
  }
}

function startDocker(image: string, url: URL, args: string[]) {
  const target = dockerTarget(url);
  const env = { ...process.env, SOURCE_URL: target.url };
  const command = ["docker", "run", "--rm", "-i", ...target.flags, "-e", "SOURCE_URL", image];
  const script = 'exec pg_dump --dbname="$SOURCE_URL" "$@"';
  try {
    return Bun.spawn([...command, "sh", "-c", script, "pg_dump", ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw usage("dump fetch needs Docker (docker command not found)");
    throw error;
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** Writes the backup to `<file>.partial` and links it to `<file>` once pg_dump finishes successfully; does not overwrite an existing file. File name
 * conflicts (both the target and `.partial`) are checked before the URL is asked and before connecting to the source DB. */
export async function fetchDump(file: string, { url: rawUrl, schemas = [], signal }: FetchDumpOptions) {
  if (!file.endsWith(".sql.gz")) throw usage("dump fetch writes a .sql.gz file");
  const args = dumpArguments(schemas);
  const partial = `${file}.partial`;
  if (await exists(file)) throw usage(`${file} already exists`);
  // An interrupted or ongoing download: it is not deleted since its owner is unknown, the operator decides.
  if (await exists(partial)) throw usage(`${partial} already exists; remove it and retry`);
  const url = sourceUrl(typeof rawUrl === "function" ? await rawUrl() : rawUrl);
  const started = performance.now();
  const major = await serverMajor(url);
  const image = `postgres:${major}-alpine`;
  const child = startDocker(image, url, args);
  const stderr = new Response(child.stderr).text();
  try {
    await pipeline(Readable.fromWeb(child.stdout as never), createGzip(), createWriteStream(partial, { flags: "wx" }), { signal });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new AppError("DUMP_FETCH_FAILED", redact(`pg_dump (${image}) exited with ${exitCode}: ${(await stderr).trim().slice(-STDERR_TAIL)}`, url));
  } catch (error) {
    child.kill();
    // In this block EEXIST can only come from the `wx` open: another run created `.partial` in the meantime, and its data is not deleted.
    if (errorCode(error) === "EEXIST") throw usage(`${partial} already exists; remove it and retry`);
    await rm(partial, { force: true });
    if (signal?.aborted) throw usage("dump fetch cancelled");
    throw error;
  }
  // Claims the target atomically: `rename` would silently overwrite a file created after the check, `link` gives EEXIST if the target exists. On the error
  // path the downloaded data stays in `.partial`; it is not deleted.
  await link(partial, file).catch((error: unknown) => {
    throw errorCode(error) === "EEXIST" ? usage(`${file} appeared while the dump was downloading; it was left untouched and the dump is kept at ${partial}`) : error;
  });
  await rm(partial, { force: true });
  return { file, bytes: (await stat(file)).size, image, serverVersion: major, schemas: schemas.length ? [...schemas] : "all", seconds: Math.round((performance.now() - started) / 100) / 10 };
}
