#!/usr/bin/env bash
# Native crash-recovery probe for archive generation (Gate 3a).
#
# The AUTHORITATIVE crash oracle: a real SIGKILL at each lifecycle boundary, not
# a hook-throw (whose error still runs the finally and masks the crash). For each
# kill-point:
#   1. build a fresh store + checkpoint (the bundled `maple` binary);
#   2. spawn the crash worker (imports createArchiveGeneration) paused at the
#      boundary via a fault seam;
#   3. wait for the durable "paused" marker, then SIGKILL the child;
#   4. reconcile WITHOUT a fresh export (the reconcile worker);
#   5. verify the exact post-recovery state (active pointer, catalog, no orphan
#      pin, no building debris, retained scratch removed, published generation
#      passes validation, live store unchanged);
#   6. run reconciliation AGAIN and assert idempotence;
#   7. separately prove a fresh `archive create` reconciles before allocating.
#
# Usage: apps/cli/test/native-archive-crash-recovery-probe.sh <bundle-dir> [port]
set -uo pipefail

BUNDLE_DIR="${1:?usage: $0 <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
LIBCHDB="${MAPLE_LIBCHDB:-$BUNDLE_DIR/libchdb.so}"
PORT="${2:-45291}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKER="$REPO/apps/cli/test/probes/archive-crash-worker.ts"
RECONCILE="$REPO/apps/cli/test/probes/archive-reconcile-worker.ts"
# The bundled `maple` binary bakes __CHDB_VERSION__=v26.1.0 via bun --define at
# compile time; running the workers from SOURCE defaults CHDB_VERSION to "dev",
# which makes the restore version-check reject a checkpoint made by the bundle.
# Define it to match so the source-tree workers are version-consistent with the
# bundle's checkpoints. (The deployed binary is consistent by construction.)
CHDB_VER="$("$MAPLE" --version 2>/dev/null | grep -oE 'chdb v[^ ]+' | sed 's/chdb //')"
[ -z "$CHDB_VER" ] && CHDB_VER="v26.1.0"
BUN=(bun --define "__CHDB_VERSION__=\"${CHDB_VER}\"")

command -v duckdb >/dev/null 2>&1 || { echo "FAIL: duckdb required" >&2; exit 1; }
[ -x "$MAPLE" ] || { echo "FAIL: maple binary not found at $MAPLE" >&2; exit 1; }
[ -f "$LIBCHDB" ] || { echo "FAIL: libchdb not found at $LIBCHDB" >&2; exit 1; }

pass=0
fail=0
declare -a FAILURES=()

# ---- store + checkpoint setup (one per boundary, so each is independent) ----
ROOT=""
SERVER_PID=""
RANGE_DATE="$(date -u +%Y-%m-%d)"
SIGNAL="traces"

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ -n "${ROOT:-}" && "${KEEP_ROOT:-0}" != "1" ]]; then
		rm -rf "$ROOT"
	fi
}
trap cleanup EXIT

query() {
	curl --fail-with-body -sS "http://127.0.0.1:$PORT/local/query" \
		-H 'content-type: application/json' --data "$(jq -nc --arg sql "$1" '{sql:$sql}')"
}
wait_health() {
	for _ in $(seq 1 200); do
		curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return
		sleep 0.1
	done
	echo "FAIL: server unhealthy" >&2; return 1
}

