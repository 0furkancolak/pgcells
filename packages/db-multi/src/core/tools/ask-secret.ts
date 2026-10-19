/** URLs that carry a password are asked for through hidden input, not a command-line option: every user on the machine can read argv with `ps`,
 * and an option also ends up in the shell history. `dump fetch`, `users import --from-url` and `doctor --pgbouncer-url` use the same prompt. */
import { AppError, errorCode } from "../errors";

const usage = (message: string) => new AppError("USAGE", message);
/** Terminal control characters: Ctrl+C, Ctrl+D and backspace (escapes in source instead of raw bytes). */
const [CTRL_C, CTRL_D, BACKSPACE] = ["\u0003", "\u0004", "\u007f"];
/** A signal arriving while the prompt is open is also a way out: if raw mode is not given back, the user's shell is left without echo. */
const CANCEL_SIGNALS = ["SIGINT", "SIGTERM"] as const;

export type SecretInput = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(raw: boolean): unknown };
/** Signal source; tests pass their own emitter instead of the real `process`. */
export type SignalSource = Pick<NodeJS.EventEmitter, "once" | "removeListener">;

/** Writes the question to `output` and reads one line. On a terminal what is typed is not shown (`*` per character, backspace works); Ctrl+C and
 * Ctrl+D cancel (`USAGE`). On non-terminal input (redirection) the first line is read. Raw mode is given back on every exit path:
 * end of line, Ctrl+C/Ctrl+D, end of stream, stream error and SIGINT/SIGTERM. */
export function askSecret(
  question: string,
  input: SecretInput = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
  signals: SignalSource = process,
): Promise<string> {
  output.write(question);
  const raw = Boolean(input.isTTY && input.setRawMode);
  if (raw) input.setRawMode?.(true);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: AppError) => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      for (const signal of CANCEL_SIGNALS) signals.removeListener(signal, onCancel);
      if (raw) input.setRawMode?.(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onEnd = () => finish(value ? undefined : usage("Nothing was entered at the hidden prompt"));
    /** Stream error: the question can never be answered, the terminal is given back. */
    const onError = (error: unknown) => finish(usage(`Hidden input could not be read (${errorCode(error)})`));
    const onCancel = () => finish(usage("Hidden input cancelled"));
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n") return finish();
        if (char === CTRL_C || char === CTRL_D) return finish(usage("Hidden input cancelled"));
        if (char === BACKSPACE || char === "\b") {
          if (value && raw) output.write("\b \b");
          value = value.slice(0, -1);
          continue;
        }
        value += char;
        if (raw) output.write("*");
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    for (const signal of CANCEL_SIGNALS) signals.once(signal, onCancel);
    input.resume();
  });
}

/** postgres:// URL from hidden input. Error messages do not contain the value: the message ends up in the log and on the terminal. */
export function postgresUrl(value: string | undefined, subject: string): URL {
  if (!value) throw usage(`${subject} was not entered`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usage(`${subject} is not a valid postgres:// URL`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw usage(`${subject} must start with postgres:// or postgresql://`);
  return url;
}
