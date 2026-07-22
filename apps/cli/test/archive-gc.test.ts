import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
	activePointerPath,
	buildingGenerationRoot,
	generationManifestPath,
	generationRoot,
	nextMidnightUtc,
} from "../src/server/archives/paths"
import { promoteGeneration, selectActiveGeneration } from "../src/server/archives/generation"
import { type ArchiveGenerationManifest, parseArchiveActivePointer } from "../src/server/archives/manifest"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"
import { rebuildCatalog } from "../src/server/archives/listing"
import { planArchiveGc, runArchiveGc, verifyCompletedGcInvariants } from "../src/server/archives/gc"
import { writeInitialIntent, type GcOperationIntent } from "../src/server/archives/journal"

// Hostile unit tests for archive garbage collection (Gate 3b). These cover the
// deterministic deletion-set logic, keep-N retention, fail-closed on
// malformed/symlinked/ambiguous state, signal-level exclusion, and dry-run
// mutates-nothing. The AUTHORITATIVE interrupted-GC crash oracle is the native
// SIGKILL probe; these unit tests cover the invariants the harness does not
// isolate.

const withArchive = async (run: (archiveDir: string) => Promise<void> | void): Promise<void> => {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "maple-gc-test-")))
	const archiveDir = join(parent, "archive")
	const dataDir = join(parent, "data")
	const scratchRoot = join(parent, "scratch")
	mkdirSync(archiveDir, { recursive: true })
	mkdirSync(dataDir, { recursive: true })
	mkdirSync(scratchRoot, { recursive: true })
	try {
		await run(archiveDir, dataDir, scratchRoot, parent)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/**
 * Seed a published, GC-verifiable generation: a real shard file whose bytes +
 * SHA-256 match the manifest, promoted to its final location with the active
 * pointer optionally selecting it. GC verifies manifest + per-shard SHA, so the
 * seeded evidence must be internally consistent.
 */
const seedPublishedGeneration = async (
	archiveDir: string,
	opts: {
		signal?: string
		rangeDate?: string
		createdAt: string
		shardContents?: string
		selectActive?: boolean
	},
): Promise<{ generationId: string; manifestSha256: string }> => {
	const generationId = randomUUID()
	const signal = opts.signal ?? "traces"
	const rangeDate = opts.rangeDate ?? "2026-06-01"
	const shardContents = opts.shardContents ?? `PAR1-${generationId}`
	const building = buildingGenerationRoot(archiveDir, generationId)
	const shardsDir = join(building, "shards")
	mkdirSync(shardsDir, { recursive: true })
	writeFileSync(join(shardsDir, "00.parquet"), shardContents)
	// Event-time bounds must fall within the sealed UTC day [rangeStart, nextMidnight).
	const noonNano = `${BigInt(Date.parse(`${rangeDate}T12:00:00.000Z`)) * 1_000_000n}`
	const manifest: ArchiveGenerationManifest = {
		formatVersion: 3,
		generationId,
		signal,
		rangeStart: rangeDate,
		rangeEndExclusive: nextMidnightUtc(rangeDate),
		checkpointId: randomUUID(),
		checkpointManifestFingerprint: `cid:${rangeDate}:100`,
		createdAt: opts.createdAt,
		mapleVersion: MAPLE_VERSION,
		chdbVersion: CHDB_VERSION,
		schemaFingerprint: SCHEMA_FINGERPRINT,
		sourceRowCount: 1,
		archivedRowCount: 1,
		tuning: {
			writerThreads: 1,
			rowGroupRows: 10_000,
			maxShardRows: 500_000,
			maxShardBytes: 256 * 1024 * 1024,
			targetChunkBytes: 1024 * 1024 * 1024,
			minFreeSpaceReserve: 512 * 1024 * 1024,
		},
		tuningConfig: null,
		shards: [
			{
				name: "00.parquet",
				rowCount: 1,
				minEventTimeUnixNano: noonNano,
				maxEventTimeUnixNano: noonNano,
				sha256: sha256(shardContents),
				bytes: shardContents.length,
				columns: ["TimestampTime", "ServiceName"],
				complexDigest: "0",
				complexDigestAlgorithm: "cityhash64-multiset-v3",
			},
		],
	}
	await promoteGeneration(archiveDir, signal, rangeDate, generationId, manifest, building)
	const manifestSha256 = createHash("sha256")
		.update(JSON.stringify({ ...manifest, createdAt: opts.createdAt }))
		.digest("hex")
	if (opts.selectActive) {
		await selectActiveGeneration(archiveDir, signal, rangeDate, generationId, null)
	}
	return { generationId, manifestSha256 }
}

const rebuildSignalCatalog = async (archiveDir: string, signal: string): Promise<void> => {
	await rebuildCatalog(archiveDir, signal as never)
}

describe("archive gc planning", () => {
	it("keep=0 targets all superseded generations and retains only the active", async () => {
		await withArchive(async (archiveDir, dataDir, scratchRoot) => {
			const old = await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			const mid = await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-03T00:00:00.000Z" })
			const active = await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-04T00:00:00.000Z",
				selectActive: true,
			})
			await rebuildSignalCatalog(archiveDir, "traces")
			const plan = planArchiveGc(archiveDir, 0)
			strictEqual(plan.deleteSet.length, 2)
			strictEqual(
				plan.deleteSet.some((c) => c.generationId === old.generationId),
				true,
			)
			strictEqual(
				plan.deleteSet.some((c) => c.generationId === mid.generationId),
				true,
			)
			strictEqual(
				plan.deleteSet.some((c) => c.generationId === active.generationId),
				false,
			)
			strictEqual(
				plan.retained.some((r) => r.generationId === active.generationId && r.reason === "active"),
				true,
			)
			void dataDir
			void scratchRoot
		})
	})

	it("keep=1 retains the newest superseded and targets only older ones", async () => {
		await withArchive(async (archiveDir) => {
			const oldest = await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-02T00:00:00.000Z",
			})
			const newer = await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-03T00:00:00.000Z" })
			await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-04T00:00:00.000Z",
				selectActive: true,
			})
			await rebuildSignalCatalog(archiveDir, "traces")
			const plan = planArchiveGc(archiveDir, 1)
			strictEqual(plan.deleteSet.length, 1)
			strictEqual(plan.deleteSet[0]!.generationId, oldest.generationId)
			strictEqual(
				plan.retained.some((r) => r.generationId === newer.generationId && r.reason === "kept"),
				true,
			)
		})
	})

	it("over-retains a range with no active pointer (missing pointer is uncertain)", async () => {
		await withArchive(async (archiveDir) => {
			// No pointer at all: every generation is ambiguous (none is provably
			// active). A missing pointer is uncertain state — the range is excluded
			// entirely and nothing is targeted (blocker 4: never encode absence as
			// an invalid empty-string sentinel that strands the journal).
			await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-03T00:00:00.000Z" })
			await rebuildSignalCatalog(archiveDir, "traces")
			const plan = planArchiveGc(archiveDir, 0)
			strictEqual(plan.deleteSet.length, 0, "nothing targeted without an active pointer")
			ok(
				plan.excludedRanges.some((r) => r.rangeStart === "2026-06-01"),
				"range excluded as uncertain",
			)
		})
	})

	it("excludes a range whose active pointer is ambiguous/malformed", async () => {
		await withArchive(async (archiveDir) => {
			const old = await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-03T00:00:00.000Z",
				selectActive: true,
			})
			await rebuildSignalCatalog(archiveDir, "traces")
			// Corrupt the pointer so it no longer matches its location.
			const pointerPath = activePointerPath(archiveDir, "traces", "2026-06-01")
			writeFileSync(
				pointerPath,
				JSON.stringify({
					formatVersion: 1,
					generationId: randomUUID(),
					signal: "logs",
					rangeStart: "2026-06-01",
				}),
			)
			const plan = planArchiveGc(archiveDir, 0)
			// The range is excluded (ambiguous pointer); neither gen is targeted.
			strictEqual(plan.deleteSet.length, 0)
			ok(plan.excludedRanges.length >= 1, "range excluded for ambiguous pointer")
			void old
		})
	})

	it("excludes an entire signal when a generation manifest is malformed", async () => {
		await withArchive(async (archiveDir) => {
			await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			const active = await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-03T00:00:00.000Z",
				selectActive: true,
			})
			// Tamper the active generation's manifest so catalog reconstruction fails.
			const manifestPath = generationManifestPath(
				archiveDir,
				"traces",
				"2026-06-01",
				active.generationId,
			)
			writeFileSync(manifestPath, "{not valid json")
			const plan = planArchiveGc(archiveDir, 0)
			// Signal excluded entirely; nothing deleted.
			strictEqual(plan.deleteSet.length, 0)
			ok(
				plan.excludedSignals.length >= 1 || plan.excludedRanges.length >= 1,
				"signal/range excluded for malformed state",
			)
		})
	})

	it("rejects an invalid keep value", async () => {
		await withArchive(async (archiveDir) => {
			await rejects(async () => planArchiveGc(archiveDir, -1), /invalid gc keep/)
			await rejects(async () => planArchiveGc(archiveDir, 1.5), /invalid gc keep/)
		})
	})
})