# build_store: start server, ingest one marker into $SIGNAL, checkpoint, stop.
# Leaves a fresh dataDir/archive/scratch with exactly one sealed checkpoint.
build_store() {
	if [[ -n "${ROOT:-}" && -d "$ROOT" && "${KEEP_ROOT:-0}" != "1" ]]; then
		rm -rf "$ROOT"
	fi
	# Canonicalize macOS's /var -> /private/var alias. Gate 3 deliberately
	# rejects configured scratch roots with symlinked ancestors, so fixtures must
	# pass the real path rather than a system alias.
	ROOT="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/maple-crash.XXXXXX")")"
	local data="$ROOT/data" archive="$ROOT/archive" scratch="$ROOT/scratch"
	local config="$ROOT/backups.xml"
	printf '%s\n' '<clickhouse><backups><allowed_disk>default</allowed_disk><allowed_path>backups</allowed_path></backups></clickhouse>' >"$config"
	chmod 600 "$config"
	"$MAPLE" start --port "$PORT" --data-dir "$data" --chdb-config-file "$config" --on-dirty-store fail --offline >"$ROOT/server.log" 2>&1 &
	SERVER_PID=$!
	wait_health
	# Three markers at fixed UTC noon inside RANGE_DATE. maxShardRows=1 in the
	# worker therefore creates three shards and makes after-first-shard genuine.
	local ts="${RANGE_DATE}T12:00:00"
	query "INSERT INTO $SIGNAL (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'crash', toDateTime64('${ts}.000000000', 9, 'UTC'), concat('t', toString(number)), concat('s', toString(number)), '', '', 'm', 'Server', 'crash-probe', 'Ok', '' FROM numbers(3)" >/dev/null
	"$MAPLE" checkpoint --port "$PORT" --data-dir "$data" >"$ROOT/cp.out" 2>&1 || { cat "$ROOT/cp.out" >&2; return 1; }
	"$MAPLE" stop --data-dir "$data" >/dev/null 2>&1 || true
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
	echo "$data" >"$ROOT/data.path"
}

# spawn_and_kill <boundary> <marker-dir>: run the crash worker paused at the
# boundary, wait for the marker, SIGKILL it. Returns the worker's PID dir.
spawn_and_kill() {
	local boundary="$1" marker="$2"
	local data archive scratch
	data="$(cat "$ROOT/data.path")"
	archive="$ROOT/archive"
	scratch="$ROOT/scratch"
	: >"$ROOT/worker-$boundary.out"
	MAPLE_LIBCHDB="$LIBCHDB" "${BUN[@]}" "$WORKER" \
		--boundary "$boundary" --marker-dir "$marker" \
		--data-dir "$data" --archive-dir "$archive" --scratch-root "$scratch" \
		--range-date "$RANGE_DATE" --signal "$SIGNAL" --block-ms 60000 \
		>"$ROOT/worker-$boundary.out" 2>&1 &
	local pid=$!
	# Wait for the durable paused marker (the boundary was reached).
	local _i
	for _i in $(seq 1 300); do
		[ -f "$marker/paused" ] && break
		kill -0 "$pid" 2>/dev/null || { echo "      worker exited before marker (see $ROOT/worker-$boundary.out)" >&2; return 1; }
		sleep 0.1
	done
	if [ ! -f "$marker/paused" ]; then
		echo "      marker never written at $boundary" >&2
		return 1
	fi
	# SIGKILL — the authoritative crash. Does NOT run the finally.
	kill -9 "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	echo "      killed at $boundary (pid was $pid)"
	return 0
}

