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
	# Record the exact identities for post-reconcile verification. The two oldest
	# (by createdAt) are the frozen GC targets (keep=0); the newest is the active
	# generation the pointer selects. Parse them from the create outputs.
	grep -m1 -oE 'generation   [0-9a-f-]+' "$ROOT/create1.out" | awk '{print $2}' >"$ROOT/gen1.id"
	grep -m1 -oE 'generation   [0-9a-f-]+' "$ROOT/create2.out" | awk '{print $2}' >"$ROOT/gen2.id"
	grep -m1 -oE 'generation   [0-9a-f-]+' "$ROOT/create3.out" | awk '{print $2}' >"$ROOT/gen3.id"
	# FROZEN_TARGETS (the two superseded, keep=0 deletes both) and ACTIVE_GEN.
	# create1 + create2 are superseded (gen3 is active). Order by createdAt for the
	# frozen set; the harness verifies EXACTLY these are removed.
	cat "$ROOT/gen1.id" "$ROOT/gen2.id" | sort >"$ROOT/frozen-targets.txt"
	cat "$ROOT/gen3.id" >"$ROOT/active-gen.id"
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
	for _ in $(seq 1 300); do
		[ -f "$marker/paused" ] && break
		kill -0 "$pid" 2>/dev/null || { echo "      gc-worker exited before marker" >&2; return 1; }
		sleep 0.1
	done
	[ -f "$marker/paused" ] || { echo "      marker never written" >&2; return 1; }
	kill -9 "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	echo "      killed gc-worker at $boundary (pid was $pid)"
}

# Verify post-reconcile state after the interrupted GC. Asserts the EXACT
# invariants (blocker 6): only the frozen target IDs removed; the active
# generation retained with its EXACT pointer identity; the completed journal has
# the expected phase/cursor; the catalog exactly matches manifests; DuckDB
# queryable; no tombstone retains data; no active op.
verify_after_reconcile() {
	local archive data errs=""
	data="$(cat "$ROOT/data.path")"; archive="$ROOT/archive"
	local gens_dir="$archive/$SIGNAL/$RANGE_DATE/generations"
	# Exactly one generation remains (the active one); both frozen targets deleted.
	local count
	count=$(find "$gens_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
	[ "$count" = "1" ] || errs="$errs generations=$count(need 1)"
	# EXACT: the remaining generation is the recorded active gen; the frozen
	# targets are absent.
	local active_gen
	active_gen="$(cat "$ROOT/active-gen.id" 2>/dev/null)"
	if [ -n "$active_gen" ]; then
		[ -d "$gens_dir/$active_gen" ] || errs="$errs active-gen-missing"
		while read -r ft; do
			[ -n "$ft" ] || continue
			[ -d "$gens_dir/$ft" ] && errs="$errs frozen-target-$ft-still-present"
		done <"$ROOT/frozen-targets.txt"
	fi
	# EXACT pointer identity: the active pointer selects exactly the active gen.
	local pointer_gen
	pointer_gen=$(jq -r '.generationId' "$archive/$SIGNAL/$RANGE_DATE/active.json" 2>/dev/null)
	[ "$pointer_gen" = "$active_gen" ] || errs="$errs pointer=$pointer_gen(need $active_gen)"
	# Catalog MUST exist and exactly match authoritative manifests (rebuild is
	# idempotent; a second rebuild must not change the file → the catalog is
	# canonical). A MISSING catalog is a failure, not skipped (blocker 5).
	local catalog="$archive/$SIGNAL/catalog.jsonl"
	[ -f "$catalog" ] || errs="$errs catalog-missing"
	if [ -f "$catalog" ]; then
		local before after
		before=$(shasum -a 256 "$catalog" | awk '{print $1}')
		"$MAPLE" archive rebuild "$SIGNAL" --archive-dir "$archive" >/dev/null 2>&1
		after=$(shasum -a 256 "$catalog" | awk '{print $1}')
		[ "$before" = "$after" ] || errs="$errs catalog-not-canonical"
	fi
	# Completed journal: phase=complete, completedTargets === frozen count, frozen
	# set unchanged. Look in completed/ for the GC op's journal specifically (there
	# may be prior create-op journals too; pick the one with kind: gc).
	local frozen_n completed_dir journal_phase journal_cursor
	frozen_n=$(wc -l <"$ROOT/frozen-targets.txt" | tr -d ' ')
	completed_dir="$archive/operations/completed"
	journal_phase=""; journal_cursor=""
	if [ -d "$completed_dir" ]; then
		local j
		j=$(find "$completed_dir" -name intent.json 2>/dev/null | while read -r f; do
			[ "$(jq -r '.kind // empty' "$f" 2>/dev/null)" = "gc" ] && { echo "$f"; break; }
		done)
		if [ -n "$j" ]; then
			journal_phase=$(jq -r '.phase // empty' "$j" 2>/dev/null)
			journal_cursor=$(jq -r '.completedTargets // empty' "$j" 2>/dev/null)
		fi
	fi
	[ "$journal_phase" = "complete" ] || errs="$errs journal-phase=$journal_phase"
	[ "$journal_cursor" = "$frozen_n" ] || errs="$errs journal-cursor=$journal_cursor(need $frozen_n)"
	# The completed journal's frozen target IDs must EXACTLY equal the pre-crash
	# frozen set (blocker 5: never re-expanded). Compare sorted generationId lists.
	if [ -n "${j:-}" ]; then
		jq -r '.targets[].generationId' "$j" 2>/dev/null | sort >"$ROOT/journal-targets.txt"
		if ! diff -q "$ROOT/frozen-targets.txt" "$ROOT/journal-targets.txt" >/dev/null 2>&1; then
			errs="$errs journal-targets-differ-from-frozen"
		fi
	fi
	# No tombstone retains a generation dir.
	local tombstone_gen
	tombstone_gen=$(find "$archive/operations" -type d -name tombstones -exec sh -c 'for e in "$1"/*; do [ -e "$e" ] && echo x && break; done' _ {} \; 2>/dev/null | wc -l | tr -d ' ')
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
	echo "      verified (exact active/pointer/frozen/journal/catalog)"
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

# Five DISTINCT SIGKILL boundaries. Reconcile ALWAYS completes the frozen target
# set (it never re-expands it), so every boundary converges to: only the active
# generation remains, no tombstones, no active op, idempotent, create-after OK.
# `nonfinal-progress` is the faithful boundary that exposes the premature-
# complete defect (replaces the duplicate `during-removal` label).
for b in after-intent-durable after-first-rename nonfinal-progress after-all-removals after-catalog; do
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
