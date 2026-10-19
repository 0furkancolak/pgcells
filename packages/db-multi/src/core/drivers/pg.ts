/** node-postgres driver (optional peer `pg`); works with Node, Bun and Cloudflare Workers (`nodejs_compat`). The logic
 * lives in the `core/pg-pool.ts` factory; only the server-side cancel is defined here. */
import pg from "pg";
import { createPgDriver, type PgModule } from "../pg-pool";

export const pgDriver = createPgDriver(pg as unknown as PgModule, {
  // `Client#cancel` sends a CancelRequest over a separate connection; the running query returns with 57014.
  cancel: (client, url) => {
    const active = (client as unknown as { _activeQuery?: unknown })._activeQuery;
    if (!active) return;
    const canceller = new pg.Client({ connectionString: url }) as unknown as { connection: { on(event: string, listener: () => void): void }; cancel(client: unknown, query: unknown): void };
    canceller.connection.on("error", () => {});
    canceller.cancel(client, active);
  },
});
