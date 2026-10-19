#!/usr/bin/env bash
# Packs every published package, checks the tarball contents, installs the tarballs into a clean project and imports them under
# Node and Bun (types are resolved with tsc using Node's `exports` rules). Needs bun, node >= 22 and npm.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/tarballs" "$TMP/app"

before="$(cat "$ROOT"/packages/*/package.json | shasum)"
# Order matters: redis builds its declarations against the built db-multi.
for package in db-multi db-single redis; do
  (cd "$ROOT/packages/$package" && bun pm pack --destination "$TMP/tarballs" --quiet >/dev/null)
done
ls "$TMP/tarballs"

for tarball in "$TMP"/tarballs/*.tgz; do
  listing="$(tar -tzf "$tarball")"
  if echo "$listing" | grep -E 'package/(src/|.*__tests__|.*bench|\.env|.*results/)'; then
    echo "unexpected files in $tarball" >&2; exit 1
  fi
  for required in package/package.json package/README.md package/LICENSE package/dist/index.js package/dist/index.d.ts; do
    echo "$listing" | grep -qx "$required" || { echo "$tarball is missing $required" >&2; exit 1; }
  done
  # The development manifest must have been restored after packing, and the packed one must point at dist.
  tar -xzOf "$tarball" package/package.json | grep -q '"./dist/index.js"' || { echo "$tarball manifest does not point at dist" >&2; exit 1; }
done
# redis must peer-depend on db-multi (two copies would break instanceof checks and types), not pin it as a dependency.
tar -xzOf "$TMP"/tarballs/0furkancolak-pgcells-redis-*.tgz package/package.json | bun -e '
  const manifest = JSON.parse(await Bun.stdin.text());
  const peer = manifest.peerDependencies?.["@0furkancolak/pgcells"] ?? "";
  if (manifest.dependencies?.["@0furkancolak/pgcells"] || !/^[\^~>=]*\d/.test(peer)) process.exit(1);
' || { echo "@0furkancolak/pgcells-redis must declare @0furkancolak/pgcells as a peerDependency with a semver range" >&2; exit 1; }
[ "$before" = "$(cat "$ROOT"/packages/*/package.json | shasum)" ] || { echo "postpack did not restore package.json" >&2; exit 1; }

cd "$TMP/app"
npm init -y >/dev/null
npm i --no-audit --no-fund --loglevel=error "$TMP"/tarballs/0furkancolak-pgcells-[0-9]*.tgz "$TMP"/tarballs/0furkancolak-pgcells-single-*.tgz "$TMP"/tarballs/0furkancolak-pgcells-redis-*.tgz \
  pg@8.23.0 postgres@3.4.7 @neondatabase/serverless@1.2.0 better-auth@1.7.5 typescript@5.9.2 @types/node@22 >/dev/null

cat > smoke.mjs <<'JS'
import assert from "node:assert/strict";
import { createConfig, createDatabase, tenantFromHost } from "@0furkancolak/pgcells";
import { pgDriver } from "@0furkancolak/pgcells/drivers/pg";
import { postgresDriver } from "@0furkancolak/pgcells/drivers/postgres";
import { dbMiddleware } from "@0furkancolak/pgcells/middleware";
import { authTables } from "@0furkancolak/pgcells/auth";
import { createPasswordUser } from "@0furkancolak/pgcells/queries/tenant/auth";
import { createPlacementCache } from "@0furkancolak/pgcells-redis";
import { createDb } from "@0furkancolak/pgcells-single";
import { pgDriver as singlePgDriver } from "@0furkancolak/pgcells-single/drivers/pg";

assert.equal(tenantFromHost("acme.example.com", "example.com"), "acme");
assert.equal(typeof dbMiddleware, "function");
assert.equal(typeof createPlacementCache, "function");
assert.equal(typeof createPasswordUser, "object");
assert.ok(authTables("user").user);
assert.equal(typeof postgresDriver, "function");
assert.equal(typeof singlePgDriver, "function");
const db = createDatabase(createConfig(["postgres://u:p@127.0.0.1:1/db"]), { driver: pgDriver });
await db.close();
assert.equal(typeof createDb, "function");
console.log("node ok");
JS
node smoke.mjs

