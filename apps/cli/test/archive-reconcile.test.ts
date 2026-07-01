import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { MAPLE_VERSION, CHDB_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
const durableStateSnapshot = (...roots: string[]): string => {
	const records: string[] = []
	const walk = (path: string, relativePath: string): void => {
		const info = lstatSync(path)
		if (info.isSymbolicLink()) {
			records.push(`link\0${relativePath}\0${readlinkSync(path)}`)
			return
		}
		if (info.isFile()) {
			records.push(`file\0${relativePath}\0${info.size}\0${sha(path)}`)
			return
		}
		if (!info.isDirectory()) {
			throw new Error(`unsupported snapshot entry type: ${path}`)
		}
		// Record every directory so empty-directory creation/removal is visible.
		records.push(`directory\0${relativePath}`)
		for (const name of readdirSync(path).sort()) {
			walk(join(path, name), `${relativePath}/${name}`)
		}
	}
	for (const [index, root] of roots.entries()) walk(root, `root-${index}`)
	return createHash("sha256").update(records.join("\n")).digest("hex")
}
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

describe("dry-run/apply parity — hostile preflight fixtures", () => {
	it("create post-promotion with a conflicting pointer: dry-run FailClosed, apply nonzero, zero mutation", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			// Seed a v3 create intent at "promoted" with a published generation + manifest,
			// but plant a pointer selecting a THIRD generation.
			const gid = randomUUID(),
				opId = randomUUID()
			const opDir = join(archiveDir, "operations", "active", `archive-${opId}`)
			mkdirSync(opDir, { recursive: true })
			const finalGen = join(archiveDir, "traces", "2026-06-01", "generations", gid)
			mkdirSync(join(finalGen, "shards"), { recursive: true })
			// Minimal valid manifest+shard for verifyPublishedGeneration to pass,
			// then assertPointerConsistent will fail (pointer selects a third gen).
			const shardContents = "PAR1"
			writeFileSync(join(finalGen, "shards", "00.parquet"), shardContents)
			const shardSha = createHash("sha256").update(shardContents).digest("hex")
			const manifest = {
				formatVersion: 3,
				generationId: gid,
				signal: "traces",
				rangeStart: "2026-06-01",
				rangeEndExclusive: "2026-06-02T00:00:00.000Z",
				checkpointId: randomUUID(),
				checkpointManifestFingerprint: "cid",
				createdAt: "2026-06-02T00:00:00.000Z",
				mapleVersion: MAPLE_VERSION,
				chdbVersion: CHDB_VERSION,
				schemaFingerprint: SCHEMA_FINGERPRINT,
				sourceRowCount: 1,
				archivedRowCount: 1,
				tuning: {
					writerThreads: 1,
					rowGroupRows: 10000,
					maxShardRows: 500000,
					maxShardBytes: 268435456,
					targetChunkBytes: 1073741824,
					minFreeSpaceReserve: 536870912,
				},
				tuningConfig: null,
				shards: [
					{
						name: "00.parquet",
						rowCount: 1,
						minEventTimeUnixNano: `${BigInt(Date.parse("2026-06-01T12:00:00.000Z")) * 1000000n}`,
						maxEventTimeUnixNano: `${BigInt(Date.parse("2026-06-01T12:00:00.000Z")) * 1000000n}`,
						sha256: shardSha,
						bytes: shardContents.length,
						columns: ["TimestampTime", "ServiceName"],
						complexDigest: "0",
						complexDigestAlgorithm: "cityhash64-multiset-v3",
					},
				],
			}
			const manifestJson = JSON.stringify(manifest)
			const manifestSha = createHash("sha256").update(manifestJson).digest("hex")
			writeFileSync(join(finalGen, "manifest.json"), manifestJson)
			// Plant a pointer selecting a THIRD generation (not the base, not the intended).
			const rangeDir = join(archiveDir, "traces", "2026-06-01")
			mkdirSync(rangeDir, { recursive: true })
			writeFileSync(
				join(rangeDir, "active.json"),
				JSON.stringify({
					formatVersion: 1,
					generationId: randomUUID(),
					signal: "traces",
					rangeStart: "2026-06-01",
				}),
			)
			// Create a valid pin so pin validation passes; the pointer CAS is the failure.
			const pinId = randomUUID(),
				checkpointId = randomUUID()
			const pinDir = join(dataDir, "backups", "pins", checkpointId)
			mkdirSync(pinDir, { recursive: true })
			writeFileSync(
				join(pinDir, `${pinId}.json`),
				JSON.stringify({
					formatVersion: 1,
					pinId,
					checkpointId,
					purpose: `archive:${gid}`,
					createdAt: "2026-06-01T00:00:00.000Z",
				}),
			)
			// Write a v3 intent at "promoted" with the manifest SHA.
			writeFileSync(
				join(opDir, "intent.json"),
				JSON.stringify({
					formatVersion: 3,
					kind: "create",
					operationId: opId,
					generationId: gid,
					signal: "traces",
					rangeStart: "2026-06-01",
					checkpointId,
					archiveDir,
					dataDir,
					scratchRoot,
					pinId,
					pinPurpose: `archive:${gid}`,
					scratchSubdir: `archive-${opId}`,
					manifestSha256: manifestSha,
					baseActiveGenerationId: null,
					phase: "promoted",
					createdAt: "2026-06-01T00:00:00.000Z",
					updatedAt: "2026-06-01T00:00:00.000Z",
				}),
			)
			// Dry-run: should return FailClosed (pointer CAS fails).
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(
				isFailClosed(dryDecision),
				`dry-run should be FailClosed for conflicting pointer, got ${dryDecision.kind}`,
			)
			// Apply: should throw (nonzero).
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/pointer|clobber|CAS|unsafe/i,
			)
			// State preserved (generation + journal still present).
			ok(existsSync(finalGen), "generation preserved after failed apply")
			ok(existsSync(opDir), "journal preserved after failed apply")
		})
	})
})

