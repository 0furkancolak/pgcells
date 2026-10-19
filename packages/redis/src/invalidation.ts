/** Cross-process invalidation broadcast: a single pub/sub channel, a message with short JSON keys `{ o, k?, t?, g? }` (the wire format
 * is fixed; processes of different versions share the same channel). For a missed message, staleness is bounded by the local TTL. */
import type { RedisClient } from "./client";

export interface Invalidation {
  /** Identity of the publishing cache; its own message is ignored. */
  origin: string;
  /** The full key that was deleted. */
  key?: string;
  /** The tenant whose generation advanced, and the new generation. */
  tenantId?: string;
  generation?: string;
}

type Wire = { o: string; k?: string; t?: string; g?: string };

const encode = ({ origin, key, tenantId, generation }: Invalidation) => JSON.stringify({ o: origin, k: key, t: tenantId, g: generation } satisfies Wire);

function decode(text: string): Invalidation {
  const wire = JSON.parse(text) as Wire;
  return { origin: wire.o, key: wire.k, tenantId: wire.t, generation: wire.g };
}

export interface InvalidationHandlers {
  onKey(key: string): void;
  onGeneration(tenantId: string, generation: string): void;
  onError(error: unknown): void;
}

/** Number of users of a channel per subscriber connection: when the last of the caches sharing the same connection closes, the channel is unsubscribed. */
const channelUsers = new WeakMap<object, Map<string, number>>();

/** Subscribes to the channel; forwards messages from other processes to `handlers`. The returned function removes the listener (a second call has no effect). */
export function subscribeInvalidations(redis: Pick<RedisClient, "subscriber">, channel: string, origin: string, handlers: InvalidationHandlers) {
  const { subscriber } = redis;
  const users = channelUsers.get(subscriber) ?? new Map<string, number>();
  channelUsers.set(subscriber, users);
  const count = users.get(channel) ?? 0;
  users.set(channel, count + 1);
  if (!count) subscriber.subscribe(channel).catch(handlers.onError);
  const listener = (from: string, text: string) => {
    if (from !== channel) return;
    try {
      const message = decode(text);
      if (message.origin === origin) return;
      if (message.key) handlers.onKey(message.key);
      if (message.tenantId && message.generation) handlers.onGeneration(message.tenantId, message.generation);
    } catch (error) {
      handlers.onError(error);
    }
  };
  subscriber.on("message", listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    subscriber.off("message", listener);
    const left = (users.get(channel) ?? 1) - 1;
    if (left > 0) users.set(channel, left);
    else {
      users.delete(channel);
      subscriber.unsubscribe(channel).catch(handlers.onError);
    }
  };
}

export async function publishInvalidation(redis: Pick<RedisClient, "command">, channel: string, message: Invalidation) {
  await redis.command.publish(channel, encode(message));
}
