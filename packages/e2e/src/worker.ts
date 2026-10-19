/** E2E worker: the BullMQ tenant worker writes the user to the tenant schema; the cron-like loop uses `createDbScope` without HTTP to
 * run a read-only count on all active tenants and writes the result to Redis (`g:e2e:cron`, read by the test). */
import { createDatabase, errorCode, loadConfig } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createDbScope } from "@0furkancolak/pgcells/middleware";
import { listTenants } from "@0furkancolak/pgcells/queries/platform/tenants";
import { createPlacementCache, createRedis, createTenantWorker, globalKey, loadRedisConfig } from "@0furkancolak/pgcells-redis";
import { countUsers, createUser, log, placementTtl, throttled, type UserJob } from "./shared";

const db = createDatabase(loadConfig(), { driver: bunDriver, poolMax: 3 });
const redis = createRedis(loadRedisConfig(), { onError: throttled("redis_error") });
const placements = createPlacementCache({ redis, db, ...placementTtl(), onError: throttled("placement_cache_error") });

const worker = createTenantWorker<UserJob>(
  "users",
  async (job, { tenantId, db: scope }) => {
    const { id, name, email } = job.data.payload;
    try {
      await scope.tenant.query(createUser, [id, name, email]);
    } catch (error) {
      // On a retry the row may already have been written.
      if (errorCode(error) !== "23505") throw error;
    }
    log("job_done", { tenantId, id });
  },
  { connection: redis.queue, db, placement: placements.loadPlacement, concurrency: 5 },
);
worker.on("failed", (job, error) => log("job_failed", { id: job?.id, code: errorCode(error) }));
worker.on("error", throttled("worker_error"));

const CRON_KEY = globalKey("e2e", "cron");
let running = false;
async function tick() {
  if (running) return;
  running = true;
  const started = Date.now();
  const counts: Record<string, number | string> = {};
  try {
    const tenants = await createDbScope(db, "").platform.query<{ tenantId: string; status: string }[]>(listTenants, [1000, 0]);
    for (const { tenantId, status } of tenants) {
      if (status !== "active") {
        counts[tenantId] = status;
        continue;
      }
      try {
        const [row] = await createDbScope(db, tenantId, placements.loadPlacement).tenant.query<{ n: number }[]>(countUsers);
        counts[tenantId] = row?.n ?? 0;
      } catch (error) {
        counts[tenantId] = errorCode(error);
      }
    }
    await redis.command.set(CRON_KEY, JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - started, counts }), "EX", 300);
  } catch (error) {
    log("cron_failed", { code: errorCode(error) });
  } finally {
    running = false;
  }
}
const timer = setInterval(() => void tick(), Number(process.env.CRON_INTERVAL_MS ?? 3000));
log("worker_started");

process.once("SIGTERM", async () => {
  clearInterval(timer);
  await worker.close();
  await Promise.all([db.close(), redis.close()]);
  process.exit(0);
});
