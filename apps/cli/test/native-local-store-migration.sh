#!/usr/bin/env bash
# Native end-to-end local-store migration probe.
#
# The source is created and populated by the compiled Maple + libchdb bundle,
# then its historical v0 marker is restored to model the fingerprint-only
# legacy store. The migration itself opens source and target through native
# chDB, verifies all six raw tables, promotes the target, and reopens the
# promoted store in a fresh Maple process.
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-local-store-migration.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
LIBCHDB="${MAPLE_LIBCHDB:-$BUNDLE_DIR/libchdb.so}"
PORT="${2:-45241}"

if [[ ! -f "$LIBCHDB" ]]; then
	echo "SKIP: native local-store migration requires libchdb at $LIBCHDB" >&2
	exit 0
fi
[[ -x "$MAPLE" ]] || { echo "FAIL: maple binary not found at $MAPLE" >&2; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/maple-native-migration.XXXXXX")"
DATA="$ROOT/data"
CONFIG="$ROOT/backups.xml"
SERVER_PID=""

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ "${KEEP_ROOT:-0}" == "1" ]]; then
		echo "preserved native migration root: $ROOT" >&2
	else
		rm -rf "$ROOT"
	fi
}
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	if [[ -f "$ROOT/server.log" ]]; then tail -80 "$ROOT/server.log" >&2 || true; fi
	exit 1
}

query() {
	curl --fail-with-body -sS "http://127.0.0.1:$PORT/local/query" \
		-H 'content-type: application/json' \
		--data "$(jq -nc --arg sql "$1" '{sql:$sql}')"
}

wait_health() {
	for _ in $(seq 1 200); do
		if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return; fi
		sleep 0.1
	done
	fail "native Maple server did not become healthy"
}

start_server() {
	MAPLE_LIBCHDB="$LIBCHDB" "$MAPLE" start \
		--port "$PORT" \
		--data-dir "$DATA" \
		--chdb-config-file "$CONFIG" \
		--on-dirty-store fail \
		--offline >"$ROOT/server.log" 2>&1 &
	SERVER_PID=$!
	wait_health
}

stop_server() {
	MAPLE_LIBCHDB="$LIBCHDB" "$MAPLE" stop --data-dir "$DATA" >/dev/null 2>&1 || true
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
}

printf '%s\n' \
	'<clickhouse>' \
	'  <backups>' \
	'    <allowed_disk>default</allowed_disk>' \
	'    <allowed_path>backups</allowed_path>' \
	'  </backups>' \
	'</clickhouse>' >"$CONFIG"
chmod 600 "$CONFIG"

start_server
query "INSERT INTO logs (OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body) SELECT 'native-migration', now64(9), now(), 'trace-native', 'span-native', 1, 'INFO', 9, 'native-migration', 'legacy source'" >/dev/null
query "INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'native-migration', now64(9), 'trace-native', 'span-native', '', '', 'native migration', 'Server', 'native-migration', 'Ok', ''" >/dev/null
query "INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic) SELECT 'native-migration', 'native-migration', 'sum-native', now64(9), now64(9), 1, 2, true" >/dev/null
query "INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value) SELECT 'native-migration', 'native-migration', 'gauge-native', now64(9), now64(9), 1" >/dev/null
query "INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) SELECT 'native-migration', 'native-migration', 'hist-native', now64(9), now64(9), 1, 1, [1], [1.0], 2" >/dev/null
query "INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, AggregationTemporality) SELECT 'native-migration', 'native-migration', 'exp-native', now64(9), now64(9), 1, 1, 0, 0, 0, [1], 0, [], 2" >/dev/null
stop_server

# Replace the newly-created active v2 marker with the historical v1 marker.
# The physical source was created by native chDB; the marker is the only
# compatibility evidence the v0 resolver is allowed to use.
CHDB_VERSION="$(MAPLE_LIBCHDB="$LIBCHDB" "$MAPLE" --version 2>/dev/null | sed -n 's/.*chdb \([^ ]*\).*/\1/p')"
[[ -n "$CHDB_VERSION" ]] || CHDB_VERSION="v26.1.0"
printf '%s\n' "{\"chdb\":\"$CHDB_VERSION\",\"maple\":\"native-probe\",\"createdAt\":\"unknown\",\"schema\":\"428701854f9fd30e\"}" >"$ROOT/maple-store-version.json"
chmod 600 "$ROOT/maple-store-version.json"

MAPLE_LIBCHDB="$LIBCHDB" "$MAPLE" schema migrate --data-dir "$DATA" --yes >"$ROOT/migrate.out" 2>&1 || {
	cat "$ROOT/migrate.out" >&2
	fail "native schema migration failed"
}
grep -q "local store migrated" "$ROOT/migrate.out" || fail "native migration did not report promotion"
[[ -f "$ROOT/maple-store-version.json" ]] || fail "active marker disappeared after native promotion"
jq -e '.formatVersion == 2 and .activation == "active" and .schemaVersion == 1 and .schema == "06ac009495b54395"' \
	"$ROOT/maple-store-version.json" >/dev/null || fail "native migration wrote the wrong active identity"

start_server
for table in logs traces metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram; do
	count="$(query "SELECT count() AS count FROM $table WHERE ServiceName = 'native-migration'" | jq -r '.[0].count | tonumber')"
	[[ "$count" == "1" ]] || fail "$table count after native migration: expected 1, got $count"
done
stop_server

rollback="$(sed -n 's/^.*rollback *//p' "$ROOT/migrate.out" | tail -1)"
[[ -n "$rollback" && -d "$rollback" ]] || fail "native migration did not retain a rollback source"
[[ -f "$(dirname "$rollback")/maple-store-version.json" ]] || fail "native rollback marker was not retained"
echo "PASS: native local-store migration, fresh reopen, and rollback retention"
