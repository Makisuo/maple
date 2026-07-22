#!/usr/bin/env bash
# Native archive end-to-end smoke against a bundled `maple` binary.
#
# Exercises the full Workstream-2 acceptance path: ingest markers into all six
# raw tables, create a checkpoint, archive a sealed UTC day per signal, list
# active generations, query the archive with DuckDB for exact source counts, and
# prove the live store is unchanged. Mirrors native-checkpoint-smoke.sh
# conventions: trap cleanup, KEEP_ROOT, start/stop/kill helpers.
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-archive-smoke.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
PORT="${2:-45241}"
ROOT="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/maple-native-archive.XXXXXX")")"
DATA="$ROOT/data"
ARCHIVE="$ROOT/archive"
SCRATCH="$ROOT/scratch"
CONFIG="$ROOT/backups.xml"
SERVER_PID=""

# Seal the UTC day containing "now" so the ingested markers fall inside it.
RANGE_DATE="$(date -u +%Y-%m-%d)"

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

if ! command -v duckdb >/dev/null 2>&1; then
	fail "duckdb is required on PATH for this smoke"
fi

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
	"$MAPLE" start \
		--port "$PORT" \
		--data-dir "$DATA" \
		--chdb-config-file "$CONFIG" \
		--on-dirty-store fail \
		--offline >"$ROOT/server.log" 2>&1 &
	SERVER_PID=$!
	wait_health
}

stop_server() {
	"$MAPLE" stop --data-dir "$DATA" >/dev/null
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
}

insert_marker() {
	local suffix="$1"
	# Insert at a fixed UTC noon timestamp within RANGE_DATE so the archive's
	# toDate()/toHour() predicates find the rows regardless of the host timezone.
	# now()/now64(9) are local-time-based and land on a different UTC day when
	# local and UTC dates diverge. Two markers at 12:00:0N (N=0,1) seconds.
	local sec
	case "$suffix" in
		A) sec="00" ;;
		B) sec="01" ;;
		*) sec="00" ;;
	esac
	local ts="${RANGE_DATE}T12:00:${sec}"
	# Use explicit 'UTC' timezone in toDateTime64/toDateTime so the markers land
	# on the intended UTC day/hour regardless of the host session timezone.
	query "INSERT INTO logs (OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body) SELECT 'local', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime('${ts}', 'UTC'), 'trace-$suffix', 'span-$suffix', 1, 'INFO', 9, 'archive-smoke', 'marker-$suffix'" >/dev/null
	query "INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'local', toDateTime64('${ts}.000000000', 9, 'UTC'), 'trace-$suffix', 'span-$suffix', '', '', 'marker-$suffix', 'Server', 'archive-smoke', 'Ok', ''" >/dev/null
	query "INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic) SELECT 'local', 'archive-smoke', 'sum-$suffix', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime64('${ts}.000000000', 9, 'UTC'), 1, 2, true" >/dev/null
	query "INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value) SELECT 'local', 'archive-smoke', 'gauge-$suffix', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime64('${ts}.000000000', 9, 'UTC'), 1" >/dev/null
	query "INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) SELECT 'local', 'archive-smoke', 'histogram-$suffix', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime64('${ts}.000000000', 9, 'UTC'), 1, 1, [1], [1.0], 2" >/dev/null
	query "INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, AggregationTemporality) SELECT 'local', 'archive-smoke', 'exponential-$suffix', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime64('${ts}.000000000', 9, 'UTC'), 1, 1, 0, 0, 0, [1], 0, [], 2" >/dev/null
}

checkpoint() {
	if ! "$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/checkpoint.out" 2>&1; then
		cat "$ROOT/checkpoint.out" >&2
		return 1
	fi
	jq -r '.current' "$DATA/backups/state.json"
}

