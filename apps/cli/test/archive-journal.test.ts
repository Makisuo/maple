import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

const baseIntent = (overrides: Partial<{ operationId: string; generationId: string }> = {}) => ({
	archiveDir: "", // set by withArchive caller
	operationId: overrides.operationId ?? randomUUID(),
	generationId: overrides.generationId ?? randomUUID(),
	signal: "traces",
	rangeStart: "2026-06-01",
	checkpointId: randomUUID(),
	dataDir: "/data",
	scratchRoot: "/scratch",
	pinId: randomUUID(),
	pinPurpose: "archive:gen",
	scratchSubdir: `archive-${randomUUID()}`,
	baseActiveGenerationId: null,
})

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
})
