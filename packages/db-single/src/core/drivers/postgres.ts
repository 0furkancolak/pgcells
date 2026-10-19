/** postgres.js driver (optional peer `postgres`); works on Bun, Node and Cloudflare Workers. */
import postgres from "postgres";
import { type Connection, type Driver, type Reserved, withTimeout } from "../driver";

type Sql = Pick<postgres.Sql, "unsafe">;

/** Built-in array types are parsed here; `fetch_types` runs a pg_type query with no caller on every new connection, and its
 * failure (statement_timeout, PgBouncer 08P01) kills the process as an unhandled rejection. */
const text = (value: string) => value;
const arrayElements: Record<number, (value: string) => unknown> = {
  1000: (value) => value === "t", // bool[]
  1005: Number, // int2[]
  1007: Number, // int4[]
  1021: Number, // float4[]
  1022: Number, // float8[]
  1009: text, // text[]
  1015: text, // varchar[]
  1016: text, // int8[] (string, like scalar int8)
  1231: text, // numeric[]
  2951: text, // uuid[]
  1185: (value) => new Date(value), // timestamptz[]
  199: JSON.parse, // json[]
  3807: JSON.parse, // jsonb[]
};

/** Single- or multi-dimensional PostgreSQL array text (`{1,"a b",NULL}`). */
function parseArray(input: string, element: (value: string) => unknown) {
  let position = 0;
  const parseQuoted = () => {
    let value = "";
    for (position++; input[position] !== '"'; position++) value += input[position] === "\\" ? input[++position] : input[position];
    position++;
    return element(value);
  };
  const parseBare = () => {
    const end = input.slice(position).search(/[,}]/) + position;
    const value = input.slice(position, end);
    position = end;
    return value === "NULL" ? null : element(value);
  };
  const parseList = (): unknown[] => {
    const items: unknown[] = [];
    position++;
    while (position < input.length && input[position] !== "}") {
      if (input[position] === "{") items.push(parseList());
      else if (input[position] === '"') items.push(parseQuoted());
      else items.push(parseBare());
      if (input[position] === ",") position++;
    }
    position++;
    return items;
  };
  return parseList();
}

const arrayTypes = Object.fromEntries(
  Object.entries(arrayElements).map(([oid, element]) => [
    `array${oid}`,
    { to: Number(oid), from: [Number(oid)], serialize: String, parse: (value: string) => parseArray(value, element) },
  ]),
);

/** Cancel hook of a postgres.js query (`Query#canceller`, 3.4.x). */
type Cancellable = { canceller?: ((query: unknown) => Promise<void>) | null };

/** `query.cancel()` drops the cancel Promise: if the cancel connection cannot be established (DB down), an unhandled rejection kills the process. The hook
 * is called directly and its error is swallowed; the running query returns with 57014. */
function cancelQuery(query: Cancellable) {
  const { canceller } = query;
  if (!canceller) return;
  query.canceller = null;
  canceller.call(query, query).catch(() => {});
}

function connection(sql: Sql, active?: Set<Cancellable>): Connection {
  /** A query running on a reserved connection is registered for cancellation; it is removed when it finishes (success or error). */
  function track<T>(pending: Promise<T>): Promise<T> {
    if (!active) return pending;
    active.add(pending as Cancellable);
    const done = () => void active.delete(pending as Cancellable);
    pending.then(done, done);
    return pending;
  }
  return {
    // Arrays are not supported as parameters; the engine sends JSON text.
    // The result array is not copied: postgres.js `Result` carries `count` and the arrays derived from it are plain `Array`s.
    query: async <R>(text: string, values: readonly unknown[] = []) =>
      (await track(sql.unsafe(text, values as postgres.ParameterOrJSON<never>[]))) as unknown as R[] & { count: number },
    exec: async (text) => {
      await track(sql.unsafe(text).simple());
    },
  };
}

export const postgresDriver: Driver = (url, options) => {
  const client = (max: number) =>
    postgres(url, {
      max,
      prepare: false,
      fetch_types: false,
      types: arrayTypes,
      idle_timeout: options.idleTimeoutSeconds,
      max_lifetime: options.maxLifetimeSeconds,
      connect_timeout: options.connectTimeoutSeconds,
      onclose: () => options.onClose?.(),
      onnotice: () => {},
    });
  // `sql.reserve()` never resolves when it has to open a new connection while fetch_types is off (3.4.9 connection.js ReadyForQuery drops the
  // reserve request). The pool consists of single-connection clients: at most `max`, a released one goes to a waiter or to the idle list; the
  // client reopens a dropped connection on the next query. Pool queries also borrow a session (single connection budget).
  const sessions: postgres.Sql[] = [];
  const idle: postgres.Sql[] = [];
  const waiting: ((session: postgres.Sql) => void)[] = [];
  const open = () => {
    const session = client(1);
    sessions.push(session);
    return session;
  };
  /** An idle session, otherwise a new session if under the limit, otherwise the first session to be released. */
  async function takeSession(): Promise<postgres.Sql> {
    const idleSession = idle.pop();
    if (idleSession) return idleSession;
    if (sessions.length < options.max) return open();
    return new Promise<postgres.Sql>((resolve) => waiting.push(resolve));
  }
  async function reserve(): Promise<Reserved> {
    const session = await takeSession();
    const active = new Set<Cancellable>();
    let released = false;
    return {
      ...connection(session, active),
      cancel: () => active.forEach(cancelQuery),
      // `discard`: the session is closed and no longer counted; if someone is waiting, a new session is opened for them.
      release: (discard) => {
        if (released) return;
        released = true;
        if (discard) {
          sessions.splice(sessions.indexOf(session), 1);
          session.end({ timeout: 0 }).catch(() => {});
        }
        const next = waiting.shift();
        if (next) next(discard ? open() : session);
        else if (!discard) idle.push(session);
      },
    };
  }
  async function borrow<T>(work: (session: Connection) => Promise<T>) {
    const session = await reserve();
    try {
      return await work(session);
    } finally {
      session.release();
    }
  }
  return {
    query: (text, values) => borrow((session) => session.query(text, values)),
    exec: (text) => borrow((session) => session.exec(text)),
    reserve,
    close: (ms) => withTimeout(Promise.all(sessions.map((session) => session.end({ timeout: ms / 1000 }))), ms + 100),
  };
};
