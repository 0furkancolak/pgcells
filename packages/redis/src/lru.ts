/** In-process LRU: at most `max` entries, each lives for `ttlMs`. Map insertion order = LRU order (an entry that is read moves to the end). */
export function createLocalLru(max: number, ttlMs: number) {
  const entries = new Map<string, { value: unknown; expires: number }>();
  return {
    /** If `ttlMs <= 0`, the local layer is disabled. */
    remember(key: string, value: unknown) {
      if (ttlMs <= 0) return;
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttlMs });
      if (entries.size > max) entries.delete(entries.keys().next().value as string);
    },
    /** Synchronous read; an expired entry is deleted. */
    peek<T>(key: string): T | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      entries.delete(key);
      if (hit.expires <= Date.now()) return undefined;
      entries.set(key, hit);
      return hit.value as T;
    },
    forget(key: string) {
      entries.delete(key);
    },
  };
}

/** Per-key invalidation counter, at most `max` entries. `now()` is taken before a read or load starts; `changedSince(key, at)`
 * is true if the key was invalidated after that moment. The counter of an evicted entry becomes a lower bound: operations that started before it also count as changed. */
export function createEpochs(max: number) {
  const bumped = new Map<string, number>();
  let now = 0;
  let floor = 0;
  return {
    now: () => now,
    bump(key: string) {
      bumped.delete(key);
      bumped.set(key, ++now);
      if (bumped.size > max) {
        const [oldest, at] = bumped.entries().next().value as [string, number];
        bumped.delete(oldest);
        floor = at;
      }
    },
    changedSince: (key: string, at: number) => at < floor || (bumped.get(key) ?? 0) > at,
  };
}
