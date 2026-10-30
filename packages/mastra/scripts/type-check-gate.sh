#!/bin/sh
# S261-S2: baseline-gated type-check for packages/mastra.
#
# WHY A BASELINE: packages/mastra had no tsconfig before #261-S2, so nothing ever
# type-checked it. Adding a clean `tsc -p` gate would either fail on day one (22
# pre-existing errors on origin/main tip 6f1a508, all in test fixtures) or tempt a
# scope-creep cleanup in a test-hardening PR. So the gate compares the diagnostic
# count against type-check.baseline: any NEW error fails, a LOWER count fails with a
# "ratchet down" reminder, and main's errors stay documented, not silently tolerated.
#
# Producer safety (learned the hard way in #258): a missing/crashed tsc must not read
# as "0 errors". We check tsc's exit code AND require diagnostics when it exits 2.
set -eu

cd "$(dirname "$0")/.."

BASELINE=type-check.baseline
TSC_ARGS="../../node_modules/typescript/bin/tsc"

if [ ! -f "$BASELINE" ]; then
  echo "mastra type-check: missing $BASELINE" >&2
  exit 1
fi
base=$(grep -oE '^[0-9]+$' "$BASELINE" | tail -1)
if [ -z "${base:-}" ]; then
  echo "mastra type-check: no numeric baseline line in $BASELINE" >&2
  exit 1
fi

out=$(mktemp)
trap 'rm -f "$out"' EXIT

set +e
node $TSC_ARGS -p tsconfig.json >"$out" 2>&1
code=$?
set -e

# tsc exits 0 (clean), 1 (diagnostics), 2 (fatal). Anything else = did not run.
if [ "$code" -ne 0 ] && [ "$code" -ne 1 ] && [ "$code" -ne 2 ]; then
  echo "mastra type-check: tsc failed to run (exit $code)" >&2
  cat "$out" >&2
  exit 1
fi

actual=$(grep -cE 'error TS[0-9]+:' "$out" || true)

if [ "$code" -eq 2 ] && [ "$actual" -eq 0 ]; then
  echo "mastra type-check: tsc crashed with no diagnostics (exit 2)" >&2
  cat "$out" >&2
  exit 1
fi

if [ "$actual" -gt "$base" ]; then
  echo "mastra type-check: $actual errors > baseline $base ($BASELINE)" >&2
  grep -E 'error TS[0-9]+:' "$out" | head -30 >&2
  exit 1
fi

if [ "$actual" -lt "$base" ]; then
  echo "mastra type-check: $actual errors < baseline $base - ratchet $BASELINE down" >&2
  exit 1
fi

echo "mastra type-check OK ($actual/$base, baseline in $BASELINE)"
