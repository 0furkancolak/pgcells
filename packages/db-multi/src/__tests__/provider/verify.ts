/** `bun run verify:provider [--driver bun|postgres|pg|neon] [--replica]`: yönetilen Postgres'te A'nın sınamasını, `ALTER DATABASE SET`'i, yetkileri ve
 * deadline sonrası sunucu davranışını ölçer; `--replica` replica URL'lerini gizli girişle sorar ve lag ile standby ayarlarını da ölçer; yalnızca JSON basar. Yönetim URL'leri `DATABASE_URLS`'ten, runtime URL'leri gizli
 * girişten gelir (`doctor --pooled-urls` ile aynı biçim). Yalnızca geçici/ücretsiz test veritabanlarında çalıştırın. */
import { createConfig, loadConfig } from "../../core/config";
import type { Driver } from "../../core/driver";
import { AppError, errorCode } from "../../core/errors";
import { askSecret, postgresUrl } from "../../core/tools/ask-secret";
import {
  alterDatabase,
  type AlterDatabaseResult,
  type Context,
  deadline,
  type DeadlineResult,
  type PrivilegeResult,
  privileges,
  probe,
  type ProbeResult,
  replica,
  type ReplicaResult,
} from "./measure";

export interface NodeReport {
  id: string;
  probe: { runtime: ProbeResult; management: ProbeResult };
  alterDatabase: AlterDatabaseResult;
  privileges: PrivilegeResult;
  deadline: DeadlineResult;
  replica?: ReplicaResult;
}
export interface Report {
  generatedAt: string;
  driver: string;
  server: string | null;
  nodes: NodeReport[];
}

const DRIVERS = ["bun", "postgres", "pg", "neon"] as const;
type DriverName = (typeof DRIVERS)[number];

export function driverName(argv: readonly string[]): DriverName {
  const index = argv.findIndex((arg) => arg === "--driver" || arg.startsWith("--driver="));
  if (index < 0) return "bun";
  const arg = argv[index] as string;
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1];
  if (!DRIVERS.includes(value as DriverName)) throw new AppError("USAGE", `--driver must be one of ${DRIVERS.join(", ")}`);
  return value as DriverName;
}

async function serverVersion(driver: Driver, url: string): Promise<string | null> {
  const pool = driver(url, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  try {
    return (await pool.query<{ server: string }>("SELECT version() AS server"))[0]?.server ?? null;
  } catch {
    return null;
  } finally {
    await pool.close(1000);
  }
}

/** Düğüm başına ölçümleri sırayla çalıştırır (paralel değil: ölçümler aynı veritabanı ayarına dokunur). */
export async function verify(
  driver: Driver,
  name: string,
  management: readonly string[],
  runtime: readonly string[],
  now = new Date(),
  timing?: Parameters<typeof deadline>[3] & { gapMs?: number },
  replicaUrls: readonly (string | undefined)[] = [],
): Promise<Report> {
  if (management.length !== runtime.length) throw new AppError("INVALID_CONFIG", "Runtime URLs must list one URL per DATABASE_URLS entry, in the same order");
  const ctx: Context = { driver, urls: [...management, ...runtime, ...replicaUrls.filter((url): url is string => !!url)] };
  const nodes: NodeReport[] = [];
  for (const [index, managementUrl] of management.entries()) {
    const runtimeUrl = runtime[index] as string;
    nodes.push({
      id: `db${index}`,
      probe: { runtime: await probe(ctx, runtimeUrl), management: await probe(ctx, managementUrl) },
      alterDatabase: await alterDatabase(ctx, managementUrl, runtimeUrl),
      privileges: await privileges(ctx, managementUrl),
      deadline: await deadline(ctx, runtimeUrl, managementUrl, timing),
      ...(replicaUrls[index] ? { replica: await replica(ctx, managementUrl, replicaUrls[index] as string, timing?.gapMs) } : {}),
    });
  }
  return { generatedAt: now.toISOString(), driver: name, server: await serverVersion(driver, management[0] as string), nodes };
}

/** Hata tek satır JSON olarak yazılır: yığın izi ve sürücü mesajı (host, kullanıcı, parola) basılmaz. */
async function main() {
  try {
    const name = driverName(process.argv.slice(2));
    const managementUrls = loadConfig().nodes.map((node) => node.url);
    const answer = await askSecret("Runtime URLs (DATABASE_URLS format, comma-separated, input is hidden): ");
    const runtimeUrls = answer.split(",").map((entry) => postgresUrl(entry.trim(), "Runtime URL").href);
    const replicaAnswer = process.argv.includes("--replica") ? await askSecret("Replica URLs (db0=postgres://…, comma-separated, input is hidden): ") : undefined;
    const replicaUrls = replicaAnswer === undefined ? [] : createConfig(managementUrls, replicaAnswer).nodes.map((node) => node.replicas[0]);
    const driver = (await import(`../../core/drivers/${name}`))[`${name}Driver`] as Driver;
    console.log(JSON.stringify(await verify(driver, name, managementUrls, runtimeUrls, undefined, undefined, replicaUrls), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: errorCode(error), message: error instanceof AppError ? error.message : "Verification failed" }));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
