/** Builds one package into `dist/`: ESM JavaScript (one shared chunk graph, so every entry sees the same module instances) and `.d.ts`
 * files. Entries come from the package manifest (`exports` and `bin` values that point into `src/`), so the manifest stays the single
 * source of truth. Run from a package directory: `bun ../../scripts/build-package.ts`. */
import { Glob } from "bun";
import { existsSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const pkg = await Bun.file("package.json").json();
const targets = [...Object.values(pkg.exports as Record<string, string>), ...Object.values((pkg.bin ?? {}) as Record<string, string>)];
const entries = targets
  .flatMap((target) => (target.includes("*") ? [...new Glob(target.slice(2).replace("*", "**/*")).scanSync(".")] : [target.slice(2)]))
  .filter((path) => path.startsWith("src/") && !path.includes("__tests__"))
  .sort();
if (!entries.length) throw new Error("no entries found in package.json exports/bin");

const dependencies = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies });
const external = ["bun", ...dependencies.flatMap((name) => [name, `${name}/*`])];

await rm("dist", { recursive: true, force: true });
const result = await Bun.build({ entrypoints: entries, outdir: "dist", root: "src", target: "node", format: "esm", splitting: true, external });
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}

const types = Bun.spawn(["bun", "run", "typecheck:build"], { stdout: "inherit", stderr: "inherit" });
if ((await types.exited) !== 0) process.exit(1);

// tsc keeps relative specifiers as written (`./core/config`). Under Node16/NodeNext module resolution those do not resolve, and with
// `skipLibCheck` (the usual setting) every exported type silently becomes `any`. Rewrite them to the `.js` form NodeNext requires.
for (const file of new Glob("dist/**/*.d.ts").scanSync(".")) {
  const text = await Bun.file(file).text();
  const fixed = text.replace(/(\bfrom\s+|\bimport\()(["'])(\.{1,2}(?:\/[^"']*)?)\2/g, (_match, lead: string, quote: string, spec: string) => {
    const target = join(dirname(file), spec);
    const resolved = existsSync(`${target}.d.ts`) ? `${spec}.js` : existsSync(join(target, "index.d.ts")) ? `${spec.replace(/\/$/, "")}/index.js` : spec;
    return `${lead}${quote}${resolved}${quote}`;
  });
  if (fixed !== text) await Bun.write(file, fixed);
}

// bin targets run directly: keep the shebang the source carries and make the file executable.
for (const bin of Object.values((pkg.bin ?? {}) as Record<string, string>)) {
  const file = bin.replace("./src/", "dist/").replace(/\.ts$/, ".js");
  const text = await Bun.file(file).text();
  if (!text.startsWith("#!")) await Bun.write(file, `#!/usr/bin/env bun\n${text}`);
  await chmod(file, 0o755);
}
console.log(`built ${pkg.name}: ${entries.length} entries`);
