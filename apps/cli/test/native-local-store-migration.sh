#!/usr/bin/env bash
# Native end-to-end local-store migration probe.
#
# A Bun setup helper creates a stopped native source from historical v0 raw-table
# DDL, then its fingerprint-only legacy marker is installed. The migration
# itself opens source and target through native chDB, verifies all six raw
# tables, promotes the target, checks rebuilt DB/namespace aggregates, and
# reopens the promoted store in a fresh Maple process.
set -euo pipefail

BUNDLE_DIR="${1:?usage: native-local-store-migration.sh <bundle-dir> [port]}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
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
	if [[ -f "$ROOT/migrate.out" ]]; then tail -80 "$ROOT/migrate.out" >&2 || true; fi
	if [[ -f "$ROOT/server.log" ]]; then tail -80 "$ROOT/server.log" >&2 || true; fi
	exit 1
}

# Every phase announces itself and runs under a wall-clock bound (when
# `timeout` exists — Linux CI; macOS dev boxes run unbounded). Before this the
# probe printed NOTHING until the final PASS, so a hung maple invocation ate
# the job's whole 20-minute budget with an empty log and no evidence.
step() { echo "probe: $*"; }

bounded() {
	local secs="$1" label="$2"
	shift 2
	if command -v timeout >/dev/null 2>&1; then
		timeout --kill-after=20 "$secs" "$@" || {
			local rc=$?
			[[ "$rc" == 124 || "$rc" == 137 ]] && fail "$label did not finish within ${secs}s"
			return "$rc"
		}
	else
		"$@"
	fi
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
	bounded 60 "maple stop" env MAPLE_LIBCHDB="$LIBCHDB" "$MAPLE" stop --data-dir "$DATA" >/dev/null 2>&1 || true
	# Bounded wait: a server that ignores the stop must not eat the job budget.
	for _ in $(seq 1 300); do
		kill -0 "$SERVER_PID" 2>/dev/null || break
		sleep 0.1
	done
	if kill -0 "$SERVER_PID" 2>/dev/null; then
		kill -9 "$SERVER_PID" 2>/dev/null || true
		fail "native Maple server did not exit within 30s of maple stop"
	fi
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

step "creating legacy v0 source store"
bounded 60 "legacy source fixture" \
	env MAPLE_LIBCHDB="$LIBCHDB" bun "$REPO_ROOT/apps/cli/test/native-local-store-migration-fixture.ts" "$DATA" "$CONFIG"

# Install the historical fingerprint-only marker for the v0 physical source.
# The physical source was created by native chDB; the marker is the only
# compatibility evidence the v0 resolver is allowed to use.
step "installing legacy marker"
CHDB_VERSION="$(bounded 60 "maple --version" env MAPLE_LIBCHDB="$LIBCHDB" "$MAPLE" --version 2>/dev/null | sed -n 's/.*chdb \([^ ]*\).*/\1/p')"
[[ -n "$CHDB_VERSION" ]] || CHDB_VERSION="v26.1.0"
printf '%s\n' "{\"chdb\":\"$CHDB_VERSION\",\"maple\":\"native-probe\",\"createdAt\":\"unknown\",\"schema\":\"428701854f9fd30e\"}" >"$ROOT/maple-store-version.json"
chmod 600 "$ROOT/maple-store-version.json"

step "running maple schema migrate"
# 120s bound: healthy runs take ~3s; the job budget is <3 minutes, so a stall
# has to fail the step in seconds-not-minutes with migrate.out as evidence.
bounded 120 "maple schema migrate" \
	env MAPLE_LIBCHDB="$LIBCHDB" "$MAPLE" schema migrate --data-dir "$DATA" --yes >"$ROOT/migrate.out" 2>&1 || {
	cat "$ROOT/migrate.out" >&2
	fail "native schema migration failed"
}
grep -q "local store migrated" "$ROOT/migrate.out" || fail "native migration did not report promotion"
[[ -f "$ROOT/maple-store-version.json" ]] || fail "active marker disappeared after native promotion"
# Pinned to the CURRENT head identity on purpose — this is the gate that proves
# the native migration promotes all the way to head, not merely that it ran. It
# must be bumped in lockstep with LOCAL_SCHEMA_VERSION and the matching
# LOCAL_SCHEMA_V<n>.fingerprint in apps/cli/src/server/schema-identity.ts;
# leaving it on the previous version is what makes this step fail after a bump.
jq -e '.formatVersion == 2 and .activation == "active" and .schemaVersion == 11 and .schema == "5642766fc2dced4f"' \
	"$ROOT/maple-store-version.json" >/dev/null || fail "native migration wrote the wrong active identity"

step "reopening promoted store in a fresh server"
start_server
step "verifying migrated tables"
for table in logs traces metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram; do
	count="$(query "SELECT count() AS count FROM $table WHERE ServiceName = 'native-migration'" | jq -r '.[0].count | tonumber')"
	expected="1"
	[[ "$table" == "traces" ]] && expected="2"
	[[ "$count" == "$expected" ]] || fail "$table count after native migration: expected $expected, got $count"
done
trace_count="$(query "SELECT sum(TraceCount) AS count FROM service_usage WHERE OrgId = 'native-migration' AND ServiceName = 'native-migration'" | jq -r '.[0].count | tonumber')"
[[ "$trace_count" == "2" ]] || fail "service usage trace count after native migration: expected 2, got $trace_count"
namespace_count="$(query "SELECT count() AS count FROM service_overview_spans WHERE OrgId = 'native-migration' AND ServiceName = 'native-migration' AND ServiceNamespace = 'payments'" | jq -r '.[0].count | tonumber')"
[[ "$namespace_count" == "1" ]] || fail "service namespace aggregate after native migration: expected 1, got $namespace_count"
db_edge_count="$(query "SELECT count() AS count FROM service_map_db_edges_hourly WHERE OrgId = 'native-migration' AND ServiceName = 'native-migration' AND DbSystem = 'postgresql' AND DbNamespace = 'orders'" | jq -r '.[0].count | tonumber')"
[[ "$db_edge_count" == "1" ]] || fail "database aggregate after native migration: expected 1, got $db_edge_count"
step "stopping server and checking rollback retention"
stop_server

step "verifying the service-map ingress bridge"
bounded 60 "service-map ingress bridge probe" \
	env MAPLE_LIBCHDB="$LIBCHDB" bun "$REPO_ROOT/apps/cli/test/native-service-map-ingest-bridge-probe.ts" "$DATA" "$CONFIG"

rollback="$(sed -n 's/^.*rollback *//p' "$ROOT/migrate.out" | tail -1)"
[[ -n "$rollback" && -d "$rollback" ]] || fail "native migration did not retain a rollback source"
[[ -f "$(dirname "$rollback")/maple-store-version.json" ]] || fail "native rollback marker was not retained"
echo "PASS: native historical migration, rebuilt aggregates, v3 materialization triggers, fresh reopen, and rollback retention"
