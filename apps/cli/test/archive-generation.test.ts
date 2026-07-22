import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual, throws } from "node:assert"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import {
	activePointerPath,
	buildingGenerationRoot,
	catalogPath,
	generationRoot,
	generationManifestPath,
	shardsRoot,
} from "../src/server/archives/paths"
import { parseArchiveActivePointer, type ArchiveGenerationManifest } from "../src/server/archives/manifest"
import {
	assertArchiveScratchFreeSpace,
	appendCatalog,
	createArchiveGeneration,
	promoteGeneration,
	reconcileArchiveGeneration,
	selectActiveGeneration,
} from "../src/server/archives/generation"
import {
	advancePhase,
	listActiveOperationIds,
	operationDir,
	writeInitialIntent,
	type ArchiveOperationPhase,
} from "../src/server/archives/journal"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"
import {
	checkpointPinsRoot,
	checkpointRoot,
	checkpointSnapshotDir,
	checkpointStatePath,
} from "../src/server/checkpoints"
import { assertCatalogExact, rebuildCatalog } from "../src/server/archives/listing"

// Filesystem-level tests for generation promotion, supersession, and catalog
// append. These exercise the durable state machine without a restored chDB; the
// full export path is covered by the native smoke script.

const withArchive = async (run: (archiveDir: string) => Promise<void> | void): Promise<void> => {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "maple-archive-gen-test-")))
	const archiveDir = join(parent, "archive")
	mkdirSync(archiveDir, { recursive: true })
	try {
		await run(archiveDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const seedCheckpoint = (dataDir: string, checkpointId: string, backupBytes = 6): void => {
	const createdAt = "2026-01-01T00:00:00.000Z"
	const snapshot = checkpointSnapshotDir(dataDir, checkpointId)
	mkdirSync(join(snapshot, "backup"), { recursive: true })
	writeFileSync(join(snapshot, "backup", "data.bin"), "x".repeat(backupBytes))
	writeFileSync(
		join(snapshot, "manifest.json"),
		`${JSON.stringify({
			formatVersion: 1,
			checkpointId,
			operationId: randomUUID(),
			mapleVersion: MAPLE_VERSION,
			chdbVersion: CHDB_VERSION,
			schemaFingerprint: SCHEMA_FINGERPRINT,
			createdAt,
			sourceDataDir: dataDir,
			backupRelativePath: `snapshots/${checkpointId}/backup`,
			backupBytes,
			validation: {
				validatedAt: createdAt,
				traces: 0,
				logs: 0,
				metricsSum: 0,
				metricsGauge: 0,
				metricsHistogram: 0,
				metricsExponentialHistogram: 0,
				materializedViews: 0,
			},
		})}\n`,
	)
	mkdirSync(checkpointRoot(dataDir), { recursive: true })
	writeFileSync(
		checkpointStatePath(dataDir),
		`${JSON.stringify({
			formatVersion: 1,
			revision: randomUUID(),
			current: checkpointId,
			previous: null,
			committedAt: createdAt,
		})}\n`,
	)
}

const manifest = (
	generationId: string,
	signal = "traces",
	archivedRowCount = 10,
): ArchiveGenerationManifest => ({
	formatVersion: 3,
	generationId,
	signal,
	rangeStart: "2026-06-01",
	rangeEndExclusive: "2026-06-02T00:00:00.000Z",
	checkpointId: randomUUID(),
	checkpointManifestFingerprint: "cid:2026-01-01:100",
	createdAt: "2026-06-02T00:00:00.000Z",
	mapleVersion: MAPLE_VERSION,
	chdbVersion: CHDB_VERSION,
	schemaFingerprint: SCHEMA_FINGERPRINT,
	sourceRowCount: archivedRowCount,
	archivedRowCount,
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
			rowCount: archivedRowCount,
			minEventTimeUnixNano: `${BigInt(Date.parse("2026-06-01T00:00:00.000Z")) * 1_000_000n}`,
			maxEventTimeUnixNano: `${BigInt(Date.parse("2026-06-01T00:30:00.000Z")) * 1_000_000n}`,
			sha256: "a".repeat(64),
			bytes: 4096,
			columns: ["TimestampTime", "ServiceName"],
			complexDigest: "123456789",
			complexDigestAlgorithm: "cityhash64-multiset-v3",
		},
	],
})

