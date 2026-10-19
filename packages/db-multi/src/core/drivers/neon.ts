/** Neon serverless driver (optional peer `@neondatabase/serverless`): WebSocket `Pool`, pg-compatible; meant for Workers/edge runtimes.
 * Runtime only: management (advisory lock) requires the pg/postgres/bun driver and a direct URL. `cancel` is not defined: the Neon client's
 * cancellation opens a new TCP connection, and Workers has no TCP. After the deadline the connection is discarded and the server stops the
 * statement via `client_connection_check_interval` (same contract as Bun SQL). WebSockets cannot outlive a single request: the `Pool` is opened and closed within the request (`poolMax: 1`). */
import { Pool, types } from "@neondatabase/serverless";
import { createPgDriver, type PgModule } from "../pg-pool";

export const neonDriver = createPgDriver({ Pool, types } as unknown as PgModule);
