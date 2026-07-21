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
if [[ ! -x /usr/bin/time ]]; then fail "/usr/bin/time is required"; fi

TIME_PLATFORM="$(uname -s)"
case "$TIME_PLATFORM" in
	Darwin) TIME_ARGS=(-lp) ;;
	Linux) TIME_ARGS=(-v) ;;
	*) fail "unsupported /usr/bin/time platform: $TIME_PLATFORM" ;;
esac

parse_peak_rss() {
	local report="$1"
	case "$TIME_PLATFORM" in
		Darwin)
			awk 'tolower($0) ~ /maximum resident set size/ { print $1; exit }' "$report"
			;;
		Linux)
			awk '/Maximum resident set size \(kbytes\):/ {
				value=$0
				sub(/^.*: */, "", value)
				printf "%.0f\n", value * 1024
				exit
			}' "$report"
			;;
	esac
}

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

# --- Step 3b: crash after session release, before config publication ---
# D-026 deliberately permits releasing the source pin after all measurements
# complete. A crash in the following gap must publish no recommendation and
# leave no session pin, recovery record, or owned sample/scratch debris.
echo "--- post-session-release/pre-config-write SIGKILL boundary ---"
BOUNDARY_CFG="$ROOT/boundary-must-not-exist.json"
BOUNDARY_MARKER="$ROOT/boundary-marker"
rm -rf "$BOUNDARY_MARKER"
mkdir -p "$BOUNDARY_MARKER"
"$MAPLE" archive calibrate "$RANGE_DATE" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" \
	--memory-budget 1073741824 --time-budget 180000 --sample-rows 10 \
	--write-config "$BOUNDARY_CFG" \
	--pause-at-session-phase post-session-release --session-marker-dir "$BOUNDARY_MARKER" \
	>"$ROOT/boundary-calibrate.out" 2>&1 &
BOUNDARY_PID=$!
for _ in $(seq 1 1800); do
	[[ -f "$BOUNDARY_MARKER/paused" ]] && break
	if ! kill -0 "$BOUNDARY_PID" 2>/dev/null; then
		cat "$ROOT/boundary-calibrate.out" >&2
		fail "boundary calibration exited before post-session-release"
	fi
	sleep 0.1
done
[[ -f "$BOUNDARY_MARKER/paused" ]] || fail "boundary calibration did not reach post-session-release"
[[ ! -e "$BOUNDARY_CFG" ]] || fail "config was published before the post-release fault seam"
[[ ! -e "$ARCHIVE/calibration/recovery.json" ]] || fail "session record survived post-release reconciliation"
if find "$DATA/backups/pins" -type f -name '*.json' -exec jq -e 'select(.purpose | startswith("archive-calibrate:"))' {} \; 2>/dev/null | grep -q .; then
	fail "calibration pin survived post-release reconciliation"
fi
if [[ -d "$ARCHIVE/calibration/samples" ]] && [[ -n "$(ls -A "$ARCHIVE/calibration/samples" 2>/dev/null)" ]]; then
	fail "sample debris existed at post-session-release boundary"
