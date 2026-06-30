import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runArchiveReconciliation } from "../src/server/archives/generation"
import type { ReconciliationDecision } from "../src/server/archives/reconcile"

const withRoots = async (
	run: (archiveDir: string, dataDir: string, scratchRoot: string) => Promise<void> | void,
): Promise<void> => {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "maple-reconcile-test-")))
	const archiveDir = join(parent, "archive")
	const dataDir = join(parent, "data")
	const scratchRoot = join(parent, "scratch")
	for (const d of [archiveDir, dataDir, scratchRoot]) mkdirSync(d, { recursive: true })
	try {
		await run(archiveDir, dataDir, scratchRoot)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}
const writeActiveIntent = (
	archiveDir: string,
	operationId: string,
	record: Record<string, unknown>,
): void => {
	const dir = join(archiveDir, "operations", "active", `archive-${operationId}`)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, "intent.json"), JSON.stringify(record))
}
const validV2 = (archiveDir: string, dataDir: string, scratchRoot: string) => {
	const operationId = randomUUID()
	const generationId = randomUUID()
	return {
		operationId,
		record: {
			formatVersion: 2,
			operationId,
			generationId,
			signal: "traces",
			rangeStart: "2026-06-01",
			checkpointId: randomUUID(),
			archiveDir,
			dataDir,
			scratchRoot,
			pinId: randomUUID(),
			pinPurpose: `archive:${generationId}`,
			scratchSubdir: `archive-${operationId}`,
			manifestSha256: null,
			baseActiveGenerationId: null,
			phase: "intent",
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		},
	}
}
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")
const isFailClosed = (
	d: ReconciliationDecision,
): d is Extract<ReconciliationDecision, { kind: "FailClosed" }> => d.kind === "FailClosed"

