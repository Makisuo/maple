#!/usr/bin/env bash
# Native proof for durable, server-coordinated live retirement.
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-retention-probe.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
PORT="${2:-45271}"
ROOT="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/maple-native-retention.XXXXXX")")"
DATA="$ROOT/data"
ARCHIVE="$ROOT/archive"
SCRATCH="$ROOT/scratch"
CONFIG="$ROOT/backups.xml"
SERVER_PID=""
SIGNALS=(logs traces metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram)

if date -u -v-3d +%F >/dev/null 2>&1; then
	RANGE_DATE="$(date -u -v-3d +%F)"
else
	RANGE_DATE="$(date -u -d '3 days ago' +%F)"
fi

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ "${KEEP_ROOT:-0}" == "1" ]]; then
		echo "preserved retention root: $ROOT" >&2
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
	for _ in $(seq 1 300); do
		if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return; fi
		sleep 0.1
	done
	fail "server did not become healthy: $(tail -100 "$ROOT/server.log" 2>/dev/null)"
}

start_server() {
	TZ=America/New_York "$MAPLE" start \
		--port "$PORT" \
		--data-dir "$DATA" \
		--chdb-config-file "$CONFIG" \
		${INITIAL_RETENTION_CONFIG:+--minimum-raw-telemetry-retention-days 120} \
		--on-dirty-store fail \
		--offline >"$ROOT/server.log" 2>&1 &
	SERVER_PID=$!
	wait_health
	[[ "$(query "SELECT timezone() AS timezone" | jq -r '.[0].timezone')" == "UTC" ]] \
		|| fail "live chDB session is not pinned to UTC"
	INITIAL_RETENTION_CONFIG=""
}

stop_server() {
	"$MAPLE" stop --data-dir "$DATA" >/dev/null
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
}

insert_markers() {
	local ts="${RANGE_DATE}T12:00:00"
	query "INSERT INTO logs (OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body) SELECT 'local', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime('${ts}', 'UTC'), 'trace-retention', 'span-retention', 1, 'INFO', 9, 'retention-probe', 'marker'" >/dev/null
	query "INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'local', toDateTime64('${ts}.000000000', 9, 'UTC'), 'trace-retention', 'span-retention', '', '', 'marker', 'Server', 'retention-probe', 'Ok', ''" >/dev/null
	query "INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic) SELECT 'local', 'retention-probe', 'sum', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime64('${ts}.000000000', 9, 'UTC'), 1, 2, true" >/dev/null
	query "INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value) SELECT 'local', 'retention-probe', 'gauge', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime64('${ts}.000000000', 9, 'UTC'), 1" >/dev/null
	query "INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) SELECT 'local', 'retention-probe', 'histogram', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime64('${ts}.000000000', 9, 'UTC'), 1, 1, [1], [1.0], 2" >/dev/null
	query "INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, AggregationTemporality) SELECT 'local', 'retention-probe', 'exponential', toDateTime64('${ts}.000000000', 9, 'UTC'), toDateTime64('${ts}.000000000', 9, 'UTC'), 1, 1, 0, 0, 0, [1], 0, [], 2" >/dev/null
}

assert_live_count() {
	local expected="$1" signal column count
	for signal in "${SIGNALS[@]}"; do
		case "$signal" in
			logs) column="TimestampTime" ;;
			traces) column="Timestamp" ;;
			*) column="TimeUnix" ;;
		esac
		count="$(query "SELECT count() AS count FROM $signal WHERE toDate($column, 'UTC') = '$RANGE_DATE'" | jq -r '.[0].count | tonumber')"
		[[ "$count" == "$expected" ]] || fail "$signal live count: expected $expected, got $count"
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

echo "native retention probe root: $ROOT (range: $RANGE_DATE; host TZ: America/New_York)"
INITIAL_RETENTION_CONFIG=1
start_server
[[ -f "${DATA}.raw-telemetry-retention.json" ]] || fail "persistent TTL floor was not recorded"
TTL_SQL="$(query "SELECT create_table_query FROM system.tables WHERE database = 'default' AND name = 'logs'" | jq -r '.[0].create_table_query')"
grep -Eq "120 DAY|toIntervalDay\(120\)" <<<"$TTL_SQL" \
	|| fail "persistent 120-day TTL floor was not applied"
insert_markers
assert_live_count 1

"$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/checkpoint.out" 2>&1 \
	|| fail "checkpoint failed: $(cat "$ROOT/checkpoint.out")"