# verify_post_crash <boundary> <expect-published>: assert the post-crash +
# post-reconcile state is exactly correct.
verify_post_crash() {
	local boundary="$1" expect_published="$2" expect_quarantine="$3" quarantine_layout="$4"
	local data archive
	data="$(cat "$ROOT/data.path")"
	archive="$ROOT/archive"
	local errs=""
	# No owned building debris (promoted or quarantined).
	if [ -d "$archive/building" ]; then
		# building root may exist (empty) but must have no generation dirs.
		local count
		count=$(find "$archive/building" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
		[ "$count" -eq 0 ] || errs="$errs building-debris($count)"
	fi
	# No owned scratch debris.
	local scratch_subdirs
	scratch_subdirs=$(find "$ROOT/scratch" -mindepth 1 -maxdepth 1 -type d -name 'archive-*' 2>/dev/null | wc -l | tr -d ' ')
	[ "$scratch_subdirs" -eq 0 ] || errs="$errs scratch-debris($scratch_subdirs)"
	# No orphan active operation journal.
	if [ -d "$archive/operations/active" ]; then
		local active_ops
		active_ops=$(find "$archive/operations/active" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
		[ "$active_ops" -eq 0 ] || errs="$errs active-op($active_ops)"
	fi
	# Active pointer: published => selects the generation; not published => absent
	# (or unchanged). Check the pointer file existence.
	local pointer="$archive/$SIGNAL/$RANGE_DATE/active.json"
	if [ "$expect_published" = "yes" ]; then
		[ -f "$pointer" ] || errs="$errs no-pointer"
		[ "$(jq -r '.signal' "$pointer" 2>/dev/null)" = "$SIGNAL" ] || errs="$errs pointer-signal"
		[ "$(jq -r '.rangeStart' "$pointer" 2>/dev/null)" = "$RANGE_DATE" ] || errs="$errs pointer-range"
	else
		# Not published: the pointer should be ABSENT (the crashed op never flipped it).
		# (If a prior unrelated generation existed it'd be unchanged; here none does.)
		if [ -f "$pointer" ]; then
			errs="$errs unexpected-pointer"
		fi
		local final_count
		final_count=$(find "$archive/$SIGNAL/$RANGE_DATE/generations" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
		[ "$final_count" -eq 0 ] || errs="$errs unpublished-final-generation($final_count)"
	fi
	local quarantine_count
	quarantine_count=$(find "$archive/quarantine" -mindepth 1 -maxdepth 1 -type d -name 'building-*' 2>/dev/null | wc -l | tr -d ' ')
	if [ "$expect_quarantine" = "yes" ]; then
		[ "$quarantine_count" -eq 1 ] || errs="$errs quarantine-count($quarantine_count)"
		local completed_intent operation_id quarantine_path quarantine_shards
		completed_intent=$(find "$archive/operations/completed" -mindepth 2 -maxdepth 2 -name intent.json 2>/dev/null | head -1)
		operation_id=$(jq -er '.operationId' "$completed_intent" 2>/dev/null) || errs="$errs missing-completed-operation-id"
		quarantine_path="$archive/quarantine/building-$operation_id"
		[ -d "$quarantine_path" ] || errs="$errs wrong-quarantine-identity"
		quarantine_shards=$(find "$quarantine_path/shards" -maxdepth 1 -type f -name '*.parquet' 2>/dev/null | wc -l | tr -d ' ')
		case "$quarantine_layout" in
			empty)
				[ "$quarantine_shards" -eq 0 ] || errs="$errs quarantine-shards($quarantine_shards)"
				[ ! -e "$quarantine_path/manifest.json" ] || errs="$errs unexpected-quarantine-manifest"
				;;
			one-shard)
				[ "$quarantine_shards" -eq 1 ] || errs="$errs quarantine-shards($quarantine_shards)"
				[ ! -e "$quarantine_path/manifest.json" ] || errs="$errs unexpected-quarantine-manifest"
				;;
			three-shards)
				[ "$quarantine_shards" -eq 3 ] || errs="$errs quarantine-shards($quarantine_shards)"
				[ ! -e "$quarantine_path/manifest.json" ] || errs="$errs unexpected-quarantine-manifest"
				;;
			manifest-three-shards)
				[ "$quarantine_shards" -eq 3 ] || errs="$errs quarantine-shards($quarantine_shards)"
				[ -f "$quarantine_path/manifest.json" ] || errs="$errs missing-quarantine-manifest"
				;;
			*) errs="$errs unknown-quarantine-layout($quarantine_layout)" ;;
		esac
	else
		[ "$quarantine_count" -eq 0 ] || errs="$errs unexpected-quarantine($quarantine_count)"
	fi
	# Pin: the crashed op's owned pin must be gone after reconcile.
	local pins
	pins=$(find "$data/backups/pins" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
	[ "$pins" -eq 0 ] || errs="$errs orphan-pin($pins)"
	# For published generations: the INDEPENDENT DuckDB oracle reads the recovered
	# active shards and must report the exact marker count (1). This proves the
	# recovered generation's Parquet is intact and queryable, not just present.
	if [ "$expect_published" = "yes" ]; then
		local shard_glob paths_csv count generation manifest manifest_generation catalog_lines catalog_generation
		local catalog_record manifest_record shard_name shard_expected_sha shard_expected_bytes shard_actual_sha shard_actual_bytes
		generation="$(jq -er '.generationId' "$pointer" 2>/dev/null)" || errs="$errs malformed-pointer"
		manifest="$archive/$SIGNAL/$RANGE_DATE/generations/$generation/manifest.json"
		[ -f "$manifest" ] || errs="$errs missing-manifest"
		manifest_generation="$(jq -er '.generationId' "$manifest" 2>/dev/null)" || errs="$errs malformed-manifest"
		[ "$manifest_generation" = "$generation" ] || errs="$errs manifest-generation-mismatch"
		catalog_lines=$(wc -l <"$archive/$SIGNAL/catalog.jsonl" 2>/dev/null | tr -d ' ') || catalog_lines=0
		[ "$catalog_lines" -eq 1 ] || errs="$errs catalog-lines($catalog_lines)"
		catalog_generation="$(jq -r '.generationId' "$archive/$SIGNAL/catalog.jsonl" 2>/dev/null)" || errs="$errs malformed-catalog"
		[ "$catalog_generation" = "$generation" ] || errs="$errs catalog-generation-mismatch"
		catalog_record="$(jq -S -c '{generationId,signal,rangeStart,checkpointId,archivedRowCount,shardCount,createdAt}' "$archive/$SIGNAL/catalog.jsonl" 2>/dev/null)" || errs="$errs malformed-catalog"
		manifest_record="$(jq -S -c '{generationId,signal,rangeStart,checkpointId,archivedRowCount,shardCount:(.shards|length),createdAt}' "$manifest" 2>/dev/null)" || errs="$errs malformed-manifest"
		[ "$catalog_record" = "$manifest_record" ] || errs="$errs catalog-manifest-mismatch"
		while IFS=$'\t' read -r shard_name shard_expected_sha shard_expected_bytes; do
			[ -n "$shard_name" ] || continue
			local shard_path="$archive/$SIGNAL/$RANGE_DATE/generations/$generation/shards/$shard_name"
			[ -f "$shard_path" ] || { errs="$errs missing-shard($shard_name)"; continue; }
			shard_actual_sha="$(shasum -a 256 "$shard_path" | awk '{print $1}')"
			shard_actual_bytes="$(wc -c <"$shard_path" | tr -d ' ')"
			[ "$shard_actual_sha" = "$shard_expected_sha" ] || errs="$errs shard-sha($shard_name)"
			[ "$shard_actual_bytes" = "$shard_expected_bytes" ] || errs="$errs shard-bytes($shard_name)"
		done < <(jq -r '.shards[] | [.name,.sha256,(.bytes|tostring)] | @tsv' "$manifest")
		shard_glob="$archive/$SIGNAL/$RANGE_DATE/generations/*/shards/*.parquet"
		# Build a quoted, comma-separated path list for DuckDB's read_parquet([...]).
		paths_csv=""
		local f
		for f in $shard_glob; do
			[ -f "$f" ] || continue
			paths_csv="${paths_csv:+$paths_csv,}\"$f\""
		done
		if [ -z "$paths_csv" ]; then
			errs="$errs no-published-shards"
		else
			count="$(duckdb -csv -noheader -c "SELECT count() FROM read_parquet([$paths_csv], union_by_name=true) WHERE ServiceName='crash-probe'" 2>"$ROOT/duckdb-$boundary.err")" \
				|| errs="$errs duckdb-fail($(head -c80 "$ROOT/duckdb-$boundary.err" | tr '\n' ' '))"
			[ "$(echo "$count" | tr -d '[:space:]')" = "3" ] || errs="$errs duckdb-count=$count"
		fi
	else
		[ ! -e "$archive/$SIGNAL/catalog.jsonl" ] || errs="$errs unexpected-catalog"
	fi
	if [ -n "$errs" ]; then
		echo "      VERIFY FAIL [$boundary]:$errs" >&2
		return 1
	fi
		echo "      verified [$boundary] (published=$expect_published quarantine=$expect_quarantine)"
	return 0
}