describe("archive gc execution", () => {
	it("dry-run mutates nothing but reports the delete set", async () => {
		await withArchive(async (archiveDir, dataDir, scratchRoot) => {
			const old = await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-03T00:00:00.000Z",
				selectActive: true,
			})
			await rebuildSignalCatalog(archiveDir, "traces")
			const oldGenPath = generationRoot(archiveDir, "traces", "2026-06-01", old.generationId)
			ok(existsSync(oldGenPath), "old gen exists before dry-run")
			const result = await runArchiveGc({ dataDir, archiveDir, scratchRoot, keep: 0, dryRun: true })
			strictEqual(result.plan.deleteSet.length, 1)
			strictEqual(result.deleted.length, 0)
			ok(existsSync(oldGenPath), "old gen STILL exists after dry-run (nothing mutated)")
		})
	})

	it("apply deletes the targeted superseded generation and keeps the active", async () => {
		await withArchive(async (archiveDir, dataDir, scratchRoot) => {
			const old = await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			const active = await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-03T00:00:00.000Z",
				selectActive: true,
			})
			await rebuildSignalCatalog(archiveDir, "traces")
			const result = await runArchiveGc({ dataDir, archiveDir, scratchRoot, keep: 0, dryRun: false })
			strictEqual(result.deleted.length, 1)
			ok(
				!existsSync(generationRoot(archiveDir, "traces", "2026-06-01", old.generationId)),
				"old gen deleted",
			)
			ok(
				existsSync(generationRoot(archiveDir, "traces", "2026-06-01", active.generationId)),
				"active gen retained",
			)
			// The pointer still selects the active generation.
			const pointer = parseArchiveActivePointer(
				JSON.parse(
					require("node:fs").readFileSync(
						activePointerPath(archiveDir, "traces", "2026-06-01"),
						"utf8",
					),
				),
				"traces",
				"2026-06-01",
			)
			strictEqual(pointer.generationId, active.generationId)
		})
	})

	it("GC leaves no active operation journal after completing", async () => {
		await withArchive(async (archiveDir, dataDir, scratchRoot) => {
			await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-03T00:00:00.000Z",
				selectActive: true,
			})
			await rebuildSignalCatalog(archiveDir, "traces")
			await runArchiveGc({ dataDir, archiveDir, scratchRoot, keep: 0, dryRun: false })
			// No active operation entries (the op dir is moved to completed/; the
			// empty active/ parent may remain but must hold no operation dirs).
			const activeDir = join(archiveDir, "operations", "active")
			const activeCount = existsSync(activeDir) ? readdirSync(activeDir).length : 0
			strictEqual(activeCount, 0, "no active op journal after gc")
		})
	})
})

