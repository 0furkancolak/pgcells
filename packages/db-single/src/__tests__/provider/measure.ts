/** Sağlayıcı doğrulama ölçümleri (`bun run verify:provider`); yayımlanan pakete girmez. Her ölçüm kendi geçici havuzunu açıp kapatır
 * ve çıktıya URL, host, kullanıcı veya parola koymaz. */
import { CLIENT_CONNECTION_CHECK_MS } from "../../core/config";
import type { Driver, Pool } from "../../core/driver";
import { errorCode } from "../../core/errors";
import { quoteIdentifier } from "../../core/identifier";
import { usesTransactionPooler } from "../../core/pooler";
import { probeReplica } from "../../core/replicas";

/** Ölçümlerin paylaştığı bağlam: sürücü ve çıktıdan silinecek bütün URL'ler (yönetim + runtime). */
export interface Context {
  driver: Driver;
  urls: readonly string[];
}

const MAX_ERROR_CHARS = 300;

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Tam URL'leri, parolayı (ham ve çözülmüş), host'u ve proje ref'i taşıyan kullanıcı adını metinden siler. Düz `postgres` rolü
 * okunur kalır: yetki hatalarının anlamı ona bağlı. */
export function scrub(text: string, urls: readonly string[]): string {
  let result = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]");
  for (const raw of urls) {
    const url = URL.parse(raw);
    if (!url) continue;
    const user = decoded(url.username);
    for (const secret of [url.password, decoded(url.password), url.hostname, user === "postgres" ? "" : user])
      if (secret) result = result.split(secret).join("[hidden]");
  }
  return result;
}

