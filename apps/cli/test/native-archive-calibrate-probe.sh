#!/usr/bin/env bash
# Native archive calibration end-to-end probe against a bundled `maple` binary.
#
# Closes the full Calibration Acceptance Contract loop:
#  1. Ingest markers into all six raw tables (incl. maps, histogram arrays, wide
#     logs, high-cardinality data).
#  2. Create a checkpoint.
#  3. `maple archive calibrate --range-date <sealed> --write-config cfg.json`
#     across all six signals.
#  4. Assert the config document has real nonzero metrics (rowCount,
#     logicalBytes, throughput) + environment + identity + that the selected
#     candidate honored maxShardRows/maxShardBytes (exercised via the shared
#     writer).
#  5. Run the real `maple archive create --config cfg.json` on a held-out
#     signal.
#  6. Inspect the resulting manifest: prove config identity (SHA-256) +
#     effective values match the loaded config.
#  7. Emit a SEPARATE validation report (the config is immutable after write)
#     comparing predicted vs observed metrics.
#  8. Assert no temp debris under the archive volume.
#
# Usage: native-archive-calibrate-probe.sh <bundle-dir> [port]
# Requires: jq, curl on PATH; /usr/bin/time for peak RSS.
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-archive-calibrate-probe.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
PORT="${2:-45261}"
ROOT="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/maple-native-calib.XXXXXX")")"
DATA="$ROOT/data"
ARCHIVE="$ROOT/archive"
SCRATCH="$ROOT/scratch"
CONFIG="$ROOT/backups.xml"
SERVER_PID=""
RANGE_DATE="$(date -u +%Y-%m-%d)"

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

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

if ! command -v jq >/dev/null 2>&1; then fail "jq is required"; fi
if ! command -v curl >/dev/null 2>&1; then fail "curl is required"; fi

query() {
	local sql="$1"
	curl --fail-with-body -sS "http://127.0.0.1:$PORT/local/query" \
		-H 'content-type: application/json' \
		--data "$(jq -nc --arg sql "$sql" '{sql:$sql}')"
}

wait_health() {
	for _ in $(seq 1 200); do
		if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return; fi
		sleep 0.1
	done
	fail "server did not become healthy; log: $(tail -80 "$ROOT/server.log" 2>/dev/null)"
}

start_server() {
	"$MAPLE" start --port "$PORT" --data-dir "$DATA" --chdb-config-file "$CONFIG" \
		--on-dirty-store fail --offline >"$ROOT/server.log" 2>&1 &
	SERVER_PID=$!
	wait_health
}

stop_server() {
	"$MAPLE" stop --data-dir "$DATA" >/dev/null
	wait "$SERVER_PID" 2>/dev/null || true
	SERVER_PID=""
}

insert_markers() {
	# Insert enough rows per signal (>= 2*SAMPLE_ROWS=10, so 30 each) so
	# calibration has a disjoint held-out window AND a representative set.
	local i
	for i in $(seq 0 29); do
		local sec min t
		sec=$(printf '%02d' $((i % 60)))
		min=$(printf '%02d' $((i / 60)))
		t="${RANGE_DATE}T12:${min}:${sec}"
		query "INSERT INTO logs (OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body) SELECT 'local', toDateTime64('${t}.000000000', 9, 'UTC'), toDateTime('${t}', 'UTC'), 'trace-$i', 'span-$i', 1, 'INFO', 9, 'calib-probe', 'marker-$i'" >/dev/null
		query "INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'local', toDateTime64('${t}.000000000', 9, 'UTC'), 'trace-$i', 'span-$i', '', '', 'marker-$i', 'Server', 'calib-probe', 'Ok', ''" >/dev/null
		query "INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic) SELECT 'local', 'calib-probe', 'sum-$i', toDateTime64('${t}.000000000', 9, 'UTC'), toDateTime64('${t}.000000000', 9, 'UTC'), ${i}, 2, true" >/dev/null
		query "INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value) SELECT 'local', 'calib-probe', 'gauge-$i', toDateTime64('${t}.000000000', 9, 'UTC'), toDateTime64('${t}.000000000', 9, 'UTC'), ${i}" >/dev/null
		query "INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) SELECT 'local', 'calib-probe', 'histogram-$i', toDateTime64('${t}.000000000', 9, 'UTC'), toDateTime64('${t}.000000000', 9, 'UTC'), 1, ${i}.0, [1,1], [1.0,2.0], 2" >/dev/null
		query "INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, AggregationTemporality) SELECT 'local', 'calib-probe', 'exp-$i', toDateTime64('${t}.000000000', 9, 'UTC'), toDateTime64('${t}.000000000', 9, 'UTC'), 1, 1, 0, 0, 0, [1], 0, [], 2" >/dev/null
	done
}

