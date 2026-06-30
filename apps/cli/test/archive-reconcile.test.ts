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
import type { ReconciliationPlan } from "../src/server/archives/journal"

// Tests for the explicit reconciliation protocol (Gate 3b r4). The protocol is
// one locked inspector → discriminated-union plan of concrete actions → apply
// executes that plan. These cover: v2 is a migration action (not a blocker);
// malformed/ambiguous/debris/corrupt-v2/mismatch/symlink states are fail-closed
// (never success, never mutated before rejection); dry-run never mutates.

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

const validV2 = (
	archiveDir: string,
	dataDir: string,
	scratchRoot: string,
): { operationId: string; record: Record<string, unknown> } => {
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
const isFailClosed = (p: ReconciliationPlan): p is Extract<ReconciliationPlan, { kind: "fail-closed" }> =>
	p.kind === "fail-closed"

describe("archive reconciliation protocol (Gate 3b r4)", () => {
	it("dry-run treats a valid v2 intent as a create plan with a migrate-v2 action", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const { operationId, record } = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, operationId, record)
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			strictEqual(plan.kind, "create")
			if (plan.kind === "create") {
				strictEqual(plan.operationId, operationId)
				ok(
					plan.actions.some((a) => a.type === "migrate-v2"),
					"plan must include a migrate-v2 action",
				)
			}
		})
	})

	it("dry-run marks a malformed v3 intent fail-closed", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			writeActiveIntent(archiveDir, randomUUID(), {
				formatVersion: 3,
				kind: "create",
				operationId: randomUUID(),
				phase: "bogus-phase",
			})
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			ok(isFailClosed(plan), "malformed intent must be fail-closed")
			ok(/strict-invalid|invalid/.test(plan.reason), `unexpected reason: ${plan.reason}`)
		})
	})

	it("dry-run marks unknown active-dir debris fail-closed (never filtered to absence)", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			mkdirSync(join(archiveDir, "operations", "active", "junk-debris"), { recursive: true })
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			ok(isFailClosed(plan), "debris must surface, not be filtered")
			ok(/debris|unsafe/.test(plan.reason), `unexpected reason: ${plan.reason}`)
		})
	})

	it("dry-run marks multiple active operations fail-closed", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const a = validV2(archiveDir, dataDir, scratchRoot)
			const b = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, a.operationId, a.record)
			writeActiveIntent(archiveDir, b.operationId, b.record)
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			ok(isFailClosed(plan), "multiple active ops must be fail-closed")
			ok(/ambiguous/.test(plan.reason), `unexpected reason: ${plan.reason}`)
		})
	})

	it("dry-run marks a corrupt v2 intent fail-closed (will not migrate)", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			writeActiveIntent(archiveDir, randomUUID(), { formatVersion: 2 })
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			ok(isFailClosed(plan), "corrupt v2 must be fail-closed")
			ok(/corrupt|will not migrate/.test(plan.reason), `unexpected reason: ${plan.reason}`)
		})
	})

	it("dry-run marks a v2 dir/record operation-ID mismatch fail-closed and does NOT rewrite it", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			// A v2 record whose operationId differs from its directory name.
			const dirId = randomUUID()
			const otherId = randomUUID()
			const rec = validV2(archiveDir, dataDir, scratchRoot)
			rec.record.operationId = otherId // mismatch with directory `archive-${dirId}`
			rec.record.scratchSubdir = `archive-${otherId}`
			rec.record.pinPurpose = `archive:${rec.record.generationId}`
			writeActiveIntent(archiveDir, dirId, rec.record)
			const intentPath = join(archiveDir, "operations", "active", `archive-${dirId}`, "intent.json")
			const before = sha(intentPath)
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			ok(isFailClosed(plan), "mismatch must be fail-closed")
			ok(/identity mismatch/.test(plan.reason), `unexpected reason: ${plan.reason}`)
			strictEqual(sha(intentPath), before, "dry-run must not rewrite a mismatched v2 intent")
		})
	})

	it("dry-run never mutates a valid v2 intent (no migration)", async () => {
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
			strictEqual(sha(intentPath), before, "dry-run mutated the v2 intent")
			strictEqual(
				JSON.parse(readFileSync(intentPath, "utf8")).formatVersion,
				2,
				"dry-run must not migrate v2",
			)
		})
	})

	it("apply throws on a fail-closed plan and preserves state", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			mkdirSync(join(archiveDir, "operations", "active", "junk-debris"), { recursive: true })
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/unsafe|fail-closed|debris|ambiguous/i,
			)
			ok(
				existsSync(join(archiveDir, "operations", "active", "junk-debris")),
				"debris preserved after failed apply",
			)
		})
	})

	it("apply with no active operation is a no-op (returns no-op)", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false })
			strictEqual(plan.kind, "no-op")
		})
	})

	it("apply does not rewrite a v2 mismatch before rejecting it", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const dirId = randomUUID()
			const rec = validV2(archiveDir, dataDir, scratchRoot)
			rec.record.operationId = randomUUID() // mismatch
			rec.record.scratchSubdir = `archive-${rec.record.operationId}`
			rec.record.pinPurpose = `archive:${rec.record.generationId}`
			writeActiveIntent(archiveDir, dirId, rec.record)
			const intentPath = join(archiveDir, "operations", "active", `archive-${dirId}`, "intent.json")
			const before = sha(intentPath)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/unsafe|identity mismatch/i,
			)
			strictEqual(
				sha(intentPath),
				before,
				"apply must not rewrite a mismatched v2 intent before rejecting",
			)
		})
	})

	it("dry-run on a symlinked intent is fail-closed and does NOT read/replace the outside target", async () => {
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
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			ok(isFailClosed(plan), "symlinked intent must be fail-closed")
			// The outside SENTINEL survives (no outside read/replace).
			strictEqual(readFileSync(join(outside, "SENTINEL"), "utf8"), "preserve")
		})
	})

	it("apply on a symlinked intent is fail-closed and preserves the outside target", async () => {
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
			strictEqual(
				readFileSync(join(outside, "SENTINEL"), "utf8"),
				"preserve",
				"outside target preserved",
			)
		})
	})

	it("dry-run fails nonzero (throws) while a live owner holds the maintenance lock", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const { withMaintenanceLock } = await import("../src/server/checkpoints")
			// Hold the lock across the dry-run attempt. withMaintenanceLock runs the
			// inner task; inside it, attempt a dry-run reconcile, which must fail
			// because THIS process is the live lock owner.
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