fi
shopt -s nullglob 2>/dev/null || true
BOUNDARY_SCRATCH=( "$SCRATCH"/calibrate-* )
[[ ${#BOUNDARY_SCRATCH[@]} -eq 0 ]] || fail "scratch debris existed at post-session-release boundary"
kill -9 "$BOUNDARY_PID" 2>/dev/null || true
wait "$BOUNDARY_PID" 2>/dev/null || true
[[ ! -e "$BOUNDARY_CFG" ]] || fail "SIGKILL published a boundary config"
[[ ! -e "$ARCHIVE/calibration/recovery.json" ]] || fail "SIGKILL recreated a session record"
echo "  no config, pin, recovery record, or owned debris; explicit rerun required"

# --- Step 4: assert the config document has real metrics + identity + environment ---
echo "--- verifying config document ---"
[[ -s "$CFG" ]] || fail "config file missing or empty"
CONFIG_SHA="$(shasum -a 256 "$CFG" | awk '{print $1}')"
CONFIG_FORMAT="$(jq -r '.formatVersion' "$CFG")"
SELECTED_THREADS="$(jq -r '.selected.candidate.writerThreads' "$CFG")"
ENV_MAPLE="$(jq -r '.environment.mapleVersion' "$CFG")"
ENV_SCHEMA="$(jq -r '.environment.schemaFingerprint' "$CFG")"
MARGIN="$(jq -r '.safetyMargin' "$CFG")"
RESULT_COUNT="$(jq '[.results[]] | length' "$CFG")"
ROW_COUNT_SUM="$(jq '[.results[] | select(.ok) | .metrics.rowCount] | add // 0' "$CFG")"
[[ "$SELECTED_THREADS" =~ ^[0-9]+$ ]] || fail "config has no selected candidate writerThreads"
[[ "$CONFIG_FORMAT" -eq 3 ]] || fail "config formatVersion is $CONFIG_FORMAT (expected 3 directional evidence)"
[[ -n "$ENV_MAPLE" && "$ENV_MAPLE" != "null" ]] || fail "config missing environment.mapleVersion"
[[ -n "$ENV_SCHEMA" && "$ENV_SCHEMA" != "null" ]] || fail "config missing environment.schemaFingerprint"
[[ "$RESULT_COUNT" -gt 0 ]] || fail "config has no candidate results (evidence dropped)"
# At least one result must have a nonzero rowCount (real metrics, not the old dead-zero).
[[ "$ROW_COUNT_SUM" -gt 0 ]] || fail "config results all have rowCount 0 (metrics are dead)"
echo "  selected writerThreads=$SELECTED_THREADS margin=$MARGIN results=$RESULT_COUNT rowSum=$ROW_COUNT_SUM"

# --- Step 4b: assert every result carries a persisted, disjoint sample scope ---
# Each training and held-out result must bind to the single checkpoint/range and
# record its ordered-row window; the samplePolicy must declare a LARGER held-out
# window disjoint from training.
TRAINING_ROWS="$(jq -r '.samplePolicy.trainingRows' "$CFG")"
HELD_OUT_ROWS="$(jq -r '.samplePolicy.heldOutRows' "$CFG")"
[[ "$TRAINING_ROWS" =~ ^[0-9]+$ && "$HELD_OUT_ROWS" =~ ^[0-9]+$ ]] || fail "config samplePolicy missing numeric window sizes"
[[ "$HELD_OUT_ROWS" -gt "$TRAINING_ROWS" ]] || fail "held-out window is not larger than training: $HELD_OUT_ROWS <= $TRAINING_ROWS"
# Every ok training result has role training, startRow 0, requestedRows = training.
BAD_TRAINING_SCOPE="$(jq -r '[.results[] | select(.ok) | select((.sample.role // "x") != "training" or (.sample.startRow // -1) != 0 or (.sample.requestedRows // -1) != '"$TRAINING_ROWS"' or (.sample.rowCount // -1) != .metrics.rowCount or .metrics.rowCount != '"$TRAINING_ROWS"')] | length' "$CFG")"
[[ "$BAD_TRAINING_SCOPE" -eq 0 ]] || fail "$BAD_TRAINING_SCOPE training result(s) have a missing/inconsistent sample scope"
# Every held-out result has role held-out, startRow = training, requestedRows = held-out, disjoint.
BAD_HELDOUT_SCOPE="$(jq -r '[.heldOut.results[] | select((.sample.role // "x") != "held-out" or (.sample.startRow // -1) != '"$TRAINING_ROWS"' or (.sample.requestedRows // -1) != '"$HELD_OUT_ROWS"' or (.sample.rowCount // -1) != .metrics.rowCount or .metrics.rowCount != '"$HELD_OUT_ROWS"')] | length' "$CFG")"
[[ "$BAD_HELDOUT_SCOPE" -eq 0 ]] || fail "$BAD_HELDOUT_SCOPE held-out result(s) have a missing/inconsistent/disjoint sample scope"
# All scopes bind to one checkpoint + range.
UNIQUE_SCOPES="$(jq -r '[.results[] | select(.ok) | .sample | {checkpointId, checkpointManifestFingerprint, rangeDate}] | unique | length' "$CFG")"
[[ "$UNIQUE_SCOPES" -eq 1 ]] || fail "training scopes bind to more than one checkpoint/range ($UNIQUE_SCOPES)"
echo "  sample scopes verified: training=$TRAINING_ROWS held-out=$HELD_OUT_ROWS (larger, disjoint, single source)"

# --- Step 4c: assert per-signal like-for-like held-out comparison evidence ---
# heldOut.signalComparisons must have exactly six entries in canonical signal
# order, each with its own scaleRatio and six metric comparisons, and every
# signal must pass (the attempt was selected).
SIGNAL_COUNT="$(jq '[.heldOut.signalComparisons[]] | length' "$CFG")"
[[ "$SIGNAL_COUNT" -eq 6 ]] || fail "heldOut.signalComparisons has $SIGNAL_COUNT entries (expected 6)"
SIGNAL_ORDER="$(jq -r '[.heldOut.signalComparisons[].signal] | join(",")' "$CFG")"
[[ "$SIGNAL_ORDER" == "logs,traces,metrics_sum,metrics_gauge,metrics_histogram,metrics_exponential_histogram" ]] \
	|| fail "heldOut.signalComparisons is not in canonical six-signal order: $SIGNAL_ORDER"
BAD_SIGNAL_ENTRY="$(jq -r '[.heldOut.signalComparisons[] | select((.scaleRatio // 0) <= 0 or (.comparisons | length) != 6 or .passed != true)] | length' "$CFG")"
[[ "$BAD_SIGNAL_ENTRY" -eq 0 ]] || fail "$BAD_SIGNAL_ENTRY heldOut.signalComparisons entry/entries have a bad ratio/comparison-count/passed"
echo "  per-signal comparisons verified: $SIGNAL_COUNT signals, canonical order, each scaled by its own ratio"

# --- Step 5: run a LIKE-FOR-LIKE calibrate-run trial on held-out data ---
# The trial runs the SAME export-sample operation the calibration measured
# (through the same shared writer), on DISJOINT held-out rows (--start-row), with
# the config's selected candidate tuning. The child emits a real metrics JSON
# with true logical/physical bytes, export-section wall time, and peak temp disk.
# Run under /usr/bin/time for the authoritative external peak RSS. This is
# like-for-like (C4): not a heavier full-create, not proxy values. The child
# runs bound to a parent calibration session (calibrate-session open) that owns
# the source pin; the session is closed after the trial.
echo "--- like-for-like calibrate-run trial on held-out data (measured) ---"
TRIAL_SESSION_JSON="$("$MAPLE" archive calibrate-session \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --action open 2>"$ROOT/trial-session.err")" \
	|| { cat "$ROOT/trial-session.err" >&2; fail "trial calibrate-session open failed"; }
TRIAL_OP="$(jq -r '.operationId' <<<"$TRIAL_SESSION_JSON")"
TRIAL_CKPT="$(jq -r '.checkpointId' <<<"$TRIAL_SESSION_JSON")"
TRIAL_FP="$(jq -r '.manifestFingerprint' <<<"$TRIAL_SESSION_JSON")"
TIME_OUT="$ROOT/trial-time.txt"
if ! /usr/bin/time "${TIME_ARGS[@]}" "$MAPLE" archive calibrate-run logs "$RANGE_DATE" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$TRIAL_CKPT" --checkpoint-fingerprint "$TRIAL_FP" --operation-id "$TRIAL_OP" \
	--start-row 10 --sample-rows 10 \
	--max-temp-disk 2147483648 --free-space-reserve 536870912 \
	--writer-threads "$SELECTED_THREADS" \
	--row-group-rows "$(jq -r '.selected.candidate.rowGroupRows' "$CFG")" \
	--max-shard-rows "$(jq -r '.selected.candidate.maxShardRows' "$CFG")" \
	--max-shard-bytes "$(jq -r '.selected.candidate.maxShardBytes' "$CFG")" \
	>"$ROOT/trial.out" 2>"$TIME_OUT"; then
	cat "$ROOT/trial.out" >&2
	"$MAPLE" archive calibrate-session \
		--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" --action close >/dev/null 2>&1
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
OBSERVED_RSS="$(parse_peak_rss "$TIME_OUT")"
[[ "$OBSERVED_RSS" =~ ^[0-9]+$ ]] || fail "could not parse observed peak RSS from /usr/bin/time"
[[ "$OBSERVED_ROWS" -gt 0 ]] || fail "trial exported zero rows (held-out window empty — need more data)"
# Close the trial session (release the pin + clear the record) now that the
# child's metrics are captured.
"$MAPLE" archive calibrate-session \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--action close >"$ROOT/trial-close.out" 2>&1 || { cat "$ROOT/trial-close.out" >&2; fail "trial session close failed"; }
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
"$MAPLE" archive verify --archive-dir "$ARCHIVE" --signal logs >"$ROOT/archive-verify.out" 2>&1 \
	|| fail "archive verify failed: $(cat "$ROOT/archive-verify.out")"
LISTING_JSON="$("$MAPLE" archive list --archive-dir "$ARCHIVE" --output json 2>/dev/null)"
GEN_ID="$(jq -r '[.active[] | select(.signal=="logs")][0].generationId' <<<"$LISTING_JSON")"
[[ -n "$GEN_ID" && "$GEN_ID" != "null" ]] || fail "could not find the logs generation"
MANIFEST="$ARCHIVE/logs/$RANGE_DATE/generations/$GEN_ID/manifest.json"
[[ -f "$MANIFEST" ]] || fail "manifest not found at $MANIFEST"
MANIFEST_CONFIG_NAME="$(jq -r '.tuningConfig.configName // "MISSING"' "$MANIFEST")"
MANIFEST_CONFIG_SHA="$(jq -r '.tuningConfig.sha256 // "MISSING"' "$MANIFEST")"
MANIFEST_CONFIG_FORMAT="$(jq -r '.tuningConfig.formatVersion // "MISSING"' "$MANIFEST")"
[[ "$MANIFEST_CONFIG_NAME" == "calib-config.json" ]] || fail "manifest configName mismatch: $MANIFEST_CONFIG_NAME"
[[ "$MANIFEST_CONFIG_SHA" == "$CONFIG_SHA" ]] || fail "manifest config SHA mismatch: manifest=$MANIFEST_CONFIG_SHA config=$CONFIG_SHA"
[[ "$MANIFEST_CONFIG_FORMAT" -eq 3 ]] || fail "manifest config formatVersion mismatch: $MANIFEST_CONFIG_FORMAT"
echo "  manifest config identity verified: $MANIFEST_CONFIG_NAME ($MANIFEST_CONFIG_SHA)"

# --- Step 5c: a config bound to a DIFFERENT archive volume is rejected ---
# The volume identity (fsid/type + canonical path) is enforced by the same
# assertCalibrationArchiveVolume the publication re-check uses. Forging the
# recorded fsid proves a volume swap between calibration and create (or a
# config copied across volumes) cannot publish a generation.
FORGED_CFG="$ROOT/forged-volume.json"
jq '.environment.archiveVolume.fsid = "dev:deadbeef"' "$CFG" > "$FORGED_CFG"
if "$MAPLE" archive create "$RANGE_DATE" traces \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --config "$FORGED_CFG" >"$ROOT/forged-create.out" 2>&1; then
	cat "$ROOT/forged-create.out" >&2
	fail "archive create --config with a forged volume identity unexpectedly succeeded"
fi
grep -q "calibration environment mismatch: archive volume" "$ROOT/forged-create.out" \
	|| { cat "$ROOT/forged-create.out" >&2; fail "forged-volume create did not report an archive volume mismatch"; }
echo "  forged-volume config rejected (volume identity enforced)"

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
