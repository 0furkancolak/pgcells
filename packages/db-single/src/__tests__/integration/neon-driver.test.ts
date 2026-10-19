import { expect } from "bun:test";
import { neonDriver } from "../../core/drivers/neon";
import { directConfig, integration, raw } from "./helpers";

const pids = (admin: ReturnType<typeof raw>, pid: number) => admin.query<{ n: number }>("SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1", [pid]);

integration("neon: reserved connections carry no cancel, and discarding a busy connection ends its backend on the server", async () => {
  const url = directConfig().url;
  const pool = neonDriver(url, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  const admin = raw();
  try {
    const reserved = await pool.reserve();
    expect("cancel" in reserved).toBe(false);
    const pid = Number((await reserved.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]?.pid);
    await reserved.exec("SET client_connection_check_interval = 500");
    void reserved.exec("SELECT pg_sleep(30)").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await pids(admin, pid))[0]?.n).toBe(1);
    reserved.release(true);
    const deadline = Date.now() + 10_000;
    let alive = 1;
    while (alive > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      alive = (await pids(admin, pid))[0]?.n ?? 0;
    }
    expect(alive).toBe(0);
  } finally {
    await pool.close(1000);
    await admin.close();
  }
});
