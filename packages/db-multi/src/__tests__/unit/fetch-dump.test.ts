/** `dump fetch` saf parçaları: URL doğrulama, container hedefi, pg_dump argümanları ve parola gizleme. Gizli girdinin kendisi
 * `ask-secret.test.ts`tedir. */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerTarget, dumpArguments, fetchDump, redact, sourceUrl } from "../../core/tools/fetch-dump";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Yalnızca dosya adı kontrolleriyle ilgilenen testler için: URL sorulursa test düşer (DB'ye bağlanılmaz). */
async function failedFetch(file: string, schemas?: readonly string[]) {
  let asked = false;
  const error = await fetchDump(file, {
    url: () => {
      asked = true;
      return Promise.resolve("postgres://u:p@127.0.0.1:1/app");
    },
    schemas,
  }).then(
    () => undefined,
    (reason: { code?: string; message?: string }) => reason,
  );
  return { asked, code: error?.code, message: error?.message };
}

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

test("source URL is required and must be postgres://", () => {
  expect(code(() => sourceUrl(undefined))).toBe("USAGE");
  expect(code(() => sourceUrl("not a url"))).toBe("USAGE");
  expect(code(() => sourceUrl("mysql://u:p@h/db"))).toBe("USAGE");
  expect(sourceUrl("postgresql://u:p@staging.example.com:5432/app").hostname).toBe("staging.example.com");
});

test("docker target: remote host unchanged; local host via host network on Linux, host.docker.internal elsewhere", () => {
  const remote = new URL("postgres://u:p@staging.example.com:6543/app?sslmode=require");
  expect(dockerTarget(remote, "darwin")).toEqual({ url: remote.href, flags: [] });
  const local = new URL("postgres://u:p@127.0.0.1:5540/app");
  expect(dockerTarget(local, "linux")).toEqual({ url: local.href, flags: ["--network=host"] });
  expect(dockerTarget(local, "darwin")).toEqual({ url: "postgres://u:p@host.docker.internal:5540/app", flags: [] });
  expect(dockerTarget(new URL("postgres://u:p@localhost/app"), "win32").url).toBe("postgres://u:p@host.docker.internal/app");
});

test("pg_dump arguments: no owner/privileges; schema names validated before they reach the container", () => {
  expect(dumpArguments()).toEqual(["--no-owner", "--no-privileges"]);
  expect(dumpArguments(["panel", "public"])).toEqual(["--no-owner", "--no-privileges", "--schema=panel", "--schema=public"]);
  for (const bad of ["Panel", "a;b", "x --file=/etc/passwd", "", "a.b"]) expect(code(() => dumpArguments([bad])), bad).toBe("USAGE");
});

test("redact hides the raw and URL-encoded password and any credentialed URL", () => {
  const url = new URL("postgres://app:s%40cret%2Fx@db.example.com/app");
  const text = 'password authentication failed; s@cret/x; s%40cret%2Fx; postgres://other:hunter2@h/db';
  const hidden = redact(text, url);
  expect(hidden).not.toContain("s@cret/x");
  expect(hidden).not.toContain("s%40cret%2Fx");
  expect(hidden).not.toContain("hunter2");
  expect(hidden).toContain("postgres://other:***@h/db");
});

test("an existing .partial is refused before the URL question and is never deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-dump-partial-"));
  dirs.push(dir);
  const file = join(dir, "staging.sql.gz");
  const partial = `${file}.partial`;
  await writeFile(partial, "YARIM INDIRME");

  const failed = await failedFetch(file);
  expect(failed.code).toBe("USAGE");
  expect(failed.message).toContain(partial);
  expect(failed.asked).toBe(false); // URL sorulmaz, DB'ye bağlanılmaz
  expect(await readFile(partial, "utf8")).toBe("YARIM INDIRME"); // başka çalıştırmanın dosyası silinmez
});

test("redact never throws: a password that is not a valid percent escape is hidden as it is", () => {
  const url = new URL("postgres://app:local%admin_password@db.example.com/app");
  const hidden = redact('password authentication failed for user "app": local%admin_password', url);
  expect(hidden).not.toContain("local%admin_password");
  expect(hidden).toContain("***");
  for (const password of ["%", "%zz", "100%", "a%2", "%E0%A4%A"]) {
    const bad = new URL(`postgres://app:${password}@db.example.com/app`);
    expect(() => redact(`connection failed: ${password}`, bad), password).not.toThrow();
    expect(redact(`connection failed: ${password}`, bad), password).not.toContain(password);
  }
  expect(redact("nothing to hide", new URL("postgres://app@db.example.com/app"))).toBe("nothing to hide");
});

test("a source password that cannot be percent-decoded still fails with DUMP_FETCH_FAILED, not a swallowed error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fetch-dump-percent-"));
  dirs.push(dir);
  const file = join(dir, "staging.sql.gz");
  const failed = await fetchDump(file, { url: "postgres://app:local%admin_password@127.0.0.1:1/app" }).then(
    () => undefined,
    (error: { code?: string; message?: string }) => error,
  );
  expect(failed?.code).toBe("DUMP_FETCH_FAILED");
  expect(failed?.message).not.toContain("local%admin_password");
  expect(await readFile(file, "utf8").catch(() => "yok")).toBe("yok");
});
