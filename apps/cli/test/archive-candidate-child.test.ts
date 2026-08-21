import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import * as BunServices from "@effect/platform-bun/BunServices"
import { runCandidateChild } from "../src/commands/archive"
import type { CalibrationBudget, CalibrationCandidate } from "../src/server/archives/calibrate"

/**
 * `runCandidateChild` used to be an unexported promise closure, reachable only
 * through the native shell probes. These tests pin the three invariants that
 * the Effect translation could silently break: a signal death must still read
 * as a failed candidate rather than aborting the matrix, the watchdog must reap
 * the whole process GROUP, and the diagnostic must contain output the child
 * wrote right before exiting.
 */

const CANDIDATE: CalibrationCandidate = {
	writerThreads: 1,
	rowGroupRows: 1000,
	maxShardRows: 1000,
	maxShardBytes: 1_000_000,
}

const budget = (overrides: Partial<CalibrationBudget> = {}): CalibrationBudget => ({
	memoryBudget: 1_000_000_000,
	timeBudget: 60_000,
	sampleRows: 100,
	maxCandidateWallMs: 30_000,
	minThroughputBytesPerSec: 1,
	maxTempDiskBytes: 1_000_000_000,
	freeSpaceReserve: 1,
	safetyMargin: 1,
	...overrides,
})

/** A stand-in for the `maple` bundle: `/usr/bin/time` execs it with the
 *  calibrate-run argv appended, which these scripts simply ignore. */
const bundleScript = (dir: string, body: string): string => {
	const path = join(dir, "fake-maple.sh")
	writeFileSync(path, `#!/bin/sh\n${body}\n`)
	chmodSync(path, 0o755)
	return path
}

const run = (dir: string, bundlePath: string, b: CalibrationBudget = budget()) =>
	runCandidateChild(
		bundlePath,
		join(dir, "data"),
		"cp-test",
		"cp-test:0:0",
		"2026-01-01",
		"spans",
		join(dir, "scratch"),
		join(dir, "archive"),
		CANDIDATE,
		b,
		"11111111-1111-4111-8111-111111111111",
		0,
		b.sampleRows,
		Date.now(),
	).pipe(Effect.provide(BunServices.layer))

describe("runCandidateChild", () => {
	// Plain `it` + `Effect.runPromise`, NOT `it.effect`: that installs a
	// TestClock, which would freeze both the watchdog sleep and the 500ms
	// poller while a real child process runs against the wall clock.
	it("fails the candidate on a nonzero exit even when metrics JSON was printed", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-candidate-exit-"))
		return Effect.runPromise(
			Effect.gen(function* () {
				const bundle = bundleScript(dir, "echo '{\"rowCount\":1}'\nexit 3")
				const result = yield* run(dir, bundle)
				strictEqual(result.ok, false)
				strictEqual(result.metrics, null)
				ok(result.error?.includes("exited 3"), `expected an exit-3 diagnostic, got: ${result.error}`)
			}).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))),
		)
	})

	it("treats a signal death as a failed candidate, not an error-channel failure", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-candidate-signal-"))
		return Effect.runPromise(
			Effect.gen(function* () {
				// `handle.exitCode` FAILS with a PlatformError when the child dies by
				// signal. If that escaped, one killed candidate would abort all six
				// signals instead of eliminating a single matrix cell.
				const bundle = bundleScript(dir, "echo '{\"rowCount\":1}'\nkill -9 $$")
				const result = yield* run(dir, bundle)
				strictEqual(result.ok, false)
				strictEqual(result.metrics, null)
				ok(result.error !== undefined && result.error.length > 0)
			}).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))),
		)
	})

	it("kills the whole process group when the wall deadline expires", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-candidate-watchdog-"))
		return Effect.runPromise(
			Effect.gen(function* () {
				const pidFile = join(dir, "grandchild.pid")
				// A grandchild that outlives its parent unless the GROUP is signalled.
				const bundle = bundleScript(dir, `sh -c 'echo $$ > ${pidFile}; sleep 60' &\nsleep 60`)
				// The deadline floor is 1000ms, so a shorter budget cannot speed this up.
				const result = yield* run(dir, bundle, budget({ maxCandidateWallMs: 1000 }))
				strictEqual(result.ok, false)
				ok(
					result.error?.includes("killed by watchdog"),
					`expected a watchdog diagnostic, got: ${result.error}`,
				)
				const grandchildPid = Number.parseInt(
					yield* Effect.sync(() => require("node:fs").readFileSync(pidFile, "utf8").trim()),
					10,
				)
				ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild never recorded its pid")
				// Give the group kill a moment to be reaped, then assert it is gone.
				yield* Effect.sleep("300 millis")
				let alive = true
				try {
					process.kill(grandchildPid, 0)
				} catch {
					alive = false
				}
				strictEqual(alive, false, `grandchild ${grandchildPid} survived the watchdog kill`)
			}).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))),
		)
	})

	it("drains stdout to EOF, including the line written immediately before exit", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-candidate-drain-"))
		return Effect.runPromise(
			Effect.gen(function* () {
				// `exit` fires before Node guarantees the stdio pipes have drained, so a
				// completion gate built on exit alone would lose the tail of this payload.
				//
				// The payload is kept SMALL on purpose. The diagnostic is
				// `stderr\n stdout\n <time report>`, and truncation keeps only the first
				// and last 800 chars — so once it truncates, the surviving tail is the
				// time report and NO assertion about stdout's end is possible. GNU
				// `time -v` alone is ~23 lines, so a large payload makes this platform
				// dependent; that is what the first version of this test got wrong.
				const bundle = bundleScript(
					dir,
					`i=0\nwhile [ $i -lt 6 ]; do printf 'PAYLOAD-%03d\\n' $i; i=$((i+1)); done\nexit 1`,
				)
				const result = yield* run(dir, bundle)
				strictEqual(result.ok, false)
				ok(
					!result.error?.includes("diagnostics truncated"),
					`payload must stay under the truncation limit on every platform: ${result.error}`,
				)
				// First AND last: the head alone would also survive a stdout that was
				// cut short at exit, so only the final line proves the fold ran to EOF.
				ok(result.error?.includes("PAYLOAD-000"), `first line missing from: ${result.error}`)
				ok(result.error?.includes("PAYLOAD-005"), `last line missing from: ${result.error}`)
			}).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))),
		)
	})

	it("truncates an oversized diagnostic to a head and a tail", () => {
		const dir = mkdtempSync(join(tmpdir(), "maple-candidate-truncate-"))
		return Effect.runPromise(
			Effect.gen(function* () {
				const bundle = bundleScript(
					dir,
					`i=0\nwhile [ $i -lt 200 ]; do printf 'PAYLOAD-%03d-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' $i; i=$((i+1)); done\nexit 1`,
				)
				const result = yield* run(dir, bundle)
				strictEqual(result.ok, false)
				ok(result.error?.includes("diagnostics truncated"), "expected the diagnostic to be truncated")
				// 800 + marker + 800, plus this branch's own prefix. Asserted as a bound
				// rather than on content, so it holds whatever `/usr/bin/time` reports.
				ok(
					(result.error?.length ?? 0) < 2000,
					`truncation did not bound the diagnostic: ${result.error?.length} chars`,
				)
				// The head is always kept, so the first line must survive.
				ok(result.error?.includes("PAYLOAD-000"), "expected the head of stdout to survive")
			}).pipe(Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))),
		)
	})
})