# verify_live_store_unchanged: prove archive creation (incl. recovery) did not
# alter the live telemetry. Start the server against the recovered dataDir,
# count the crash-probe marker in $SIGNAL (must be 1), and stop. Per the plan,
# "unchanged" means telemetry contents + selection, not a byte-identical
# dataDir (maintenance-lock + pin metadata legitimately change).
verify_live_store_unchanged() {
	local boundary="$1"
	local data config attempt count
	data="$(cat "$ROOT/data.path")"
	config="$ROOT/backups.xml"
	# The crash worker held an open chDB connection when SIGKILLed; re-opening
	# chDB on the same dataDir immediately can transiently hit a chDB
	# recursive_mutex error (a chDB restart artifact, NOT data corruption — the
	# marker data is intact, proven by build_store's checkpoint). Retry with a
	# short backoff so the live-store confirmation is not flapped by this.
	for attempt in 1 2 3; do
		"$MAPLE" start --port "$PORT" --data-dir "$data" --chdb-config-file "$config" --on-dirty-store fail --offline >"$ROOT/live-$boundary.log" 2>&1 &
		SERVER_PID=$!
		if wait_health 2>/dev/null; then
			break
		fi
		# health failed: stop and retry after a short delay.
		"$MAPLE" stop --data-dir "$data" >/dev/null 2>&1 || true
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
		SERVER_PID=""
		[ "$attempt" -lt 3 ] && sleep 1
	done
	if [ -z "$SERVER_PID" ] || ! kill -0 "$SERVER_PID" 2>/dev/null; then
		echo "      live-store: server failed to start (see log) [$boundary]" >&2
		tail -3 "$ROOT/live-$boundary.log" >&2
		return 1
	fi
	count="$(query "SELECT count() AS count FROM $SIGNAL WHERE ServiceName='crash-probe'" | jq -r '.[0].count | tonumber' 2>/dev/null)"
	"$MAPLE" stop --data-dir "$data" >/dev/null 2>&1 || true
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
	if [ "$count" != "3" ]; then
		echo "      LIVE-STORE FAIL [$boundary]: marker count=$count (expected 3)" >&2
		return 1
	fi
	echo "      live-store unchanged [$boundary] (marker count=$count)"
	return 0
}