describe("archive reconciliation protocol (Gate 3b r5)", () => {
	it("dry-run treats a valid v2 intent as a decision with migrationRequired", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const { operationId, record } = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, operationId, record)
			const d = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			if (d.kind !== "CreateAbortPrepublication")
				ok(false, `expected CreateAbortPrepublication, got ${d.kind}`)
			if (d.kind === "CreateAbortPrepublication") strictEqual(d.migrationRequired, true)
		})
	})
	it("dry-run marks a malformed v3 intent FailClosed", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			writeActiveIntent(archiveDir, randomUUID(), {
				formatVersion: 3,
				kind: "create",
				operationId: randomUUID(),
				phase: "bogus-phase",
			})
			ok(
				isFailClosed(
					await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true }),
				),
			)
		})
	})
	it("dry-run marks unknown active-dir debris FailClosed", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			mkdirSync(join(archiveDir, "operations", "active", "junk-debris"), { recursive: true })
			ok(
				isFailClosed(
					await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true }),
				),
			)
		})
	})
	it("dry-run marks multiple active operations FailClosed", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const a = validV2(archiveDir, dataDir, scratchRoot),
				b = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, a.operationId, a.record)
			writeActiveIntent(archiveDir, b.operationId, b.record)
			ok(
				isFailClosed(
					await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true }),
				),
			)
		})
	})
	it("dry-run marks a corrupt v2 intent FailClosed", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			writeActiveIntent(archiveDir, randomUUID(), { formatVersion: 2 })
			ok(
				isFailClosed(
					await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true }),
				),
			)
		})
	})
	it("dry-run marks a v2 dir/record mismatch FailClosed and does NOT rewrite it", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const dirId = randomUUID()
			const rec = validV2(archiveDir, dataDir, scratchRoot)
			rec.record.operationId = randomUUID()
			rec.record.scratchSubdir = `archive-${rec.record.operationId}`
			rec.record.pinPurpose = `archive:${rec.record.generationId}`
			writeActiveIntent(archiveDir, dirId, rec.record)
			const intentPath = join(archiveDir, "operations", "active", `archive-${dirId}`, "intent.json")
			const before = sha(intentPath)
			ok(
				isFailClosed(
					await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true }),
				),
			)
			strictEqual(sha(intentPath), before, "dry-run must not rewrite mismatched v2")
		})
	})
	it("dry-run never mutates a valid v2 intent", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const { operationId, record } = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, operationId, record)
			const intentPath = join(
				archiveDir,
				"operations",
				"active",
				`archive-${operationId}`,
				"intent.json",
			)
			const before = sha(intentPath)
			await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			strictEqual(sha(intentPath), before, "dry-run mutated v2")
			strictEqual(JSON.parse(readFileSync(intentPath, "utf8")).formatVersion, 2)
		})
	})
	it("apply throws on FailClosed and preserves state", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			mkdirSync(join(archiveDir, "operations", "active", "junk-debris"), { recursive: true })
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/unsafe|FailClosed|debris|ambiguous/i,
			)
			ok(existsSync(join(archiveDir, "operations", "active", "junk-debris")))
		})
	})
	it("apply with no active operation returns NoOp", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			strictEqual(
				(await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false })).kind,
				"NoOp",
			)
		})
	})
	it("apply does not rewrite a v2 mismatch before rejecting it", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const dirId = randomUUID()
			const rec = validV2(archiveDir, dataDir, scratchRoot)
			rec.record.operationId = randomUUID()
			rec.record.scratchSubdir = `archive-${rec.record.operationId}`
			rec.record.pinPurpose = `archive:${rec.record.generationId}`
			writeActiveIntent(archiveDir, dirId, rec.record)
			const intentPath = join(archiveDir, "operations", "active", `archive-${dirId}`, "intent.json")
			const before = sha(intentPath)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/unsafe|identity mismatch/i,
			)
			strictEqual(sha(intentPath), before)
		})
	})
	it("dry-run on a symlinked intent is FailClosed; outside target survives", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const opId = randomUUID()
			const outside = join(archiveDir, "..", "outside-intent")
			mkdirSync(outside, { recursive: true })
			const { record } = validV2(archiveDir, dataDir, scratchRoot)
			record.operationId = opId
			record.scratchSubdir = `archive-${opId}`
			record.pinPurpose = `archive:${record.generationId}`
			writeFileSync(join(outside, "intent.json"), JSON.stringify(record))
			writeFileSync(join(outside, "SENTINEL"), "preserve")
			const dirOp = join(archiveDir, "operations", "active", `archive-${opId}`)
			mkdirSync(dirOp, { recursive: true })
			symlinkSync(join(outside, "intent.json"), join(dirOp, "intent.json"))
			ok(
				isFailClosed(
					await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true }),
				),
			)
			strictEqual(readFileSync(join(outside, "SENTINEL"), "utf8"), "preserve")
		})
	})
	it("apply on a symlinked intent is FailClosed; outside target survives", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const opId = randomUUID()
			const outside = join(archiveDir, "..", "outside-intent")
			mkdirSync(outside, { recursive: true })
			const { record } = validV2(archiveDir, dataDir, scratchRoot)
			record.operationId = opId
			record.scratchSubdir = `archive-${opId}`
			record.pinPurpose = `archive:${record.generationId}`
			writeFileSync(join(outside, "intent.json"), JSON.stringify(record))
			writeFileSync(join(outside, "SENTINEL"), "preserve")
			const dirOp = join(archiveDir, "operations", "active", `archive-${opId}`)
			mkdirSync(dirOp, { recursive: true })
			symlinkSync(join(outside, "intent.json"), join(dirOp, "intent.json"))
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/unsafe|unreadable|symlink/i,
			)
			strictEqual(readFileSync(join(outside, "SENTINEL"), "utf8"), "preserve")
		})
	})
	it("dry-run fails nonzero while a live owner holds the lock", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const { withMaintenanceLock } = await import("../src/server/checkpoints")
			const { record } = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, record.operationId as string, record)
			await withMaintenanceLock(dataDir, randomUUID(), async () => {
				await rejects(
					runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true }),
					/active|lock/i,
				)
			})
		})
	})
})
