/** İstemci deadline'ı gerçek sorguyu bırakmaz (`DB_DRIVER` = bun | postgres | pg): süresi dolan deyim iptal edilir ya da bağlantısı
 * atılır; arkadan yazım olmaz, çalışan deyimin oturumu yeniden kullanılmaz, transaction kirli dönmez. Doğrudan bağlantı ve PgBouncer. */
import { afterAll, beforeAll, expect } from "bun:test";
import pg from "pg";
import { connect, type Database } from "../../core/database";
import { errorCode } from "../../core/errors";
import { bootstrap } from "../../management";
import { createTestManagement, directConfig, driver, enabled, integration, pooledConfig, q, raw } from "./helpers";

const DEADLINE_MS = 250;
/** Cevap deadline'ı (deadline + 1 sn) + tarama aralığı + iptal beklemesi + pay. */
const BOUND_MS = DEADLINE_MS + 1000 + 250 + 500 + 500;
const schema = `deadline_matrix_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const writes = q(schema, "writes");
const admin = enabled ? raw() : undefined;
const bouncer = "postgres://admin:local_admin_password@127.0.0.1:5543/pgbouncer";

beforeAll(async () => {
  if (!admin) return;
  // Runtime DB varsayılanları (statement_timeout, client_connection_check_interval); PgBouncer sunucu bağlantıları yenilenir.
  const management = createTestManagement();
  await bootstrap(management).finally(() => management.close());
  await adminConsole("RECONNECT");
  await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${writes} (id integer PRIMARY KEY)`);
});
afterAll(async () => {
  await admin?.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
  await admin?.close();
});

/** PgBouncer yönetim konsolu komutu (yalnızca simple protocol kabul eder; pg parametresiz sorguyu öyle gönderir); test altyapısı. */
async function adminConsole(command: string) {
  const client = new pg.Client({ connectionString: bouncer });
  await client.connect();
  try {
    await client.query(command);
  } finally {
    await client.end();
  }
}

const open = (url: string | undefined, deadlineMs = DEADLINE_MS) =>
  connect(driver(url ?? "", { max: 1, idleTimeoutSeconds: 10, maxLifetimeSeconds: 60, connectTimeoutSeconds: 2 }), { deadlineMs, maxPending: 8 });
const direct = () => open(directConfig().nodes[0]?.url);
const pooled = () => open(pooledConfig().nodes[0]?.url);

async function outcome(work: Promise<unknown>) {
  const started = performance.now();
  const code = await work.then(
    () => "ok",
    (error: unknown) => errorCode(error),
  );
  return { code, ms: performance.now() - started };
}

const pid = async (db: Database) => (await db.query<{ pid: number }>("SELECT pg_catalog.pg_backend_pid() AS pid"))[0]?.pid;
const rows = async (id: number) => (await admin?.query(`SELECT id FROM ${writes} WHERE id=$1`, [id]))?.length;
/** Eski backend'in deyimi sona erdi mi (iptal ya da kopan istemci): `until` sınırına kadar `pg_stat_activity` yoklanır. */
async function backendIdleOrGone(backend: number | undefined, ms: number) {
  const started = performance.now();
  while (performance.now() - started < ms) {
    const [row] = (await admin?.query<{ running: number }>("SELECT count(*)::int AS running FROM pg_catalog.pg_stat_activity WHERE pid=$1 AND state='active'", [backend])) ?? [];
    if (row?.running === 0) return true;
    await Bun.sleep(50);
  }
  return false;
}

async function usingDatabase(db: Database, work: (db: Database) => Promise<void>) {
  try {
    await work(db);
  } finally {
    await db.close();
  }
}

integration("running SELECT past the deadline: DATABASE_TIMEOUT in bounded time and the running session is never reused", () =>
  usingDatabase(direct(), async (db) => {
    const before = await pid(db);
    const result = await outcome(db.query("SELECT pg_catalog.pg_sleep(4)"));
    expect(result.code).toBe("DATABASE_TIMEOUT");
    expect(result.ms).toBeLessThan(BOUND_MS);
    expect(await pid(db)).not.toBe(before); // max=1: atılan bağlantının yerine yeni oturum
    expect(await backendIdleOrGone(before, 2000)).toBe(true); // sunucudaki deyim de bitti
  }),
);