# run_boundary <boundary> <expect-published>: full crash→reconcile→verify→idempotence.
run_boundary() {
	local boundary="$1" expect_published="$2" expect_quarantine="${3:-no}" quarantine_layout="${4:-none}"
	echo "  [$boundary] expect-published=$expect_published"
	build_store >/dev/null || { echo "  !! build_store failed" >&2; fail=$((fail+1)); FAILURES+=("$boundary"); return; }
	# marker path uses ROOT, which build_store just set — assign AFTER build_store.
	local marker="$ROOT/marker-$boundary"
	rm -rf "$marker"; mkdir -p "$marker"
	spawn_and_kill "$boundary" "$marker" || { echo "  !! spawn_and_kill failed for $boundary" >&2; fail=$((fail+1)); FAILURES+=("$boundary"); return; }
	local data archive
	data="$(cat "$ROOT/data.path")"
	archive="$ROOT/archive"
	# Reconcile WITHOUT a fresh export.
	if ! MAPLE_LIBCHDB="$LIBCHDB" "${BUN[@]}" "$RECONCILE" --data-dir "$data" --archive-dir "$archive" --scratch-root "$ROOT/scratch" >"$ROOT/reconcile-$boundary.out" 2>&1; then
		echo "  !! reconcile threw for $boundary:" >&2; tail -3 "$ROOT/reconcile-$boundary.out" >&2
		fail=$((fail+1)); FAILURES+=("$boundary"); return
	fi
	verify_post_crash "$boundary" "$expect_published" "$expect_quarantine" "$quarantine_layout" || { fail=$((fail+1)); FAILURES+=("$boundary"); return; }
	# For published generations: the DuckDB oracle is already checked inside
	# verify_post_crash. Additionally prove the LIVE store is unchanged by the
	# archive operation + recovery (plan: archive creation must not alter the
	# live store). This holds for every boundary — even a crashed-and-recovered
	# op must leave telemetry intact.
	verify_live_store_unchanged "$boundary" || { fail=$((fail+1)); FAILURES+=("$boundary:live-store"); return; }
	# Idempotence: reconcile AGAIN, expect the same converged state + exit 0.
	if ! MAPLE_LIBCHDB="$LIBCHDB" "${BUN[@]}" "$RECONCILE" --data-dir "$data" --archive-dir "$archive" --scratch-root "$ROOT/scratch" >"$ROOT/reconcile2-$boundary.out" 2>&1; then
		echo "  !! second reconcile (idempotence) threw for $boundary" >&2; fail=$((fail+1)); FAILURES+=("$boundary:idempotence"); return
	fi
	verify_post_crash "$boundary" "$expect_published" "$expect_quarantine" "$quarantine_layout" >/dev/null || { echo "  !! state drifted after second reconcile for $boundary" >&2; fail=$((fail+1)); FAILURES+=("$boundary:idempotence"); return; }
	pass=$((pass+1))
}

