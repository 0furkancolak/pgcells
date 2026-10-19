/** Bench driver selection: the named driver is imported lazily, so only the selected driver's dependency is loaded. */
import type { Driver } from "@0furkancolak/pgcells";

const DRIVERS: Record<string, () => Promise<Driver>> = {
  bun: async () => (await import("@0furkancolak/pgcells/drivers/bun")).bunDriver,
  postgres: async () => (await import("@0furkancolak/pgcells/drivers/postgres")).postgresDriver,
  pg: async () => (await import("@0furkancolak/pgcells/drivers/pg")).pgDriver,
};

export async function loadDriver(name: string): Promise<Driver> {
  const load = DRIVERS[name];
  if (!load) throw new Error(`Unknown driver "${name}"; valid drivers: ${Object.keys(DRIVERS).join(", ")}`);
  return load();
}
