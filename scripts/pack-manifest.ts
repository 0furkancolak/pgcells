/** `prepack` / `postpack` helper: while the tarball is made, point `exports` and `bin` at `dist/` (types first) instead of `src/`.
 * The development manifest keeps `src/` so workspace packages resolve without a build. Run from a package directory. */
const mode = process.argv[2];
const backup = "package.json.prepack";
if (mode === "postpack") {
  if (await Bun.file(backup).exists()) {
    await Bun.write("package.json", await Bun.file(backup).text());
    await Bun.$`rm ${backup}`;
  }
  await Bun.$`rm -f LICENSE NOTICE`;
  process.exit(0);
}
if (mode !== "prepack") throw new Error("usage: pack-manifest.ts prepack|postpack");

// An interrupted earlier pack leaves the rewritten manifest behind; the backup is the truth, so restore it first.
if (await Bun.file(backup).exists()) await Bun.write("package.json", await Bun.file(backup).text());
const original = await Bun.file("package.json").text();
const pkg = JSON.parse(original);
const toDist = (path: string) => path.replace("./src/", "./dist/").replace(/\.ts$/, ".js");
const rewrite = (value: string) => ({ types: toDist(value).replace(/\.js$/, ".d.ts"), default: toDist(value) });
pkg.exports = Object.fromEntries(Object.entries(pkg.exports as Record<string, string>).map(([key, value]) => [key, rewrite(value)]));
if (pkg.bin) pkg.bin = Object.fromEntries(Object.entries(pkg.bin as Record<string, string>).map(([key, value]) => [key, toDist(value)]));
await Bun.write(backup, original);
// npm and bun pack LICENSE/NOTICE only from the package directory; the repository keeps one copy at the root.
await Bun.write("LICENSE", Bun.file("../../LICENSE"));
await Bun.write("NOTICE", Bun.file("../../NOTICE"));
await Bun.write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