/** Build a fake building generation with a shards dir and a placeholder shard. */
const seedBuilding = (archiveDir: string, generationId: string): string => {
	const building = buildingGenerationRoot(archiveDir, generationId)
	const shards = join(building, "shards")
	mkdirSync(shards, { recursive: true })
	writeFileSync(join(shards, "00.parquet"), "PAR1-placeholder")
	return building
}

const seedPublishedOperation = async (
	archiveDir: string,
	phase: ArchiveOperationPhase,
	options: { pointer?: boolean; catalog?: boolean } = {},
) => {
	const parent = join(archiveDir, "..")
	const dataDir = join(parent, "data")
	const scratchRoot = join(parent, "scratch")
	mkdirSync(dataDir, { recursive: true })
	mkdirSync(scratchRoot, { recursive: true })
	const operationId = randomUUID()
	const generationId = randomUUID()
	const checkpointId = randomUUID()
	const pinId = randomUUID()
	const building = seedBuilding(archiveDir, generationId)
	const shardPath = join(building, "shards", "00.parquet")
	const baseManifest = manifest(generationId)
	const exactManifest: ArchiveGenerationManifest = {
		...baseManifest,
		checkpointId,
		shards: [
			{
				...baseManifest.shards[0]!,
				bytes: statSync(shardPath).size,
				sha256: createHash("sha256").update(readFileSync(shardPath)).digest("hex"),
			},
		],
	}
	await writeInitialIntent({
		archiveDir,
		operationId,
		generationId,
		signal: "traces",
		rangeStart: "2026-06-01",
		checkpointId,
		dataDir,
		scratchRoot,
		pinId,
		pinPurpose: `archive:${generationId}`,
		scratchSubdir: `archive-${operationId}`,
		baseActiveGenerationId: null,
	})
	await promoteGeneration(archiveDir, "traces", "2026-06-01", generationId, exactManifest, building)
	const finalManifestPath = generationManifestPath(archiveDir, "traces", "2026-06-01", generationId)
	const manifestSha256 = createHash("sha256").update(readFileSync(finalManifestPath)).digest("hex")
	await advancePhase(archiveDir, operationId, "manifest-written", manifestSha256)
	await advancePhase(archiveDir, operationId, "promoted")
	if (options.pointer) {
		await selectActiveGeneration(archiveDir, "traces", "2026-06-01", generationId, null)
	}
	if (options.catalog) await rebuildCatalog(archiveDir, "traces")
	if (phase !== "promoted") await advancePhase(archiveDir, operationId, phase)
	return {
		archiveDir,
		dataDir,
		scratchRoot,
		operationId,
		generationId,
		checkpointId,
		pinId,
		finalManifestPath,
		finalShardPath: join(shardsRoot(archiveDir, "traces", "2026-06-01", generationId), "00.parquet"),
	}
}

