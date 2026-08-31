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
run_gate "source syntax" npm run check:syntax
run_gate "whitespace" git diff --check

if ((${#failed[@]} > 0)); then
  echo "[verify] failed: ${failed[*]}" >&2
  exit 1
fi

echo "[verify] all API gates passed"
