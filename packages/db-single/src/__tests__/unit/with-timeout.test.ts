import { afterEach, expect, test } from "bun:test";
import { withTimeout } from "../../core/driver";

const realSet = globalThis.setTimeout;
const realClear = globalThis.clearTimeout;
afterEach(() => {
  globalThis.setTimeout = realSet;
  globalThis.clearTimeout = realClear;
});

/** Number of timers set up inside that are still pending (expired or cleared ones are not counted). */
function trackTimers() {
  const pending = new Set<unknown>();
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    const timer = realSet(() => {
      pending.delete(timer);
      handler();
    }, ms);
    pending.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: never) => {
    pending.delete(timer);
    realClear(timer);
  }) as typeof clearTimeout;
  return pending;
}

test("the timer is cleared as soon as the work settles, for success and failure alike", async () => {
  const pending = trackTimers();
  await withTimeout(Promise.resolve("done"), 5000);
  expect(pending.size).toBe(0);
  await expect(withTimeout(Promise.reject(new Error("close failed")), 5000)).rejects.toThrow("close failed");
  expect(pending.size).toBe(0);
});

test("when the timeout wins the result resolves after the limit and the work is left alone", async () => {
  const pending = trackTimers();
  const started = performance.now();
  await withTimeout(new Promise<void>(() => {}), 30);
  expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  expect(pending.size).toBe(0);
});
