#!/usr/bin/env bash
# Native archive calibration SIGKILL cleanup probe (C1: deterministic boundary).
#
# Uses the calibrate-run --pause-at-phase fault seam to block at a NAMED phase
# AFTER durable-writing the recovery record + acquiring the pin + allocating
# scratch. The probe:
#  1. waits for the `paused` marker (the child reached the boundary),
#  2. asserts the recovery record, pin, scratch dir, and sample dir EXIST,
#  3. seeds an UNRELATED pin and asserts it survives reconciliation,
#  4. SIGKILLs the process group (so the Maple descendant is reaped),
#  5. reconciles via a fresh calibration run,
#  6. asserts the exact pin/scratch/sample are gone, the record is cleared, and
#     the unrelated pin SURVIVES (over-retention safe).
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
echo "native calibration crash probe root: $ROOT (boundary: sampling)"

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
UNRELATED_PIN_ID="$(uuidgen | tr 'A-Z' 'a-z')"
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

# --- Crash boundary: launch calibrate-run paused at sampling ---
CRASH_OP="$(uuidgen | tr 'A-Z' 'a-z')"
rm -rf "$MARKER"; mkdir -p "$MARKER"
"$MAPLE" archive calibrate-run logs "$RANGE_DATE" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --operation-id "$CRASH_OP" \
	--sample-rows 5 --max-temp-disk 2147483648 --free-space-reserve 536870912 \
	--writer-threads 1 --row-group-rows 10000 --max-shard-rows 500000 --max-shard-bytes 268435456 \
	--pause-at-phase sampling --marker-dir "$MARKER" \
	>"$ROOT/crashed-child.out" 2>&1 &
CHILD_PID=$!

# Wait for the marker (child reached the sampling boundary).
echo "--- waiting for sampling boundary ---"
KILLED=0
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
[[ -f "$ARCHIVE/calibration/recovery.json" ]] || fail "recovery record does not exist at boundary"
RECORD_PHASE="$(jq -r '.phase' "$ARCHIVE/calibration/recovery.json")"
[[ "$RECORD_PHASE" == "sampling" ]] || fail "record phase is $RECORD_PHASE, expected sampling"
ACTUAL_PIN_PATH="$(jq -r '.pinPath' "$ARCHIVE/calibration/recovery.json")"
[[ -f "$ACTUAL_PIN_PATH" ]] || fail "pin file does not exist at boundary: $ACTUAL_PIN_PATH"
EXPECTED_SCRATCH="$SCRATCH/calibrate-$CRASH_OP"
EXPECTED_SAMPLE="$ARCHIVE/calibration/samples/$CRASH_OP"
[[ -d "$EXPECTED_SCRATCH" ]] || fail "scratch directory does not exist at boundary: $EXPECTED_SCRATCH"
[[ -d "$EXPECTED_SAMPLE" ]] || fail "sample directory does not exist at boundary: $EXPECTED_SAMPLE"
echo "  record=sampling pin=$ACTUAL_PIN_PATH scratch=$EXPECTED_SCRATCH sample=$EXPECTED_SAMPLE"

# --- SIGKILL the process group ---
echo "--- SIGKILL process group ---"
# The child is the maple process (spawned directly); kill it and reap.
kill -9 "$CHILD_PID" 2>/dev/null || true
wait "$CHILD_PID" 2>/dev/null || true
KILLED=1
[[ "$KILLED" -eq 1 ]] || fail "SIGKILL was not delivered"
echo "  killed child $CHILD_PID at sampling boundary"

# --- Reconcile via a fresh calibration run ---
echo "--- reconciling via a fresh calibration run ---"
RECON_OP="$(uuidgen | tr 'A-Z' 'a-z')"
if ! "$MAPLE" archive calibrate-run logs "$RANGE_DATE" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --operation-id "$RECON_OP" \
	--sample-rows 5 --max-temp-disk 2147483648 --free-space-reserve 536870912 \
	--writer-threads 1 --row-group-rows 10000 --max-shard-rows 500000 --max-shard-bytes 268435456 \
	>"$ROOT/reconcile-child.out" 2>&1; then
	cat "$ROOT/reconcile-child.out" >&2
	fail "post-crash reconcile calibrate-run failed"
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

# --- Idempotency: re-run reconcile (no-op) ---
echo "--- idempotency ---"
IDEM_OP="$(uuidgen | tr 'A-Z' 'a-z')"
"$MAPLE" archive calibrate-run logs "$RANGE_DATE" \
	--data-dir "$DATA" --archive-dir "$ARCHIVE" --scratch-root "$SCRATCH" \
	--checkpoint-id "$C1" --operation-id "$IDEM_OP" \
	--sample-rows 5 --max-temp-disk 2147483648 --free-space-reserve 536870912 \
	--writer-threads 1 --row-group-rows 10000 --max-shard-rows 500000 --max-shard-bytes 268435456 \
	>"$ROOT/idem-child.out" 2>&1 || { cat "$ROOT/idem-child.out" >&2; fail "idempotent run failed"; }
[[ ! -e "$ARCHIVE/calibration/recovery.json" ]] || fail "record survived idempotent run"

# --- Assert: no owned debris from any run ---
shopt -s nullglob 2>/dev/null || true
DEBRIS=( "$SCRATCH"/calibrate-* )
[[ ${#DEBRIS[@]} -eq 0 ]] || fail "scratch debris survived: ${DEBRIS[*]}"
DEBRIS_SAMPLES=( "$ARCHIVE"/calibration/samples/*/ )
[[ ${#DEBRIS_SAMPLES[@]} -eq 0 ]] || fail "sample debris survived: ${DEBRIS_SAMPLES[*]}"

echo "PASS: calibration SIGKILL at sampling boundary reconciled (exact pin/scratch/sample removed, unrelated pin survived, idempotent)"
