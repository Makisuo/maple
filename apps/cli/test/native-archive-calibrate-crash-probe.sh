#!/usr/bin/env bash
# Native archive calibration session SIGKILL cleanup probes.
#
# The parent calibration session (calibrate-session open) owns the source pin
# and the durable recovery record; a calibrate-run child binds to it. This probe
# covers two SIGKILL boundaries:
#  - sampling: open a session, run a child paused at the sampling seam (its
#    sample/scratch exist; the parent record is at pin-acquired), SIGKILL the
#    child, and prove session close reconciles the pin/record/debris while an
#    unrelated pin survives; close is idempotent.
#  - intent: open a session paused at the intent seam (record at intent, no
#    pin), SIGKILL it, normally retire the unpinned source checkpoint, and prove
#    a later session retires the inert record even though its source is gone.
#
# Usage: native-archive-calibrate-crash-probe.sh <bundle-dir> [port]
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-archive-calibrate-crash-probe.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
PORT="${2:-45441}"
ROOT="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/maple-native-calib-crash.XXXXXX")")"
DATA="$ROOT/data"
ARCHIVE="$ROOT/archive"
SCRATCH="$ROOT/scratch"
CONFIG="$ROOT/backups.xml"
MARKER="$ROOT/marker"
SERVER_PID=""
RANGE_DATE="$(date -u +%Y-%m-%d)"

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	if [[ "${KEEP_ROOT:-0}" == "1" ]]; then
		echo "preserved crash probe root: $ROOT" >&2
	else
		rm -rf "$ROOT"
	fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"

