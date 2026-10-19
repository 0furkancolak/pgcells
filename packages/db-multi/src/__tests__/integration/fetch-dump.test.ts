/** `dump fetch` gerçek compose DB'sine karşı: Docker'daki pg_dump ile schema yedeği, `dump split` ile okunabilirlik, var olan dosyayı
 * korumak ve yanlış parolada parolayı sızdırmayan hata. */
import { afterAll, expect } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchDump } from "../../core/tools/fetch-dump";
import { splitSqlDump } from "../../core/tools/sql-dump";
import { readLines } from "../../core/tools/jsonl";
import { directConfig, failure, integration } from "./helpers";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

integration("dump fetch downloads a schema as .sql.gz that dump split reads, never overwrites and hides a wrong password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-dump-"));
  dirs.push(dir);
  const url = directConfig().nodes[0]?.url ?? "";
  const file = join(dir, "platform.sql.gz");

  const result = await fetchDump(file, { url, schemas: ["platform"] });
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.image).toMatch(/^postgres:\d+-alpine$/);
  let text = "";
  for await (const line of readLines(file)) text += `${line}\n`;
  expect(text).toContain("CREATE TABLE platform.tenants");
  expect(text).toContain("PostgreSQL database dump complete");
  expect(text).not.toMatch(/OWNER TO|GRANT /);
  const analysis = await splitSqlDump(file, join(dir, "split"));
  expect(Object.keys(analysis.tables)).toContain("platform.tenants");

  expect(await failure(fetchDump(file, { url, schemas: ["platform"] }))).toBe("USAGE"); // var olan dosya korunur

  const wrong = new URL(url);
  wrong.password = "wrong_secret_value";
  const failed = fetchDump(join(dir, "wrong.sql.gz"), { url: wrong.href });
  const error = await failed.then(() => undefined, (reason: { code?: string; message?: string }) => reason);
  expect(error?.code).toBe("DUMP_FETCH_FAILED");
  expect(error?.message).not.toContain("wrong_secret_value");
  expect((await readdir(dir)).filter((name) => name.startsWith("wrong"))).toEqual([]); // yarım dosya kalmaz
});

integration("a target file created after the check is never overwritten and the downloaded data is kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-dump-race-"));
  dirs.push(dir);
  const url = directConfig().nodes[0]?.url ?? "";
  const file = join(dir, "raced.sql.gz");

  // `url` fonksiyonu dosya kontrolünden hemen sonra çağrılır: pencere tam buradadır.
  const raced = fetchDump(file, {
    url: async () => {
      await writeFile(file, "BASKA BIR YEDEK");
      return url;
    },
    schemas: ["platform"],
  });
  expect(await failure(raced)).toBe("USAGE");
  expect(await readFile(file, "utf8")).toBe("BASKA BIR YEDEK");
  expect((await stat(`${file}.partial`)).size).toBeGreaterThan(0); // indirilen veri kaybolmaz
});

integration("a failing pg_dump is reported as DUMP_FETCH_FAILED with its stderr and without the password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-dump-stderr-"));
  dirs.push(dir);
  const url = directConfig().nodes[0]?.url ?? "";
  const password = new URL(url).password;
  const file = join(dir, "missing-schema.sql.gz");

  // Bağlantı kurulur (serverMajor geçer), pg_dump olmayan schema'da hata verir: hata :139 yolundan gelir.
  const error = await fetchDump(file, { url, schemas: ["no_such_schema_here"] }).then(
    () => undefined,
    (reason: { code?: string; message?: string }) => reason,
  );
  expect(error?.code).toBe("DUMP_FETCH_FAILED");
  expect(error?.message).toContain("no matching schemas");
  expect(password.length).toBeGreaterThan(0);
  expect(error?.message).not.toContain(password);
  expect(await readdir(dir)).toEqual([]); // ne hedef ne yarım dosya kalır
});

integration("a signal during the download cancels with USAGE and removes this run's half file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-dump-cancel-"));
  dirs.push(dir);
  const url = directConfig().nodes[0]?.url ?? "";
  const file = join(dir, "cancelled.sql.gz");
  const controller = new AbortController();

  const running = fetchDump(file, { url, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  expect(await failure(running)).toBe("USAGE");
  expect(await readdir(dir)).toEqual([]);
});
