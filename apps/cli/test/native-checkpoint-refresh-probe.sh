#!/usr/bin/env bash
set -euo pipefail

# Proves the fresh-install-then-crash path is survivable.
#
# The journey this reproduces is the ordinary one, and it was the CLI's single
# largest source of real errors: install Maple, send it telemetry, lose the
# process to a SIGKILL. Nothing had ever checkpointed that store — `maple
# checkpoint` was the only thing that created one and nobody runs it — so
# `maple start` found a dirty store with no restore point and could offer only
# `--reset`, which throws the telemetry away.
#
#   1. start on a FRESH store with a short --checkpoint-interval;
#   2. ingest markers, wait for the refresh loop to seal a checkpoint;
#   3. SIGKILL the server, which leaves the store dirty (no finalizers run);
#   4. `maple start` must refuse AND name `maple restore` in its advice;
#   5. `maple restore --yes` must succeed;
#   6. the restored store must reopen and still hold the markers;
#   7. a store with data but no registry (every install upgrading into this)
#      must get its opening checkpoint on start.
#
# Step 4 is the regression that matters: before the refresh loop the advice
# could not mention restore, because there was nothing to restore from.
#
# Steps 2 and 7 also pin the reason both checkpoints are taken by a spawned
# `maple checkpoint` child rather than in-process: chDB allows ONE connection
# per process, the server already holds it, and an in-process BACKUP fails with
# `chdb_connect returned NULL` on every attempt — quietly, since neither path is
# allowed to take the server down with it.

BUNDLE_DIR="${1:?usage: native-checkpoint-refresh-probe.sh <bundle-dir> [port]}"
MAPLE="$BUNDLE_DIR/maple"
PORT="${2:-45233}"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/maple-native-cp-refresh.XXXXXX")"
DATA="$ROOT/data"
CONFIG="$ROOT/backups.xml"
SIGNAL="traces"
SERVER_PID=""
# Short enough to keep the probe fast, long enough that the server is serving
# before the first refresh fires.
INTERVAL="3s"

cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill -9 "$SERVER_PID" 2>/dev/null || true
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
	[[ -f "$ROOT/server.log" ]] && tail -40 "$ROOT/server.log" >&2
	exit 1
}

query() {
	curl --fail-with-body -sS --max-time 30 "http://127.0.0.1:$PORT/local/query" \
		-H 'content-type: application/json' \
		--data "$(jq -nc --arg sql "$1" '{sql:$sql}')"
}

wait_health() {
	for _ in $(seq 1 200); do
		curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return
		sleep 0.1
	done
	fail "server did not become healthy"
}

printf '%s\n' '<clickhouse><backups><allowed_disk>default</allowed_disk><allowed_path>backups</allowed_path></backups></clickhouse>' >"$CONFIG"
chmod 600 "$CONFIG"

# ---- 1. fresh store, refresh loop armed -------------------------------------
[[ -e "$DATA" ]] && fail "fixture must begin with no store at all"
"$MAPLE" start --port "$PORT" --data-dir "$DATA" --chdb-config-file "$CONFIG" \
	--on-dirty-store fail --checkpoint-interval "$INTERVAL" --offline \
	>"$ROOT/server.log" 2>&1 &
SERVER_PID=$!
wait_health
echo "  started on a fresh store (--checkpoint-interval $INTERVAL)"

# The opening checkpoint deliberately does NOT fire here: the store held nothing
# at start, and backing up an empty store restores to nothing. Everything below
# is therefore the refresh loop's doing.
if [[ -f "$DATA/backups/state.json" ]]; then
	fail "an empty store was checkpointed on start; only the refresh loop should checkpoint here"
fi

# ---- 2. ingest, then wait for the loop to seal a checkpoint ------------------
query "INSERT INTO $SIGNAL (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, StatusCode, StatusMessage) SELECT 'refresh', now64(9,'UTC'), concat('t', toString(number)), concat('s', toString(number)), '', '', 'm', 'Server', 'refresh-probe', 'Ok', '' FROM numbers(3)" >/dev/null
markers="$(query "SELECT count() AS c FROM $SIGNAL WHERE OrgId = 'refresh' FORMAT JSON" | jq -r '.[0].c')"
[[ "$markers" == "3" ]] || fail "expected 3 markers before the crash, got '$markers'"

