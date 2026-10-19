/** Capacity model: how many application instances, cells (primaries) and replicas a target load needs, from throughput figures **you measured** on your hardware.
 * Pure arithmetic, no I/O; the figures are inputs because they depend entirely on hardware, schema and query mix (docs/guides/capacity.md has a measured starting point). */
import { AppError } from "../errors";

export interface CapacityInput {
  /** Statements per second the whole system must sustain at peak. */
  targetRps: number;
  /** Fraction of those statements that are reads which may be served by replicas (0–1). */
  readShare: number;
  /** Statements per second one application process sustains at 100 % of one core, measured. */
  perProcessRps: number;
  /** Statements per second one PostgreSQL server (a primary or a replica) sustains at 100 %, measured with your query mix. */
  perCellRps: number;
  /** The fraction of capacity to plan for at peak (0–1], default 0.6: headroom for spikes, failover and rolling deploys. */
  utilization?: number;
  /** Total tenants and how many one cell comfortably holds (catalog size, migration time): sets a floor on the number of cells. Both optional. */
  tenants?: number;
  tenantsPerCell?: number;
  /** `false`: no replicas, so reads land on the primaries too. Default `true`. */
  replicasAllowed?: boolean;
}

export interface CapacityPlan {
  appInstances: number;
  cells: number;
  replicasPerCell: number;
  /** Primaries plus replicas. */
  postgresServers: number;
  writeRps: number;
  readRps: number;
  /** Per cell, at the planned peak. */
  perCell: { writeRps: number; readRps: number; tenants?: number };
  /** What decided the number of cells. */
  limitedBy: "writes" | "statements" | "tenants";
  notes: string[];
}

/** PostgreSQL replicas per node the package accepts (`DATABASE_REPLICA_URLS`). */
const MAX_REPLICAS = 8;
/** An application tier of one instance has no redundancy. */
const MIN_INSTANCES = 2;

const positive = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new AppError("INVALID_CONFIG", `${name} must be a positive number`);
  return value;
};

export function capacityPlan(input: CapacityInput): CapacityPlan {
  const targetRps = positive(input.targetRps, "targetRps");
  const perProcessRps = positive(input.perProcessRps, "perProcessRps");
  const perCellRps = positive(input.perCellRps, "perCellRps");
  const utilization = input.utilization === undefined ? 0.6 : positive(input.utilization, "utilization");
  if (utilization > 1) throw new AppError("INVALID_CONFIG", "utilization must be a fraction above 0 and at most 1");
  const readShare = input.readShare;
  if (typeof readShare !== "number" || !(readShare >= 0 && readShare <= 1)) throw new AppError("INVALID_CONFIG", "readShare must be between 0 and 1");
  const tenants = input.tenants === undefined ? undefined : positive(input.tenants, "tenants");
  const tenantsPerCell = input.tenantsPerCell === undefined ? undefined : positive(input.tenantsPerCell, "tenantsPerCell");
  const replicasAllowed = input.replicasAllowed ?? true;
  const notes: string[] = [];

  const usable = perCellRps * utilization;
  const writeRps = Math.round(targetRps * (1 - readShare));
  const readRps = Math.round(targetRps * readShare);
  const appInstances = Math.max(MIN_INSTANCES, Math.ceil(targetRps / (perProcessRps * utilization)));
  const byTenants = tenants !== undefined && tenantsPerCell !== undefined ? Math.ceil(tenants / tenantsPerCell) : 1;

  let cells: number;
  let limitedBy: CapacityPlan["limitedBy"];
  let replicasPerCell = 0;
  if (replicasAllowed && readRps > 0) {
    // Writes decide the primaries; reads are spread over replicas, which are added per cell up to the node limit and beyond that by adding cells.
    const byWrites = Math.max(1, Math.ceil(writeRps / usable));
    cells = Math.max(byWrites, byTenants);
    limitedBy = byTenants > byWrites ? "tenants" : "writes";
    replicasPerCell = Math.ceil(readRps / cells / usable);
    if (replicasPerCell > MAX_REPLICAS) {
      cells = Math.ceil(readRps / (MAX_REPLICAS * usable));
      replicasPerCell = MAX_REPLICAS;
      limitedBy = "statements";
      notes.push(`Reads need more than ${MAX_REPLICAS} replicas per cell, so the plan adds cells instead (more cells, ${MAX_REPLICAS} replicas each).`);
    }
  } else {
    const byStatements = Math.max(1, Math.ceil(targetRps / usable));
    cells = Math.max(byStatements, byTenants);
    limitedBy = byTenants > byStatements ? "tenants" : "statements";
  }
  if (cells > 1 && limitedBy === "writes" && replicasPerCell > 0) notes.push("Writes decide the primaries; replicas absorb the reads.");
  notes.push("All figures are as good as the measurements behind perProcessRps and perCellRps: measure with your schema and query mix (bench:hotpath, bench:scale).");

  return {
    appInstances,
    cells,
    replicasPerCell,
    postgresServers: cells * (1 + replicasPerCell),
    writeRps,
    readRps,
    perCell: {
      writeRps: Math.round(writeRps / cells),
      readRps: Math.round(readRps / cells),
      ...(tenants !== undefined ? { tenants: Math.round(tenants / cells) } : {}),
    },
    limitedBy,
    notes,
  };
}
