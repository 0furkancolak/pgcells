/** Source file format: `<yyyyMMddHHmmss>_<snake_name>.sql` (UTC; `.ts` is also allowed for seeds). ID = the name without extension, order = ID order.
 * Migration: a `--up` line + SQL, a `--down` line + SQL; the checksum covers the whole file. Seed: DML only if SQL, a default
 * async function if TS. Codegen and the registry use the same compiler. */
import { createHash } from "node:crypto";
import type { Statement } from "pgsql-ast-parser";
import { type Queryable, runContext } from "../context";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { maskSqlComments, prepareMigration } from "../sql/compiler";

export const MIGRATION_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const SOURCE_FILE = /^(\d{14}_[a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.(sql|ts)$/;

type Prepared = ReturnType<typeof prepareMigration>;
export interface Migration {
  readonly id: string;
  readonly checksum: string;
  readonly up: Prepared;
  /** If absent, `--down` is empty: it cannot be rolled back. */
  readonly down?: Prepared;
  /** If the single up statement is CREATE INDEX CONCURRENTLY: it runs outside a transaction, and on retry the index is inspected. */
  readonly concurrentIndex?: Readonly<{ name: string; table: string; unique: boolean }>;
  /** The name of the index to drop if the single down statement is DROP INDEX CONCURRENTLY. */
  readonly concurrentDrop?: string;
}

/** The context a TS seed receives: a schema-bound `query` (generated queries) and the seed's own transaction. */
export interface SeedContext {
  readonly schema: string;
  readonly query: Queryable["query"];
  /** A seed already runs in a single transaction; `work` runs with the same context. */
  transaction<T>(work: (db: Queryable) => Promise<T>): Promise<T>;
}
export interface Seed {
  readonly id: string;
  readonly checksum: string;
  run(tx: Connection, schema: string, verify: () => Promise<void>): Promise<void>;
}
/** An entry in the generated list: SQL text or a TS function whose checksum was computed at codegen. */
export type SeedSource = string | { readonly checksum: string; readonly run: (context: SeedContext) => Promise<void> };

const invalid = (message: string) => new AppError("MIGRATION_INVALID", message);
export const checksum = (text: string) => createHash("sha256").update(text).digest("hex");

/** UTC `yyyyMMddHHmmss`. */
export const migrationPrefix = (now: Date) =>
  [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()]
    .map((part, i) => String(part).padStart(i ? 2 : 4, "0"))
    .join("");

/** The `--up` and `--down` sections; the markers are whole lines (no space after `--`), and any other `--word` line is rejected. */
export function splitMigration(id: string, source: string): { up: string; down: string } {
  const markers = [...source.matchAll(/^--(\w+)[ \t]*\r?$/gm)];
  const [up, down] = markers;
  if (markers.map((m) => m[1]).join() !== "up,down" || !up || !down)
    throw invalid(`${id}: expected one --up line followed by one --down line, found [${markers.map((m) => m[0].trim())}]`);
  if (source.slice(0, up.index).trim()) throw invalid(`${id}: content before --up`);
  return { up: source.slice(up.index + up[0].length, down.index), down: source.slice(down.index + down[0].length) };
}

/** CONCURRENTLY is accepted only as the single statement of a section. */
function concurrentIndexStatement(id: string, statements: readonly Statement[], kind: "create index" | "drop index") {
  const found = statements.find((s) => (s.type === "create index" || s.type === "drop index") && s.concurrently);
  if (found && (statements.length !== 1 || found.type !== kind)) {
    const section = kind === "create index" ? "--up" : "--down";
    throw invalid(`${id}: ${found.type.toUpperCase()} CONCURRENTLY must be the only statement of a ${section} section`);
  }
  return found;
}

/** An ordered `[id, source]` list: the ID format and increasing order are checked, and errors are prefixed with the ID. */
function compileList<S, T>(list: readonly (readonly [string, S])[], compileOne: (id: string, source: S) => T): readonly T[] {
  let previous = "";
  return Object.freeze(
    list.map(([id, source]) => {
      if (!SOURCE_FILE.test(`${id}.sql`) || id <= previous) throw invalid(`${id}: IDs must be <yyyyMMddHHmmss>_<snake_name>, unique and increasing`);
      previous = id;
      try {
        return Object.freeze(compileOne(id, source));
      } catch (error) {
        if (error instanceof AppError && !error.message.startsWith(id)) throw new AppError(error.code, `${id}: ${error.message}`);
        throw error;
      }
    }),
  );
}

/** Enum types are carried across files. */
export function compileMigrations(list: readonly (readonly [string, string])[]): readonly Migration[] {
  const types = new Set<string>();
  return compileList(list, (id, source) => {
    const sections = splitMigration(id, source);
    const up = prepareMigration(sections.up, types);
    const down = maskSqlComments(sections.down).trim() ? prepareMigration(sections.down, new Set(types)) : undefined;
    const index = concurrentIndexStatement(id, up.statements, "create index");
    const drop = down && concurrentIndexStatement(id, down.statements, "drop index");
    if (index?.type === "create index" && !index.indexName) throw invalid(`${id}: concurrent index needs a name`);
    if (drop?.type === "drop index" && drop.names.length !== 1) throw invalid(`${id}: DROP INDEX CONCURRENTLY takes one index`);
    return {
      id,
      checksum: checksum(source),
      up,
      down,
      concurrentIndex:
        index?.type === "create index" ? Object.freeze({ name: index.indexName?.name ?? "", table: index.table.name, unique: !!index.unique }) : undefined,
      concurrentDrop: drop?.type === "drop index" ? drop.names[0]?.name : undefined,
    };
  });
}

/** SQL seed: INSERT/UPDATE/DELETE bound to the schema. TS seed: called with a schema-bound context. */
export function compileSeeds(list: readonly (readonly [string, SeedSource])[]): readonly Seed[] {
  return compileList(list, (id, source): Seed => {
    if (typeof source !== "string") {
      const run = (tx: Connection, schema: string) => runContext(tx, undefined, schema, (db) => source.run({ schema, query: db.query, transaction: (work) => work(db) }));
      return { id, checksum: source.checksum, run };
    }
    const prepared = prepareMigration(source);
    if (prepared.statements.some((s) => !["insert", "update", "delete"].includes(s.type)))
      throw invalid(`${id}: SQL seeds may only contain INSERT, UPDATE or DELETE`);
    async function run(tx: Connection, schema: string, verify: () => Promise<void>) {
      for (const statement of prepared.bind(schema)) {
        await verify();
        await tx.exec(statement);
      }
    }
    return { id, checksum: checksum(source), run };
  });
}
