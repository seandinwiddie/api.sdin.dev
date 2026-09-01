#!/usr/bin/env bash

set -uo pipefail

failed=()

run_gate() {
  local label="$1"
  shift
  echo "[verify] ${label}"
  if ! "$@"; then
    failed+=("${label}")
  fi
}

run_gate "node tests" npm test
run_gate "authored data authority" npm run check:data-authority
run_gate "security policy and secrets" npm run check:security
run_gate "production dependencies" npm run check:dependencies
run_gate "source syntax" npm run check:syntax
run_gate "whitespace" git diff --check

if ((${#failed[@]} > 0)); then
  echo "[verify] failed: ${failed[*]}" >&2
  exit 1
fi

echo "[verify] all API gates passed"
