/** `@0furkancolak/pgcells-redis`: ioredis connections, a two-layer cache, a placement cache, tenant-bound BullMQ queues and keys.
 * Option types are read from the function signatures; `onSpan` options are compatible with the `@0furkancolak/pgcells/telemetry` adapters. */
export { createAuthStorage } from "./auth-storage";
export { type Cache, createCache } from "./cache";
export { createRedis, loadRedisConfig, type RedisClient } from "./client";
export { globalKey, tenantKey } from "./keys";
export { createPlacementCache } from "./placement";
export { createTenantQueue, createTenantWorker } from "./queue";