describe("dry-run/apply parity — GC multi-target hostile preflight", () => {
	const seedGcOperation = (
		archiveDir: string,
		dataDir: string,
		scratchRoot: string,
		targets: Array<{
			generationId: string
			signal: string
			rangeStart: string
			manifestSha256: string
			shardName: string
			shardSha: string
			shardBytes: number
			sourcePath: string
			recordedActive: string
		}>,
		completedTargets: number,
	) => {
		const opId = randomUUID()
		const opDir = join(archiveDir, "operations", "active", `archive-${opId}`)
		mkdirSync(opDir, { recursive: true })
		const gcTargets = targets.map((t) => ({
			signal: t.signal,
			rangeStart: t.rangeStart,
			generationId: t.generationId,
			createdAt: "2026-06-02T00:00:00.000Z",
			manifestSha256: t.manifestSha256,
			bytes: t.shardBytes,
			shards: [{ name: t.shardName, bytes: t.shardBytes, sha256: t.shardSha }],
			recordedActiveGenerationId: t.recordedActive,
		}))
		writeFileSync(
			join(opDir, "intent.json"),
			JSON.stringify({
				formatVersion: 3,
				kind: "gc",
				operationId: opId,
				keep: 0,
				targets: gcTargets,
				completedTargets,
				archiveDir,
				dataDir,
				scratchRoot,
				phase: completedTargets > 0 ? "gc-collecting" : "intent",
				createdAt: "2026-06-01T00:00:00.000Z",
				updatedAt: "2026-06-01T00:00:00.000Z",
			}),
		)
		return { opId, opDir }
	}

	const seedGeneration = (
		archiveDir: string,
		signal: string,
		rangeDate: string,
		generationId: string,
		shardContents: string,
	) => {
		const genDir = join(archiveDir, signal, rangeDate, "generations", generationId)
		mkdirSync(join(genDir, "shards"), { recursive: true })
		writeFileSync(join(genDir, "shards", "00.parquet"), shardContents)
		const shardSha = createHash("sha256").update(shardContents).digest("hex")
		const manifest = {
			formatVersion: 3,
			generationId,
			signal,
			rangeStart: rangeDate,
			rangeEndExclusive: `${rangeDate}T23:59:59.000000000Z`,
			checkpointId: randomUUID(),
			checkpointManifestFingerprint: "cid",
			createdAt: "2026-06-02T00:00:00.000Z",
			mapleVersion: MAPLE_VERSION,
			chdbVersion: CHDB_VERSION,
			schemaFingerprint: SCHEMA_FINGERPRINT,
			sourceRowCount: 1,
			archivedRowCount: 1,
			tuning: {
				writerThreads: 1,
				rowGroupRows: 10000,
				maxShardRows: 500000,
				maxShardBytes: 268435456,
				targetChunkBytes: 1073741824,
				minFreeSpaceReserve: 536870912,
			},
			tuningConfig: null,
			shards: [
				{
					name: "00.parquet",
					rowCount: 1,
					minEventTimeUnixNano: `${BigInt(Date.parse(`${rangeDate}T12:00:00.000Z`)) * 1000000n}`,
					maxEventTimeUnixNano: `${BigInt(Date.parse(`${rangeDate}T12:00:00.000Z`)) * 1000000n}`,
					sha256: shardSha,
					bytes: shardContents.length,
					columns: ["TimestampTime", "ServiceName"],
					complexDigest: "0",
					complexDigestAlgorithm: "cityhash64-multiset-v3",
				},
			],
		}
		const manifestJson = JSON.stringify(manifest)
		const manifestSha = createHash("sha256").update(manifestJson).digest("hex")
		writeFileSync(join(genDir, "manifest.json"), manifestJson)
		return { genDir, manifestSha, shardSha }
	}

	it("cursor-ahead (completedTargets=1 but target 0 source still exists): dry-run FailClosed, apply nonzero, zero mutation", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const gid1 = randomUUID(),
				gid2 = randomUUID(),
				activeGid = randomUUID()
			const ev1 = seedGeneration(archiveDir, "traces", "2026-06-01", gid1, "PAR1-old")
			const ev2 = seedGeneration(archiveDir, "traces", "2026-06-01", gid2, "PAR1-mid")
			seedGeneration(archiveDir, "traces", "2026-06-01", activeGid, "PAR1-active")
			// Plant active pointer.
			const rangeDir = join(archiveDir, "traces", "2026-06-01")
			writeFileSync(
				join(rangeDir, "active.json"),
				JSON.stringify({
					formatVersion: 1,
					generationId: activeGid,
					signal: "traces",
					rangeStart: "2026-06-01",
				}),
			)
			// Cursor=1 but target 0 (gid1) source still exists — impossible prefix.
			seedGcOperation(
				archiveDir,
				dataDir,
				scratchRoot,
				[
					{
						generationId: gid1,
						signal: "traces",
						rangeStart: "2026-06-01",
						manifestSha256: ev1.manifestSha,
						shardName: "00.parquet",
						shardSha: ev1.shardSha,
						shardBytes: 4,
						sourcePath: "",
						recordedActive: activeGid,
					},
					{
						generationId: gid2,
						signal: "traces",
						rangeStart: "2026-06-01",
						manifestSha256: ev2.manifestSha,
						shardName: "00.parquet",
						shardSha: ev2.shardSha,
						shardBytes: 7,
						sourcePath: "",
						recordedActive: activeGid,
					},
				],
				1,
			)
			const before = durableStateSnapshot(archiveDir, dataDir)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(
				isFailClosed(dryDecision),
				`dry-run should be FailClosed for cursor-ahead, got ${dryDecision.kind}`,
			)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/completed target still has source|unsafe/i,
			)
			const after = durableStateSnapshot(archiveDir, dataDir)
			strictEqual(before, after, "zero mutation on cursor-ahead preflight failure")
		})
	})

	it("source-absent/tombstone-present with symlinked tombstone: dry-run FailClosed, apply nonzero", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const gid1 = randomUUID(),
				activeGid = randomUUID()
			const ev1 = seedGeneration(archiveDir, "traces", "2026-06-01", gid1, "PAR1-old")
			seedGeneration(archiveDir, "traces", "2026-06-01", activeGid, "PAR1-active")
			const rangeDir = join(archiveDir, "traces", "2026-06-01")
			writeFileSync(
				join(rangeDir, "active.json"),
				JSON.stringify({
					formatVersion: 1,
					generationId: activeGid,
					signal: "traces",
					rangeStart: "2026-06-01",
				}),
			)
			// Seed GC op at cursor=0, but manually create a symlinked tombstone for target 0
			// while removing its source — simulating a mid-removal crash where the tombstone
			// is a symlink (uncertain state).
			const { opId } = seedGcOperation(
				archiveDir,
				dataDir,
				scratchRoot,
				[
					{
						generationId: gid1,
						signal: "traces",
						rangeStart: "2026-06-01",
						manifestSha256: ev1.manifestSha,
						shardName: "00.parquet",
						shardSha: ev1.shardSha,
						shardBytes: 7,
						sourcePath: "",
						recordedActive: activeGid,
					},
				],
				0,
			)
			// Remove source, create a symlinked tombstone.
			rmSync(join(archiveDir, "traces", "2026-06-01", "generations", gid1), {
				recursive: true,
				force: true,
			})
			const tombDir = join(archiveDir, "operations", "active", `archive-${opId}`, "tombstones", gid1)
			mkdirSync(join(tombDir, "shards"), { recursive: true })
			// Replace tombstone dir with a symlink to /tmp (uncertain).
			rmSync(tombDir, { recursive: true, force: true })
			symlinkSync("/tmp", tombDir)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(
				isFailClosed(dryDecision),
				`dry-run should be FailClosed for symlinked tombstone, got ${dryDecision.kind}`,
			)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/symlink|tombstone|unsafe/i,
			)
		})
	})
})

