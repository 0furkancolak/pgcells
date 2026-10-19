/** Birim testleri için sürücü: her havuzu ve komutu kaydeder; transaction komutları (BEGIN/COMMIT/ROLLBACK) handler'a gitmez. */
import type { Connection, Driver, PoolOptions } from "../../core/driver";

export type Handler = (text: string, params: readonly unknown[], pool: FakePool) => unknown[] | Promise<unknown[]>;
export interface FakePool {
  index: number;
  url: string;
  options: PoolOptions;
  closed: boolean;
  released: number;
  /** `release(true)` ile atılan bağlantılar (`released`'e de sayılır). */
  discarded: number;
  cancels: number;
}

export function fakeDriver(handler: Handler = () => []) {
  const commands: { url: string; text: string; params: readonly unknown[] }[] = [];
  const pools: FakePool[] = [];
  const driver: Driver = (url, options) => {
    const pool: FakePool = { index: pools.length, url, options, closed: false, released: 0, discarded: 0, cancels: 0 };
    pools.push(pool);
    const run = async (text: string, params: readonly unknown[] = []) => {
      commands.push({ url, text, params });
      return /^(BEGIN|COMMIT|ROLLBACK)/.test(text) ? [] : handler(text, params, pool);
    };
    const connection: Connection = {
      query: async <R>(text: string, params?: readonly unknown[]) => (await run(text, params)) as R[],
      exec: async (text) => {
        await run(text);
      },
    };
    return {
      ...connection,
      reserve: async () => ({
        ...connection,
        cancel: () => {
          pool.cancels++;
        },
        release: (discard?: boolean) => {
          pool.released++;
          if (discard) pool.discarded++;
        },
      }),
      close: async () => {
        pool.closed = true;
      },
    };
  };
  return { driver, commands, pools };
}
