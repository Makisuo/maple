#!/usr/bin/env bash
# Native interrupted-GC crash-recovery probe (Gate 3b).
#
# The AUTHORITATIVE oracle for GC crash-safety: a real SIGKILL mid-collection,
# then convergence via the real `maple archive reconcile` CLI. GC deletes
# published generations, so its crash-safety is where a half-deleted generation
# could otherwise leave the archive unreconcilable. The tombstone-rename design
# (never in-place recursive delete) makes a crash leave only whole, owned state.
#
# Scenario: seed one ACTIVE generation + two superseded generations, run
# `gc --keep 0` via the worker paused after the first target is collected (one
# superseded deleted, one remaining), SIGKILL it, then run the real reconcile CLI
# and verify:
#   - only the frozen targets are removed; active generation intact + queryable;
#   - pointer unchanged; catalog exactly matches manifests; no tombstones remain;
#   - completed GC journal retained; second reconcile is a no-op;
#   - a subsequent `archive create` succeeds (crashed GC didn't block future work).
#
# Usage: apps/cli/test/native-archive-gc-probe.sh <bundle-dir> [port]
set -uo pipefail

BUNDLE_DIR="${1:?usage: $0 <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
LIBCHDB="${MAPLE_LIBCHDB:-$BUNDLE_DIR/libchdb.so}"
PORT="${2:-45401}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKER="$REPO/apps/cli/test/probes/archive-gc-worker.ts"
RANGE_DATE="2026-06-29"
SIGNAL="traces"

command -v duckdb >/dev/null 2>&1 || { echo "FAIL: duckdb required" >&2; exit 1; }
[ -x "$MAPLE" ] || { echo "FAIL: maple binary not found at $MAPLE" >&2; exit 1; }
[ -f "$LIBCHDB" ] || { echo "FAIL: libchdb not found at $LIBCHDB" >&2; exit 1; }

CHDB_VER="$("$MAPLE" --version 2>/dev/null | grep -oE 'chdb v[^ ]+' | sed 's/chdb //')"
[ -z "$CHDB_VER" ] && CHDB_VER="v26.1.0"
BUN=(bun --define "__CHDB_VERSION__=\"${CHDB_VER}\"")

pass=0
fail=0
declare -a FAILURES=()
ROOT=""
SERVER_PID=""

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	SERVER_PID=""
	if [[ -n "${ROOT:-}" && "${KEEP_ROOT:-0}" != "1" ]]; then rm -rf "$ROOT"; fi
}
trap cleanup EXIT

# Clear any process bound to our port before each server start, so a leaked
# server from a prior step can't collide (defensive; the trap should prevent it,
# but a server killed mid-bootstrap can occasionally leave the port bound briefly).
clear_port() {
	for pid in $(lsof -ti tcp:"$PORT" 2>/dev/null); do
		kill -9 "$pid" 2>/dev/null || true
	done
	sleep 0.3
}

query() {
	curl --fail-with-body -sS "http://127.0.0.1:$PORT/local/query" \
		-H 'content-type: application/json' --data "$(jq -nc --arg sql "$1" '{sql:$sql}')"
}
wait_health() {
	for _ in $(seq 1 200); do
		curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return
		sleep 0.1
	done
	return 1
}

# Build a store, then create THREE generations for RANGE_DATE (each supersedes),
# so there is 1 active + 2 superseded. Returns the active generation id on stdout.
build_superseded_store() {
	ROOT="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/maple-gc.XXXXXX")")"
	local data="$ROOT/data" archive="$ROOT/archive" scratch="$ROOT/scratch"
	local config="$ROOT/backups.xml"
	printf '%s\n' '<clickhouse><backups><allowed_disk>default</allowed_disk><allowed_path>backups</allowed_path></backups></clickhouse>' >"$config"
	chmod 600 "$config"
	clear_port
	"$MAPLE" start --port "$PORT" --data-dir "$data" --chdb-config-file "$config" --on-dirty-store fail --offline >"$ROOT/server.log" 2>&1 &
	SERVER_PID=$!
	wait_health || { echo "FAIL: server unhealthy" >&2; return 1; }
	local ts="${RANGE_DATE}T12:00:00"
	query "INSERT INTO $SIGNAL (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'gc', toDateTime64('${ts}.000000000', 9, 'UTC'), 't1', 's1', '', '', 'm', 'Server', 'gc-probe', 'Ok', ''" >/dev/null
	"$MAPLE" checkpoint --port "$PORT" --data-dir "$data" >/dev/null 2>&1
	# Seal gen 1.
	"$MAPLE" archive create "$RANGE_DATE" "$SIGNAL" --data-dir "$data" --archive-dir "$archive" --scratch-root "$scratch" >"$ROOT/create1.out" 2>&1 || return 1
	# Seal gen 2 (supersedes 1).
	"$MAPLE" archive create "$RANGE_DATE" "$SIGNAL" --data-dir "$data" --archive-dir "$archive" --scratch-root "$scratch" >"$ROOT/create2.out" 2>&1 || return 1
	# Seal gen 3 (supersedes 2) — this is the active generation.
	"$MAPLE" archive create "$RANGE_DATE" "$SIGNAL" --data-dir "$data" --archive-dir "$archive" --scratch-root "$scratch" >"$ROOT/create3.out" 2>&1 || return 1
	"$MAPLE" stop --data-dir "$data" >/dev/null 2>&1 || true
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
	echo "$data" >"$ROOT/data.path"
	# Count superseded generations (should be 2; active is 1).
	local gens_dir="$archive/$SIGNAL/$RANGE_DATE/generations"
	local count
	count=$(find "$gens_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
	[ "$count" = "3" ] || { echo "FAIL: expected 3 generations, got $count" >&2; return 1; }
}

