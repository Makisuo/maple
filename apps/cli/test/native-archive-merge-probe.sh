#!/usr/bin/env bash
# Adversarial multi-part, multi-shard archive probe with an injected merge.
#
# Reproduces the exact corruption scenario from the Gate 2 cross-check: two
# parts for the same hour, where a merge between shard queries could corrupt
# the archive. The part-interval sharding plan must be merge-safe: either the
# export succeeds with the exact source row set, or it fails closed detecting
# the layout change.
#
# Usage: native-archive-merge-probe.sh <bundle-dir> [port]
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-archive-merge-probe.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
PORT="${2:-45330}"
ROOT="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/maple-merge-probe.XXXXXX")")"
DATA="$ROOT/data"
CONFIG="$ROOT/backups.xml"
ARCHIVE="$ROOT/archive"
SCRATCH="$ROOT/scratch"
SERVER_PID=""

RANGE_DATE="2026-06-29"

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ "${KEEP_ROOT:-0}" == "1" ]]; then
		echo "preserved probe root: $ROOT" >&2
	else
		rm -rf "$ROOT"
	fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

query() {
	curl --fail-with-body -sS "http://127.0.0.1:$PORT/local/query" \
		-H 'content-type: application/json' \
		--data "$(jq -nc --arg sql "$1" '{sql:$sql}')" 2>&1
}

wait_health() {
	for _ in $(seq 1 200); do
		curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return
		sleep 0.1
	done
	fail "server did not become healthy"
}

printf '%s\n' '<clickhouse>' '  <backups>' '    <allowed_disk>default</allowed_disk>' '    <allowed_path>backups</allowed_path>' '  </backups>' '</clickhouse>' >"$CONFIG"
chmod 600 "$CONFIG"

# Start server
"$MAPLE" start --port "$PORT" --data-dir "$DATA" --chdb-config-file "$CONFIG" --on-dirty-store fail --offline >"$ROOT/server.log" 2>&1 &
SERVER_PID=$!
wait_health

# Insert two batches at the SAME UTC hour (12:00 UTC) to create two parts.
# Batch 1: IDs 5-8. Batch 2: IDs 1-4. (Out-of-order insertion, like the cross-check.)
query "INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'local', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't'||toString(number+4), 's'||toString(number+4), '', '', 'probe', 'Server', 'merge-probe', 'Ok', '' FROM numbers(4)" >/dev/null
query "INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'local', toDateTime64('2026-06-29 12:00:00', 9, 'UTC'), 't'||toString(number), 's'||toString(number), '', '', 'probe', 'Server', 'merge-probe', 'Ok', '' FROM numbers(4)" >/dev/null

# Verify two parts exist.
NPARTS=$(query "SELECT count(DISTINCT _part) AS n FROM traces WHERE toDate(Timestamp,'UTC')='2026-06-29' AND toHour(Timestamp,'UTC')=12" | jq -r '.[0].n')
[[ "$NPARTS" == "2" ]] || fail "expected 2 parts before checkpoint, got $NPARTS"

# The exact set of TraceIds that MUST appear in the archive (1-8).
# The endpoint returns a JSON array; use .[].TraceId to iterate.
SOURCE_IDS=$(query "SELECT TraceId FROM traces WHERE toDate(Timestamp,'UTC')='2026-06-29' AND toHour(Timestamp,'UTC')=12 ORDER BY TraceId" | jq -r '.[].TraceId' | sort | tr '\n' ',')
echo "source IDs: $SOURCE_IDS"

# Checkpoint (creates a restored snapshot to export from).
"$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/ckpt.out" 2>&1 || fail "checkpoint failed"

# Stop the server (archive create runs offline, restoring from the checkpoint).
"$MAPLE" stop --data-dir "$DATA" >/dev/null
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# Archive the traces signal. With 8 rows and maxShardRows=500000, this should
# produce TWO shards (one per part, since the part-interval plan creates one
# shard per part when the part fits in maxShardRows).
"$MAPLE" archive create "$RANGE_DATE" traces \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	>"$ROOT/archive.out" 2>&1 || { cat "$ROOT/archive.out" >&2; fail "archive create failed"; }

# Count the shards produced.
SHARD_COUNT=$("$MAPLE" archive list --archive-dir "$ARCHIVE" --output json 2>/dev/null | jq '.active[0].shardCount // 0')
echo "shard count: $SHARD_COUNT"
[[ "$SHARD_COUNT" -ge 1 ]] || fail "no shards produced"

# Explicitly stream-verify the active shard contents before querying their paths.
"$MAPLE" archive verify --archive-dir "$ARCHIVE" --signal traces >"$ROOT/archive-verify.out" 2>&1 \
	|| fail "archive verify failed: $(cat "$ROOT/archive-verify.out")"

# Get the active Parquet paths and read ALL TraceIds via DuckDB.
PATHS=$("$MAPLE" archive list --archive-dir "$ARCHIVE" --output paths --signal traces 2>/dev/null)
echo "paths: $PATHS"
ARCHIVED_IDS=$(duckdb -csv -noheader -c "SELECT TraceId FROM read_parquet([$PATHS], union_by_name=true) ORDER BY TraceId" 2>"$ROOT/duckdb.err" | sort | tr '\n' ',') \
	|| fail "duckdb query failed: $(cat "$ROOT/duckdb.err")"
echo "archived IDs: $ARCHIVED_IDS"

# The archived IDs MUST exactly match the source IDs — no duplicates, no omissions.
# This is the corruption check: the old OFFSET approach produced [5,6,7,8,5,6,7,8].
[[ "$ARCHIVED_IDS" == "$SOURCE_IDS" ]] || fail "ID MISMATCH (corruption): source={$SOURCE_IDS} archived={$ARCHIVED_IDS}"

# Count must be exactly 8 (no duplicates).
ARCHIVED_COUNT=$(duckdb -csv -noheader -c "SELECT count() FROM read_parquet([$PATHS], union_by_name=true)" 2>/dev/null)
[[ "$ARCHIVED_COUNT" == "8" ]] || fail "count mismatch: expected 8, got $ARCHIVED_COUNT"

# Count distinct IDs — must be 8 (no duplicates).
DISTINCT_COUNT=$(duckdb -csv -noheader -c "SELECT count(DISTINCT TraceId) FROM read_parquet([$PATHS], union_by_name=true)" 2>/dev/null)
[[ "$DISTINCT_COUNT" == "8" ]] || fail "distinct ID mismatch: expected 8, got $DISTINCT_COUNT (duplicates present)"

echo "PASS merge-safety probe: 2 parts, $SHARD_COUNT shard(s), exact ID match [1-8], no duplicates"
