import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
	ARCHIVE_OPERATION_FORMAT_VERSION,
	advancePhase,
	archiveCompletedOperation,
	activeOperationsRoot,
	listActiveOperationIds,
	operationDir,
	parseArchiveOperationIntent,
	readActiveOperation,
	writeInitialIntent,
	type ArchiveOperationIntent,
} from "../src/server/archives/journal"
import { reconcileArchiveGeneration } from "../src/server/archives/generation"
import { checkpointPinsRoot } from "../src/server/checkpoints"

// Filesystem-level tests for the archive operation journal (Gate 3). These are
// the fast in-process checks of the journal's fail-closed parsing, phase
// transitions, and at-most-one-active-operation invariant. The AUTHORITATIVE
// crash-safety oracle is the native SIGKILL harness
// (native-archive-crash-recovery-probe.sh); these unit tests cover the
// deterministic invariants the harness does not isolate.

const withArchive = async (run: (archiveDir: string) => Promise<void> | void): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-archive-journal-test-"))
	const archiveDir = join(parent, "archive")
	mkdirSync(archiveDir, { recursive: true })
	try {
		await run(archiveDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const baseIntent = (overrides: Partial<{ operationId: string; generationId: string }> = {}) => {
	const operationId = overrides.operationId ?? randomUUID()
	const generationId = overrides.generationId ?? randomUUID()
	return {
		archiveDir: "", // set by withArchive caller
		operationId,
		generationId,
		signal: "traces",
		rangeStart: "2026-06-01",
		checkpointId: randomUUID(),
		dataDir: "/data",
		scratchRoot: "/scratch",
		pinId: randomUUID(),
		pinPurpose: `archive:${generationId}`,
		scratchSubdir: `archive-${operationId}`,
		baseActiveGenerationId: null,
	}
}

describe("archive operation journal", () => {
	it("writeInitialIntent persists a parseable intent at phase intent", async () => {
		await withArchive(async (archiveDir) => {
			const intent = baseIntent()
			await writeInitialIntent({ ...intent, archiveDir })
			const active = readActiveOperation(archiveDir)
			ok(active !== null)
			strictEqual(active.intent.phase, "intent")
			strictEqual(active.intent.operationId, intent.operationId)
			strictEqual(active.intent.pinId, intent.pinId)
			strictEqual(active.intent.scratchSubdir, intent.scratchSubdir)
			strictEqual(active.intent.formatVersion, ARCHIVE_OPERATION_FORMAT_VERSION)
		})
	})

	it("listActiveOperationIds returns empty when no operations exist", async () => {
		await withArchive(async (archiveDir) => {
			strictEqual(listActiveOperationIds(archiveDir).length, 0)
			strictEqual(readActiveOperation(archiveDir), null)
		})
	})

	it("advancePhase records a forward transition and refuses regression", async () => {
		await withArchive(async (archiveDir) => {
			const op = randomUUID()
			await writeInitialIntent({ ...baseIntent({ operationId: op }), archiveDir })
			await advancePhase(archiveDir, op, "pin-acquired")
			let active = readActiveOperation(archiveDir)
			strictEqual(active!.intent.phase, "pin-acquired")
			// Idempotent re-advance to the same phase is allowed.
			await advancePhase(archiveDir, op, "pin-acquired")
			// Backward transition is refused.
			await rejects(advancePhase(archiveDir, op, "intent"), /regression/)
			active = readActiveOperation(archiveDir)
			strictEqual(active!.intent.phase, "pin-acquired")
		})
	})

	it("clears published-manifest authority when a prepublication operation aborts", async () => {
		await withArchive(async (archiveDir) => {
			const op = randomUUID()
			await writeInitialIntent({ ...baseIntent({ operationId: op }), archiveDir })
			await advancePhase(archiveDir, op, "manifest-written", "a".repeat(64))
			await advancePhase(archiveDir, op, "aborted")
			const active = readActiveOperation(archiveDir)
			strictEqual(active!.intent.phase, "aborted")
			strictEqual(active!.intent.manifestSha256, null)
		})
	})

	it("readActiveOperation fails closed on more than one active operation", async () => {
		await withArchive(async (archiveDir) => {
			await writeInitialIntent({ ...baseIntent({ operationId: randomUUID() }), archiveDir })
			await writeInitialIntent({ ...baseIntent({ operationId: randomUUID() }), archiveDir })
			// Two active operation dirs -> ambiguous -> fail closed.
			await rejects(async () => readActiveOperation(archiveDir), /multiple active/)
		})
	})

	it("readActiveOperation fails closed on an unrecognized active entry", async () => {
		await withArchive(async (archiveDir) => {
			// A non-conforming entry (not archive-<uuid>) is unrecognized debris.
			mkdirSync(join(activeOperationsRoot(archiveDir), "junk"), { recursive: true })
			await rejects(async () => readActiveOperation(archiveDir), /unrecognized/)
		})
	})

	it("archiveCompletedOperation moves the journal out of active/ and retains it", async () => {
		await withArchive(async (archiveDir) => {
			const op = randomUUID()
			await writeInitialIntent({ ...baseIntent({ operationId: op }), archiveDir })
			await archiveCompletedOperation(archiveDir, op)
			// No longer in active/.
			strictEqual(listActiveOperationIds(archiveDir).length, 0)
			// Retained under completed/.
			const completed = join(archiveDir, "operations", "completed", `archive-${op}`, "intent.json")
			ok(existsSync(completed), "completed journal retained")
		})
	})
})

describe("archive operation journal strict parsing (fail-closed)", () => {
	it("rejects an unknown format version", async () => {
		const raw = { ...baseIntent(), formatVersion: 99, phase: "intent" }
		await rejects(async () => parseArchiveOperationIntent("/archive", raw), /format version/)
	})

	it("rejects an invalid phase", async () => {
		const raw: Record<string, unknown> = {
			...baseIntent(),
			formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
			phase: "nope",
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		}
		await rejects(async () => parseArchiveOperationIntent("/archive", raw), /invalid.*phase/)
	})

	it("rejects a malformed/missing identity", async () => {
		const raw: Record<string, unknown> = {
			formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
			phase: "intent",
			// missing operationId, generationId, etc.
		}
		await rejects(async () => parseArchiveOperationIntent("/archive", raw), /operationId/)
	})

	it("rejects a scratchSubdir containing a path separator (escape attempt)", async () => {
		const intent = baseIntent()
		const raw: ArchiveOperationIntent = {
			formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
			operationId: intent.operationId,
			generationId: intent.generationId,
			signal: intent.signal,
			rangeStart: intent.rangeStart,
			checkpointId: intent.checkpointId,
			archiveDir: "/archive",
			dataDir: intent.dataDir,
			scratchRoot: intent.scratchRoot,
			pinId: intent.pinId,
			pinPurpose: intent.pinPurpose,
			scratchSubdir: "../escape",
			manifestSha256: null,
			baseActiveGenerationId: null,
			phase: "intent",
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		}
		await rejects(async () => parseArchiveOperationIntent("/archive", raw), /scratch subdir/)
	})

	it("readActiveOperation fails closed when the intent operationId mismatches its directory", async () => {
		await withArchive(async (archiveDir) => {
			const op = randomUUID()
			await writeInitialIntent({ ...baseIntent({ operationId: op }), archiveDir })
			// Corrupt: rename the dir to a different operation id while leaving the
			// intent recording the original. Identity binding must catch this.
			const other = randomUUID()
			const fs = await import("node:fs/promises")
			await fs.rename(operationDir(archiveDir, op), operationDir(archiveDir, other))
			await rejects(async () => readActiveOperation(archiveDir), /identity mismatch/)
		})
	})

	it("readActiveOperation fails closed on a hand-edited malformed intent file", async () => {
		await withArchive(async (archiveDir) => {
			const op = randomUUID()
			await writeInitialIntent({ ...baseIntent({ operationId: op }), archiveDir })
			// Overwrite the intent with garbage.
			writeFileSync(join(operationDir(archiveDir, op), "intent.json"), "{not json")
			await rejects(async () => readActiveOperation(archiveDir))
		})
	})

	it("reconciliation rejects altered configured roots without touching outside state", async () => {
		await withArchive(async (archiveDir) => {
			const root = join(archiveDir, "..")
			const dataDir = join(root, "data")
			const scratchRoot = join(root, "scratch")
			const outside = join(root, "outside")
			const marker = join(outside, "KEEP")
			mkdirSync(dataDir, { recursive: true })
			mkdirSync(scratchRoot, { recursive: true })
			mkdirSync(outside, { recursive: true })
			writeFileSync(marker, "preserve")
			const op = randomUUID()
			await writeInitialIntent({
				...baseIntent({ operationId: op }),
				archiveDir,
				dataDir,
				scratchRoot,
			})
			const path = join(operationDir(archiveDir, op), "intent.json")
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
			writeFileSync(path, `${JSON.stringify({ ...raw, scratchRoot: outside })}\n`)
			await rejects(
				reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot),
				/scratch root mismatch/,
			)
			strictEqual(readFileSync(marker, "utf8"), "preserve")
			ok(existsSync(path), "active journal retained on root mismatch")
		})
	})

	it("reconciliation refuses a symlinked owned scratch directory and preserves its target", async () => {
		await withArchive(async (archiveDir) => {
			const root = join(archiveDir, "..")
			const dataDir = join(root, "data")
			const scratchRoot = join(root, "scratch")
			const outside = join(root, "outside")
			const marker = join(outside, "KEEP")
			mkdirSync(dataDir, { recursive: true })
			mkdirSync(scratchRoot, { recursive: true })
			mkdirSync(outside, { recursive: true })
			writeFileSync(marker, "preserve")
			const op = randomUUID()
			await writeInitialIntent({
				...baseIntent({ operationId: op }),
				archiveDir,
				dataDir,
				scratchRoot,
			})
			symlinkSync(outside, join(scratchRoot, `archive-${op}`))
			await rejects(
				reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot),
				/refusing symlink in owned scratch/,
			)
			strictEqual(readFileSync(marker, "utf8"), "preserve")
			ok(readActiveOperation(archiveDir) !== null, "active journal retained")
		})
	})

	it("reconciliation refuses a symlinked configured root and preserves its target", async () => {
		await withArchive(async (archiveDir) => {
			const root = join(archiveDir, "..")
			const dataDir = join(root, "data")
			const realScratch = join(root, "real-scratch")
			const scratchRoot = join(root, "scratch-link")
			const marker = join(realScratch, "KEEP")
			mkdirSync(dataDir, { recursive: true })
			mkdirSync(realScratch, { recursive: true })
			writeFileSync(marker, "preserve")
			symlinkSync(realScratch, scratchRoot)
			const op = randomUUID()
			await writeInitialIntent({
				...baseIntent({ operationId: op }),
				archiveDir,
				dataDir,
				scratchRoot,
			})
			await rejects(
				reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot),
				/refusing symlink in scratch root/,
			)
			strictEqual(readFileSync(marker, "utf8"), "preserve")
			ok(readActiveOperation(archiveDir) !== null)
		})
	})

	it("strictly binds known signal and deterministic identities", async () => {
		const base = baseIntent()
		const raw = {
			...base,
			formatVersion: ARCHIVE_OPERATION_FORMAT_VERSION,
			archiveDir: "/archive",
			phase: "intent",
			manifestSha256: null,
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		}
		await rejects(
			async () => parseArchiveOperationIntent("/archive", { ...raw, signal: "unknown" }),
			/unknown archive signal/,
		)
		await rejects(
			async () => parseArchiveOperationIntent("/archive", { ...raw, pinPurpose: "archive:other" }),
			/pin purpose/,
		)
		await rejects(
			async () => parseArchiveOperationIntent("/archive", { ...raw, scratchSubdir: "archive-other" }),
			/scratch subdir/,
		)
	})

	it("reconciliation rejects a mismatched pin purpose and premature pin absence", async () => {
		await withArchive(async (archiveDir) => {
			const root = join(archiveDir, "..")
			const dataDir = join(root, "data")
			const scratchRoot = join(root, "scratch")
			mkdirSync(dataDir, { recursive: true })
			mkdirSync(scratchRoot, { recursive: true })
			const op = randomUUID()
			const initial = { ...baseIntent({ operationId: op }), archiveDir, dataDir, scratchRoot }
			await writeInitialIntent(initial)
			const pinPath = join(checkpointPinsRoot(dataDir), initial.checkpointId, `${initial.pinId}.json`)
			mkdirSync(join(pinPath, ".."), { recursive: true })
			writeFileSync(
				pinPath,
				`${JSON.stringify({
					formatVersion: 1,
					pinId: initial.pinId,
					checkpointId: initial.checkpointId,
					purpose: "archive:attacker",
					createdAt: new Date().toISOString(),
				})}\n`,
			)
			await rejects(
				reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot),
				/pin identity or purpose mismatch/,
			)
			rmSync(pinPath)
			await advancePhase(archiveDir, op, "pin-acquired")
			await rejects(
				reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot),
				/pin is missing before release was authorized/,
			)
			ok(readActiveOperation(archiveDir) !== null)
		})
	})
})
