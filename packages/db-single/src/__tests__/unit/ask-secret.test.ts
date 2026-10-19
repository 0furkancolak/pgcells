/** Secret input: the prompt is not shown in the terminal, raw mode is restored on every exit path, and URL validation does not leak the value. */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { askSecret, postgresUrl } from "../../core/tools/ask-secret";

/** Fake terminal: raw-mode calls are recorded, and what is written accumulates in `shown`. */
function fakeTerminal(isTTY: boolean) {
  const input = Object.assign(new PassThrough(), { isTTY, rawModes: [] as boolean[], setRawMode(raw: boolean) { input.rawModes.push(raw); } });
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => (shown += chunk.toString()));
  return { input, output, shown: () => shown };
}

test("askSecret in a terminal hides the typed URL, supports backspace and restores the terminal", async () => {
  const term = fakeTerminal(true);
  const answer = askSecret("URL: ", term.input, term.output);
  term.input.write("postgres://u:s3cretX");
  term.input.write("@db/app\r");
  expect(await answer).toBe("postgres://u:s3cret@db/app");
  expect(term.shown()).toStartWith("URL: ");
  expect(term.shown()).not.toContain("s3cret");
  expect(term.input.rawModes).toEqual([true, false]);
});

test("askSecret: Ctrl+C cancels with USAGE; redirected input reads the first line without raw mode", async () => {
  const term = fakeTerminal(true);
  const cancelled = askSecret("URL: ", term.input, term.output);
  term.input.write("postgres://x");
  expect(await cancelled.then(() => "", (error: { code?: string }) => error.code)).toBe("USAGE");
  expect(term.input.rawModes).toEqual([true, false]);

  const piped = fakeTerminal(false);
  const line = askSecret("URL: ", piped.input, piped.output);
  piped.input.end("postgres://a:b@h/db\nignored\n");
  expect(await line).toBe("postgres://a:b@h/db");
  expect(piped.input.rawModes).toEqual([]);
});

const message = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return `${(error as { code?: string }).code}: ${(error as Error).message}`;
  }
  return "";
};

test("a hidden URL answer must be postgres://; the rejection never repeats the value", () => {
  for (const value of [undefined, "", "not a url", "mysql://u:p@h/db"]) expect(message(() => postgresUrl(value, "Source database URL")), String(value)).toStartWith("USAGE: Source database URL");
  const refused = message(() => postgresUrl("https://admin:hunter2@h/db", "PgBouncer admin URL"));
  expect(refused).toStartWith("USAGE: PgBouncer admin URL");
  expect(refused).not.toContain("hunter2");
  expect(postgresUrl("postgresql://u:p@staging.example.com:5432/app", "Source database URL").hostname).toBe("staging.example.com");
});

test("a stream error gives the terminal back instead of hanging in raw mode", async () => {
  const term = fakeTerminal(true);
  const answer = askSecret("URL: ", term.input, term.output);
  term.input.emit("error", new Error("read failed"));
  expect(await answer.then(() => "", (error: { code?: string }) => error.code)).toBe("USAGE");
  expect(term.input.rawModes).toEqual([true, false]);
});

test("the end of the input stream gives the terminal back", async () => {
  const term = fakeTerminal(true);
  const answer = askSecret("URL: ", term.input, term.output);
  term.input.end();
  expect(await answer.then(() => "", (error: { code?: string }) => error.code)).toBe("USAGE");
  expect(term.input.rawModes).toEqual([true, false]);
});

test.each(["SIGINT", "SIGTERM"])("%s while the hidden question is open cancels with USAGE and restores the terminal", async (signal) => {
  const term = fakeTerminal(true);
  const signals = new EventEmitter();
  const answer = askSecret("URL: ", term.input, term.output, signals);
  expect(signals.listenerCount(signal)).toBe(1);
  signals.emit(signal);
  expect(await answer.then(() => "", (error: { code?: string }) => error.code)).toBe("USAGE");
  expect(term.input.rawModes).toEqual([true, false]);
  expect(signals.listenerCount(signal)).toBe(0); // no listener is left behind
});
