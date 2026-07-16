#!/usr/bin/env bash
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-checkpoint-smoke.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
PORT="${2:-45231}"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/maple-native-checkpoint.XXXXXX")"
DATA="$ROOT/data"
CONFIG="$ROOT/backups.xml"
SERVER_PID=""

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ "${KEEP_ROOT:-0}" == "1" ]]; then
		echo "preserved smoke root: $ROOT" >&2
	else
		rm -rf "$ROOT"
	fi
}
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

query() {
	local sql="$1"
	curl --fail-with-body -sS "http://127.0.0.1:$PORT/local/query" \
		-H 'content-type: application/json' \
		--data "$(jq -nc --arg sql "$sql" '{sql:$sql}')"
}

wait_health() {
	for _ in $(seq 1 200); do
		if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
			return
		fi
		sleep 0.1
	done
	fail "server did not become healthy; log follows: $(tail -80 "$ROOT/server.log" 2>/dev/null)"
}

start_server() {
	local policy="${1:-fail}"
	"$MAPLE" start \
		--port "$PORT" \
		--data-dir "$DATA" \
		--chdb-config-file "$CONFIG" \
		--on-dirty-store "$policy" \
		--offline >"$ROOT/server.log" 2>&1 &
	SERVER_PID=$!
	wait_health
}

stop_server() {
	"$MAPLE" stop --data-dir "$DATA" >/dev/null
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
}

kill_server() {
	kill -9 "$SERVER_PID"
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
}

checkpoint() {
	if ! "$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/checkpoint.out" 2>&1; then
		cat "$ROOT/checkpoint.out" >&2
		return 1
	fi
	if [[ ! -f "$DATA/backups/state.json" ]]; then
		cat "$ROOT/checkpoint.out" >&2
		fail "checkpoint command returned without publishing state"
	fi
	jq -r '.current' "$DATA/backups/state.json"
}

insert_marker() {
	local suffix="$1"
	# /local/query appends FORMAT JSONEachRow, so INSERT SELECT is used instead
	# of VALUES (whose input parser would consume the appended FORMAT token).
	query "INSERT INTO logs (OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body) SELECT 'local', now64(9), now(), 'trace-$suffix', 'span-$suffix', 1, 'INFO', 9, 'checkpoint-smoke', 'marker-$suffix'" >/dev/null
	query "INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'local', now64(9), 'trace-$suffix', 'span-$suffix', '', '', 'marker-$suffix', 'Server', 'checkpoint-smoke', 'Ok', ''" >/dev/null
	query "INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic) SELECT 'local', 'checkpoint-smoke', 'sum-$suffix', now64(9), now64(9), 1, 2, true" >/dev/null
	query "INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value) SELECT 'local', 'checkpoint-smoke', 'gauge-$suffix', now64(9), now64(9), 1" >/dev/null
	query "INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) SELECT 'local', 'checkpoint-smoke', 'histogram-$suffix', now64(9), now64(9), 1, 1, [1], [1.0], 2" >/dev/null
	query "INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, AggregationTemporality) SELECT 'local', 'checkpoint-smoke', 'exponential-$suffix', now64(9), now64(9), 1, 1, 0, 0, 0, [1], 0, [], 2" >/dev/null
}

assert_counts() {
	local expected="$1"
	for table in logs traces metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram; do
		local actual
		actual="$(query "SELECT count() AS count FROM $table WHERE ServiceName = 'checkpoint-smoke'" |
			jq -r '.[0].count | tonumber')"
		[[ "$actual" == "$expected" ]] || fail "$table count: expected $expected, got $actual"
	done
}

# A restore is not accepted merely because the restoring chDB connection could
# query it. Repeatedly exec wholly fresh Maple processes so persisted metadata
# must load from disk on every cycle.
assert_fresh_reopen_cycles() {
	local expected="$1"
	local cycles="${2:-3}"
	local label="${3:-restored-store}"
	for cycle in $(seq 1 "$cycles"); do
		start_server fail
		assert_counts "$expected"
		stop_server
		echo "fresh reopen $label: $cycle/$cycles"
	done
}

printf '%s\n' \
	'<clickhouse>' \
	'  <backups>' \
	'    <allowed_disk>default</allowed_disk>' \
	'    <allowed_path>backups</allowed_path>' \
	'  </backups>' \
	'</clickhouse>' >"$CONFIG"
chmod 600 "$CONFIG"

echo "native smoke root: $ROOT"

# Prove the real missing-config error is classified narrowly and actionably.
"$MAPLE" start --port "$PORT" --data-dir "$DATA" --on-dirty-store fail --offline \
	>"$ROOT/server.log" 2>&1 &
SERVER_PID=$!
wait_health
set +e
"$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/no-config.out" 2>&1
no_config_status=$?
set -e
[[ "$no_config_status" -ne 0 ]] || fail "checkpoint without backup config unexpectedly succeeded"
grep -q -- '--chdb-config-file' "$ROOT/no-config.out" ||
	fail "missing-config failure was not actionable: $(cat "$ROOT/no-config.out")"
