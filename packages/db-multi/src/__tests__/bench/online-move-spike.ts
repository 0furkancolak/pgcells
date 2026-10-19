/** Spike (docs/guides/regions.md, "zero-downtime move"): move a schema between two PostgreSQL 16 servers with logical replication while it is written to, and
 * measure the write pause. Needs `docker compose up -d postgres-lr-a postgres-lr-b`.
 *   bun src/__tests__/bench/online-move-spike.ts [sizesMB=100,1000] [writesPerSecond=200]
 * Steps: structure on the target, publication (FOR TABLES IN SCHEMA) on the source, subscription with copy_data on the target, a writer running all along; then the
 * pause: in one source transaction lock every table SHARE ROW EXCLUSIVE (writes wait, reads continue), wait until the subscriber has applied everything up to the current
 * position, copy sequence values, compare row counts, and only then rename the schema (the fence) and commit. Renaming earlier does not work: the publisher sends the
 * schema's *current* name, so changes committed before the rename but not yet applied fail on the subscriber ("target relation ... does not exist").
 * The pause is measured from the lock to the commit (the placement flip itself is one UPDATE and is not included). `move --online` itself proves "applied" with a heartbeat
 * row instead of comparing WAL positions (this spike can use positions because nothing else writes WAL on its two servers). */
import { connect } from "../../core/database";
import { bunDriver } from "../../core/drivers/bun";

const sizes = (process.argv[2] ?? "100,1000").split(",").map(Number);
const rate = Number(process.argv[3] ?? 200);
const A = "postgres://admin:local_admin_password@127.0.0.1:5601/app";
const B = "postgres://admin:local_admin_password@127.0.0.1:5602/app";
const FROM_B = "host=postgres-lr-a port=5432 dbname=app user=admin password=local_admin_password";
const options = { max: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 600, connectTimeoutSeconds: 10 };
const a = bunDriver(A, options);
const b = bunDriver(B, options);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const one = async <T>(db: typeof a, sql: string) => (await db.query<T>(sql))[0] as T;

const DDL = `
  CREATE SCHEMA spike_move;
  CREATE TABLE spike_move.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, bio text);
  CREATE TABLE spike_move.events (id bigserial PRIMARY KEY, user_id uuid, kind text NOT NULL, payload jsonb);
  CREATE INDEX events_user_idx ON spike_move.events (user_id);
  CREATE TABLE spike_move.audit (ts timestamptz NOT NULL DEFAULT now(), msg text);`;

async function reset() {
  for (const db of [a, b]) {
    await db.exec("DROP SUBSCRIPTION IF EXISTS spike_sub").catch(() => {});
    await db.exec("DROP SCHEMA IF EXISTS spike_move CASCADE; DROP SCHEMA IF EXISTS spike_move__moved CASCADE");
  }
  await a.exec("DROP PUBLICATION IF EXISTS spike_pub");
  await a.query("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'spike_sub'").catch(() => {});
}

