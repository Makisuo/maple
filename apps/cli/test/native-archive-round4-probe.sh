#!/usr/bin/env bash
# Native round-4 adversarial probe for the archive export.
#
# Exercises the real exportSignalShards against real chDB with each of the
# reviewer's exact round-3 failure scenarios, plus the merge-injection case.
# Every scenario must end in the contract outcome (PASS when data should
# archive exactly; FAIL-CLOSED when validation should reject). This is the
# evidence that the round-4 fixes are correct under native runtime behavior,
# not under unit-test assumptions.
#
# Usage: apps/cli/test/native-archive-round4-probe.sh <bundle-dir> [libchdb-path]
#   bundle-dir  directory containing the `maple` binary
#   libchdb     optional explicit libchdb.so (defaults to <bundle>/libchdb.so)

set -euo pipefail

BUNDLE="${1:?usage: $0 <bundle-dir> [libchdb-path]}"
LIBCHDB="${2:-$BUNDLE/libchdb.so}"
PROBE_TS="$(date +%s)"
export MAPLE_LIBCHDB="$LIBCHDB"

cd "$(dirname "$0")/.."

pass=0
fail=0
declare -a FAILURES=()

run() {
  local name="$1" expect="$2"; shift 2
  local out rc
  out="$(MAPLE_LIBCHDB="$LIBCHDB" bun "$@" 2>&1)" && rc=0 || rc=$?
  local got
  if [ "$rc" -eq 0 ]; then got="PASS"; else got="FAIL"; fi
  if [ "$got" = "$expect" ]; then
    printf '  OK   %-54s %s\n' "$name" "$got"
    pass=$((pass+1))
  else
    printf '  !!   %-54s expected %s got %s\n' "$name" "$expect" "$got"
    printf '%s\n' "$out" | sed 's/^/        | /' | tail -8
    fail=$((fail+1))
    FAILURES+=("$name (expected $expect got $got)")
  fi
}

echo "=== Native round-4 adversarial probe (libchdb=$(basename "$LIBCHDB")) ==="
echo

echo "--- export correctness scenarios (expect PASS) ---"
# 1. Mixed-hour non-contiguous offsets (reviewer's offsets 0/9 layout). The
#    round-3 part-interval planner rejected this valid layout. Round-4 must
#    archive it exactly.
run "mixed-hour non-contiguous offsets archive exactly" PASS /tmp/r4probe-mixed-hour.ts
# 2. Multiple parts in one hour (out-of-order inserts). Must archive exact set.
run "multi-part one hour archives exact set" PASS /tmp/r4probe-multipart.ts
# 3. The merge-injection case: OPTIMIZE between shards blocked by STOP MERGES.
run "injected OPTIMIZE between shards is blocked" PASS /tmp/r4probe-merge-injection.ts

echo
echo "--- byte-driven sharding scenario (expect PASS) ---"
# 4. Wide high-entropy rows under the row limit but over the byte bound -> splits.
run "wide-row hour splits by bytes under row limit" PASS /tmp/r4probe-byte-split.ts

echo
echo "--- validation-failure scenarios (probes exit 0 when rejection confirmed) ---"
# Each probe below exits 0 (PASS) once it confirms validation rejects the
# adversarial input. A non-zero exit means validation FAILED to reject.
# 5. Schema substitution: Array(UInt64) source vs injected Array(String) Parquet
#    reopened schema -> compareSchema must reject.
run "schema substitution Array(UInt64)!=Array(String) rejected" PASS /tmp/r4probe-schema-substitution.ts
# 6. Complex-value digest: an altered map value with identical count/time must be
#    detected (the per-shard digest differs).
run "altered complex value with identical count/time detected" PASS /tmp/r4probe-complex-alter.ts
# 7. Merge-freeze leak: a failure after STOP MERGES must still restart merges.
run "merge freeze restarted after setup failure" PASS /tmp/r4probe-merge-freeze-leak.ts

echo
echo "=== Summary: $pass passed, $fail failed ==="
if [ "$fail" -gt 0 ]; then
  echo "FAILURES:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "ALL NATIVE ROUND-4 SCENARIOS PASS"
