/** `bun run verify:provider [--driver bun|postgres|pg|neon] [--replica]`: yönetilen Postgres'te pooler sınamasını, `ALTER DATABASE SET`'i, yetkileri ve
 * deadline sonrası sunucu davranışını ölçer; `--replica` replica URL'sini gizli girişle sorar ve lag ile standby ayarlarını da ölçer; yalnızca JSON basar.
 * Yönetim URL'si `DATABASE_URLS`'ten, runtime URL'si gizli girişten gelir (`doctor --pooled-url` ile aynı biçim). Yalnızca geçici/ücretsiz test
 * veritabanlarında çalıştırın. */
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

export interface DatabaseReport {
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
  database: DatabaseReport;
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

/** Ölçümleri sırayla çalıştırır (paralel değil: ölçümler aynı veritabanı ayarına dokunur). */
export async function verify(
  driver: Driver,
  name: string,
  managementUrl: string,
  runtimeUrl: string,
  now = new Date(),
  timing?: Parameters<typeof deadline>[3] & { gapMs?: number },
  replicaUrl?: string,
): Promise<Report> {
  const ctx: Context = { driver, urls: [managementUrl, runtimeUrl, ...(replicaUrl ? [replicaUrl] : [])] };
  const database: DatabaseReport = {
    probe: { runtime: await probe(ctx, runtimeUrl), management: await probe(ctx, managementUrl) },
    alterDatabase: await alterDatabase(ctx, managementUrl, runtimeUrl),
    privileges: await privileges(ctx, managementUrl),
    deadline: await deadline(ctx, runtimeUrl, managementUrl, timing),
    ...(replicaUrl ? { replica: await replica(ctx, managementUrl, replicaUrl, timing?.gapMs) } : {}),
  };
  return { generatedAt: now.toISOString(), driver: name, server: await serverVersion(driver, managementUrl), database };
}

/** Hata tek satır JSON olarak yazılır: yığın izi ve sürücü mesajı (host, kullanıcı, parola) basılmaz. */
async function main() {
  try {
    const name = driverName(process.argv.slice(2));
    const managementUrl = loadConfig().url;
    const runtimeUrl = postgresUrl(await askSecret("Runtime URL (DATABASE_URLS format, input is hidden): "), "Runtime URL").href;
    const replicaUrl = process.argv.includes("--replica")
      ? createConfig(managementUrl, postgresUrl(await askSecret("Replica URL (postgres://…, input is hidden): "), "Replica URL").href).replicas[0]
      : undefined;
    const driver = (await import(`../../core/drivers/${name}`))[`${name}Driver`] as Driver;
    console.log(JSON.stringify(await verify(driver, name, managementUrl, runtimeUrl, undefined, undefined, replicaUrl), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: errorCode(error), message: error instanceof AppError ? error.message : "Verification failed" }));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