/** `<kod>: <temizlenmiş mesaj>`; sürücü hataları kimlik bilgisi ve host içerebilir. */
export function describe(error: unknown, urls: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${errorCode(error)}: ${scrub(message, urls)}`.slice(0, MAX_ERROR_CHARS);
}

// Bun SQL çalışan bir sorguyu da boşta sayıp `idleTimeout`'ta düşürür; uzun `pg_sleep` ölçümü için süre uzun tutulur (havuz her ölçümde kapatılır).
const POOL = { max: 1, idleTimeoutSeconds: 60, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 } as const;

const withPool = async <T>(driver: Driver, url: string, work: (pool: Pool) => Promise<T>): Promise<T> => {
  const pool = driver(url, POOL);
  try {
    return await work(pool);
  } finally {
    await pool.close(1000);
  }
};

const SETTING = "statement_timeout";
const PROBE_VALUE = "7777ms";
const STORED_SETTING = `SELECT pg_catalog.current_database() AS name,
  (SELECT s FROM pg_catalog.pg_db_role_setting r, pg_catalog.unnest(r.setconfig) AS s
    WHERE r.setrole=0 AND r.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
      AND s LIKE '${SETTING}=%') AS stored`;
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface AlterDatabaseResult {
  /** `ALTER DATABASE … SET` kabul edildi mi. */
  allowed: boolean;
  /** Ayar yeni bir doğrudan oturumda görüldü mü. */
  newSession?: boolean;
  /** Runtime (pooler) URL'sinde görüldü mü; pooler mevcut sunucu bağlantılarını yeniden kullanabilir, `false` tek başına hata değildir. */
  throughRuntime?: boolean;
  error?: string;
  /** Özgün değer geri yazılamadıysa elle çalıştırılacak SQL (URL ve parola içermez). */
  restoreSql?: string;
}

const seesProbe = (driver: Driver, url: string) =>
  withPool(driver, url, async (pool) => (await pool.query<{ value: string }>(`SELECT current_setting('${SETTING}') AS value`))[0]?.value === PROBE_VALUE);

/** `migrate`'ın yaptığı `ALTER DATABASE … SET` işini geçici bir değerle dener, yeni oturumlarda görüldüğünü ölçer ve özgün değeri
 * (veya yokluğunu) geri yazar. Ölçüm hata verse de geri yazma çalışır. */
export async function alterDatabase({ driver, urls }: Context, managementUrl: string, runtimeUrl: string): Promise<AlterDatabaseResult> {
  try {
    return await withPool(driver, managementUrl, (admin) => alterWith(admin, { driver, urls }, managementUrl, runtimeUrl));
  } catch (error) {
    return { allowed: false, error: describe(error, urls) };
  }
}

async function alterWith(admin: Pool, { driver, urls }: Context, managementUrl: string, runtimeUrl: string): Promise<AlterDatabaseResult> {
  const [row] = await admin.query<{ name: string; stored: string | null }>(STORED_SETTING);
  if (!row) return { allowed: false, error: "OPERATION_FAILED: current database name unavailable" };
  const database = quoteIdentifier(row.name);
  const original = row.stored?.slice(SETTING.length + 1);
  const restore = original === undefined ? `ALTER DATABASE ${database} RESET ${SETTING}` : `ALTER DATABASE ${database} SET ${SETTING} TO ${quoted(original)}`;
  try {
    await admin.exec(`ALTER DATABASE ${database} SET ${SETTING} TO ${quoted(PROBE_VALUE)}`);
  } catch (error) {
    return { allowed: false, error: describe(error, urls) };
  }
  const result: AlterDatabaseResult = { allowed: true };
  try {
    result.newSession = await seesProbe(driver, managementUrl);
    result.throughRuntime = await seesProbe(driver, runtimeUrl);
  } catch (error) {
    result.error = describe(error, urls);
  } finally {
    try {
      await admin.exec(restore);
    } catch {
      result.restoreSql = restore;
    }
  }
  return result;
}

const EXTENSIONS = ["citext", "pg_trgm", "pgcrypto"];

export interface PrivilegeResult {
  createSchema: boolean;
  superuser: boolean;
  /** Kurulu olmayan ilk uygun extension'ın `CREATE EXTENSION` denemesi (transaction geri alınır); aday yoksa yok. */
  extension?: { name: string; allowed: boolean; error?: string };
  error?: string;
}

/** `migrate`'ın ihtiyacı olan `CREATE` hakkı ve rol türü; extension yetkisi geri alınan bir transaction'da denenir. */
export async function privileges({ driver, urls }: Context, managementUrl: string): Promise<PrivilegeResult> {
  try {
    return await withPool(driver, managementUrl, async (pool) => {
      const [row] = await pool.query<{ create_schema: boolean; superuser: boolean }>(
        "SELECT pg_catalog.has_database_privilege(pg_catalog.current_database(),'CREATE') AS create_schema, COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user),false) AS superuser",
      );
      const result: PrivilegeResult = { createSchema: row?.create_schema === true, superuser: row?.superuser === true };
      const candidate = await pool.query<{ name: string }>(
        `SELECT name FROM pg_catalog.pg_available_extensions WHERE name IN (${EXTENSIONS.map(quoted).join(",")}) AND installed_version IS NULL ORDER BY name LIMIT 1`,
      );
      const name = candidate[0]?.name;
      if (!name) return result;
      const session = await pool.reserve();
      try {
        await session.exec("BEGIN");
        await session.exec(`CREATE EXTENSION ${quoteIdentifier(name)}`);
        result.extension = { name, allowed: true };
      } catch (error) {
        result.extension = { name, allowed: false, error: describe(error, urls) };
      } finally {
        await session.exec("ROLLBACK").catch(() => {});
        session.release();
      }
      return result;
    });
  } catch (error) {
    return { createSchema: false, superuser: false, error: describe(error, urls) };
  }
}

const PROBE_DEADLINE_MS = 15_000;

export type ProbeResult = { transactionPooler: boolean } | { error: string };

/** A'nın `pg_backend_pid` sınaması: runtime URL'si için `true`, yönetim URL'si için `false` beklenir. */
export async function probe({ driver, urls }: Context, url: string): Promise<ProbeResult> {
  try {
    return { transactionPooler: await usesTransactionPooler(driver, url, { deadlineMs: PROBE_DEADLINE_MS }) };
  } catch (error) {
    return { error: describe(error, urls) };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SLEEP_SECONDS = 120;

export interface DeadlineResult {
  /** Etiketli uzun sorgu `pg_stat_activity`'de görüldü mü; görülmediyse "sunucu durdu" ölçümü anlamsızdır. */
  observedRunning: boolean;
  /** Sürücü `cancel` tanımlıyor mu (`neonDriver` ve Bun SQL tanımlamaz). */
  cancelDefined: boolean;
  /** Bağlantı atıldıktan sonra sunucudaki sorgunun bitmesi için geçen süre; süre içinde bitmediyse `null`. */
  serverStoppedAfterMs: number | null;
  error?: string;
}

/** Runtime URL'sinde ayrılmış bağlantıda uzun bir sorgu başlatır, `afterMs` sonra bağlantıyı atar (`release(true)`, varsa `cancel`)
 * ve yönetim URL'sinden sunucudaki sorgunun ne zaman bittiğini izler. `client_connection_check_interval` `migrate`'ın varsayılanıdır. */
export async function deadline(
  { driver, urls }: Context,
  runtimeUrl: string,
  managementUrl: string,
  { afterMs = 2000, waitMs = 20_000, pollMs = 500 } = {},
): Promise<DeadlineResult> {
  const tag = `verify-provider-${crypto.randomUUID()}`;
  const running = (monitor: Pool) =>
    monitor
      .query<{ n: number }>("SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid <> pg_catalog.pg_backend_pid() AND state = 'active' AND query LIKE $1", [`%${tag}%`])
      .then(([row]) => row?.n ?? 0);
  try {
    return await withPool(driver, managementUrl, (monitor) =>
      withPool(driver, runtimeUrl, async (pool) => {
        const reserved = await pool.reserve();
        let startError: string | undefined;
        let dropped = false;
        /** Bağlantıyı bir kez atar; ölçüm ortasında hata olsa da sunucuda 120 sn'lik sorgu açık kalmaz. */
        const drop = () => {
          if (dropped) return;
          dropped = true;
          reserved.cancel?.();
          reserved.release(true);
        };
        void reserved
          .exec(`BEGIN; SET LOCAL statement_timeout = 0; SET LOCAL client_connection_check_interval = ${CLIENT_CONNECTION_CHECK_MS}; SELECT pg_sleep(${SLEEP_SECONDS}) /* ${tag} */`)
          .catch((error: unknown) => {
            startError = describe(error, urls);
          });
        try {
          await sleep(afterMs);
          const observedRunning = (await running(monitor)) > 0;
          const cancelDefined = typeof reserved.cancel === "function";
          drop();
          if (!observedRunning) return { observedRunning, cancelDefined, serverStoppedAfterMs: null, ...(startError ? { error: startError } : {}) };
          const started = performance.now();
          while (performance.now() - started < waitMs) {
            await sleep(pollMs);
            if ((await running(monitor)) === 0) return { observedRunning, cancelDefined, serverStoppedAfterMs: Math.max(1, Math.round(performance.now() - started)) };
          }
          return { observedRunning, cancelDefined, serverStoppedAfterMs: null };
        } finally {
          drop();
        }
      }),
    );
  } catch (error) {
    return { observedRunning: false, cancelDefined: false, serverStoppedAfterMs: null, error: describe(error, urls) };
  }
}

export type ReplicaResult =
  | { inRecovery: boolean; lagMs: (number | null)[]; maxStandbyStreamingDelay: string | null; hotStandbyFeedback: string | null }
  | { error: string };

const SAMPLES = 3;

/** Replica'nın gerçek davranışı: üç örnekte lag (replay LSN'e göre) ve recovery çakışmasını belirleyen iki ayar. Yalnızca okur. */
export async function replica({ driver, urls }: Context, primaryUrl: string, replicaUrl: string, gapMs = 1000): Promise<ReplicaResult> {
  try {
    return await withPool(driver, primaryUrl, (primary) =>
      withPool(driver, replicaUrl, async (standby) => {
        const lagMs: (number | null)[] = [];
        let inRecovery = false;
        for (let sample = 0; sample < SAMPLES; sample++) {
          if (sample) await sleep(gapMs);
          const probed = await probeReplica(primary, standby);
          inRecovery = probed.inRecovery;
          lagMs.push(probed.lagMs);
        }
        const setting = async (name: string) => (await standby.query<Record<string, string>>(`SHOW ${name}`))[0]?.[name] ?? null;
        return { inRecovery, lagMs, maxStandbyStreamingDelay: await setting("max_standby_streaming_delay"), hotStandbyFeedback: await setting("hot_standby_feedback") };
      }),
    );
  } catch (error) {
    return { error: describe(error, urls) };
  }
}