CHECKPOINT_ID="$(jq -r '.current' "$DATA/backups/state.json")"
[[ "$CHECKPOINT_ID" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid checkpoint ID: $CHECKPOINT_ID"

for signal in "${SIGNALS[@]}"; do
	"$MAPLE" archive create "$RANGE_DATE" "$signal" \
		--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
		--checkpoint-id "$CHECKPOINT_ID" >"$ROOT/archive-$signal.out" 2>&1 \
		|| fail "archive create failed for $signal: $(cat "$ROOT/archive-$signal.out")"
done

# Replace one archived live row with a different row while preserving its count.
# Count-only retirement would delete it; the canonical digest must refuse before
# the retired-day ledger or any live deletion exists.
query "ALTER TABLE logs DELETE WHERE toDate(TimestampTime, 'UTC') = '$RANGE_DATE' SETTINGS mutations_sync = 2" >/dev/null
query "INSERT INTO logs (OrgId, Timestamp, TimestampTime, ServiceName, Body) SELECT 'local', toDateTime64('${RANGE_DATE}T12:00:01.000000000', 9, 'UTC'), toDateTime('${RANGE_DATE}T12:00:01', 'UTC'), 'retention-probe', 'different-same-count-row'" >/dev/null
if "$MAPLE" archive retire-live "$RANGE_DATE" --port "$PORT" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--sealing-lag-hours 24 --apply >"$ROOT/mismatch-retire.out" 2>&1; then
	fail "same-count/different-content retirement unexpectedly succeeded"
fi
grep -q "content digest mismatch" "$ROOT/mismatch-retire.out" \
	|| fail "retirement did not report digest mismatch: $(cat "$ROOT/mismatch-retire.out")"
[[ ! -e "${DATA}.retired-days.json" ]] || fail "failed retirement committed the retired-day ledger"
assert_live_count 1

# Restore the exact checkpoint used for the archives before the successful run.
stop_server
"$MAPLE" restore --yes --data-dir "$DATA" --checkpoint-id "$CHECKPOINT_ID" >"$ROOT/pre-retire-restore.out" 2>&1 \
	|| fail "pre-retirement restore failed: $(cat "$ROOT/pre-retire-restore.out")"
start_server

"$MAPLE" archive retire-live "$RANGE_DATE" --port "$PORT" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--sealing-lag-hours 24 --apply >"$ROOT/retire.out" 2>&1 \
	|| fail "retirement failed: $(cat "$ROOT/retire.out")"

[[ -f "${DATA}.retired-days.json" ]] || fail "external retired-day ledger was not committed"
[[ ! -e "$DATA/retention" ]] || fail "retirement state leaked into replaceable chDB directory"
assert_live_count 0

# A retired day cannot be re-exported into a partial/empty generation that
# supersedes the complete generation recorded by the durable authority.
if "$MAPLE" archive create "$RANGE_DATE" logs \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$CHECKPOINT_ID" >"$ROOT/late-rearchive.out" 2>&1; then
	fail "archive create unexpectedly superseded a retired day"
fi
grep -q "permanently retired" "$ROOT/late-rearchive.out" \
	|| fail "retired-day rearchive did not fail for the expected reason: $(cat "$ROOT/late-rearchive.out")"

# Direct SQL mutation cannot persist a retired row.
query "INSERT INTO logs (OrgId, Timestamp, TimestampTime, ServiceName, Body) SELECT 'local', toDateTime64('${RANGE_DATE}T12:00:02.000000000', 9, 'UTC'), toDateTime('${RANGE_DATE}T12:00:02', 'UTC'), 'retention-probe', 'late-sql'" >/dev/null
[[ "$(query "SELECT count() AS count FROM logs WHERE toDate(TimestampTime, 'UTC') = '$RANGE_DATE'" | jq -r '.[0].count | tonumber')" == "0" ]] \
	|| fail "local SQL recreated a retired day"

# OTLP late telemetry is rejected before its first INSERT.
NANOS="$(python3 -c 'import datetime,sys; print(int(datetime.datetime.fromisoformat(sys.argv[1]+"T12:00:03+00:00").timestamp()*1_000_000_000))' "$RANGE_DATE")"
OTLP="$(jq -nc --arg n "$NANOS" '{resourceLogs:[{resource:{attributes:[{key:"service.name",value:{stringValue:"retention-probe"}}]},scopeLogs:[{logRecords:[{timeUnixNano:$n,body:{stringValue:"late-otlp"}}]}]}]}')"
STATUS="$(curl -sS -o "$ROOT/late-otlp.out" -w '%{http_code}' "http://127.0.0.1:$PORT/v1/logs" -H 'content-type: application/json' --data "$OTLP")"
[[ "$STATUS" == "409" ]] || fail "late OTLP returned $STATUS instead of 409: $(cat "$ROOT/late-otlp.out")"

# Restore the pre-retirement checkpoint, then prove startup removes resurrected
# rows before the listener becomes healthy.
stop_server
"$MAPLE" restore --yes --data-dir "$DATA" --checkpoint-id "$CHECKPOINT_ID" >"$ROOT/restore.out" 2>&1 \
	|| fail "restore failed: $(cat "$ROOT/restore.out")"
start_server
assert_live_count 0

stop_server
echo "PASS native retention: UTC digest retirement, late rejection, SQL enforcement, and restore replay"
