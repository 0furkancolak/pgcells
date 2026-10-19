/** Belgeler yürütülebilir denetimle korunur: göreli bağlantılar çözülür, `docs/cli.md` her komutu adlandırır, `docs/errors.md` kaynaktaki
 * hata kodlarıyla birebir aynıdır, kod örneklerindeki import yolları gerçek `exports` anahtarlarıdır, gösterdikleri dosya vardır ve içe
 * aktarılan (tip olmayan) adları dışa aktarır. */
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { dirname, join, resolve } from "node:path";
import { commandNames } from "../../core/cli";

const root = join(import.meta.dir, "../../..");
const read = (path: string) => Bun.file(join(root, path)).text();
const markdown = () => ["README.md", ...[...new Glob("docs/*.md").scanSync({ cwd: root })].sort()];

/** GitHub başlık bağlantısı: küçük harf, noktalama (`, ’ …) atılır, boşluk `-` olur, Türkçe harfler kalır. */
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-");
const anchors = async (file: string) =>
  new Set([...(await read(file)).replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1] as string)));

test("every relative link in the README and docs resolves to a file and, with #anchor, to a heading of it", async () => {
  const broken: string[] = [];
  for (const file of markdown())
    for (const [, target = "", anchor] of (await read(file)).matchAll(/\]\((?!https?:|mailto:)([^)#\s]*)(?:#([^)\s]*))?\)/g)) {
      const path = target ? resolve(root, dirname(file), target) : join(root, file);
      if (!(await Bun.file(path).exists())) broken.push(`${file} -> ${target}`);
      else if (anchor && path.endsWith(".md") && !(await anchors(path.slice(root.length + 1))).has(anchor)) broken.push(`${file} -> ${target}#${anchor}`);
    }
  expect(broken).toEqual([]);
});

test("docs/cli.md has a table row for exactly the commands the CLI knows", async () => {
  const documented = [...(await read("docs/cli.md")).matchAll(/^\| `([a-z][a-z -]*)` \|/gm)].map((match) => match[1] as string).sort();
  expect(documented).toEqual(commandNames().sort());
});

test("docs/errors.md lists exactly the error codes the source throws", async () => {
  const thrown = new Set<string>();
  const source = new Map<string, string>();
  for (const file of new Glob("src/**/*.ts").scanSync({ cwd: root })) {
    if (file.includes("__tests__") || file.endsWith(".gen.ts")) continue;
    const text = await read(file);
    source.set(file, text);
    for (const [, code] of text.matchAll(/new AppError\(\s*"([A-Z][A-Z0-9_]+)"/g)) thrown.add(code as string);
  }
  const documented = new Set([...(await read("docs/errors.md")).matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((match) => match[1] as string));
  expect([...thrown].filter((code) => !documented.has(code)).sort()).toEqual([]);
  // Değişkenle atılan kodlar (ör. DriftCode) kaynakta tırnaklı sabit olarak geçer.
  const everywhere = [...source.values()].join("\n");
  expect([...documented].filter((code) => !everywhere.includes(`"${code}"`)).sort()).toEqual([]);
});

test("import paths in code examples are real package exports, point at an existing file and export the imported names", async () => {
  const exportsMap = ((await Bun.file(join(root, "package.json")).json()) as { exports: Record<string, string> }).exports;
  /** `./queries/users` → `./src/queries/users.gen.ts` (joker anahtar), tam anahtar ise kendi hedefi. */
  const target = (path: string) => {
    for (const [key, file] of Object.entries(exportsMap)) {
      if (key === path) return file;
      if (key.endsWith("/*") && path.startsWith(key.slice(0, -1))) return file.replace("*", path.slice(key.length - 1));
    }
  };
  const bad: string[] = [];
  for (const file of markdown())
    for (const [, typeOnly, names = "", spec] of (await read(file)).matchAll(/(?:import (type )?\{([^}]*)\} )?from "(@0furkancolak\/pgcells-single[^"]*)"/g)) {
      const path = spec === "@0furkancolak/pgcells-single" ? "." : `.${(spec as string).slice("@0furkancolak/pgcells-single".length)}`;
      const found = target(path);
      if (!found || !(await Bun.file(join(root, found)).exists())) {
        bad.push(`${file}: ${spec}`);
        continue;
      }
      const exported = typeOnly ? [] : Object.keys(await import(join(root, found)));
      for (const name of typeOnly ? [] : names.split(",").map((entry) => entry.trim().split(/\s+as\s+/)[0] as string))
        if (name && !name.startsWith("type ") && !exported.includes(name)) bad.push(`${file}: ${name} from ${spec}`);
    }
  expect(bad).toEqual([]);
});

test("the vocabulary guard has a documented reason: docs/from-multi.md explains why tenants do not exist here", async () => {
  expect(await read("docs/from-multi.md")).toMatch(/tenant/i);
});