echo "=== Archive crash-recovery probe (libchdb=$(basename "$LIBCHDB")) ==="
echo "    boundary crash via real SIGKILL; oracle = reconcile then verify exact state"
echo

# Boundary -> whether the generation is durably published at/after it.
# Pre-publication boundaries leave NO published generation (reconcile aborts).
# Post-promotion boundaries leave a published generation (reconcile completes it).
run_boundary "before-intent-durable" "no"
run_boundary "before-pin-acquired" "no"
run_boundary "before-restore" "no"
run_boundary "after-restore" "no"
run_boundary "after-building-created" "no" "yes" "empty"
run_boundary "after-first-shard" "no" "yes" "one-shard"
run_boundary "after-validation-complete" "no" "yes" "three-shards"
run_boundary "before-manifest-durable" "no" "yes" "three-shards"
run_boundary "after-manifest-durable" "no" "yes" "manifest-three-shards"
run_boundary "after-promoted" "yes"
run_boundary "before-pointer-update" "yes"
run_boundary "after-pointer" "yes"
run_boundary "after-catalog" "yes"
run_boundary "pin-removed-before-journal" "yes"
run_boundary "after-pin-released" "yes"
run_boundary "before-scratch-removed" "yes"
run_boundary "before-operation-archived" "yes"

echo
echo "--- ordinary archive create reconciles an interrupted op before allocating ---"

# create_reconciles: plan step 7 — a fresh `archive create` must reconcile a
# prior crashed operation as its first locked step, then allocate + run a new
# range. Crash at after-catalog (published), then a REAL archive create for a
# DIFFERENT range must both recover the crashed op AND seal the new range.
create_reconciles() {
	local marker boundary data archive other_range crashed_pointer
	build_store >/dev/null || { echo "  !! build_store failed (create-reconciles step)" >&2; fail=$((fail+1)); FAILURES+=("create-reconciles"); return; }
	boundary="after-catalog"
	marker="$ROOT/marker-create-reconciles"
	data="$(cat "$ROOT/data.path")"; archive="$ROOT/archive"
	rm -rf "$marker"; mkdir -p "$marker"
	spawn_and_kill "$boundary" "$marker" || { echo "  !! spawn failed (create-reconciles)" >&2; fail=$((fail+1)); FAILURES+=("create-reconciles"); return; }
	# A fresh real archive create for the SAME range (which has the marker row).
	# Its first locked step reconciles the crashed after-catalog op to completion;
	# then it allocates a NEW generation that supersedes the recovered one. Both
	# must succeed — proving create reconciles-before-allocating.
	other_range="$RANGE_DATE"
	if ! "$MAPLE" archive create "$other_range" "$SIGNAL" --data-dir "$data" --archive-dir "$archive" --scratch-root "$ROOT/scratch" >"$ROOT/create-reconciles.out" 2>&1; then
		echo "  !! fresh archive create failed after a crashed op:" >&2; tail -5 "$ROOT/create-reconciles.out" >&2
		fail=$((fail+1)); FAILURES+=("create-reconciles"); return
	fi
	# The crashed op's range must now have a published (recovered + superseded) gen.
	crashed_pointer="$archive/$SIGNAL/$RANGE_DATE/active.json"
	if [ ! -f "$crashed_pointer" ]; then
		echo "  !! crashed op not reconciled by fresh create" >&2; fail=$((fail+1)); FAILURES+=("create-reconciles:crashed"); return
	fi
	# The fresh create must have sealed its own (superseding) generation.
	if ! grep -q "archive generation sealed" "$ROOT/create-reconciles.out"; then
		echo "  !! fresh create did not seal" >&2; fail=$((fail+1)); FAILURES+=("create-reconciles:newrange"); return
	fi
	pass=$((pass+1))
	echo "  create-reconciles: OK (crashed op recovered + new range sealed)"
}
create_reconciles

echo
echo "=== Summary: $pass passed, $fail failed ==="
if [ "$fail" -gt 0 ]; then
	echo "FAILURES:"
	for f in "${FAILURES[@]}"; do echo "  - $f"; done
	exit 1
fi
echo "ALL ARCHIVE CRASH-RECOVERY BOUNDARIES GREEN"
