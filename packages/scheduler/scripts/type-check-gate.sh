#!/bin/sh
# S315-S1: baseline-gated type-check for packages/scheduler (Refs #315).
#
# WHY A BASELINE: scheduler had a tsconfig but NO `type-check` script, so the root
# `pnpm -r type-check` gate silently SKIPPED it (pnpm -r skips packages without the
# script — the exact failure mode pinned for mastra by type-check-coverage-s267-s4).
# On top of that, `tsc -p` was unusable as-is: `rootDir: src` + the root
# tsconfig.base `paths` (workspace packages export raw .ts sources) produced ~140
# TS6059 cross-package errors — the structural noise the base tsconfig comment had
# been tracking as "any future scheduler rootDir fix". Removing rootDir (noEmit
# anyway) dissolves that class; the remaining 27 diagnostics are pre-existing
# (product + test fixtures + cross-package pull-ins), so the gate compares against
# type-check.baseline like mastra's S261-S2 gate: any NEW error fails, a LOWER
# count fails with a "ratchet down" reminder, main's errors stay documented, not
# silently tolerated.
#
# Producer safety (S267-S3 lesson, learned in #258): a missing/crashed tsc must not
# read as "0 errors". We check tsc's exit code AND require diagnostics whenever it
# exits non-zero.
set -eu

cd "$(dirname "$0")/.."

BASELINE=type-check.baseline
TSC_ARGS="../../node_modules/typescript/bin/tsc"

if [ ! -f "$BASELINE" ]; then
  echo "scheduler type-check: missing $BASELINE" >&2
  exit 1
fi
base=$(grep -oE '^[0-9]+$' "$BASELINE" | tail -1)
if [ -z "${base:-}" ]; then
  echo "scheduler type-check: no numeric baseline line in $BASELINE" >&2
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
  echo "scheduler type-check: tsc failed to run (exit $code)" >&2
  cat "$out" >&2
  exit 1
fi

actual=$(grep -cE 'error TS[0-9]+:' "$out" || true)

# S267-S3 shape (do not regress to an exit-2-only check): a non-zero tsc exit MUST
# have produced at least one `error TS` line. A missing tsc binary makes
# `node <missing path>` exit 1 with MODULE_NOT_FOUND and zero error lines; without
# this guard that reads as "0 < baseline -> ratchet down" or, with a 0 baseline, as
# a clean GREEN. Neither is allowed.
if [ "$code" -ne 0 ] && [ "$actual" -eq 0 ]; then
  echo "scheduler type-check: tsc exited $code with zero 'error TS' diagnostics - the gate did not observe real type errors (missing/crashed tsc?)" >&2
  cat "$out" >&2
  exit 1
fi

if [ "$actual" -gt "$base" ]; then
  echo "scheduler type-check: $actual errors > baseline $base ($BASELINE)" >&2
  grep -E 'error TS[0-9]+:' "$out" | head -30 >&2
  exit 1
fi

if [ "$actual" -lt "$base" ]; then
  echo "scheduler type-check: $actual errors < baseline $base - ratchet $BASELINE down" >&2
  exit 1
fi

echo "scheduler type-check OK ($actual/$base, baseline in $BASELINE)"
