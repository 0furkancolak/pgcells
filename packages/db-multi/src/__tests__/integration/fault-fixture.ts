/** Fault-injection fixture: the app reaches PgBouncer (`pgbouncer-faults`) through toxiproxy `app-pooler`, and PgBouncer reaches PostgreSQL through `pooler-pg0` /
 * `pooler-pg1`, so each leg can be delayed, cut or blackholed (compose.yaml, src/core/local/faults). Toxiproxy API: http://127.0.0.1:8474. */
import { createConfig } from "../../core/config";
import { bunDriver } from "../../core/drivers/bun";

const API = "http://127.0.0.1:8474";
const CREDENTIALS = "admin:local_admin_password";
export const FAULT_URLS = [`postgres://${CREDENTIALS}@127.0.0.1:5581/db0`, `postgres://${CREDENTIALS}@127.0.0.1:5581/db1`];
export const faultConfig = () => createConfig(FAULT_URLS);
/** The PgBouncer console, reached through the same app-side proxy. */
export const CONSOLE_URL = `postgres://${CREDENTIALS}@127.0.0.1:5581/pgbouncer`;

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`toxiproxy ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

export const available = () =>
  fetch(`${API}/proxies`).then(
    (response) => response.ok,
    () => false,
  );

export function proxy(name: "app-pooler" | "pooler-pg0" | "pooler-pg1") {
  const path = `/proxies/${name}`;
  return {
    /** A toxic on both directions of the proxy until `reset()`. `timeout` with `timeout: 0` stalls the data forever without closing (a partition). */
    async toxic(type: "latency" | "timeout" | "reset_peer" | "bandwidth" | "slow_close" | "limit_data", attributes: Record<string, number>, stream: "upstream" | "downstream" = "downstream") {
      await call("POST", `${path}/toxics`, { name: `${type}-${stream}`, type, stream, toxicity: 1, attributes });
    },
    /** Closes the listener: new connections are refused and existing ones are cut. */
    disable: () => call("POST", path, { enabled: false }),
    enable: () => call("POST", path, { enabled: true }),
    async reset() {
      await call("POST", path, { enabled: true });
      for (const toxic of (await call("GET", `${path}/toxics`)) as { name: string }[]) await call("DELETE", `${path}/toxics/${toxic.name}`);
    },
  };
}

export const resetFaults = () => Promise.all((["app-pooler", "pooler-pg0", "pooler-pg1"] as const).map((name) => proxy(name).reset()));

/** The PgBouncer console (`SHOW POOLS` …) on a raw single-connection pool; the console accepts no transactions. */
export function pgbouncerConsole() {
  const pool = bunDriver(CONSOLE_URL, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 30, connectTimeoutSeconds: 5 });
  return { query: <R>(sql: string) => pool.query<R>(sql), close: () => pool.close(1000) };
}

/** Polls until `check` returns a truthy value or `timeoutMs` passes; returns the elapsed time in ms. */
export async function until(check: () => Promise<unknown>, timeoutMs: number, everyMs = 250): Promise<number> {
  const start = performance.now();
  for (;;) {
    if (await check().then(Boolean, () => false)) return performance.now() - start;
    if (performance.now() - start > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
    await Bun.sleep(everyMs);
  }
}
