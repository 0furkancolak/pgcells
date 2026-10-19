/** Bench sürücü seçimi: adı verilen sürücü tembel (lazy) import edilir, böylece yalnızca seçilen sürücünün bağımlılığı yüklenir. */
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
