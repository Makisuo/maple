#!/usr/bin/env bash
# Real-process Ctrl-C probe for the maintenance-lock Effect boundary.
#
# The maintenance lock is released by a `finally` inside promise land, so
# whether it survives a Ctrl-C is decided by the Effect boundary above it. A
# bare `Effect.tryPromise` is interruptible and ABANDONS its promise on
# interruption, so `BunRuntime.runMain`'s SIGINT handler used to tear the
# process down mid-operation and strand `<dataDir>.maple-maintenance-lock` with
# a plausible owner record. `maintenanceOperation` makes the boundary
# uninterruptible: the interrupt is recorded, the operation finishes, the lock
# is released, and the interrupt is delivered afterwards.
#
# This probe asserts BOTH arms against real processes and real signals, so it
# cannot pass vacuously: `bare` must strand the lock, `maintenance` must not.
#
# Exit semantics: zero when the boundary behaves correctly, nonzero otherwise.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKER="$REPO/apps/cli/test/probes/maintenance-sigint-worker.ts"
ROOT="$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/maple-maintenance-sigint.XXXXXX")")"
HOLD_MS="${HOLD_MS:-2000}"

cleanup() {
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

# Run one arm: start the worker, wait for it to hold the lock, SIGINT it, and
# report whether the lock directory survived the process.
#   $1 = boundary shape (bare|maintenance)
# Echoes "<lock-state> <exit-code> <completed>".
run_arm() {
	local boundary="$1"
	local data_dir="$ROOT/$boundary/data"
	local lock="$ROOT/$boundary/data.maple-maintenance-lock"
	local out="$ROOT/$boundary.out"
	mkdir -p "$data_dir"

	bun run "$WORKER" --data-dir "$data_dir" --hold-ms "$HOLD_MS" --boundary "$boundary" >"$out" 2>"$ROOT/$boundary.err" &
	local pid=$!

	# Wait for READY: the lock is on disk only after this line is printed, so the
	# signal below can never land before the window under test.
	local waited=0
	while ! grep -q READY "$out" 2>/dev/null; do
		sleep 0.05
		waited=$((waited + 1))
		if [[ $waited -gt 200 ]]; then
			kill -9 "$pid" 2>/dev/null || true
			fail "$boundary: worker never acquired the maintenance lock"
		fi
	done
	[[ -d "$lock" ]] || fail "$boundary: precondition — lock directory absent while worker reports READY"

	kill -INT "$pid"

	local code=0
	wait "$pid" || code=$?

	local state="released"
	[[ -d "$lock" ]] && state="stranded"
	local completed="no"
	grep -q COMPLETED "$out" 2>/dev/null && completed="yes"
	echo "$state $code $completed"
}

echo "== arm 1: bare Effect.tryPromise (the pre-fix shape)"
read -r bare_state bare_code bare_completed <<<"$(run_arm bare)"
echo "   lock=$bare_state exit=$bare_code completed=$bare_completed"
[[ "$bare_state" == "stranded" ]] ||
	fail "bare boundary released the lock — the probe cannot distinguish the arms, so arm 2 would pass vacuously"
[[ "$bare_completed" == "no" ]] ||
	fail "bare boundary ran to completion — SIGINT did not land inside the locked window"

echo "== arm 2: maintenanceOperation"
read -r fixed_state fixed_code fixed_completed <<<"$(run_arm maintenance)"
echo "   lock=$fixed_state exit=$fixed_code completed=$fixed_completed"
[[ "$fixed_state" == "released" ]] ||
	fail "maintenanceOperation stranded the maintenance lock on SIGINT"
[[ "$fixed_completed" == "yes" ]] ||
	fail "maintenanceOperation abandoned the operation instead of letting it finish"
# 130 = 128 + SIGINT: the deferred interrupt is still delivered, just later.
[[ "$fixed_code" -ne 0 ]] ||
	fail "maintenanceOperation swallowed the interrupt (exit 0); Ctrl-C must still terminate the CLI"

echo "PASS: the maintenance boundary finishes its operation, releases the lock, and still honours SIGINT"
