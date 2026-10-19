/** Bun SQL driver (no extra dependency; Bun only). It does not support COPY; `tools move` moves data as bulk JSON. Bun's
 * `query.cancel()` does not stop the running statement (tried: the statement commits), so there is no `cancel`; a connection whose deadline expires is discarded. */
import { SQL } from "bun";
import { type Connection, type Driver, normalizeParams, withTimeout } from "../driver";

function connection(sql: Pick<SQL, "unsafe">): Connection {
  return {
    // The result array is not copied: Bun's array carries `count`, and the arrays derived from it (`map`, `filter`) are plain `Array`s.
    query: async (text, values) => await sql.unsafe(text, normalizeParams(values)),
    exec: async (text) => {
      await sql.unsafe(text).simple();
    },
  };
}

export const bunDriver: Driver = (url, options) => {
  const sql = new SQL({
    url,
    max: options.max,
    prepare: false,
    idleTimeout: options.idleTimeoutSeconds,
    maxLifetime: options.maxLifetimeSeconds,
    connectionTimeout: options.connectTimeoutSeconds,
    onclose: () => options.onClose?.(),
  });
  return {
    ...connection(sql),
    async reserve() {
      const reserved = await sql.reserve();
      return {
        ...connection(reserved),
        // Bun rejects (synchronously or asynchronously) when releasing a closed connection; the connection is discarded in every case. `discard` closes the connection.
        release: (discard) => void Promise.resolve().then(() => (discard ? reserved.close({ timeout: 0 }) : reserved.release())).catch(() => {}),
      };
    },
    close: (ms) => withTimeout(sql.close({ timeout: ms / 1000 }), ms + 100),
  };
};