describe("dry-run/apply parity — dangling symlinks and impossible suffix (r9)", () => {
	it("dangling source symlink is FailClosed (not treated as absent), zero mutation", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const gid1 = randomUUID(),
				activeGid = randomUUID()
			const ev1 = seedGeneration2(archiveDir, "traces", "2026-06-01", gid1, "PAR1-old")
			seedGeneration2(archiveDir, "traces", "2026-06-01", activeGid, "PAR1-active")
			const rangeDir = join(archiveDir, "traces", "2026-06-01")
			mkdirSync(rangeDir, { recursive: true })
			writeFileSync(
				join(rangeDir, "active.json"),
				JSON.stringify({
					formatVersion: 1,
					generationId: activeGid,
					signal: "traces",
					rangeStart: "2026-06-01",
				}),
			)
			// Seed a GC operation targeting gid1.
			seedGcOpWithEvidence(
				archiveDir,
				dataDir,
				scratchRoot,
				[
					{
						gid: gid1,
						signal: "traces",
						rangeDate: "2026-06-01",
						contents: "PAR1-old",
						recordedActive: activeGid,
					},
				],
				0,
			)
			// Replace gid1's generation dir with a dangling symlink.
			const genDir = join(archiveDir, "traces", "2026-06-01", "generations", gid1)
			rmSync(genDir, { recursive: true, force: true })
			symlinkSync(join(archiveDir, "nonexistent-target"), genDir)
			const before = durableStateSnapshot(archiveDir, dataDir)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(
				isFailClosed(dryDecision),
				`dry-run should be FailClosed for dangling source symlink, got ${dryDecision.kind}`,
			)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/symlink|unsafe|source/i,
			)
			strictEqual(
				durableStateSnapshot(archiveDir, dataDir),
				before,
				"zero mutation on dangling source symlink",
			)
			void ev1
		})
	})

	it("dangling tombstone symlink is FailClosed (not treated as absent), zero mutation", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const gid1 = randomUUID(),
				activeGid = randomUUID()
			seedGeneration2(archiveDir, "traces", "2026-06-01", gid1, "PAR1-old")
			seedGeneration2(archiveDir, "traces", "2026-06-01", activeGid, "PAR1-active")
			const rangeDir = join(archiveDir, "traces", "2026-06-01")
			mkdirSync(rangeDir, { recursive: true })
			writeFileSync(
				join(rangeDir, "active.json"),
				JSON.stringify({
					formatVersion: 1,
					generationId: activeGid,
					signal: "traces",
					rangeStart: "2026-06-01",
				}),
			)
			const { opId, manifestSha1, shardSha1 } = seedGcOp2(
				archiveDir,
				dataDir,
				scratchRoot,
				gid1,
				activeGid,
			)
			// Remove source, create a DANGLING tombstone symlink.
			rmSync(join(archiveDir, "traces", "2026-06-01", "generations", gid1), {
				recursive: true,
				force: true,
			})
			const tombDir = join(archiveDir, "operations", "active", `archive-${opId}`, "tombstones", gid1)
			mkdirSync(dirname(tombDir), { recursive: true })
			symlinkSync(join(archiveDir, "nonexistent-tomb"), tombDir)
			const before = durableStateSnapshot(archiveDir, dataDir)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(
				isFailClosed(dryDecision),
				`dry-run should be FailClosed for dangling tombstone symlink, got ${dryDecision.kind}`,
			)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/symlink|tombstone|unsafe/i,
			)
			strictEqual(
				durableStateSnapshot(archiveDir, dataDir),
				before,
				"zero mutation on dangling tombstone symlink",
			)
			void manifestSha1
			void shardSha1
		})
	})

	it("impossible suffix (target 2 absent while cursor=0): FailClosed, zero mutation", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const gid1 = randomUUID(),
				gid2 = randomUUID(),
				activeGid = randomUUID()
			seedGeneration2(archiveDir, "traces", "2026-06-01", gid1, "PAR1-t1")
			seedGeneration2(archiveDir, "traces", "2026-06-01", activeGid, "PAR1-active")
			// gid2 is a suffix target but we DON'T create its generation — it's absent.
			const rangeDir = join(archiveDir, "traces", "2026-06-01")
			mkdirSync(rangeDir, { recursive: true })
			writeFileSync(
				join(rangeDir, "active.json"),
				JSON.stringify({
					formatVersion: 1,
					generationId: activeGid,
					signal: "traces",
					rangeStart: "2026-06-01",
				}),
			)
			// Seed GC op with 2 targets, cursor=0. Target 2 (gid2) is absent — impossible suffix.
			seedGcOpWithEvidence(
				archiveDir,
				dataDir,
				scratchRoot,
				[
					{
						gid: gid1,
						signal: "traces",
						rangeDate: "2026-06-01",
						contents: "PAR1-t1",
						recordedActive: activeGid,
					},
					{
						gid: gid2,
						signal: "traces",
						rangeDate: "2026-06-01",
						contents: "PAR1-t2",
						recordedActive: activeGid,
					},
				],
				0,
			)
			// Remove gid2's generation dir — it's absent as a suffix target (impossible).
			rmSync(join(archiveDir, "traces", "2026-06-01", "generations", gid2), {
				recursive: true,
				force: true,
			})
			const before = durableStateSnapshot(archiveDir, dataDir)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(
				isFailClosed(dryDecision),
				`dry-run should be FailClosed for impossible suffix, got ${dryDecision.kind}`,
			)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/suffix.*absent|impossible|unsafe/i,
			)
			strictEqual(
				durableStateSnapshot(archiveDir, dataDir),
				before,
				"zero mutation on impossible suffix",
			)
		})
	})
})

