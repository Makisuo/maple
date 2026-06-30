import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planArchiveReconciliation, runArchiveReconciliation } from "../src/server/archives/generation"

// Tests for the explicit reconciliation wrapper (Gate 3b repair, round 3). The
// round-2 review found that v2 migration was treated as a blocker (so apply
// returned without migrating) and that malformed/ambiguous/debris state returned
// success instead of failing closed. These cover the locked-wrapper contract:
// v2 is an ACTION, fail-closed states throw, dry-run never mutates.

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

describe("archive reconciliation wrapper (Gate 3b repair)", () => {
	it("treats a valid v2 intent as a migration action, not a blocker", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const { operationId, record } = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, operationId, record)
			const plan = planArchiveReconciliation(archiveDir, dataDir, scratchRoot)
			strictEqual(plan.hasActiveOperation, true)
			strictEqual(plan.needsMigration, true)
			strictEqual(plan.failClosed, null)
			strictEqual(plan.kind, "create")
		})
	})

	it("marks a malformed v3 intent fail-closed (never success)", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			writeActiveIntent(archiveDir, randomUUID(), {
				formatVersion: 3,
				kind: "create",
				operationId: randomUUID(),
				phase: "bogus-phase",
			})
			const plan = planArchiveReconciliation(archiveDir, dataDir, scratchRoot)
			ok(plan.failClosed !== null, "malformed intent must be fail-closed")
			ok(/strict-invalid/.test(plan.failClosed), `unexpected reason: ${plan.failClosed}`)
		})
	})

	it("marks unknown active-dir debris fail-closed (never filtered to absence)", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			mkdirSync(join(archiveDir, "operations", "active", "junk-debris"), { recursive: true })
			const plan = planArchiveReconciliation(archiveDir, dataDir, scratchRoot)
			ok(plan.failClosed !== null, "debris must surface, not be filtered")
			ok(/debris/.test(plan.failClosed), `unexpected reason: ${plan.failClosed}`)
		})
	})

	it("marks multiple active operations fail-closed", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const a = validV2(archiveDir, dataDir, scratchRoot)
			const b = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, a.operationId, a.record)
			writeActiveIntent(archiveDir, b.operationId, b.record)
			const plan = planArchiveReconciliation(archiveDir, dataDir, scratchRoot)
			ok(plan.failClosed !== null, "multiple active ops must be fail-closed")
			ok(/ambiguous/.test(plan.failClosed), `unexpected reason: ${plan.failClosed}`)
		})
	})

	it("marks a corrupt v2 intent fail-closed (will not migrate)", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			// A v2 record missing required fields → migrateV2CreateIntent throws.
			writeActiveIntent(archiveDir, randomUUID(), { formatVersion: 2 })
			const plan = planArchiveReconciliation(archiveDir, dataDir, scratchRoot)
			ok(plan.failClosed !== null, "corrupt v2 must be fail-closed")
			ok(/corrupt/.test(plan.failClosed), `unexpected reason: ${plan.failClosed}`)
		})
	})

	it("dry-run never mutates, even with a valid v2 intent present", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const { operationId, record } = validV2(archiveDir, dataDir, scratchRoot)
			writeActiveIntent(archiveDir, operationId, record)
			// Snapshot the active intent file.
			const intentPath = join(
				archiveDir,
				"operations",
				"active",
				`archive-${operationId}`,
				"intent.json",
			)
			const before = require("node:crypto")
				.createHash("sha256")
				.update(require("node:fs").readFileSync(intentPath))
				.digest("hex")
			await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: true })
			const after = require("node:crypto")
				.createHash("sha256")
				.update(require("node:fs").readFileSync(intentPath))
				.digest("hex")
			strictEqual(before, after, "dry-run mutated the v2 intent (should not migrate)")
			// The v2 record is still v2 (not migrated by dry-run).
			const onDisk = JSON.parse(require("node:fs").readFileSync(intentPath, "utf8"))
			strictEqual(onDisk.formatVersion, 2, "dry-run must not migrate v2")
		})
	})

	it("apply throws on a fail-closed plan (never reports success for unsafe state)", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			mkdirSync(join(archiveDir, "operations", "active", "junk-debris"), { recursive: true })
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/refusing to reconcile unsafe archive state/,
			)
			// State preserved.
			ok(
				existsSync(join(archiveDir, "operations", "active", "junk-debris")),
				"debris preserved after failed apply",
			)
		})
	})

	it("apply with no active operation is a no-op success (not an error)", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const plan = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false })
			strictEqual(plan.hasActiveOperation, false)
		})
	})
})
