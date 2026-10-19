/** Two-region test stack (compose.regions.yaml, project `pgcells-regions`): db0 (directory) and db1 in eu-west, db2 in us-east. A latency toxic on the cross-region proxies stands in
 * for the ocean. Off unless `REGIONS_STACK=1`. */
import { createConfig } from "../../core/config";

const API = "http://127.0.0.1:8475";
const LOGIN = "admin:local_admin_password";
const url = (port: number) => `postgres://${LOGIN}@127.0.0.1:${port}/app`;

export const regionsEnabled = process.env.REGIONS_STACK === "1";
/** Direct URLs, for management and fixtures. */
export const directUrls = [url(5591), url(5592), url(5593)];
/** What the eu-west application uses: db2 is across the ocean. */
export const euUrls = [url(5591), url(5592), url(15452)];
/** What the us-east application uses: db0 (the directory) and db1 are across the ocean. */
export const usUrls = [url(15450), url(15451), url(5593)];
export const config = (urls: readonly string[]) => createConfig([...urls]);

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`toxiproxy ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

export type Path = "us-to-dir" | "us-to-eu" | "eu-to-us";
export const paths: readonly Path[] = ["us-to-dir", "us-to-eu", "eu-to-us"];
export function path(name: Path) {
  const base = `/proxies/${name}`;
  const toxic = (type: string, attributes: Record<string, number>, stream: "upstream" | "downstream") =>
    call("POST", `${base}/toxics`, { name: `${type}-${stream}`, type, stream, toxicity: 1, attributes });
  return {
    /** `ms` of delay in each direction: a round trip costs twice that. */
    latency: async (ms: number) => void (await toxic("latency", { latency: ms }, "upstream"), await toxic("latency", { latency: ms }, "downstream")),
    /** Data stalls without the connection closing. */
    partition: async () => void (await toxic("timeout", { timeout: 0 }, "upstream"), await toxic("timeout", { timeout: 0 }, "downstream")),
    async reset() {
      await call("POST", base, { enabled: true });
      for (const existing of (await call("GET", `${base}/toxics`)) as { name: string }[]) await call("DELETE", `${base}/toxics/${existing.name}`);
    },
  };
}
export const resetPaths = () => Promise.all(paths.map((name) => path(name).reset()));
export const available = () =>
  fetch(`${API}/proxies`).then(
    (response) => response.ok,
    () => false,
  );