describe("dry-run/apply parity — root-aware topology (r10)", () => {
	const writePointer = (archiveDir: string, activeGid: string): void => {
		const rangeDir = join(archiveDir, "traces", "2026-06-01")
		mkdirSync(rangeDir, { recursive: true })
		writeFileSync(
			join(rangeDir, "active.json"),
			JSON.stringify({
				formatVersion: 1,
				generationId: activeGid,
				signal: "traces",
				rangeStart: "2026-06-01",
			}),
		)
	}

	it("rejects an absent source leaf beneath a symlinked generations ancestor", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const targetGid = randomUUID()
			const activeGid = randomUUID()
			seedGeneration2(archiveDir, "traces", "2026-06-01", activeGid, "PAR1-active")
			writePointer(archiveDir, activeGid)
			seedGcOpWithEvidence(
				archiveDir,
				dataDir,
				scratchRoot,
				[
					{
						gid: targetGid,
						signal: "traces",
						rangeDate: "2026-06-01",
						contents: "PAR1-old",
						recordedActive: activeGid,
					},
				],
				0,
			)
			const generations = join(archiveDir, "traces", "2026-06-01", "generations")
			const outside = join(dirname(archiveDir), "outside-generations")
			rmSync(generations, { recursive: true, force: true })
			mkdirSync(outside)
			writeFileSync(join(outside, "sentinel"), "outside")
			symlinkSync(outside, generations)

			const before = durableStateSnapshot(archiveDir, dataDir, outside)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(isFailClosed(dryDecision), `expected FailClosed, got ${dryDecision.kind}`)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/symlink|source|unsafe/i,
			)
			strictEqual(durableStateSnapshot(archiveDir, dataDir, outside), before)
		})
	})

	it("rejects an absent tombstone leaf beneath a symlinked ancestor at a full cursor", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const targetGid = randomUUID()
			const activeGid = randomUUID()
			seedGeneration2(archiveDir, "traces", "2026-06-01", activeGid, "PAR1-active")
			writePointer(archiveDir, activeGid)
			const { opDir } = seedGcOpWithEvidence(
				archiveDir,
				dataDir,
				scratchRoot,
				[
					{
						gid: targetGid,
						signal: "traces",
						rangeDate: "2026-06-01",
						contents: "PAR1-old",
						recordedActive: activeGid,
					},
				],
				1,
			)
			rmSync(join(archiveDir, "traces", "2026-06-01", "generations", targetGid), {
				recursive: true,
				force: true,
			})
			const outside = join(dirname(archiveDir), "outside-tombstones")
			mkdirSync(outside)
			writeFileSync(join(outside, "sentinel"), "outside")
			symlinkSync(outside, join(opDir, "tombstones"))

			const before = durableStateSnapshot(archiveDir, dataDir, outside)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(isFailClosed(dryDecision), `expected FailClosed, got ${dryDecision.kind}`)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/symlink|tombstone|unsafe/i,
			)
			strictEqual(durableStateSnapshot(archiveDir, dataDir, outside), before)
		})
	})

	it("rejects a dangling completed-operations ancestor before GC mutation", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const targetGid = randomUUID()
			const activeGid = randomUUID()
			seedGeneration2(archiveDir, "traces", "2026-06-01", activeGid, "PAR1-active")
			writePointer(archiveDir, activeGid)
			seedGcOpWithEvidence(
				archiveDir,
				dataDir,
				scratchRoot,
				[
					{
						gid: targetGid,
						signal: "traces",
						rangeDate: "2026-06-01",
						contents: "PAR1-old",
						recordedActive: activeGid,
					},
				],
				0,
			)
			const completed = join(archiveDir, "operations", "completed")
			symlinkSync(join(dirname(archiveDir), "missing-completed-target"), completed)

			const before = durableStateSnapshot(archiveDir, dataDir)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(isFailClosed(dryDecision), `expected FailClosed, got ${dryDecision.kind}`)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/symlink|completed|unsafe/i,
			)
			strictEqual(durableStateSnapshot(archiveDir, dataDir), before)
		})
	})

	it("rejects a symlinked quarantine ancestor before moving building state", async () => {
		await withRoots(async (archiveDir, dataDir, scratchRoot) => {
			const operationId = randomUUID()
			const generationId = randomUUID()
			const checkpointId = randomUUID()
			const pinId = randomUUID()
			const opDir = join(archiveDir, "operations", "active", `archive-${operationId}`)
			const building = join(archiveDir, "building", generationId)
			mkdirSync(opDir, { recursive: true })
			mkdirSync(building, { recursive: true })
			writeFileSync(join(building, "partial"), "retain me")
			writeFileSync(
				join(opDir, "intent.json"),
				JSON.stringify({
					formatVersion: 3,
					kind: "create",
					operationId,
					generationId,
					signal: "traces",
					rangeStart: "2026-06-01",
					checkpointId,
					archiveDir,
					dataDir,
					scratchRoot,
					pinId,
					pinPurpose: `archive:${generationId}`,
					scratchSubdir: `archive-${operationId}`,
					manifestSha256: null,
					baseActiveGenerationId: null,
					phase: "intent",
					createdAt: "2026-06-01T00:00:00.000Z",
					updatedAt: "2026-06-01T00:00:00.000Z",
				}),
			)
			const outside = join(dirname(archiveDir), "outside-quarantine")
			mkdirSync(outside)
			writeFileSync(join(outside, "sentinel"), "outside")
			symlinkSync(outside, join(archiveDir, "quarantine"))

			const before = durableStateSnapshot(archiveDir, dataDir, outside)
			const dryDecision = await runArchiveReconciliation(dataDir, archiveDir, scratchRoot, {
				dryRun: true,
			})
			ok(isFailClosed(dryDecision), `expected FailClosed, got ${dryDecision.kind}`)
			await rejects(
				runArchiveReconciliation(dataDir, archiveDir, scratchRoot, { dryRun: false }),
				/symlink|quarantine|unsafe/i,
			)
			strictEqual(durableStateSnapshot(archiveDir, dataDir, outside), before)
		})
	})
})