query() {
	curl --fail-with-body -sS "http://127.0.0.1:$PORT/local/query" \
		-H 'content-type: application/json' \
		--data "$(jq -nc --arg sql "$1" '{sql:$sql}')"
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
echo "native calibration crash probe root: $ROOT (boundaries: sampling, retired intent)"

# --- Setup: ingest rows, checkpoint, stop ---
"$MAPLE" start --port "$PORT" --data-dir "$DATA" --chdb-config-file "$CONFIG" \
	--on-dirty-store fail --offline >"$ROOT/server.log" 2>&1 &
SERVER_PID=$!
wait_health
t="${RANGE_DATE}T12:00:00"
query "INSERT INTO logs (OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber, ServiceName, Body) SELECT 'local', toDateTime64('${t}.000000000', 9, 'UTC'), toDateTime('${t}', 'UTC'), 'tr-0', 'sp-0', 1, 'INFO', 9, 'crash', 'm-0'" >/dev/null
"$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/ck.out" 2>&1 || { cat "$ROOT/ck.out" >&2; fail "checkpoint failed"; }
C1="$(jq -r '.current' "$DATA/backups/state.json")"
"$MAPLE" stop --data-dir "$DATA" >/dev/null
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# --- Seed an UNRELATED pin on the same checkpoint (must survive reconcile) ---
UNRELATED_PIN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
UNRELATED_PIN_DIR="$DATA/backups/pins/$C1"
UNRELATED_PIN="$UNRELATED_PIN_DIR/$UNRELATED_PIN_ID.json"
mkdir -p "$UNRELATED_PIN_DIR"
jq -nc \
	--arg pinId "$UNRELATED_PIN_ID" \
	--arg checkpointId "$C1" \
	--arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	'{formatVersion:1,pinId:$pinId,checkpointId:$checkpointId,purpose:"unrelated-test",createdAt:$createdAt}' \
	>"$UNRELATED_PIN"
chmod 600 "$UNRELATED_PIN"
[[ -n "$UNRELATED_PIN" && -f "$UNRELATED_PIN" ]] || fail "unrelated pin was not created"

# --- Open a parent calibration session that owns the pin + recovery record ---
# In the session model the parent acquires the pin and writes the pin-acquired
# record; a child binds to that session by operation-id + checkpoint id +
# fingerprint. A SIGKILLed child leaves the parent's record at pin-acquired with
# the child's sample/scratch debris owned by the same operation id.
echo "--- opening calibration session ---"
SESSION_JSON="$("$MAPLE" archive calibrate-session \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --action open 2>"$ROOT/session-open.err")" \
	|| { cat "$ROOT/session-open.err" >&2; fail "calibrate-session open failed"; }
CRASH_OP="$(jq -r '.operationId' <<<"$SESSION_JSON")"
SESSION_CKPT="$(jq -r '.checkpointId' <<<"$SESSION_JSON")"
SESSION_FP="$(jq -r '.manifestFingerprint' <<<"$SESSION_JSON")"
[[ "$CRASH_OP" != "null" && "$SESSION_CKPT" == "$C1" && "$SESSION_FP" != "null" ]] \
	|| fail "calibrate-session open returned an incomplete session: $SESSION_JSON"
ACTUAL_PIN_PATH="$(jq -r '.pinPath' <<<"$SESSION_JSON")"
[[ -f "$ACTUAL_PIN_PATH" ]] || fail "session pin not live after open: $ACTUAL_PIN_PATH"
[[ "$(jq -r '.phase' "$ARCHIVE/calibration/recovery.json")" == "pin-acquired" ]] \
	|| fail "session record is not pin-acquired after open"

# --- Crash boundary: launch a child paused at sampling, then SIGKILL it ---
rm -rf "$MARKER"; mkdir -p "$MARKER"
"$MAPLE" archive calibrate-run logs "$RANGE_DATE" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$SESSION_CKPT" --checkpoint-fingerprint "$SESSION_FP" \
	--operation-id "$CRASH_OP" \
	--sample-rows 5 --max-temp-disk 2147483648 --free-space-reserve 536870912 \
	--writer-threads 1 --row-group-rows 10000 --max-shard-rows 500000 --max-shard-bytes 268435456 \
	--pause-at-phase sampling --marker-dir "$MARKER" \
	>"$ROOT/crashed-child.out" 2>&1 &
CHILD_PID=$!

# Wait for the marker (child reached the sampling boundary).
echo "--- waiting for sampling boundary ---"
for _ in $(seq 1 300); do
	[[ -f "$MARKER/paused" ]] && break
	if ! kill -0 "$CHILD_PID" 2>/dev/null; then
		fail "child exited before reaching the sampling boundary (never paused)"
	fi
	sleep 0.1
done
[[ -f "$MARKER/paused" ]] || fail "child did not pause at sampling within 30s"

# --- Assert the durable state exists at the boundary ---
echo "--- asserting boundary state exists ---"
# The record stays at pin-acquired (parent-owned); the child allocated sample
# output and scratch before pausing at sampling.
[[ "$(jq -r '.phase' "$ARCHIVE/calibration/recovery.json")" == "pin-acquired" ]] \
	|| fail "record phase changed under the child"
EXPECTED_SCRATCH="$SCRATCH/calibrate-$CRASH_OP"
EXPECTED_SAMPLE="$ARCHIVE/calibration/samples/$CRASH_OP"
[[ -d "$EXPECTED_SCRATCH" ]] || fail "scratch directory does not exist at boundary: $EXPECTED_SCRATCH"
[[ -d "$EXPECTED_SAMPLE" ]] || fail "sample directory does not exist at boundary: $EXPECTED_SAMPLE"
echo "  record=pin-acquired pin=$ACTUAL_PIN_PATH scratch=$EXPECTED_SCRATCH sample=$EXPECTED_SAMPLE"

# --- SIGKILL the child (the parent session is NOT a process here) ---
echo "--- SIGKILL child ---"
kill -9 "$CHILD_PID" 2>/dev/null || true
wait "$CHILD_PID" 2>/dev/null || true
echo "  killed child $CHILD_PID at sampling boundary"

# --- Reconcile via session close (releases the pin + clears the record) ---
echo "--- reconciling via calibrate-session close ---"
if ! "$MAPLE" archive calibrate-session \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--action close >"$ROOT/reconcile.out" 2>&1; then
	cat "$ROOT/reconcile.out" >&2
	fail "session close reconcile failed"
fi

# --- Assert: crashed run's resources are gone ---
echo "--- verifying reconciliation ---"
[[ ! -e "$ARCHIVE/calibration/recovery.json" ]] || fail "recovery record survived reconciliation"
[[ ! -e "$ACTUAL_PIN_PATH" ]] || fail "crashed pin survived reconciliation: $ACTUAL_PIN_PATH"
[[ ! -d "$EXPECTED_SCRATCH" ]] || fail "crashed scratch survived: $EXPECTED_SCRATCH"
[[ ! -d "$EXPECTED_SAMPLE" ]] || fail "crashed sample survived: $EXPECTED_SAMPLE"

# --- Assert: UNRELATED pin survives (over-retention safe) ---
[[ -f "$UNRELATED_PIN" ]] || fail "UNRELATED pin was deleted by reconciliation (over-deletion!): $UNRELATED_PIN"
echo "  unrelated pin survived: $UNRELATED_PIN"

# --- Idempotency: close again is a no-op (record already clear) ---
echo "--- idempotency ---"
"$MAPLE" archive calibrate-session \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--action close >"$ROOT/idem.out" 2>&1 || { cat "$ROOT/idem.out" >&2; fail "idempotent close failed"; }
[[ ! -e "$ARCHIVE/calibration/recovery.json" ]] || fail "record survived idempotent close"

# --- Retired-source boundary: a session opened to intent, SIGKILLed pre-pin ---
echo "--- retired-source intent boundary ---"
rm -rf "$MARKER"; mkdir -p "$MARKER"
"$MAPLE" archive calibrate-session \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --action open \
	--pause-at-session-phase intent --session-marker-dir "$MARKER" \
	>"$ROOT/intent-session.out" 2>&1 &
INTENT_PID=$!
for _ in $(seq 1 300); do
	[[ -f "$MARKER/paused" ]] && break
	if ! kill -0 "$INTENT_PID" 2>/dev/null; then
		fail "intent session exited before reaching the intent boundary"
	fi
	sleep 0.1
done
[[ -f "$MARKER/paused" ]] || fail "session did not pause at intent within 30s"
[[ "$(jq -r '.phase' "$ARCHIVE/calibration/recovery.json")" == "intent" ]] || fail "record is not at intent"
[[ "$(jq -r '.pinPath' "$ARCHIVE/calibration/recovery.json")" == "null" ]] || fail "intent unexpectedly records a pin path"
INTENT_OP="$(jq -r '.operationId' "$ARCHIVE/calibration/recovery.json")"
INTENT_PIN_ID="$(jq -r '.pinId' "$ARCHIVE/calibration/recovery.json")"
INTENT_PIN="$DATA/backups/pins/$C1/$INTENT_PIN_ID.json"
INTENT_SCRATCH="$SCRATCH/calibrate-$INTENT_OP"
INTENT_SAMPLE="$ARCHIVE/calibration/samples/$INTENT_OP"
[[ ! -e "$INTENT_PIN" ]] || fail "intent unexpectedly acquired a pin"
[[ ! -e "$INTENT_SCRATCH" ]] || fail "intent unexpectedly allocated scratch"
[[ ! -e "$INTENT_SAMPLE" ]] || fail "intent unexpectedly allocated sample output"
kill -9 "$INTENT_PID" 2>/dev/null || true
wait "$INTENT_PID" 2>/dev/null || true

# Remove only the probe's unrelated pin, then create two newer checkpoints.
# Current/previous retention must retire the unpinned C1 snapshot.
rm -f "$UNRELATED_PIN"
"$MAPLE" start --port "$PORT" --data-dir "$DATA" --chdb-config-file "$CONFIG" \
	--on-dirty-store fail --offline >"$ROOT/retention-server.log" 2>&1 &
SERVER_PID=$!
wait_health
"$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/ck2.out" 2>&1 || {
	cat "$ROOT/ck2.out" >&2
	fail "second checkpoint failed"
}
"$MAPLE" checkpoint --port "$PORT" --data-dir "$DATA" >"$ROOT/ck3.out" 2>&1 || {
	cat "$ROOT/ck3.out" >&2
	fail "third checkpoint failed"
}
C3="$(jq -r '.current' "$DATA/backups/state.json")"
"$MAPLE" stop --data-dir "$DATA" >/dev/null
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
[[ ! -e "$DATA/backups/snapshots/$C1" ]] || fail "normal retention did not retire unpinned C1"
[[ -f "$ARCHIVE/calibration/recovery.json" ]] || fail "intent recovery record vanished before reconciliation"

# A new session against the current checkpoint must first retire the inert
# intent even though its recorded source checkpoint no longer exists.
if ! "$MAPLE" archive calibrate-session \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C3" --action open >"$ROOT/retired-reconcile.out" 2>&1; then
	cat "$ROOT/retired-reconcile.out" >&2
	fail "retired-source intent reconciliation failed"
fi
# The new session opens (writing its own pin-acquired record); close it to
# leave a clean slate for the debris assertion.
"$MAPLE" archive calibrate-session \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--action close >"$ROOT/retired-close.out" 2>&1 || { cat "$ROOT/retired-close.out" >&2; fail "retired close failed"; }
[[ ! -e "$ARCHIVE/calibration/recovery.json" ]] || fail "retired intent recovery record survived"
[[ ! -e "$INTENT_PIN" ]] || fail "retired intent pin appeared during reconciliation"
[[ ! -e "$INTENT_SCRATCH" ]] || fail "retired intent scratch appeared during reconciliation"
[[ ! -e "$INTENT_SAMPLE" ]] || fail "retired intent sample appeared during reconciliation"

# --- Assert: no owned debris from any run ---
shopt -s nullglob 2>/dev/null || true
DEBRIS=( "$SCRATCH"/calibrate-* )
[[ ${#DEBRIS[@]} -eq 0 ]] || fail "scratch debris survived: ${DEBRIS[*]}"
DEBRIS_SAMPLES=( "$ARCHIVE"/calibration/samples/*/ )
[[ ${#DEBRIS_SAMPLES[@]} -eq 0 ]] || fail "sample debris survived: ${DEBRIS_SAMPLES[*]}"

echo "PASS: calibration session SIGKILL recovery reconciled a crashed sampling child and an inert intent whose source was normally retired"
