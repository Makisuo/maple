#!/usr/bin/env bash
# Native adversarial probe runner for archive export.
#
# Invokes ONLY committed, repository-relative probe sources under apps/cli/test/
# probes/. Every probe uses an owned mkdtemp dir and consistent exit semantics:
# nonzero when corruption is ACCEPTED (the bug is present), zero when corruption
# is correctly REJECTED. This runner reports the verdict per probe.
#
# See apps/cli/test/archive-adversarial-matrix.md for the invariant matrix.
#
# Usage: apps/cli/test/native-archive-adversarial-probe.sh <bundle-dir> [libchdb-path]

set -uo pipefail

BUNDLE="${1:?usage: $0 <bundle-dir> [libchdb-path]}"
LIBCHDB="${2:-$BUNDLE/libchdb.so}"
export MAPLE_LIBCHDB="$LIBCHDB"

cd "$(dirname "$0")/../../.." || exit 1  # apps/cli/test/x.sh -> apps/cli/test -> apps/cli -> apps -> repo root
PROBE_DIR="apps/cli/test/probes"

pass=0
fail=0
declare -a FAILURES=()

# run_probe <label> <probe-file> [extra-env-assignments...] : a probe exits 0
# when it succeeds at its contract (corruption correctly rejected, OR valid data
# archived exactly).
run_probe() {
  local label="$1" probe="$2"; shift 2
  local out rc
  out="$(env MAPLE_LIBCHDB="$LIBCHDB" "$@" bun "$PROBE_DIR/$probe" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '  OK   %s\n' "$label"
    pass=$((pass+1))
  else
    printf '  !!   %s\n' "$label"
    printf '%s\n' "$out" | sed 's/^/        | /' | tail -6
    fail=$((fail+1))
    FAILURES+=("$label")
  fi
}

echo "=== Archive adversarial probe suite (libchdb=$(basename "$LIBCHDB")) ==="
echo

echo "--- sharding correctness ---"
run_probe "mixed-hour non-contiguous offsets archive exactly" "archive-probe-mixed-hour.ts"
run_probe "multi-part one hour archives exact set"            "archive-probe-multipart.ts"
run_probe "injected OPTIMIZE between shards blocked"          "archive-probe-merge-injection.ts"

echo
echo "--- byte bounds ---"
run_probe "uniform wide rows split by bytes"                  "archive-probe-byte-uniform.ts"
run_probe "heterogeneous widths refine (narrow prefix/wide tail)" "archive-probe-byte-heterogeneous.ts"
run_probe "single oversized row fails distinctly"             "archive-probe-byte-single-row.ts"

echo
echo "--- complex-value + digest ---"
run_probe "schema substitution Array(UInt64)!=Array(String) rejected" "archive-probe-schema-substitution.ts"
run_probe "NULL columns do not collapse digest"               "archive-probe-null-digest.ts"
run_probe "NULL-bearing rows remain value-sensitive in non-null cols" "archive-probe-null-value-sensitivity.ts"
run_probe "explicit NULL flag: NULL != sentinel string"            "archive-probe-null-flag-binding.ts"
run_probe "altered complex value (identical count/time) detected"     "archive-probe-complex-alter.ts"
run_probe "same-typed column swap detected"                   "archive-probe-digest-column-swap.ts"
run_probe "cross-row value reassociation detected"            "archive-probe-digest-row-swap.ts"
run_probe "duplicate-one/drop-another equal-count detected"   "archive-probe-digest-dup-drop.ts"

echo
echo "--- cleanup ---"
run_probe "merge freeze restarted after setup failure"        "archive-probe-merge-freeze-leak.ts"

echo
echo "--- independent DuckDB oracle (read-back fidelity) ---"
run_probe "DuckDB oracle: count, nanos, NULL, arrays match source" "archive-probe-duckdb-oracle.ts"

echo
echo "--- UTC time bounds (host timezone independence) ---"
run_probe "valid 23:30 UTC bound accepted under America/New_York" "archive-probe-timezone-bound.ts" env TZ=America/New_York

echo
echo "=== Summary: $pass passed, $fail failed ==="
if [ "$fail" -gt 0 ]; then
  echo "FAILURES:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "ALL ARCHIVE ADVERSARIAL PROBES GREEN"