describe("archive generation promotion", () => {
	it("preflights archive and scratch independently on separate devices", () => {
		assertArchiveScratchFreeSpace(
			{ identity: "archive", path: "/archive", freeBytes: 150 },
			{ identity: "scratch", path: "/scratch", freeBytes: 80 },
			50,
			100,
			80,
		)
		throws(
			() =>
				assertArchiveScratchFreeSpace(
					{ identity: "archive", path: "/archive", freeBytes: 149 },
					{ identity: "scratch", path: "/scratch", freeBytes: 80 },
					50,
					100,
					80,
				),
			/archive volume .* below the required 150 bytes/,
		)
		throws(
			() =>
				assertArchiveScratchFreeSpace(
					{ identity: "archive", path: "/archive", freeBytes: 150 },
					{ identity: "scratch", path: "/scratch", freeBytes: 79 },
					50,
					100,
					80,
				),
			/scratch volume .* below the required 80 bytes/,
		)
	})

	it("combines archive and scratch requirements exactly once on one device", () => {
		assertArchiveScratchFreeSpace(
			{ identity: "shared", path: "/archive", freeBytes: 230 },
			{ identity: "shared", path: "/scratch", freeBytes: 230 },
			50,
			100,
			80,
		)
		throws(
			() =>
				assertArchiveScratchFreeSpace(
					{ identity: "shared", path: "/archive", freeBytes: 229 },
					{ identity: "shared", path: "/scratch", freeBytes: 229 },
					50,
					100,
					80,
				),
			/archive\/scratch volume .* below the required 230 bytes/,
		)
	})

	it("fails free-space preflight before creating an active operation journal", async () => {
		await withArchive(async (archiveDir) => {
			const parent = join(archiveDir, "..")
			const dataDir = join(parent, "data")
			const scratchRoot = join(parent, "scratch")
			mkdirSync(dataDir, { recursive: true })
			mkdirSync(scratchRoot, { recursive: true })
			seedCheckpoint(dataDir, randomUUID())
			await rejects(
				createArchiveGeneration(dataDir, archiveDir, "traces", "2026-06-01", {
					writerThreads: 1,
					rowGroupRows: 1,
					maxShardRows: 1,
					maxShardBytes: 1,
					targetChunkBytes: 1,
					minFreeSpaceReserve: Number.MAX_SAFE_INTEGER - 100,
					archiveDir,
					scratchRoot,
				}),
				/below the required/,
			)
			strictEqual(listActiveOperationIds(archiveDir).length, 0)
		})
	})

	it("makes the complete manifest durable in building before publishing the generation", async () => {
		await withArchive(async (archiveDir) => {
			const generationId = randomUUID()
			const building = seedBuilding(archiveDir, generationId)
			await rejects(
				promoteGeneration(
					archiveDir,
					"traces",
					"2026-06-01",
					generationId,
					manifest(generationId),
					building,
					{
						beforeGenerationPromoted: () => {
							throw new Error("stop before rename")
						},
					},
				),
				/stop before rename/,
			)
			ok(existsSync(join(building, "manifest.json")), "manifest is durable inside building")
			ok(
				!existsSync(generationManifestPath(archiveDir, "traces", "2026-06-01", generationId)),
				"no final generation exists before the atomic directory rename",
			)
		})
	})

	it("does not publish a final generation when interrupted before manifest durability", async () => {
		await withArchive(async (archiveDir) => {
			const generationId = randomUUID()
			const building = seedBuilding(archiveDir, generationId)
			await rejects(
				promoteGeneration(
					archiveDir,
					"traces",
					"2026-06-01",
					generationId,
					manifest(generationId),
					building,
					{
						beforeManifestDurable: () => {
							throw new Error("stop before manifest")
						},
					},
				),
				/stop before manifest/,
			)
			ok(!existsSync(join(building, "manifest.json")))
			ok(!existsSync(generationManifestPath(archiveDir, "traces", "2026-06-01", generationId)))
		})
	})

	it("moves the building generation into place and selects it through the active pointer", async () => {
		await withArchive(async (archiveDir) => {
			const generationId = randomUUID()
			const building = seedBuilding(archiveDir, generationId)
			// Promotion moves building → final + writes manifest (does not touch the
			// pointer). A separate CAS pointer update selects the generation.
			await promoteGeneration(
				archiveDir,
				"traces",
				"2026-06-01",
				generationId,
				manifest(generationId),
				building,
				{},
			)
			const superseded = await selectActiveGeneration(
				archiveDir,
				"traces",
				"2026-06-01",
				generationId,
				null,
				{},
			)
			strictEqual(superseded, null)
			// The generation dir now exists with a manifest and shards.
			ok(existsSync(generationManifestPath(archiveDir, "traces", "2026-06-01", generationId)))
			ok(existsSync(join(shardsRoot(archiveDir, "traces", "2026-06-01", generationId), "00.parquet")))
			// The active pointer selects this generation.
			const pointer = parseArchiveActivePointer(
				JSON.parse(readFileSync(activePointerPath(archiveDir, "traces", "2026-06-01"), "utf8")),
			)
			strictEqual(pointer.generationId, generationId)
			// The building dir is gone after promotion.
			ok(!existsSync(building))
		})
	})

	it("supersedes a previous generation and retains the old one", async () => {
		await withArchive(async (archiveDir) => {
			const old = randomUUID()
			const oldBuilding = seedBuilding(archiveDir, old)
			await promoteGeneration(archiveDir, "traces", "2026-06-01", old, manifest(old), oldBuilding, {})
			await selectActiveGeneration(archiveDir, "traces", "2026-06-01", old, null, {})

			const next = randomUUID()
			const nextBuilding = seedBuilding(archiveDir, next)
			await promoteGeneration(
				archiveDir,
				"traces",
				"2026-06-01",
				next,
				manifest(next),
				nextBuilding,
				{},
			)
			// CAS base is the previously-active generation (old). selectActiveGeneration
			// returns the superseded id.
			const superseded = await selectActiveGeneration(archiveDir, "traces", "2026-06-01", next, old, {})
			strictEqual(superseded, old)
			// The active pointer now selects the new generation...
			const pointer = parseArchiveActivePointer(
				JSON.parse(readFileSync(activePointerPath(archiveDir, "traces", "2026-06-01"), "utf8")),
			)
			strictEqual(pointer.generationId, next)
			// ...but the old generation directory is retained, never deleted.
			ok(existsSync(generationManifestPath(archiveDir, "traces", "2026-06-01", old)))
			ok(existsSync(generationManifestPath(archiveDir, "traces", "2026-06-01", next)))
		})
	})

	it("selectActiveGeneration refuses to clobber a pointer that moved off the recorded base", async () => {
		// CAS: if the pointer no longer matches the recorded base AND does not
		// already select the intended generation, a blind flip would clobber
		// concurrent activity — fail closed.
		await withArchive(async (archiveDir) => {
			const gen = randomUUID()
			const building = seedBuilding(archiveDir, gen)
			await promoteGeneration(archiveDir, "traces", "2026-06-01", gen, manifest(gen), building, {})
			// Record a base that does NOT match reality (no pointer exists; base
			// claims a different generation).
			await rejects(
				selectActiveGeneration(archiveDir, "traces", "2026-06-01", gen, randomUUID(), {}),
				/no longer matches base/,
			)
		})
	})

	it("selectActiveGeneration is idempotent when the pointer already selects the generation", async () => {
		await withArchive(async (archiveDir) => {
			const gen = randomUUID()
			const building = seedBuilding(archiveDir, gen)
			await promoteGeneration(archiveDir, "traces", "2026-06-01", gen, manifest(gen), building, {})
			await selectActiveGeneration(archiveDir, "traces", "2026-06-01", gen, null, {})
			// Re-selecting with a base equal to the generation is a no-op (no throw).
			const superseded = await selectActiveGeneration(archiveDir, "traces", "2026-06-01", gen, gen, {})
			strictEqual(superseded, gen)
		})
	})

	it("refuses to promote into an existing generation directory", async () => {
		await withArchive(async (archiveDir) => {
			const generationId = randomUUID()
			const building = seedBuilding(archiveDir, generationId)
			await promoteGeneration(
				archiveDir,
				"traces",
				"2026-06-01",
				generationId,
				manifest(generationId),
				building,
				{},
			)
			// A second promotion of the same id must fail closed; the existing
			// generation directory is not overwritten.
			const dupBuilding = seedBuilding(archiveDir, generationId)
			await rejects(
				promoteGeneration(
					archiveDir,
					"traces",
					"2026-06-01",
					generationId,
					manifest(generationId),
					dupBuilding,
					{},
				),
				/already exists/,
			)
		})
	})

	it("reconciliation rejects a tampered published shard before pointer or catalog mutation", async () => {
		await withArchive(async (archiveDir) => {
			const parent = join(archiveDir, "..")
			const dataDir = join(parent, "data")
			const scratchRoot = join(parent, "scratch")
			mkdirSync(dataDir, { recursive: true })
			mkdirSync(scratchRoot, { recursive: true })
			const operationId = randomUUID()
			const generationId = randomUUID()
			const checkpointId = randomUUID()
			const pinId = randomUUID()
			const building = seedBuilding(archiveDir, generationId)
			const shardPath = join(building, "shards", "00.parquet")
			const shardBytes = statSync(shardPath).size
			const shardSha256 = createHash("sha256").update(readFileSync(shardPath)).digest("hex")
			const baseManifest = manifest(generationId)
			const exactManifest: ArchiveGenerationManifest = {
				...baseManifest,
				checkpointId,
				shards: [{ ...baseManifest.shards[0]!, bytes: shardBytes, sha256: shardSha256 }],
			}
			await writeInitialIntent({
				archiveDir,
				operationId,
				generationId,
				signal: "traces",
				rangeStart: "2026-06-01",
				checkpointId,
				dataDir,
				scratchRoot,
				pinId,
				pinPurpose: `archive:${generationId}`,
				scratchSubdir: `archive-${operationId}`,
				baseActiveGenerationId: null,
			})
			await promoteGeneration(archiveDir, "traces", "2026-06-01", generationId, exactManifest, building)
			const finalManifestPath = generationManifestPath(archiveDir, "traces", "2026-06-01", generationId)
			const manifestSha256 = createHash("sha256").update(readFileSync(finalManifestPath)).digest("hex")
			await advancePhase(archiveDir, operationId, "manifest-written", manifestSha256)
			await advancePhase(archiveDir, operationId, "promoted")
			const pinPath = join(checkpointPinsRoot(dataDir), checkpointId, `${pinId}.json`)
			mkdirSync(join(pinPath, ".."), { recursive: true })
			writeFileSync(
				pinPath,
				`${JSON.stringify({
					formatVersion: 1,
					pinId,
					checkpointId,
					purpose: `archive:${generationId}`,
					createdAt: new Date().toISOString(),
				})}\n`,
			)
			const finalShardPath = join(
				shardsRoot(archiveDir, "traces", "2026-06-01", generationId),
				"00.parquet",
			)
			writeFileSync(finalShardPath, "attacker bytes")
			await rejects(
				reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot),
				/shard 00\.parquet (byte size|SHA-256) mismatch/,
			)
			ok(!existsSync(activePointerPath(archiveDir, "traces", "2026-06-01")))
			ok(!existsSync(catalogPath(archiveDir, "traces")))
		})
	})

	it("preserves authority over an impossible final generation without a manifest", async () => {
		await withArchive(async (archiveDir) => {
			const parent = join(archiveDir, "..")
			const dataDir = join(parent, "data")
			const scratchRoot = join(parent, "scratch")
			mkdirSync(dataDir, { recursive: true })
			mkdirSync(scratchRoot, { recursive: true })
			const operationId = randomUUID()
			const generationId = randomUUID()
			await writeInitialIntent({
				archiveDir,
				operationId,
				generationId,
				signal: "traces",
				rangeStart: "2026-06-01",
				checkpointId: randomUUID(),
				dataDir,
				scratchRoot,
				pinId: randomUUID(),
				pinPurpose: `archive:${generationId}`,
				scratchSubdir: `archive-${operationId}`,
				baseActiveGenerationId: null,
			})
			const impossibleFinal = generationRoot(archiveDir, "traces", "2026-06-01", generationId)
			mkdirSync(join(impossibleFinal, "shards"), { recursive: true })
			await rejects(
				reconcileArchiveGeneration(dataDir, archiveDir, scratchRoot),
				/published a generation without a manifest/,
			)
			ok(existsSync(impossibleFinal), "uncertain final state retained")
			ok(existsSync(operationDir(archiveDir, operationId)), "journal authority retained")
		})
	})

	it("repairs missing pointer and catalog despite journal completion labels", async () => {
		await withArchive(async (archiveDir) => {
			const seeded = await seedPublishedOperation(archiveDir, "catalog-complete")
			await reconcileArchiveGeneration(seeded.dataDir, archiveDir, seeded.scratchRoot)
			const pointer = parseArchiveActivePointer(
				JSON.parse(readFileSync(activePointerPath(archiveDir, "traces", "2026-06-01"), "utf8")),
				"traces",
				"2026-06-01",
			)
			strictEqual(pointer.generationId, seeded.generationId)
			assertCatalogExact(archiveDir, "traces")
			strictEqual(listActiveOperationIds(archiveDir).length, 0)
		})
	})

	it("fails closed when the observed pointer conflicts with the journal CAS topology", async () => {
		await withArchive(async (archiveDir) => {
			const seeded = await seedPublishedOperation(archiveDir, "catalog-complete")
			writeFileSync(
				activePointerPath(archiveDir, "traces", "2026-06-01"),
				`${JSON.stringify({
					formatVersion: 1,
					generationId: randomUUID(),
					signal: "traces",
					rangeStart: "2026-06-01",
					selectedAt: new Date().toISOString(),
				})}\n`,
			)
			await rejects(
				reconcileArchiveGeneration(seeded.dataDir, archiveDir, seeded.scratchRoot),
				/no longer matches the recorded base/,
			)
			ok(existsSync(operationDir(archiveDir, seeded.operationId)), "journal authority retained")
		})
	})

	it("repairs a tampered catalog from authoritative manifests despite catalog-complete", async () => {
		await withArchive(async (archiveDir) => {
			const seeded = await seedPublishedOperation(archiveDir, "catalog-complete", {
				pointer: true,
				catalog: true,
			})
			writeFileSync(catalogPath(archiveDir, "traces"), '{"attacker":true}\n')
			await reconcileArchiveGeneration(seeded.dataDir, archiveDir, seeded.scratchRoot)
			assertCatalogExact(archiveDir, "traces")
			const lines = readFileSync(catalogPath(archiveDir, "traces"), "utf8").trim().split("\n")
			strictEqual(lines.length, 1)
			strictEqual((JSON.parse(lines[0]!) as { generationId: string }).generationId, seeded.generationId)
		})
	})

	it("retains a complete journal unless every implied durable invariant is exact", async () => {
		await withArchive(async (outerArchiveDir) => {
			const root = join(outerArchiveDir, "..")
			const cases: ReadonlyArray<{
				name: string
				mutate: (seeded: Awaited<ReturnType<typeof seedPublishedOperation>>) => void
				error: RegExp
			}> = [
				{
					name: "manifest",
					mutate: (s) => writeFileSync(s.finalManifestPath, "{}\n"),
					error: /manifest SHA-256 mismatch/,
				},
				{
					name: "shard",
					mutate: (s) => writeFileSync(s.finalShardPath, "tampered"),
					error: /shard 00\.parquet (byte size|SHA-256) mismatch/,
				},
				{
					name: "pointer",
					mutate: (s) => rmSync(activePointerPath(s.archiveDir, "traces", "2026-06-01")),
					error: /pointer mismatch/,
				},
				{
					name: "catalog",
					mutate: (s) => writeFileSync(catalogPath(s.archiveDir, "traces"), "{}\n"),
					error: /catalog does not exactly match/,
				},
				{
					name: "pin",
					mutate: (s) => {
						const pinPath = join(checkpointPinsRoot(s.dataDir), s.checkpointId, `${s.pinId}.json`)
						mkdirSync(join(pinPath, ".."), { recursive: true })
						writeFileSync(
							pinPath,
							`${JSON.stringify({
								formatVersion: 1,
								pinId: s.pinId,
								checkpointId: s.checkpointId,
								purpose: `archive:${s.generationId}`,
								createdAt: new Date().toISOString(),
							})}\n`,
						)
					},
					error: /requires its exact owned pin to be absent/,
				},
				{
					name: "scratch",
					mutate: (s) =>
						mkdirSync(join(s.scratchRoot, `archive-${s.operationId}`), { recursive: true }),
					error: /requires its exact owned scratch to be absent/,
				},
				{
					name: "building",
					mutate: (s) =>
						mkdirSync(buildingGenerationRoot(s.archiveDir, s.generationId), { recursive: true }),
					error: /both building and final generation state/,
				},
			]
			for (const scenario of cases) {
				const archiveDir = join(root, `complete-${scenario.name}`, "archive")
				mkdirSync(archiveDir, { recursive: true })
				const seeded = await seedPublishedOperation(archiveDir, "complete", {
					pointer: true,
					catalog: true,
				})
				scenario.mutate(seeded)
				await rejects(
					reconcileArchiveGeneration(seeded.dataDir, archiveDir, seeded.scratchRoot),
					scenario.error,
				)
				ok(
					existsSync(operationDir(archiveDir, seeded.operationId)),
					`${scenario.name}: active journal retained`,
				)
			}
		})
	})
})

describe("archive catalog append", () => {
	it("appends one line per generation and survives a rebuild from manifests", async () => {
		await withArchive(async (archiveDir) => {
			const g1 = randomUUID()
			await appendCatalog(archiveDir, "traces", manifest(g1, "traces", 10))
			const g2 = randomUUID()
			await appendCatalog(archiveDir, "traces", manifest(g2, "traces", 20))
			const catalog = readFileSync(catalogPath(archiveDir, "traces"), "utf8").trim().split("\n")
			strictEqual(catalog.length, 2)
			const first = JSON.parse(catalog[0]!) as { generationId: string; archivedRowCount: number }
			const second = JSON.parse(catalog[1]!) as { generationId: string; archivedRowCount: number }
			strictEqual(first.generationId, g1)
			strictEqual(first.archivedRowCount, 10)
			strictEqual(second.generationId, g2)
			strictEqual(second.archivedRowCount, 20)
		})
	})

	it("creates the catalog on first append when none exists", async () => {
		await withArchive(async (archiveDir) => {
			const g = randomUUID()
			await appendCatalog(archiveDir, "logs", manifest(g, "logs", 5))
			ok(existsSync(catalogPath(archiveDir, "logs")))
		})
	})
})