cat > smoke-bun.mjs <<'JS'
import assert from "node:assert/strict";
import { createManagement } from "@0furkancolak/pgcells/management";
import { backupAll } from "@0furkancolak/pgcells/tools";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
assert.equal(typeof createManagement, "function");
assert.equal(typeof backupAll, "function");
assert.equal(typeof bunDriver, "function");
console.log("bun ok");
JS
bun smoke-bun.mjs
test -x node_modules/.bin/pgcells && test -x node_modules/.bin/pgcells-single   # both CLIs installed side by side must not shadow each other
bun node_modules/.bin/pgcells > "$TMP/cli-multi.txt" 2>&1 || true
bun node_modules/.bin/pgcells-single > "$TMP/cli-single.txt" 2>&1 || true
grep -q . "$TMP/cli-multi.txt" && grep -q . "$TMP/cli-single.txt" || { echo "a CLI printed nothing" >&2; exit 1; }
! cmp -s "$TMP/cli-multi.txt" "$TMP/cli-single.txt" || { echo "pgcells and pgcells-single print the same help" >&2; exit 1; }

cat > smoke-types.mts <<'TS'
import { createConfig, createDatabase, type Placement } from "@0furkancolak/pgcells";
import { pgDriver } from "@0furkancolak/pgcells/drivers/pg";
import { createPlacementCache } from "@0furkancolak/pgcells-redis";
import { createDb } from "@0furkancolak/pgcells-single";
const config = createConfig(["postgres://u:p@h/db"]);
const db = createDatabase(config, { driver: pgDriver });
const placement: Promise<Placement> = Promise.resolve(db.placement("acme"));
void [placement, createPlacementCache, createDb];
// The types must be real: with broken declarations they silently become `any` and these lines stop being errors.
// @ts-expect-error createConfig takes a string or an array of strings
createConfig(123);
// @ts-expect-error a tenant id is a string
db.placement(1);
// @ts-expect-error not a placement
const wrong: Placement = 42;
void wrong;
TS
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --strict smoke-types.mts
# Workers: the built runtime entries must bundle for workerd without Bun or Node-only modules (dry run, nothing is deployed).
WRANGLER="$ROOT/packages/db-multi/node_modules/.bin/wrangler"
if [ -x "$WRANGLER" ]; then
  cat > worker.mjs <<'JS'
import { createConfig, createDatabase } from "@0furkancolak/pgcells";
import { neonDriver } from "@0furkancolak/pgcells/drivers/neon";
import { postgresDriver } from "@0furkancolak/pgcells/drivers/postgres";
import { dbMiddleware } from "@0furkancolak/pgcells/middleware";
export default {
  async fetch(request, env) {
    const db = createDatabase(createConfig([String(env.DB0 ?? "")]), { driver: env.DRIVER === "neon" ? neonDriver : postgresDriver, poolMax: 1 });
    try { return new Response(typeof dbMiddleware === "function" ? "ok" : "no"); } finally { await db.close(); }
  },
};
JS
  echo '{ "name": "pack-workers-check", "main": "worker.mjs", "compatibility_date": "2026-09-07", "compatibility_flags": ["nodejs_compat"] }' > wrangler.jsonc
  "$WRANGLER" deploy --dry-run --config wrangler.jsonc --outdir "$TMP/worker-out" > "$TMP/wrangler.txt" 2>&1 || { cat "$TMP/wrangler.txt" >&2; echo "the packed package does not bundle for Workers" >&2; exit 1; }
else
  echo "wrangler is not installed (run bun install); skipping the Workers bundle check" >&2
fi
# The publish script defaults to the `next` dist-tag while the version is 0.x, and prints (does not do) the publish in dry-run mode.
publish_output="$(DRY_RUN=1 bash "$ROOT/scripts/publish.sh" 2>&1)"   # captured first: `grep -q` in a pipe would SIGPIPE the script under pipefail
echo "$publish_output" | grep -q "with tag next" || { echo "publish.sh dry run did not use the next tag for a 0.x version" >&2; exit 1; }
echo "pack smoke ok"