stop_server

start_server
insert_marker A
C1="$(checkpoint)"
[[ "$C1" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid C1 ID: $C1"
insert_marker B
C2="$(checkpoint)"
[[ "$C2" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid C2 ID: $C2"
[[ "$C1" != "$C2" ]] || fail "checkpoint IDs collided"
jq -e --arg c "$C2" --arg p "$C1" \
	'.formatVersion == 1 and .current == $c and .previous == $p' \
	"$DATA/backups/state.json" >/dev/null

# Restore must reject before allocating a transaction or mutating the live
# process when the server PID is active.
state_before_running_restore="$(cat "$DATA/backups/state.json")"
set +e
"$MAPLE" restore --data-dir "$DATA" --checkpoint-id "$C1" --yes \
	>"$ROOT/restore-while-running.out" 2>&1
running_restore_status=$?
set -e
[[ "$running_restore_status" -ne 0 ]] || fail "restore while server was running unexpectedly succeeded"
grep -q 'maple is running' "$ROOT/restore-while-running.out" ||
	fail "restore while running was not actionable: $(cat "$ROOT/restore-while-running.out")"
[[ "$(cat "$DATA/backups/state.json")" == "$state_before_running_restore" ]] ||
	fail "restore while running changed checkpoint state"
[[ ! -e "${DATA}.restore-transaction.json" ]] ||
	fail "restore while running allocated a restore transaction"
assert_counts 2
stop_server

"$MAPLE" restore --data-dir "$DATA" --checkpoint-id "$C1" --yes >/dev/null
assert_fresh_reopen_cycles 1 3 C1

"$MAPLE" restore --data-dir "$DATA" --checkpoint-id "$C2" --yes >/dev/null
assert_fresh_reopen_cycles 2 3 C2

# Leave one healthy process running for the dirty-store recovery cases below.
start_server fail
assert_counts 2

# Foreground dirty-store recovery.
kill_server
set +e
"$MAPLE" start \
	--port "$PORT" \
	--data-dir "$DATA" \
	--chdb-config-file "$CONFIG" \
	--offline >"$ROOT/default-dirty.out" 2>&1
default_dirty_status=$?
set -e
[[ "$default_dirty_status" -ne 0 ]] || fail "default dirty-store policy unexpectedly started"
grep -q 'was not cleanly closed' "$ROOT/default-dirty.out" ||
	fail "default dirty-store failure was not actionable: $(cat "$ROOT/default-dirty.out")"
[[ -f "$DATA/backups/state.json" ]] || fail "default dirty-store failure removed checkpoints"

# Explicit dirty-store wipe clears live telemetry while preserving the exact
# checkpoint registry. Restore C2 afterwards so the remaining recovery paths
# continue from a known two-row store.
start_server wipe
assert_counts 0
stop_server
jq -e --arg c "$C2" --arg p "$C1" \
	'.current == $c and .previous == $p' "$DATA/backups/state.json" >/dev/null
"$MAPLE" restore --data-dir "$DATA" --checkpoint-id "$C2" --yes >/dev/null
start_server fail
assert_counts 2
kill_server
start_server restore-checkpoint
assert_counts 2

# Detached recovery exercises the exact re-exec argument path.
kill_server
"$MAPLE" start \
	--background \
	--port "$PORT" \
	--data-dir "$DATA" \
	--chdb-config-file "$CONFIG" \
	--on-dirty-store restore-checkpoint \
	--offline >"$ROOT/detached.out"
SERVER_PID="$(cat "$(dirname "$DATA")/maple.pid")"
wait_health
assert_counts 2

insert_marker C
C3="$(checkpoint)"
[[ "$C3" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid C3 ID: $C3"
jq -e --arg c "$C3" --arg p "$C2" \
	'.current == $c and .previous == $p' "$DATA/backups/state.json" >/dev/null
[[ ! -e "$DATA/backups/snapshots/$C1" ]] || fail "old previous C1 was not retired"
[[ -d "$DATA/backups/snapshots/$C2" ]] || fail "previous C2 is missing"
[[ -d "$DATA/backups/snapshots/$C3" ]] || fail "current C3 is missing"

stop_server
assert_fresh_reopen_cycles 3 5 C3-after-checkpoint

"$MAPLE" reset --data-dir "$DATA" --yes >/dev/null
jq -e --arg c "$C3" --arg p "$C2" \
	'.current == $c and .previous == $p' "$DATA/backups/state.json" >/dev/null
[[ -d "$DATA/backups/snapshots/$C2" ]] || fail "reset removed previous checkpoint C2"
[[ -d "$DATA/backups/snapshots/$C3" ]] || fail "reset removed current checkpoint C3"
start_server fail
assert_counts 0
stop_server
"$MAPLE" restore --data-dir "$DATA" --checkpoint-id "$C3" --yes >/dev/null
assert_fresh_reopen_cycles 3 3 C3-after-reset

echo "PASS native checkpoint smoke: C1=$C1 C2=$C2 C3=$C3"
