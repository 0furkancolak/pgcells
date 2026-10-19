#!/usr/bin/env bash
# Fails when the pre-rename package scope `@repo/` is still referenced outside the allowed places:
# design history, applied migration files (frozen), and persisted strings that must never change (derived-secret salt,
# pull marker, Better Auth adapter names).
set -euo pipefail
cd "$(dirname "$0")/.."
hits=$(git ls-files -z | xargs -0 grep -nHE '@repo\\?/' 2>/dev/null \
  | grep -vE '^(docs/(superpowers|design)/|scripts/|[^:]*/src/migrations/|bun\.lock|[^:]*/frozen-identifiers\.golden\.json)' \
  | grep -vE '@repo\\?/db\\?/auth|@repo\\?/db pull|adapterName: "@repo/db' \
  | grep -vE '^README(\.tr)?\.md:.*@repo/\*' || true)
if [ -n "$hits" ]; then
  echo "Legacy @repo/ references found:" >&2
  echo "$hits" >&2
  exit 1
fi