archive_create() {
	local signal="$1"
	if ! "$MAPLE" archive create "$RANGE_DATE" "$signal" \
		--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
		>"$ROOT/archive-$signal.out" 2>&1; then
		cat "$ROOT/archive-$signal.out" >&2
		fail "archive create failed for $signal"
	fi
	# The output is a text summary; assert it sealed with at least one row.
	grep -q "archive generation sealed" "$ROOT/archive-$signal.out" || fail "archive create did not seal $signal"
	grep -qE "rows +[1-9]" "$ROOT/archive-$signal.out" || fail "archive create for $signal produced zero rows: $(cat "$ROOT/archive-$signal.out")"
}

# Build the active Parquet path list for a signal from `archive list --output paths`.
active_paths() {
	local signal="$1"
	"$MAPLE" archive list --archive-dir "$ARCHIVE" --output paths --signal "$signal" 2>/dev/null
}

printf '%s\n' \
	'<clickhouse>' \
	'  <backups>' \
	'    <allowed_disk>default</allowed_disk>' \
	'    <allowed_path>backups</allowed_path>' \
	'  </backups>' \
	'</clickhouse>' >"$CONFIG"
chmod 600 "$CONFIG"

echo "native archive smoke root: $ROOT (range: $RANGE_DATE)"

start_server
insert_marker A
C1="$(checkpoint)"
[[ "$C1" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid checkpoint ID: $C1"
insert_marker B
C2="$(checkpoint)"
[[ "$C2" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid checkpoint ID: $C2"
[[ "$C1" != "$C2" ]] || fail "checkpoint IDs collided"

# Source row counts for markers (2 each: A and B) across all six tables.
for signal in logs traces metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram; do
	archive_create "$signal"
done
stop_server

# List active generations and assert one per signal.
ACTIVE_COUNT="$("$MAPLE" archive list --archive-dir "$ARCHIVE" --output json 2>/dev/null | jq '[.active[]] | length')"
[[ "$ACTIVE_COUNT" == "6" ]] || fail "expected 6 active generations, got $ACTIVE_COUNT"

# Listing is metadata-only; integrity verification is explicit and streams each
# shard with bounded memory before DuckDB receives any active paths.
"$MAPLE" archive verify --archive-dir "$ARCHIVE" >"$ROOT/archive-verify.out" 2>&1 \
	|| fail "archive verify failed: $(cat "$ROOT/archive-verify.out")"

# Query each signal's archive with DuckDB and confirm exact marker counts (2).
for signal in logs traces metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram; do
	PATHS="$(active_paths "$signal")"
	[[ -n "$PATHS" ]] || fail "no active paths for $signal"
	# -csv -noheader renders a clean single value (box mode is the default).
	COUNT="$(duckdb -csv -noheader -c "SELECT count() FROM read_parquet([$PATHS], union_by_name=true) WHERE ServiceName = 'archive-smoke'" 2>"$ROOT/duckdb-$signal.err")" \
		|| fail "duckdb query failed for $signal: $(cat "$ROOT/duckdb-$signal.err")"
	[[ "$(echo "$COUNT" | tr -d '[:space:]')" == "2" ]] || fail "$signal archive count: expected 2, got '$COUNT'"
done

# Prove the live store still reports the markers after archiving (unchanged).
start_server
for signal in logs traces metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram; do
	COUNT="$(query "SELECT count() AS count FROM $signal WHERE ServiceName = 'archive-smoke'" | jq -r '.[0].count | tonumber')"
	[[ "$COUNT" == "2" ]] || fail "live $signal count changed after archive: expected 2, got $COUNT"
done
stop_server

# Catalog rebuild recovers the index for each signal.
for signal in logs traces metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram; do
	"$MAPLE" archive rebuild "$signal" --data-dir "$DATA" --archive-dir "$ARCHIVE" >/dev/null 2>&1 \
		|| fail "catalog rebuild failed for $signal"
done

echo "PASS native archive smoke: 6 signals archived, DuckDB exact counts, live store unchanged, catalog rebuilt"
