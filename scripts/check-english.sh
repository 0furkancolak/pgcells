#!/usr/bin/env bash
# Fails when Turkish text remains in source comments and documentation. Exempt: applied migration/seed files (their bytes are frozen),
# tests (their comments are English; they keep deliberate non-ASCII test data such as "çğ" and "Ayşe"), design history, the Turkish README, the unpublished preset, fixtures, and benchmark results. The word
# "Türkçe" (language-switch link) is allowed.
set -euo pipefail
cd "$(dirname "$0")/.."
hits=""
while IFS= read -r -d '' file; do
  case "$file" in
    docs/design/*|scripts/*|README.tr.md|bun.lock|*/src/migrations/*|*/src/seeds/*|*/__tests__/*|*/fixtures/*|*/results/*|*.gen.ts|*.sql|*.json|*.jsonl) continue ;;
  esac
  if perl -CSD -pe 's/Türkçe//g' "$file" 2>/dev/null | perl -CSD -ne 'BEGIN{$f=0} $f=1 if /[çğıöşüÇĞİÖŞÜ]/; END{exit($f?0:1)}'; then hits="$hits$file"$'\n'; fi
done < <(git ls-files -z)
if [ -n "$hits" ]; then
  echo "Turkish text found in $(printf '%s' "$hits" | grep -c .) files:" >&2
  printf '%s' "$hits" >&2
  exit 1
fi
