import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { openReplicaSource, replicaConflict } from "../../core/tools/replica-source";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@primary.example.com/app";
const DIRECT = "postgres://app:secret-pw@replica.example.com/app";
const POOLED = "postgres://app:secret-pw@pooled.example.com/app";
let pid = 100;

type State = { inRecovery?: boolean; lagMs?: number | null; identity?: string | null; behind?: number };
function open(state: State = {}, extra?: { fail?: unknown }, options: { replicaMaxLagMs?: number } = {}) {
  let behind = state.behind ?? 0;
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_backend_pid")) return [{ pid: pool.url.includes("pooled") ? 7 : ++pid }];
    if (text.includes("platform.node_identity")) return state.identity === null ? [] : [{ database_id: state.identity ?? "db0" }];
    if (text.includes("AS ok")) return behind-- > 0 ? [{ ok: false, lsn: "0/2000000" }] : [{ ok: true, lsn: "0/3000010" }];
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: state.inRecovery ?? true, caught_up: false, lag_ms: state.lagMs === undefined ? 20 : state.lagMs }];
    if (text.includes("pg_last_wal_replay_lsn()::")) return [{ lsn: "0/2FFFF00" }];
    if (text.includes("pg_stat_database_conflicts")) return [{ n: "0" }];
    if (extra?.fail) throw extra.fail;
    return [];
  });
  const app = createManagement(createConfig([PRIMARY]), { driver: fake.driver, ...options });
  return { app, fake };
}
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => (error as { code: string; message: string }));

test("a direct, caught-up replica opens and exposes its connection and replay position", async () => {
  const { app, fake } = open();
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  expect(source.has("db0")).toBe(true);
  expect(source.has("db1")).toBe(false);
  expect(source.replayLsn("db0")).toBe("0/2FFFF00");
  await source.node("db0").query("SELECT 1");
  expect(fake.commands.some((command) => command.url === DIRECT && command.text === "SELECT 1")).toBe(true);
  await source.close();
  expect(fake.pools.filter((pool) => pool.url === DIRECT).every((pool) => pool.closed)).toBe(true);
});

test("refusals: pooler URL, not a replica, lag over the threshold or unknown, two URLs per database, no URL, bad format", async () => {
  const pooled = open();
  expect(await code(openReplicaSource(pooled.app, `db0=${POOLED}`))).toMatchObject({ code: "DIRECT_CONNECTION_REQUIRED" });
  expect(await code(openReplicaSource(open({ inRecovery: false }).app, `db0=${DIRECT}`))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open({ lagMs: 60_000 }).app, `db0=${DIRECT}`))).toMatchObject({ code: "REPLICA_LAG_EXCEEDED" });
  expect(await code(openReplicaSource(open({ lagMs: null }).app, `db0=${DIRECT}`))).toMatchObject({ code: "REPLICA_LAG_EXCEEDED" });
  expect(await code(openReplicaSource(open().app, `db0=${DIRECT},db0=${DIRECT}?x=1`))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open().app, ""))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open().app, `db9=${DIRECT}`))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open().app, `${PRIMARY}?application_name=x`))).toMatchObject({ code: "INVALID_CONFIG" });
});

test("a failed validation closes the pools it opened and no message carries the URL, host or password", async () => {
  const { app, fake } = open({ lagMs: 60_000 });
  const error = await code(openReplicaSource(app, `db0=${DIRECT}`));
  expect(fake.pools.filter((pool) => pool.url === DIRECT).every((pool) => pool.closed)).toBe(true);
  for (const secret of ["secret-pw", "replica.example.com", "primary.example.com", "postgres://"]) expect(error?.message).not.toContain(secret);
});

test("a recovery conflict (SQLSTATE 40001) becomes REPLICA_CONFLICT; any other error passes through untouched", async () => {
  const conflict = Object.assign(new Error("canceling statement due to conflict with recovery"), { code: "40001" });
  expect(replicaConflict(conflict)).toMatchObject({ code: "REPLICA_CONFLICT" });
  const serialization = Object.assign(new Error("could not serialize access"), { code: "40001" });
  expect(replicaConflict(serialization)).toBe(serialization);
  const other = new Error("boom");
  expect(replicaConflict(other)).toBe(other);

  const { app } = open({}, { fail: conflict });
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  expect(await code(source.node("db0").query("SELECT 2"))).toMatchObject({ code: "REPLICA_CONFLICT" });
  expect(await code(source.node("db0").transaction((tx) => tx.query("SELECT 3")))).toMatchObject({ code: "REPLICA_CONFLICT" });
  await source.close();
});