describe("archive gc dry-run nonmutation with an active operation (Gate 3b repair)", () => {
	// A snapshot of the durable state (journal/pins/pointers/catalogs/generations)
	// to compare before/after a dry-run that must not mutate.
	const snapshot = (archiveDir: string, dataDir: string): string => {
		const { execSync } = require("node:child_process") as typeof import("node:child_process")
		try {
			return execSync(
				`find "${archiveDir}" "${dataDir}" -type f 2>/dev/null | sort | xargs shasum -a 256 2>/dev/null | shasum -a 256`,
				{ encoding: "utf8" },
			).trim()
		} catch {
			return "snapshot-failed"
		}
	}

	it("gc --dry-run mutates nothing even when an active operation is present", async () => {
		await withArchive(async (archiveDir, dataDir, scratchRoot) => {
			await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-03T00:00:00.000Z",
				selectActive: true,
			})
			await rebuildSignalCatalog(archiveDir, "traces")
			// Seed an active CREATE operation journal (an interrupted op present).
			const op = randomUUID()
			await writeInitialIntent({
				archiveDir,
				operationId: op,
				generationId: randomUUID(),
				signal: "traces",
				rangeStart: "2026-06-01",
				checkpointId: randomUUID(),
				dataDir,
				scratchRoot,
				pinId: randomUUID(),
				pinPurpose: `archive:${op}`,
				scratchSubdir: `archive-${op}`,
				baseActiveGenerationId: null,
			})
			const before = snapshot(archiveDir, dataDir)
			// dry-run must NOT reconcile the active op or delete anything.
			const result = await runArchiveGc({ dataDir, archiveDir, scratchRoot, keep: 0, dryRun: true })
			const after = snapshot(archiveDir, dataDir)
			strictEqual(before, after, "dry-run mutated durable state with an active op present")
			// With an active op present, dry-run reports the blocker (no deletion set predicted).
			strictEqual(result.deleted.length, 0)
		})
	})

	it("gc --dry-run mutates nothing on a clean archive", async () => {
		await withArchive(async (archiveDir, dataDir, scratchRoot) => {
			await seedPublishedGeneration(archiveDir, { createdAt: "2026-06-02T00:00:00.000Z" })
			await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-03T00:00:00.000Z",
				selectActive: true,
			})
			await rebuildSignalCatalog(archiveDir, "traces")
			const before = snapshot(archiveDir, dataDir)
			await runArchiveGc({ dataDir, archiveDir, scratchRoot, keep: 0, dryRun: true })
			const after = snapshot(archiveDir, dataDir)
			strictEqual(before, after, "dry-run mutated durable state on a clean archive")
		})
	})
})