for _ in $(seq 1 60); do
	[[ -f "$DATA/backups/state.json" ]] && break
	sleep 0.5
done
[[ -f "$DATA/backups/state.json" ]] || fail "the refresh loop never sealed a checkpoint within 30s"
checkpoint_id="$(jq -r '.current' "$DATA/backups/state.json")"
[[ -n "$checkpoint_id" && "$checkpoint_id" != "null" ]] || fail "checkpoint state has no current id"
echo "  refresh loop sealed checkpoint $checkpoint_id"

# ---- 3. SIGKILL: no finalizers, so the store is left dirty ------------------
kill -9 "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
echo "  SIGKILLed the server (store left unclean)"

# ---- 4. start must refuse, and must now name restore ------------------------
set +e
"$MAPLE" start --port "$PORT" --data-dir "$DATA" --chdb-config-file "$CONFIG" \
	--on-dirty-store fail --offline >"$ROOT/refuse.out" 2>&1
refuse_status=$?
set -e
[[ $refuse_status -ne 0 ]] || fail "start accepted a dirty store"
grep -q "not cleanly closed" "$ROOT/refuse.out" || fail "refusal did not name the unclean store: $(cat "$ROOT/refuse.out")"
# The regression under test. Without the refresh loop this store had no
# checkpoint, so the advice could only offer the destructive `--reset`.
grep -q "maple restore" "$ROOT/refuse.out" ||
	fail "advice offered no restore path — the refresh loop's checkpoint was not found: $(cat "$ROOT/refuse.out")"
echo "  start refused and offered restore"

# ---- 5 + 6. restore, reopen, markers intact ---------------------------------
"$MAPLE" restore --data-dir "$DATA" --yes >"$ROOT/restore.out" 2>&1 ||
	fail "restore failed: $(cat "$ROOT/restore.out")"

"$MAPLE" start --port "$PORT" --data-dir "$DATA" --chdb-config-file "$CONFIG" \
	--on-dirty-store fail --checkpoint-interval off --offline \
	>"$ROOT/server2.log" 2>&1 &
SERVER_PID=$!
wait_health
restored="$(query "SELECT count() AS c FROM $SIGNAL WHERE OrgId = 'refresh' FORMAT JSON" | jq -r '.[0].c')"
[[ "$restored" == "3" ]] || fail "restored store lost the markers: expected 3, got '$restored'"

# `--checkpoint-interval off` must actually mean off. Proven against the id the
# loop sealed earlier: a running loop would have rotated `current` past it.
sleep 4
still="$(jq -r '.current' "$DATA/backups/state.json")"
[[ "$still" == "$checkpoint_id" ]] || fail "--checkpoint-interval off still refreshed ($still != $checkpoint_id)"

"$MAPLE" stop --data-dir "$DATA" >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

# ---- 7. the upgrade path: data, but no checkpoint ---------------------------
# Every install that predates checkpointing looks like this on its first start
# after upgrading — a store full of telemetry with an empty registry. The
# opening checkpoint covers it, and it runs in the same child process as the
# refresh (chDB permits one connection per process, so neither can be taken
# in-process by the server itself).
rm -rf "${DATA:?}/backups"
"$MAPLE" start --port "$PORT" --data-dir "$DATA" --chdb-config-file "$CONFIG" \
	--on-dirty-store fail --checkpoint-interval off --offline \
	>"$ROOT/server3.log" 2>&1 &
SERVER_PID=$!
wait_health
for _ in $(seq 1 60); do
	[[ -f "$DATA/backups/state.json" ]] && break
	sleep 0.5
done
[[ -f "$DATA/backups/state.json" ]] ||
	fail "a store with data and no checkpoint was not checkpointed on start: $(tail -20 "$ROOT/server3.log")"
opening_id="$(jq -r '.current' "$DATA/backups/state.json")"
[[ -n "$opening_id" && "$opening_id" != "null" ]] || fail "opening checkpoint state has no current id"
echo "  opening checkpoint sealed $opening_id on a store with data"

"$MAPLE" stop --data-dir "$DATA" >/dev/null 2>&1 || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

echo "PASS native checkpoint refresh: crash on a fresh store recovered $restored/3 markers from $checkpoint_id"