test("a replica that belongs to another database is refused at open", async () => {
  expect(await code(openReplicaSource(open({ identity: "db1" }).app, `db0=${DIRECT}`))).toMatchObject({ code: "INVALID_CONFIG" });
  expect(await code(openReplicaSource(open({ identity: null }).app, `db0=${DIRECT}`))).toMatchObject({ code: "INVALID_CONFIG" });
});

test("catchUp waits until the replica replayed the primary's current position, then returns where it stands", async () => {
  const { app } = open({ behind: 2 });
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  expect(await source.catchUp("db0")).toBe("0/3000010");
  await source.close();
});

test("catchUp fails with REPLICA_LAG_EXCEEDED when the replica does not catch up within the lag limit", async () => {
  const { app } = open({ behind: 1_000_000 }, undefined, { replicaMaxLagMs: 60 });
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  expect(await code(source.catchUp("db0"))).toMatchObject({ code: "REPLICA_LAG_EXCEEDED" });
  await source.close();
});

/** Standby'ın çakışma sayacı (`pg_stat_database_conflicts`) iş sırasında `bump` ile artırılabilir. */
function conflictFixture() {
  const state = { counter: 5 };
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_backend_pid")) return [{ pid: ++pid }];
    if (text.includes("platform.node_identity")) return [{ database_id: "db0" }];
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: true, caught_up: false, lag_ms: 20 }];
    if (text.includes("pg_last_wal_replay_lsn()::")) return [{ lsn: "0/2FFFF00" }];
    if (text.includes("pg_stat_database_conflicts")) return [{ n: String(state.counter) }];
    void pool;
    return [];
  });
  const app = createManagement(createConfig([PRIMARY]), { driver: fake.driver });
  const diagnoses = () => fake.commands.filter((command) => command.text.includes("pg_stat_database_conflicts")).length;
  return { state, app, diagnoses };
}

test("a connection lost during a transaction while the standby's conflict counter rose is REPLICA_CONFLICT", async () => {
  const { state, app } = conflictFixture();
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  const lost = new Error("connection closed"); // sürücüler terminate edilen bağlantıda yalnızca genel bir hata verir
  expect(await code(source.node("db0").transaction(() => Promise.reject(lost)))).toMatchObject({ message: "connection closed" }); // sayaç artmadı
  expect(
    await code(
      source.node("db0").transaction(async () => {
        state.counter += 1;
        throw lost;
      }),
    ),
  ).toMatchObject({ code: "REPLICA_CONFLICT" });
  await source.close();
});

test("the counter baseline is taken per transaction: an earlier conflict does not relabel a later unrelated failure", async () => {
  const { state, app } = conflictFixture();
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  state.counter += 3; // açılıştan sonra, transaction'dan önce başka bir çakışma
  const lost = new Error("connection closed");
  expect(await code(source.node("db0").transaction(() => Promise.reject(lost)))).toMatchObject({ message: "connection closed" });
  await source.close();
});

test("only connection-class failures are diagnosed: app errors, filesystem errors and plain SQL errors keep their own code", async () => {
  const { state, app, diagnoses } = conflictFixture();
  const source = await openReplicaSource(app, `db0=${DIRECT}`);
  const failing = (error: unknown) =>
    code(
      source.node("db0").transaction(async () => {
        state.counter += 1; // sayaç artsa bile
        throw error;
      }),
    );
  expect(await failing(Object.assign(new Error("no space"), { code: "ENOSPC" }))).toMatchObject({ code: "ENOSPC" });
  expect(await failing(Object.assign(new Error("relation does not exist"), { code: "42P01" }))).toMatchObject({ code: "42P01" });
  const { AppError } = await import("../../core/errors");
  expect(await failing(new AppError("SQL_UNSUPPORTED", "unsupported"))).toMatchObject({ code: "SQL_UNSUPPORTED" });
  // Her transaction başında bir kez taban sayaç okunur; yalnızca bağlantı sınıfı hatada sayaç bir kez daha okunur.
  const plain = diagnoses();
  await failing(Object.assign(new Error("relation does not exist"), { code: "42P01" }));
  expect(diagnoses()).toBe(plain + 1);
  const connection = diagnoses();
  await failing(Object.assign(new Error("not queryable"), {})); // pg'nin kopma mesajı: CONNECTION_CLOSED
  expect(diagnoses()).toBe(connection + 2);
  await source.close();
});