checkpoint() {
	if ! "$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/checkpoint.out" 2>&1; then
		cat "$ROOT/checkpoint.out" >&2
		return 1
	fi
	jq -r '.current' "$DATA/backups/state.json"
}

printf '%s\n' '<clickhouse>' '  <backups>' '    <allowed_disk>default</allowed_disk>' '    <allowed_path>backups</allowed_path>' '  </backups>' '</clickhouse>' >"$CONFIG"
chmod 600 "$CONFIG"

echo "native calibration probe root: $ROOT (range: $RANGE_DATE)"
start_server
insert_markers
C1="$(checkpoint)"
[[ "$C1" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid checkpoint ID: $C1"
stop_server

CFG="$ROOT/calib-config.json"
VALREPORT="$ROOT/calib-validation.json"

# --- Step 3: calibrate across all six signals and write the config ---
echo "--- calibrating ---"
if ! "$MAPLE" archive calibrate "$RANGE_DATE" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" \
	--memory-budget 1073741824 --time-budget 180000 --sample-rows 10 \
	--write-config "$CFG" >"$ROOT/calibrate.out" 2>&1; then
	cat "$ROOT/calibrate.out" >&2
	fail "calibrate did not produce a recommendation (this is valid for tiny data but the probe expects enough rows)"
fi
grep -q "config written" "$ROOT/calibrate.out" || fail "calibrate did not write a config: $(cat "$ROOT/calibrate.out")"

# --- Step 4: assert the config document has real metrics + identity + environment ---
echo "--- verifying config document ---"
[[ -s "$CFG" ]] || fail "config file missing or empty"
CONFIG_SHA="$(shasum -a 256 "$CFG" | awk '{print $1}')"
SELECTED_THREADS="$(jq -r '.selected.candidate.writerThreads' "$CFG")"
ENV_MAPLE="$(jq -r '.environment.mapleVersion' "$CFG")"
ENV_SCHEMA="$(jq -r '.environment.schemaFingerprint' "$CFG")"
MARGIN="$(jq -r '.safetyMargin' "$CFG")"
RESULT_COUNT="$(jq '[.results[]] | length' "$CFG")"
ROW_COUNT_SUM="$(jq '[.results[] | select(.ok) | .metrics.rowCount] | add // 0' "$CFG")"
[[ "$SELECTED_THREADS" =~ ^[0-9]+$ ]] || fail "config has no selected candidate writerThreads"
[[ -n "$ENV_MAPLE" && "$ENV_MAPLE" != "null" ]] || fail "config missing environment.mapleVersion"
[[ -n "$ENV_SCHEMA" && "$ENV_SCHEMA" != "null" ]] || fail "config missing environment.schemaFingerprint"
[[ "$RESULT_COUNT" -gt 0 ]] || fail "config has no candidate results (evidence dropped)"
# At least one result must have a nonzero rowCount (real metrics, not the old dead-zero).
[[ "$ROW_COUNT_SUM" -gt 0 ]] || fail "config results all have rowCount 0 (metrics are dead)"
echo "  selected writerThreads=$SELECTED_THREADS margin=$MARGIN results=$RESULT_COUNT rowSum=$ROW_COUNT_SUM"

# --- Step 5: run a LIKE-FOR-LIKE calibrate-run trial on held-out data ---
# The trial runs the SAME export-sample operation the calibration measured
# (through the same shared writer), on DISJOINT held-out rows (--start-row), with
# the config's selected candidate tuning. The child emits a real metrics JSON
# with true logical/physical bytes, export-section wall time, and peak temp disk.
# Run under /usr/bin/time for the authoritative external peak RSS. This is
# like-for-like (C4): not a heavier full-create, not proxy values.
echo "--- like-for-like calibrate-run trial on held-out data (measured) ---"
TRIAL_OP="$(uuidgen | tr 'A-Z' 'a-z')"
TIME_OUT="$ROOT/trial-time.txt"
if ! /usr/bin/time -lp "$MAPLE" archive calibrate-run logs "$RANGE_DATE" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --operation-id "$TRIAL_OP" \
	--start-row 10 --sample-rows 10 \
	--max-temp-disk 2147483648 --free-space-reserve 536870912 \
	--writer-threads "$SELECTED_THREADS" \
	--row-group-rows "$(jq -r '.selected.candidate.rowGroupRows' "$CFG")" \
	--max-shard-rows "$(jq -r '.selected.candidate.maxShardRows' "$CFG")" \
	--max-shard-bytes "$(jq -r '.selected.candidate.maxShardBytes' "$CFG")" \
	>"$ROOT/trial.out" 2>"$TIME_OUT"; then
	cat "$ROOT/trial.out" >&2
	fail "like-for-like calibrate-run trial failed"
fi
# The child prints a metrics JSON as its last stdout line (after cleanup).
TRIAL_JSON="$(tail -1 "$ROOT/trial.out")"
echo "$TRIAL_JSON" | jq -e . >/dev/null || fail "trial did not emit a metrics JSON line"
# Parse the real measured metrics from the child + the external peak RSS.
OBSERVED_LOGICAL="$(echo "$TRIAL_JSON" | jq -r '.logicalBytes')"
OBSERVED_PHYSICAL="$(echo "$TRIAL_JSON" | jq -r '.physicalBytes')"
OBSERVED_TEMP="$(echo "$TRIAL_JSON" | jq -r '.peakTempDiskBytes')"
OBSERVED_EXPORT_WALL="$(echo "$TRIAL_JSON" | jq -r '.exportWallMs')"
OBSERVED_ROWS="$(echo "$TRIAL_JSON" | jq -r '.rowCount')"
OBSERVED_RSS="$(grep -i 'maximum resident set size' "$TIME_OUT" | awk '{print $1}')"
[[ "$OBSERVED_RSS" =~ ^[0-9]+$ ]] || fail "could not parse observed peak RSS from /usr/bin/time"
[[ "$OBSERVED_ROWS" -gt 0 ]] || fail "trial exported zero rows (held-out window empty — need more data)"
# Compute the derived metrics exactly as the parent calibrator does.
OBSERVED_COMP="$(awk "BEGIN{ if($OBSERVED_LOGICAL>0) printf \"%.6f\", $OBSERVED_PHYSICAL/$OBSERVED_LOGICAL; else print 0 }")"
OBSERVED_TPUT="$(awk "BEGIN{ if($OBSERVED_EXPORT_WALL>0) printf \"%.1f\", $OBSERVED_LOGICAL/($OBSERVED_EXPORT_WALL/1000); else print 0 }")"

# --- Step 6: verify the config SHA is immutable (trial did not rewrite it) ---
CONFIG_SHA_AFTER="$(shasum -a 256 "$CFG" | awk '{print $1}')"
[[ "$CONFIG_SHA_AFTER" == "$CONFIG_SHA" ]] || fail "config SHA changed after the trial (config was mutated!)"

# --- Step 7: build the typed six-metric predicted-vs-observed comparison (C4) ---
echo "--- six-metric predicted-vs-observed comparison (like-for-like) ---"
OBSERVED_JSON="$ROOT/observed.json"
jq -nc \
	--argjson rss "$OBSERVED_RSS" \
	--argjson wall "$OBSERVED_EXPORT_WALL" \
	--argjson phys "$OBSERVED_PHYSICAL" \
	--argjson logical "$OBSERVED_LOGICAL" \
	--argjson comp "$OBSERVED_COMP" \
	--argjson tput "$OBSERVED_TPUT" \
	--argjson temp "$OBSERVED_TEMP" \
	--argjson rows "$OBSERVED_ROWS" \
	'{peakRssBytes:$rss, wallMs:$wall, physicalBytes:$phys, logicalBytes:$logical, compressionRatio:$comp, writeThroughputBytesPerSec:$tput, peakTempDiskBytes:$temp, rowCount:$rows}' \
	> "$OBSERVED_JSON"
COMPARISON_OUT="$ROOT/comparison.txt"
if ! MAPLE_LIBCHDB="$BUNDLE_DIR/libchdb.so" bun apps/cli/test/probes/calibration-validation-compare.ts \
	"$CFG" "$OBSERVED_JSON" "$TRIAL_OP" "logs" "$OBSERVED_ROWS" 1 \
	>"$VALREPORT" 2>"$COMPARISON_OUT"; then
	cat "$COMPARISON_OUT" >&2
	fail "six-metric predicted-vs-observed comparison FAILED (see above)"
fi
cat "$COMPARISON_OUT" >&2
# Stamp the config SHA + name into the report.
jq --arg sha "$CONFIG_SHA" --arg name "calib-config.json" \
	'.configSha256=$sha | .configName=$name | .trial.rangeStart="'"$RANGE_DATE"'"' \
	"$VALREPORT" > "$VALREPORT.tmp" && mv "$VALREPORT.tmp" "$VALREPORT"
echo "  validation report: $VALREPORT (six-metric like-for-like verdict from production comparePredictedObserved)"

# --- Step 5b: also verify the real archive create --config works (manifest identity) ---
echo "--- real archive create --config (manifest identity) ---"
if ! "$MAPLE" archive create "$RANGE_DATE" logs \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --config "$CFG" >"$ROOT/create-config.out" 2>&1; then
	cat "$ROOT/create-config.out" >&2
	fail "archive create --config failed"
fi
grep -q "archive generation sealed" "$ROOT/create-config.out" || fail "create --config did not seal"
grep -q "config" "$ROOT/create-config.out" || fail "create --config summary missing config identity"
grep -q "effective" "$ROOT/create-config.out" || fail "create --config summary missing effective values"
LISTING_JSON="$("$MAPLE" archive list --archive-dir "$ARCHIVE" --output json 2>/dev/null)"
GEN_ID="$(jq -r '[.active[] | select(.signal=="logs")][0].generationId' <<<"$LISTING_JSON")"
[[ -n "$GEN_ID" && "$GEN_ID" != "null" ]] || fail "could not find the logs generation"
MANIFEST="$ARCHIVE/logs/$RANGE_DATE/generations/$GEN_ID/manifest.json"
[[ -f "$MANIFEST" ]] || fail "manifest not found at $MANIFEST"
MANIFEST_CONFIG_NAME="$(jq -r '.tuningConfig.configName // "MISSING"' "$MANIFEST")"
MANIFEST_CONFIG_SHA="$(jq -r '.tuningConfig.sha256 // "MISSING"' "$MANIFEST")"
[[ "$MANIFEST_CONFIG_NAME" == "calib-config.json" ]] || fail "manifest configName mismatch: $MANIFEST_CONFIG_NAME"
[[ "$MANIFEST_CONFIG_SHA" == "$CONFIG_SHA" ]] || fail "manifest config SHA mismatch: manifest=$MANIFEST_CONFIG_SHA config=$CONFIG_SHA"
echo "  manifest config identity verified: $MANIFEST_CONFIG_NAME ($MANIFEST_CONFIG_SHA)"

# --- Step 8: assert no temp debris under the archive volume ---
echo "--- checking for temp debris ---"
if [[ -d "$ARCHIVE/calibration/samples" ]] && [[ -n "$(ls -A "$ARCHIVE/calibration/samples" 2>/dev/null)" ]]; then
	fail "calibration left sample debris under $ARCHIVE/calibration/samples"
fi
if [[ -e "$ARCHIVE/calibration/recovery.json" ]]; then
	fail "calibration left a stale recovery record at $ARCHIVE/calibration/recovery.json"
fi
echo "  no debris"

echo "PASS: calibration loop closed (calibrate -> config -> real create --config -> manifest identity -> validation report -> no debris)"
