/** ioredis connections. The only env is `REDIS_URL`. Three separate connections, opened on first use:
 * - `command`: cache commands; while Redis is down, a command errors at `commandTimeout` (the cache stays fail-open).
 * - `subscriber`: pub/sub (a subscriber connection cannot run other commands).
 * - `queue`: BullMQ (`maxRetriesPerRequest: null`, no timeout; Worker duplicates it for blocking commands). */
import { AppError } from "@0furkancolak/pgcells";
import { Redis, type RedisOptions } from "ioredis";

export interface RedisConfig {
  url: string;
}

export function loadRedisConfig(env: Record<string, string | undefined> = process.env): RedisConfig {
  const url = env.REDIS_URL;
  if (!url) throw new AppError("INVALID_CONFIG", "REDIS_URL is required");
  return { url };
}

export interface RedisClient {
  readonly command: Redis;
  readonly subscriber: Redis;
  readonly queue: Redis;
  close(): Promise<void>;
}

/** `createRedis()` without arguments reads the address from `REDIS_URL`. `options` applies only to the `command` and `subscriber` connections.
 * `onError` receives connection errors (if omitted, ioredis logs "Unhandled error event"); reconnection is handled by ioredis. */
export function createRedis({ url }: RedisConfig = loadRedisConfig(), { onError, ...options }: RedisOptions & { onError?: (error: Error) => void } = {}): RedisClient {
  const opened: Redis[] = [];
  const open = (extra: RedisOptions) => {
    const redis = new Redis(url, extra);
    if (onError) redis.on("error", onError);
    opened.push(redis);
    return redis;
  };
  let command: Redis | undefined;
  let subscriber: Redis | undefined;
  let queue: Redis | undefined;
  return {
    get command() {
      return (command ??= open({ maxRetriesPerRequest: 1, commandTimeout: 500, ...options }));
    },
    get subscriber() {
      return (subscriber ??= open({ ...options }));
    },
    get queue() {
      return (queue ??= open({ maxRetriesPerRequest: null }));
    },
    /** Close the BullMQ queues/workers first; pending replies are not awaited. */
    async close() {
      for (const redis of opened.splice(0)) redis.disconnect();
      command = subscriber = queue = undefined;
    },
  };
}