async function run(sizeMB: number) {
  await reset();
  await a.exec(DDL);
  await b.exec(DDL);
  const usersRows = Math.round((sizeMB * 1024 * 1024 * 0.6) / 520);
  const eventsRows = Math.round((sizeMB * 1024 * 1024 * 0.4) / 180);
  const loadStart = performance.now();
  await a.exec(`INSERT INTO spike_move.users (name, bio) SELECT 'user' || g, repeat('x', 440) FROM generate_series(1, ${usersRows}) g`);
  await a.exec(
    `INSERT INTO spike_move.events (user_id, kind, payload) SELECT (SELECT id FROM spike_move.users OFFSET (g % ${Math.max(usersRows, 1)}) LIMIT 1), 'k' || (g % 7), jsonb_build_object('n', g, 's', repeat('y', 60)) FROM generate_series(1, ${eventsRows}) g`.replace(
      `(SELECT id FROM spike_move.users OFFSET (g % ${Math.max(usersRows, 1)}) LIMIT 1)`,
      "gen_random_uuid()",
    ),
  );
  await a.exec("INSERT INTO spike_move.audit (msg) SELECT 'audit ' || g FROM generate_series(1, 1000) g; ALTER TABLE spike_move.audit REPLICA IDENTITY FULL");
  const loadMs = performance.now() - loadStart;
  const bytes = (await one<{ size: string }>(a, "SELECT pg_total_relation_size('spike_move.users') + pg_total_relation_size('spike_move.events') + pg_total_relation_size('spike_move.audit') AS size")).size;

  // A writer that never stops until the schema is fenced: inserts and updates at about `rate` per second.
  let writing = true;
  let writes = 0;
  const errors: { at: number; code: string }[] = [];
  const writer = (async () => {
    const tick = 1000 / rate;
    while (writing) {
      const started = performance.now();
      try {
        await a.exec("INSERT INTO spike_move.events (user_id, kind, payload) VALUES (gen_random_uuid(), 'live', '{}'); UPDATE spike_move.users SET bio = 'edited' WHERE id = (SELECT id FROM spike_move.users LIMIT 1)");
        writes++;
      } catch (error) {
        errors.push({ at: performance.now(), code: String((error as { errno?: string }).errno ?? error) });
        await sleep(20);
      }
      await sleep(Math.max(0, tick - (performance.now() - started)));
    }
  })();

  const syncStart = performance.now();
  await a.exec("CREATE PUBLICATION spike_pub FOR TABLES IN SCHEMA spike_move");
  await b.exec(`CREATE SUBSCRIPTION spike_sub CONNECTION '${FROM_B}' PUBLICATION spike_pub WITH (copy_data = true)`);
  for (;;) {
    const state = await one<{ pending: number }>(b, "SELECT count(*) FILTER (WHERE srsubstate <> 'r')::int AS pending FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid = r.srsubid WHERE s.subname = 'spike_sub'");
    const total = await one<{ n: number }>(b, "SELECT count(*)::int AS n FROM pg_subscription_rel r JOIN pg_subscription s ON s.oid = r.srsubid WHERE s.subname = 'spike_sub'");
    if (state.pending === 0 && total.n === 3) break;
    await sleep(200);
  }
  const initialSyncMs = performance.now() - syncStart;

  // Catch up with the live writes, then pause.
  const applied = () => one<{ remote: string | null }>(b, "SELECT o.remote_lsn::text AS remote FROM pg_replication_origin_status o WHERE o.external_id = 'pg_' || (SELECT oid FROM pg_subscription WHERE subname = 'spike_sub')");
  const reached = async (lsn: string) => {
    const row = await applied();
    return row?.remote !== null && row?.remote !== undefined && (await one<{ ok: boolean }>(b, `SELECT '${row.remote}'::pg_lsn >= '${lsn}'::pg_lsn AS ok`)).ok;
  };
  await sleep(500);
  const pauseStart = performance.now();
  let lockedAt = 0;
  let caughtUpMs = 0;
  let sequencesMs = 0;
  let verifyMs = 0;
  let fromA = "";
  let fromB = "";
  // One source transaction holds the locks for the whole pause (the package's own transaction wrapper: deadlines, discard on failure).
  const holder = connect(bunDriver(A, { ...options, max: 1, idleTimeoutSeconds: 0 }), { deadlineMs: 600_000, maxPending: 4 });
  try {
    await holder.transaction(
      async (tx) => {
        await tx.exec("LOCK TABLE spike_move.users, spike_move.events, spike_move.audit IN SHARE ROW EXCLUSIVE MODE");
        lockedAt = performance.now();
        const target = (await one<{ lsn: string }>(a, "SELECT pg_current_wal_lsn()::text AS lsn")).lsn;
        while (!(await reached(target))) await sleep(2);
        caughtUpMs = performance.now() - lockedAt;
        const seqStart = performance.now();
        const seq = await one<{ last: string }>(a, "SELECT last_value::text AS last FROM spike_move.events_id_seq");
        await b.exec(`SELECT setval('spike_move.events_id_seq', ${seq.last})`);
        sequencesMs = performance.now() - seqStart;

        const verifyStart = performance.now();
        const counts = async (db: { query: typeof a.query }) =>
          (await db.query<{ t: string; n: string }>("SELECT 'users' AS t, count(*)::text AS n FROM spike_move.users UNION ALL SELECT 'events', count(*)::text FROM spike_move.events UNION ALL SELECT 'audit', count(*)::text FROM spike_move.audit ORDER BY 1")).map((r) => `${r.t}=${r.n}`).join(",");
        [fromA, fromB] = await Promise.all([counts(a), counts(b)]);
        verifyMs = performance.now() - verifyStart;
        await tx.exec("ALTER SCHEMA spike_move RENAME TO spike_move__moved");
      },
      { statementTimeoutMs: 600_000, lockTimeoutMs: 5000 },
    );
  } finally {
    await holder.close();
  }
  const pauseMs = performance.now() - lockedAt;
  await sleep(300); // writers that waited on the locks run now, against the renamed schema
  writing = false;
  await writer;
  // Nothing may have been written to the abandoned copy after the comparison: the writers that waited on the locks must have failed, not succeeded.
  const afterRename = (await a.query<{ t: string; n: string }>("SELECT 'users' AS t, count(*)::text AS n FROM spike_move__moved.users UNION ALL SELECT 'events', count(*)::text FROM spike_move__moved.events UNION ALL SELECT 'audit', count(*)::text FROM spike_move__moved.audit ORDER BY 1")).map((r) => `${r.t}=${r.n}`).join(",");
  const result = {
    sizeMB,
    tableBytesMB: Math.round(Number(bytes) / 1048576),
    loadMs: Math.round(loadMs),
    initialSyncMs: Math.round(initialSyncMs),
    liveWrites: writes,
    staleWriterErrors: errors.length,
    staleWriterErrorCodes: [...new Set(errors.map((e) => e.code))],
    pause: { total: Math.round(pauseMs), waitForSubscriber: Math.round(caughtUpMs), sequences: Math.round(sequencesMs), verifyCounts: Math.round(verifyMs), lockAcquisition: Math.round(lockedAt - pauseStart) },
    countsMatch: fromA === fromB,
    abandonedCopyUnchangedAfterRename: afterRename === fromA,
    counts: fromB,
  };
  await b.exec("DROP SUBSCRIPTION spike_sub");
  await a.exec("DROP PUBLICATION spike_pub");
  await reset();
  return result;
}

try {
  for (const size of sizes) console.log(JSON.stringify(await run(size)));
} finally {
  await a.close(1000);
  await b.close(1000);
}
