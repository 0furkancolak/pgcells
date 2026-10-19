#!/usr/bin/env bash
# Fails when jamaster-specific wording appears in the published packages and guides. Allowed: design history,
# and applied migration/seed files whose bytes are frozen (their SHA-256 is stored in every ledger).
set -euo pipefail
cd "$(dirname "$0")/.."
hits=$(git ls-files -z | xargs -0 grep -niH "jamaster" 2>/dev/null \
  | grep -vE '^(docs/(superpowers|design)/|scripts/|\.github/CODEOWNERS|\.github/workflows/checks\.yml|\.changeset/config\.json|CHANGELOG\.md|bun\.lock)|[^:]*/src/(migrations|seeds)/' || true)
if [ -n "$hits" ]; then
  echo "jamaster wording found outside the design history:" >&2
  echo "$hits" >&2
  exit 1
fi
