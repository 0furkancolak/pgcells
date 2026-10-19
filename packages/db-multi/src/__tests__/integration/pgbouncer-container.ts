/** A real PgBouncer container built from `src/core/local/pgbouncer` and configured with `generatePoolerFiles`, joined to the compose network so it reaches the cells by
 * service name. `alpine` picks the PgBouncer version (3.19 -> 1.21, 3.21 -> 1.23, 3.22 -> 1.24). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConfig } from "../../core/config";
import { generatePoolerFiles } from "../../core/tools/pooler-generate";
import { directConfig, raw } from "./helpers";

const composeDirectory = join(import.meta.dir, "../../..");

export async function sh(...args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${args.join(" ")}: ${err}`);
  return out;
}

export async function startPgbouncer(options: { alpine?: string; maxPreparedStatements?: number; port: number }) {
  const { alpine = "3.22", maxPreparedStatements = 0, port } = options;
  const image = `pgcells-pgbouncer-${alpine}`;
  const container = `pgcells-pgbouncer-${alpine}-${crypto.randomUUID().slice(0, 8)}`;
  await sh("docker", "build", "-q", "--build-arg", `ALPINE=${alpine}`, "-t", image, join(composeDirectory, "src/core/local/pgbouncer"));
  // Other projects on the machine may run services with the same names: only this compose project's containers count.
  const [first = ""] = (
    await sh("docker", "ps", "-q", "--filter", "label=com.docker.compose.service=postgres-0", "--filter", `label=com.docker.compose.project.working_dir=${composeDirectory}`)
  )
    .trim()
    .split("\n");
  const network = (await sh("docker", "inspect", "-f", "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}", first)).trim();
  const nodes = createConfig(directConfig().nodes.map((node, index) => node.url.replace(/@[^/]+\//, `@postgres-${index}:5432/`))).nodes;
  const files = generatePoolerFiles({ nodes, tls: false, maxPreparedStatements });
  const admin = raw(0);
  const [{ verifier } = { verifier: "" }] = await admin.query<{ verifier: string }>("SELECT rolpassword AS verifier FROM pg_authid WHERE rolname='admin'");
  await admin.close();
  // With a SCRAM verifier in userlist.txt the pooler logs in to every backend with it, so all backends must hold the same verifier for the user.
  for (let index = 1; index < directConfig().nodes.length; index++) {
    const other = raw(index);
    await other.exec(`ALTER ROLE admin PASSWORD '${verifier.replaceAll("'", "''")}'`);
    await other.close();
  }
  const directory = await mkdtemp(join(composeDirectory, ".tmp-generated-pooler-"));
  await writeFile(join(directory, "pgbouncer.ini"), files["pgbouncer.ini"].replace("admin_users = pgbouncer_admin", "admin_users = admin"));
  await writeFile(join(directory, "userlist.txt"), `"admin" "${verifier}"\n`);
  await sh("docker", "run", "-d", "--rm", "--name", container, "--network", network, "-p", `127.0.0.1:${port}:6432`, "-v", `${directory}:/etc/pgbouncer:ro`, image);
  for (let i = 0; i < 40; i++) {
    const up = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, error() {} } }).then((socket) => (socket.end(), true), () => false);
    if (up) break;
    await Bun.sleep(250);
  }
  return {
    port,
    /** Runtime URLs: the aliases `db0`, `db1` of the generated config. */
    urls: directConfig().nodes.map((_, index) => `postgres://admin:local_admin_password@127.0.0.1:${port}/db${index}`),
    consoleUrl: `postgres://admin:local_admin_password@127.0.0.1:${port}/pgbouncer`,
    async stop() {
      await sh("docker", "rm", "-f", container).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
}