// Shared test helpers for r9 parity tests.
function seedGeneration2(
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
	shardContents: string,
): { manifestSha: string; shardSha: string } {
	const genDir = join(archiveDir, signal, rangeDate, "generations", generationId)
	mkdirSync(join(genDir, "shards"), { recursive: true })
	writeFileSync(join(genDir, "shards", "00.parquet"), shardContents)
	const shardSha = createHash("sha256").update(shardContents).digest("hex")
	const manifest = {
		formatVersion: 3,
		generationId,
		signal,
		rangeStart: rangeDate,
		rangeEndExclusive: "2026-06-02T00:00:00.000Z",
		checkpointId: randomUUID(),
		checkpointManifestFingerprint: "cid",
		createdAt: "2026-06-02T00:00:00.000Z",
		mapleVersion: MAPLE_VERSION,
		chdbVersion: CHDB_VERSION,
		schemaFingerprint: SCHEMA_FINGERPRINT,
		sourceRowCount: 1,
		archivedRowCount: 1,
		tuning: {
			writerThreads: 1,
			rowGroupRows: 10000,
			maxShardRows: 500000,
			maxShardBytes: 268435456,
			targetChunkBytes: 1073741824,
			minFreeSpaceReserve: 536870912,
		},
		tuningConfig: null,
		shards: [
			{
				name: "00.parquet",
				rowCount: 1,
				minEventTimeUnixNano: `${BigInt(Date.parse(`${rangeDate}T12:00:00.000Z`)) * 1000000n}`,
				maxEventTimeUnixNano: `${BigInt(Date.parse(`${rangeDate}T12:00:00.000Z`)) * 1000000n}`,
				sha256: shardSha,
				bytes: shardContents.length,
				columns: ["TimestampTime", "ServiceName"],
				complexDigest: "0",
				complexDigestAlgorithm: "cityhash64-multiset-v3",
			},
		],
	}
	const manifestJson = JSON.stringify(manifest)
	const manifestSha = createHash("sha256").update(manifestJson).digest("hex")
	writeFileSync(join(genDir, "manifest.json"), manifestJson)
	return { manifestSha, shardSha }
}