integration("running INSERT past the deadline never commits later (direct and through PgBouncer)", async () => {
  for (const [id, open] of [[1, direct], [2, pooled]] as const)
    await usingDatabase(open(), async (db) => {
      await db.query("SELECT 1");
      const result = await outcome(db.query(`INSERT INTO ${writes} (id) SELECT $1 FROM pg_catalog.pg_sleep(3)`, [id]));
      expect(result.code).toBe("DATABASE_TIMEOUT");
      expect(result.ms).toBeLessThan(BOUND_MS);
      await Bun.sleep(3500 - result.ms); // deyim iptal edilmeseydi şimdiye commit etmişti
      expect(await rows(id)).toBe(0);
    });
});

integration("after a timeout on a max=1 PgBouncer pool the next query gets a clean connection at once", () =>
  usingDatabase(pooled(), async (db) => {
    expect((await outcome(db.query("SELECT pg_catalog.pg_sleep(4)"))).code).toBe("DATABASE_TIMEOUT");
    const next = await outcome(db.query("SELECT $1::int AS n", [7]));
    expect(next.code).toBe("ok");
    expect(next.ms).toBeLessThan(1000);
    expect(await db.query<{ n: number }>("SELECT $1::int AS n", [8])).toEqual([{ n: 8 }]);
    expect(await db.transaction((tx) => tx.query<{ n: number }>("SELECT $1::int AS n", [9]))).toEqual([{ n: 9 }]);
  }),
);

integration("PgBouncer without a backend: BEGIN and a queued INSERT are bounded, and the INSERT does not run after the backend returns", () =>
  usingDatabase(pooled(), async (db) => {
    await db.query("SELECT 1");
    await adminConsole("PAUSE db0");
    let ran = false;
    try {
      const transaction = await outcome(
        db.transaction(async (tx) => {
          ran = true;
          await tx.query(`INSERT INTO ${writes} (id) VALUES (3)`);
        }),
      );
      expect(transaction.code).toBe("DATABASE_TIMEOUT");
      expect(transaction.ms).toBeLessThan(BOUND_MS);
      expect(ran).toBe(false);
      const insert = await outcome(db.query(`INSERT INTO ${writes} (id) VALUES (4)`));
      expect(insert.code).toBe("DATABASE_TIMEOUT");
      expect(insert.ms).toBeLessThan(BOUND_MS);
    } finally {
      await adminConsole("RESUME db0");
    }
    await Bun.sleep(1000);
    expect(await rows(3)).toBe(0);
    expect(await rows(4)).toBe(0);
    expect(await db.query<{ n: number }>("SELECT $1::int AS n", [1])).toEqual([{ n: 1 }]);
  }),
);

integration("transaction statement past the deadline: bounded, nothing committed, the connection is replaced", () =>
  usingDatabase(direct(), async (db) => {
    const before = await pid(db);
    const result = await outcome(
      db.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${writes} (id) VALUES (5)`);
        await tx.query("SELECT pg_catalog.pg_sleep(4)");
      }),
    );
    expect(result.code).toBe("DATABASE_TIMEOUT");
    expect(result.ms).toBeLessThan(BOUND_MS);
    expect(await pid(db)).not.toBe(before);
    expect(await backendIdleOrGone(before, 2000)).toBe(true);
    expect(await rows(5)).toBe(0);
  }),
);

integration("rollback after an application error keeps the same healthy connection with no open transaction", () =>
  usingDatabase(direct(), async (db) => {
    const before = await pid(db);
    const failure = await outcome(
      db.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${writes} (id) VALUES (6)`);
        throw new Error("application");
      }),
    );
    expect(failure.code).toBe("OPERATION_FAILED");
    expect(await pid(db)).toBe(before);
    const [state] = await db.query<{ open: boolean }>("SELECT pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL AS open");
    expect(state?.open).toBe(false);
    expect(await rows(6)).toBe(0);
    await db.transaction((tx) => tx.query(`INSERT INTO ${writes} (id) VALUES (7)`));
    expect(await rows(7)).toBe(1);
  }),
);
