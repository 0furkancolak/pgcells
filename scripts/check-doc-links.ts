/** Checks relative Markdown links (files and #anchors) in tracked documents. Anchors follow GitHub's slug rules. Design history is skipped.
 * Usage: bun scripts/check-doc-links.ts */
import { dirname, join, normalize } from "node:path";

const files = (await Bun.$`git ls-files '*.md'`.text()).split("\n").filter((file) => file && !file.startsWith("docs/design/"));
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

const anchorCache = new Map<string, Set<string>>();
async function anchors(file: string) {
  let found = anchorCache.get(file);
  if (!found) {
    found = new Set();
    const seen = new Map<string, number>();
    let fenced = false;
    for (const line of (await Bun.file(file).text()).split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      const heading = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
      if (!heading) continue;
      const base = slug(heading[1] as string);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      found.add(count ? `${base}-${count}` : base);
    }
    anchorCache.set(file, found);
  }
  return found;
}

const problems: string[] = [];
for (const file of files) {
  let fenced = false;
  for (const [index, line] of (await Bun.file(file).text()).split("\n").entries()) {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] as string;
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path = "", anchor] = target.split("#");
      const resolved = path ? normalize(join(dirname(file), decodeURI(path))) : file;
      // A link inside a published package must stay inside it: the README and docs ship in the tarball, the rest of the repository does not.
      const owner = /^packages\/(db-multi|db-single|redis)\//.exec(file)?.[0];
      if (owner && path && !resolved.startsWith(owner)) {
        problems.push(`${file}:${index + 1}: link leaves the published package, use an absolute URL: ${target}`);
        continue;
      }
      const exists = (await Bun.file(resolved).exists()) || (await Bun.$`test -d ${resolved}`.nothrow().quiet()).exitCode === 0;
      if (path && !exists) {
        problems.push(`${file}:${index + 1}: missing file ${target}`);
        continue;
      }
      if (anchor && resolved.endsWith(".md") && !(await anchors(resolved)).has(anchor)) problems.push(`${file}:${index + 1}: missing anchor ${target}`);
    }
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${files.length} documents, links ok`);
