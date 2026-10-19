import { expect, test } from "bun:test";
import { createConfig, loadConfig, managementSettings, runtimeSettings } from "../../core/config";

const one = "postgres://app:local@localhost:6432/one";
const two = "postgres://app:local@localhost:6432/two";

test("DATABASE_URLS is split, trimmed and identified by position; the first URL is the platform DB", () => {
  expect(loadConfig({ DATABASE_URLS: ` ${one} , ${two}` })).toEqual({
    nodes: [
      { id: "db0", url: one, replicas: [] },
      { id: "db1", url: two, replicas: [] },
    ],
  });
});

test("DATABASE_URLS is the only environment variable", () => {
  const config = loadConfig({ DATABASE_URLS: one, DATABASE_ADMIN_URLS: "postgres://ignored@h/x" });
  expect(JSON.stringify(config)).not.toContain("ignored");
});

test("database URL lists reject missing, empty, duplicate, non-PostgreSQL and schema-routing entries", () => {
  for (const DATABASE_URLS of [
    undefined,
    "",
    `${one},`,
    `${one},,${two}`,
    `${one},${one}`,
    "https://localhost/one",
    `${one}?options=-c%20search_path%3Dtenant_a`,
    `${one}?search_path=tenant_a`,
    Array.from({ length: 101 }, (_, i) => `postgres://h/db${i}`).join(","),
  ])
    expect(() => loadConfig({ DATABASE_URLS })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

test("options are typed defaults with finite bounds", () => {
  const config = createConfig([one]);
  expect(managementSettings(config)).toEqual({
    ...config,
    poolMax: 5,
    statementTimeoutMs: 5000,
    idleTimeoutSeconds: 20,
    maxLifetimeSeconds: 300,
    placementCacheMs: 5000,
    replicaMaxLagMs: 5000,
    replicaStatusMs: 5000,
    causalWaitMs: 200,
    migrationConcurrency: 16,
    perDatabaseConcurrency: 4,
    migrationStatementTimeoutMs: 30000,
    migrationLockTimeoutMs: 1000,
    shutdownGraceMs: 10000,
    placementCacheWaitMs: 30000,
    pageSize: 100,
  });
  expect(runtimeSettings(createConfig(one), { poolMax: 1 }).poolMax).toBe(1);
  for (const options of [
    { poolMax: 0 },
    { poolMax: 101 },
    { statementTimeoutMs: 1.5 },
    { perDatabaseConcurrency: 65 },
    { migrationConcurrency: 129 },
    { pageSize: 1001 },
  ])
    expect(() => managementSettings(config, options)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

const replicaA = "postgres://app:local@localhost:6433/one";
const replicaB = "postgres://app:local@localhost:6434/one?sslmode=require";
const replicaC = "postgres://app:local@localhost:6435/two";

test("DATABASE_REPLICA_URLS attaches replicas to databases by id; a repeated key adds replicas and the whole URL is kept", () => {
  const config = loadConfig({ DATABASE_URLS: `${one},${two}`, DATABASE_REPLICA_URLS: ` db0=${replicaA} , db0=${replicaB},db1=${replicaC}` });
  expect(config.nodes.map((node) => [node.id, node.replicas])).toEqual([
    ["db0", [replicaA, replicaB]],
    ["db1", [replicaC]],
  ]);
  // URL içindeki `=` ve sorgu dizesi anahtarı bozmaz.
  expect(config.nodes[0]?.replicas[1]).toBe(replicaB);
});

test("no replica variable, a blank one or the array form: replicas are optional", () => {
  expect(loadConfig({ DATABASE_URLS: one }).nodes[0]?.replicas).toEqual([]);
  expect(loadConfig({ DATABASE_URLS: one, DATABASE_REPLICA_URLS: "" }).nodes[0]?.replicas).toEqual([]);
  expect(loadConfig({ DATABASE_URLS: one, DATABASE_REPLICA_URLS: "   " }).nodes[0]?.replicas).toEqual([]);
  expect(createConfig([one], [`db0=${replicaA}`]).nodes[0]?.replicas).toEqual([replicaA]);
});

test("replica lists reject missing keys, unknown databases, empty and duplicate entries, other protocols, schema routing and more than 8 replicas", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `db0=postgres://app:local@localhost:${7000 + i}/one`).join(",");
  for (const DATABASE_REPLICA_URLS of [
    replicaA,
    `db2=${replicaA}`,
    "db0=",
    `db0=${replicaA},,db0=${replicaB}`,
    `db0=${replicaA},db0=${replicaA}`,
    `db0=${one}`,
    `db1=${one}`,
    "db0=https://localhost/one",
    `db0=${replicaA}?search_path=tenant_a`,
    `db0=${replicaA}?options=-c%20search_path%3Dtenant_a`,
    nine,
  ])
    expect(() => loadConfig({ DATABASE_URLS: `${one},${two}`, DATABASE_REPLICA_URLS })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

test("replica configuration errors never echo URLs or passwords", () => {
  let message = "";
  try {
    loadConfig({ DATABASE_URLS: one, DATABASE_REPLICA_URLS: `db0=${one}` });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toBe("Invalid configuration: DATABASE_REPLICA_URLS");
  expect(message).not.toContain("local");
});
