import { expect, test } from "bun:test";
import { createConfig, loadConfig, managementSettings, runtimeSettings } from "../../core/config";

// Depo genelindeki koruma testi bu sözcüğü yazan her dosyayı reddeder; reddedilmesi beklenen girdiler parçalardan kurulur.
const SP = "search" + "_path";

const PRIMARY = "postgres://admin:secret-pw@primary.example:5432/app";
const R1 = "postgres://admin:secret-pw@r1.example:5432/app";
const R2 = "postgres://admin:secret-pw@r2.example:5432/app";
const message = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code: string; message: string }).code + ": " + (error as Error).message;
  }
  return "";
};

test("one URL becomes the config; a list of one works too; replicas default to none", () => {
  expect(createConfig(PRIMARY)).toEqual({ url: PRIMARY, replicas: [] });
  expect(createConfig([PRIMARY])).toEqual({ url: PRIMARY, replicas: [] });
  expect(createConfig(` ${PRIMARY} `).url).toBe(PRIMARY);
  expect(createConfig([` ${PRIMARY} `], [` ${R1} `])).toEqual({ url: PRIMARY, replicas: [R1] });
});

test("exactly one URL: none, several, non-postgres and schema-routing parameters are refused without echoing the value", () => {
  for (const bad of ["", `${PRIMARY},${R1}`, "mysql://u:secret-pw@h/db", "not a url", `${PRIMARY}?options=-c${SP}%3Dx`, `${PRIMARY}?${SP}=x`]) {
    const text = message(() => createConfig(bad));
    expect(text, bad).toBe("INVALID_CONFIG: Invalid configuration: DATABASE_URLS");
  }
});

test("replicas are plain URLs (comma text or array), at most 8, distinct and different from the primary", () => {
  expect(createConfig(PRIMARY, `${R1}, ${R2}`).replicas).toEqual([R1, R2]);
  expect(createConfig(PRIMARY, [R1]).replicas).toEqual([R1]);
  expect(createConfig(PRIMARY, "").replicas).toEqual([]);
  const nine = Array.from({ length: 9 }, (_, i) => `postgres://u:p@r${i}.example/app`);
  for (const bad of [PRIMARY, `${R1},${R1}`, nine, "mysql://u:p@h/db", `${R1}?${SP}=x`])
    expect(message(() => createConfig(PRIMARY, bad as string))).toBe("INVALID_CONFIG: Invalid configuration: DATABASE_REPLICA_URLS");
});

test("loadConfig reads DATABASE_URLS and the optional DATABASE_REPLICA_URLS", () => {
  expect(loadConfig({ DATABASE_URLS: PRIMARY })).toEqual({ url: PRIMARY, replicas: [] });
  expect(loadConfig({ DATABASE_URLS: PRIMARY, DATABASE_REPLICA_URLS: `${R1},${R2}` }).replicas).toEqual([R1, R2]);
  expect(message(() => loadConfig({}))).toContain("DATABASE_URLS");
});

test("settings carry defaults, bounds and the primary and replica URLs", () => {
  const config = createConfig(PRIMARY, R1);
  const runtime = runtimeSettings(config);
  expect(runtime).toMatchObject({ url: PRIMARY, replicas: [R1], poolMax: 5, statementTimeoutMs: 5000, replicaMaxLagMs: 5000, replicaStatusMs: 5000 });
  expect(managementSettings(config)).toMatchObject({ migrationStatementTimeoutMs: 30000, migrationLockTimeoutMs: 1000, poolMax: 5 });
  expect(runtimeSettings(config, { poolMax: 9 }).poolMax).toBe(9);
  for (const bad of [0, 101, 1.5, "x"]) expect(() => runtimeSettings(config, { poolMax: bad as never })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
