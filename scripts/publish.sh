#!/usr/bin/env bash
# Publishes every package whose version is not on npm yet. Packs with bun (resolves `workspace:*` to real versions and runs the
# prepack build), then publishes the tarball with npm so provenance (GitHub OIDC) works. 0.x versions use the `next` dist-tag.
# DRY_RUN=1 only prints what would happen.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Redis builds its declarations against the built db-multi; build it even when db-multi itself is skipped as already published.
bun run --cwd "$ROOT/packages/db-multi" build >/dev/null
for package in db-multi db-single redis; do
  dir="$ROOT/packages/$package"
  name="$(bun -e "console.log(require('$dir/package.json').name)")"
  version="$(bun -e "console.log(require('$dir/package.json').version)")"
  # 0.x versions go to the `next` dist-tag; 1.0 and later to `latest`. NPM_TAG overrides.
  TAG="${NPM_TAG:-$([ "${version%%.*}" = "0" ] && echo next || echo latest)}"
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "$name@$version is already published, skipping"
    continue
  fi
  (cd "$dir" && bun pm pack --destination "$TMP" --quiet >/dev/null)
  tarball="$(ls "$TMP"/*.tgz | grep -F "$(echo "$name" | sed 's#@##; s#/#-#')-$version.tgz")"
  if [ "${DRY_RUN:-}" = "1" ]; then
    npm publish "$tarball" --access public --tag "$TAG" --dry-run
  else
    npm publish "$tarball" --access public --tag "$TAG" --provenance
  fi
done