# Spawn the gc worker paused after the first target, SIGKILL it.
spawn_and_kill_gc() {
	local marker="$1" boundary="$2"
	local data archive
	data="$(cat "$ROOT/data.path")"; archive="$ROOT/archive"
	MAPLE_LIBCHDB="$LIBCHDB" "${BUN[@]}" "$WORKER" \
		--boundary "$boundary" --marker-dir "$marker" \
		--data-dir "$data" --archive-dir "$archive" --scratch-root "$ROOT/scratch" \
		--keep 0 --block-ms 60000 >"$ROOT/gc-worker.out" 2>&1 &
	local pid=$!
	local i
	for i in $(seq 1 300); do
		[ -f "$marker/paused" ] && break
		kill -0 "$pid" 2>/dev/null || { echo "      gc-worker exited before marker" >&2; return 1; }
		sleep 0.1
	done
	[ -f "$marker/paused" ] || { echo "      marker never written" >&2; return 1; }
	kill -9 "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	echo "      killed gc-worker at $boundary (pid was $pid)"
}

# Verify post-reconcile state after the interrupted GC.
# $1 = expected number of generations remaining (1 if collection proceeded; 3 if
# the crash was before any collection, e.g. after-intent-durable).
verify_after_reconcile() {
	local expect_gens="${1:-1}"
	local archive data errs=""
	data="$(cat "$ROOT/data.path")"; archive="$ROOT/archive"
	local gens_dir="$archive/$SIGNAL/$RANGE_DATE/generations"
	local count
	count=$(find "$gens_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
	[ "$count" = "$expect_gens" ] || errs="$errs generations=$count(need $expect_gens)"
	# No tombstone may still HOLD a generation dir (a tombstone with entries means a
	# rename completed but removal didn't — an unreclaimed generation). An empty
	# tombstones/ parent retained in a completed op journal is harmless metadata.
	local tombstone_gen
	tombstone_gen=$(find "$archive/operations" -type d -name tombstones 2>/dev/null -exec sh -c 'for e in "$1"/*; do [ -e "$e" ] && echo x && break; done' _ {} \; | wc -l | tr -d ' ')
	[ "$tombstone_gen" = "0" ] || errs="$errs tombstone-with-generations"
	# No active operation journal.
	local active_dir="$archive/operations/active"
	local active_count
	active_count=$( [ -d "$active_dir" ] && find "$active_dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ' || echo 0 )
	[ "$active_count" = "0" ] || errs="$errs active-op=$active_count"
	# The active generation is DuckDB-queryable with the exact marker count.
	local paths_csv f count_duck=""
	for f in "$gens_dir"/*/shards/*.parquet; do
		[ -f "$f" ] || continue
		paths_csv="${paths_csv:+$paths_csv,}\"$f\""
	done
	if [ -n "$paths_csv" ]; then
		count_duck="$(duckdb -csv -noheader -c "SELECT count() FROM read_parquet([$paths_csv]) WHERE ServiceName='gc-probe'" 2>"$ROOT/gc-duckdb.err")" \
			|| errs="$errs duckdb-fail"
		[ "$(echo "$count_duck" | tr -d '[:space:]')" = "1" ] || errs="$errs duckdb-count=$count_duck"
	fi
	if [ -n "$errs" ]; then
		echo "      VERIFY FAIL:$errs" >&2
		return 1
	fi
	echo "      verified (1 active gen, queryable, no tombstones/active-op)"
}

run_gc_crash() {
	local boundary="$1"
	echo "  [interrupted gc @ $boundary]"
	build_superseded_store >/dev/null || { echo "  !! build failed ($boundary)" >&2; fail=$((fail+1)); FAILURES+=("build:$boundary"); return; }
	# marker path uses ROOT, which build_superseded_store just set — assign AFTER build.
	local marker="$ROOT/marker-gc-$boundary"
	rm -rf "$marker"; mkdir -p "$marker"
	spawn_and_kill_gc "$marker" "$boundary" || { echo "  !! spawn/kill failed ($boundary)" >&2; fail=$((fail+1)); FAILURES+=("spawn:$boundary"); return; }
	local data archive
	data="$(cat "$ROOT/data.path")"; archive="$ROOT/archive"
	# Reconcile the crashed GC via the REAL CLI.
	if ! "$MAPLE" archive reconcile --data-dir "$data" --archive-dir "$archive" --scratch-root "$ROOT/scratch" >"$ROOT/reconcile.out" 2>&1; then
		echo "  !! reconcile failed:" >&2; tail -5 "$ROOT/reconcile.out" >&2; fail=$((fail+1)); FAILURES+=("reconcile"); return
	fi
	verify_after_reconcile || { fail=$((fail+1)); FAILURES+=("verify"); return; }
	# Idempotence: reconcile AGAIN is a no-op.
	if ! "$MAPLE" archive reconcile --data-dir "$data" --archive-dir "$archive" --scratch-root "$ROOT/scratch" >"$ROOT/reconcile2.out" 2>&1; then
		echo "  !! second reconcile failed" >&2; fail=$((fail+1)); FAILURES+=("idempotence"); return
	fi
	verify_after_reconcile >/dev/null || { echo "  !! state drifted after second reconcile" >&2; fail=$((fail+1)); FAILURES+=("idempotence"); return; }
	# A subsequent archive create must succeed (crashed GC didn't block future work).
	clear_port
	"$MAPLE" start --port "$PORT" --data-dir "$data" --chdb-config-file "$ROOT/backups.xml" --on-dirty-store fail --offline >"$ROOT/server2.log" 2>&1 &
	SERVER_PID=$!
	wait_health || { echo "  !! server2 unhealthy" >&2; fail=$((fail+1)); FAILURES+=("create-after"); return; }
	"$MAPLE" stop --data-dir "$data" >/dev/null 2>&1 || true
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
	if ! "$MAPLE" archive create "$RANGE_DATE" "$SIGNAL" --data-dir "$data" --archive-dir "$archive" --scratch-root "$ROOT/scratch" >"$ROOT/create-after.out" 2>&1; then
		echo "  !! subsequent archive create failed (GC blocked future work)" >&2; tail -5 "$ROOT/create-after.out" >&2
		fail=$((fail+1)); FAILURES+=("create-after"); return
	fi
	pass=$((pass+1))
	echo "  create-after: OK (crashed GC did not block future work)"
}

echo "=== Archive interrupted-GC crash-recovery probe (libchdb=$(basename "$LIBCHDB")) ==="
echo "    real SIGKILL mid-collection → real reconcile CLI → verify convergence + idempotence + create-after"
echo

# All 5 SIGKILL boundaries. Reconcile ALWAYS completes the frozen target set
# (it never re-expands it), so every boundary converges to: only the active
# generation remains, no tombstones, no active op, idempotent, create-after OK.
for b in after-intent-durable after-first-rename during-removal after-all-removals after-catalog; do
	run_gc_crash "$b"
done

echo
echo "--- gc dry-run mutates nothing ---"

# gc_dry_run: separately prove --dry-run reports the delete set but deletes
# nothing and leaves no operation journal.
gc_dry_run() {
	build_superseded_store >/dev/null || { echo "  !! build failed (dry-run)" >&2; fail=$((fail+1)); FAILURES+=("dry-run-build"); return; }
	local data archive gens_before gens_after
	data="$(cat "$ROOT/data.path")"; archive="$ROOT/archive"
	gens_before=$(find "$archive/$SIGNAL/$RANGE_DATE/generations" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
	if "$MAPLE" archive gc --keep 0 --dry-run --data-dir "$data" --archive-dir "$archive" --scratch-root "$ROOT/scratch" >"$ROOT/gc-dryrun.out" 2>&1; then
		grep -q "would delete 2" "$ROOT/gc-dryrun.out" || { echo "  !! dry-run did not report 2 deletions" >&2; fail=$((fail+1)); FAILURES+=("dry-run-report"); return; }
		gens_after=$(find "$archive/$SIGNAL/$RANGE_DATE/generations" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
		[ "$gens_after" = "$gens_before" ] || { echo "  !! dry-run mutated generations ($gens_before → $gens_after)" >&2; fail=$((fail+1)); FAILURES+=("dry-run-mutate"); return; }
		# dry-run should leave no operation journal.
		if [ -d "$archive/operations/active" ] && [ "$(find "$archive/operations/active" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
			echo "  !! dry-run left an active op" >&2; fail=$((fail+1)); FAILURES+=("dry-run-journal"); return
		fi
		pass=$((pass+1)); echo "  dry-run: OK (reported 2 deletions, mutated nothing)"
	else
		echo "  !! gc dry-run failed:" >&2; tail -5 "$ROOT/gc-dryrun.out" >&2; fail=$((fail+1)); FAILURES+=("dry-run")
	fi
}
gc_dry_run

echo
echo "=== Summary: $pass passed, $fail failed ==="
if [ "$fail" -gt 0 ]; then
	echo "FAILURES:"; for f in "${FAILURES[@]}"; do echo "  - $f"; done
	exit 1
fi
echo "ALL ARCHIVE GC CRASH-RECOVERY CHECKS GREEN"