function seedGcOp2(
	archiveDir: string,
	dataDir: string,
	scratchRoot: string,
	gid: string,
	activeGid: string,
): { opId: string; manifestSha1: string; shardSha1: string } {
	const { manifestSha, shardSha } = seedGeneration2(archiveDir, "traces", "2026-06-01", gid, "PAR1-old")
	const opId = randomUUID()
	const opDir = join(archiveDir, "operations", "active", `archive-${opId}`)
	mkdirSync(opDir, { recursive: true })
	writeFileSync(
		join(opDir, "intent.json"),
		JSON.stringify({
			formatVersion: 3,
			kind: "gc",
			operationId: opId,
			keep: 0,
			targets: [
				{
					signal: "traces",
					rangeStart: "2026-06-01",
					generationId: gid,
					createdAt: "2026-06-02T00:00:00.000Z",
					manifestSha256: manifestSha,
					bytes: 7,
					shards: [{ name: "00.parquet", bytes: 7, sha256: shardSha }],
					recordedActiveGenerationId: activeGid,
				},
			],
			completedTargets: 0,
			archiveDir,
			dataDir,
			scratchRoot,
			phase: "intent",
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		}),
	)
	return { opId, manifestSha1: manifestSha, shardSha1: shardSha }
}

function seedGcOpWithEvidence(
	archiveDir: string,
	dataDir: string,
	scratchRoot: string,
	targets: Array<{
		gid: string
		signal: string
		rangeDate: string
		contents: string
		recordedActive: string
	}>,
	completedTargets: number,
): { opId: string; opDir: string } {
	const opId = randomUUID()
	const opDir = join(archiveDir, "operations", "active", `archive-${opId}`)
	mkdirSync(opDir, { recursive: true })
	const gcTargets = targets.map((t) => {
		const { manifestSha, shardSha } = seedGeneration2(
			archiveDir,
			t.signal,
			t.rangeDate,
			t.gid,
			t.contents,
		)
		return {
			signal: t.signal,
			rangeStart: t.rangeDate,
			generationId: t.gid,
			createdAt: "2026-06-02T00:00:00.000Z",
			manifestSha256: manifestSha,
			bytes: t.contents.length,
			shards: [{ name: "00.parquet", bytes: t.contents.length, sha256: shardSha }],
			recordedActiveGenerationId: t.recordedActive,
		}
	})
	writeFileSync(
		join(opDir, "intent.json"),
		JSON.stringify({
			formatVersion: 3,
			kind: "gc",
			operationId: opId,
			keep: 0,
			targets: gcTargets,
			completedTargets,
			archiveDir,
			dataDir,
			scratchRoot,
			phase: completedTargets > 0 ? "gc-collecting" : "intent",
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
		}),
	)
	return { opId, opDir }
}
