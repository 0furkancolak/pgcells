/** JSON Lines files: line-by-line reading (decompressing if `.gz`), splitting into batches and gzipped writing. */
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/** The file's lines (including blank lines); a file with a `.gz` extension is decompressed while reading. */
export function readLines(path: string): AsyncIterable<string> {
  const input = createReadStream(path);
  return createInterface({ input: path.endsWith(".gz") ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
}

/** Groups non-blank lines into groups of length `size`; the last group may be shorter. */
export async function* batches(lines: AsyncIterable<string>, size: number): AsyncGenerator<string[]> {
  let batch: string[] = [];
  for await (const line of lines) {
    if (!line) continue;
    batch.push(line);
    if (batch.length === size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

export type GzipWriter = { write(line: string): Promise<void>; close(): Promise<void> };

/** Gzip writer for `file`. `append`: a new gzip member is appended to the end of the file (gunzip decompresses members back to back).
 * `write` adds the line ending itself and waits for drain if the stream fills; `close` waits until the file is closed. */
export function openGzipWriter(file: string, options: { append?: boolean } = {}): GzipWriter {
  const gzip = createGzip();
  const done = finished(gzip.pipe(createWriteStream(file, { flags: options.append ? "a" : "w" })));
  return {
    async write(line) {
      if (!gzip.write(`${line}\n`)) await once(gzip, "drain");
    },
    async close() {
      gzip.end();
      await done;
    },
  };
}
