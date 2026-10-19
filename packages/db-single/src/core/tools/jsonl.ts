/** JSON Lines files: reading line by line (decompressing if `.gz`), splitting into batches and gzipped writing. */
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

/** The file's lines (including empty lines); a file with a `.gz` extension is decompressed while reading. */
export function readLines(path: string): AsyncIterable<string> {
  const input = createReadStream(path);
  return createInterface({ input: path.endsWith(".gz") ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
}

/** Groups the non-empty lines into groups of length `size`; the last group may be shorter. */
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

/** A gzip writer for `file`. `write` adds the line break itself and waits for the stream to drain if it fills up; `close` waits until the file is closed. */
export function openGzipWriter(file: string): GzipWriter {
  const gzip = createGzip();
  const done = finished(gzip.pipe(createWriteStream(file)));
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