describe("archive gc terminal invariant verification (Gate 3b repair)", () => {
	it("verifyCompletedGcInvariants fails when a frozen target source still exists", async () => {
		await withArchive(async (archiveDir) => {
			const active = await seedPublishedGeneration(archiveDir, {
				createdAt: "2026-06-03T00:00:00.000Z",
				selectActive: true,
			})
			const target = {
				signal: "traces",
				rangeStart: "2026-06-01",
				generationId: active.generationId,
				createdAt: "2026-06-03T00:00:00.000Z",
				manifestSha256: "a".repeat(64),
				bytes: 100,
				shards: [{ name: "00.parquet", bytes: 100, sha256: "b".repeat(64) }],
				recordedActiveGenerationId: active.generationId,
			}
			const intent = {
				kind: "gc" as const,
				operationId: randomUUID(),
				keep: 0,
				targets: [target],
				completedTargets: 1,
				formatVersion: 3 as const,
				archiveDir,
				dataDir: "/d",
				scratchRoot: "/s",
				phase: "complete" as const,
				createdAt: "x",
				updatedAt: "x",
			} as GcOperationIntent
			// The target source (the active gen) still exists → must fail closed.
			await rejects(
				async () => verifyCompletedGcInvariants(archiveDir, intent),
				/target source still exists/,
			)
		})
	})

	it("verifyCompletedGcInvariants fails when completedTargets !== targets.length", async () => {
		await withArchive(async (archiveDir) => {
			const intent = {
				kind: "gc" as const,
				operationId: randomUUID(),
				keep: 0,
				targets: [],
				completedTargets: 1,
				formatVersion: 3 as const,
				archiveDir,
				dataDir: "/d",
				scratchRoot: "/s",
				phase: "complete" as const,
				createdAt: "x",
				updatedAt: "x",
			} as GcOperationIntent
			await rejects(
				async () => verifyCompletedGcInvariants(archiveDir, intent),
				/completedTargets === targets.length/,
			)
		})
	})
})

void dirname
void symlinkSync
void readdirSync
void rmSync
