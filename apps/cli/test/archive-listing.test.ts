import { describe, it } from "@effect/vitest"
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import {
	activePointerPath,
	catalogPath,
	generationManifestPath,
	generationsRoot,
	nextMidnightUtc,
	shardsRoot,
} from "../src/server/archives/paths"
import {
	ARCHIVE_VERIFY_BUFFER_BYTES,
	activeParquetPaths,
	listActiveGenerations,
	rebuildCatalog,
	rebuildCatalogWithMaintenanceLock,
	verifyActiveGenerations,
} from "../src/server/archives/listing"
import { withMaintenanceLock } from "../src/server/checkpoints"
import { type ArchiveGenerationManifest } from "../src/server/archives/manifest"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"

const withArchive = async (run: (archiveDir: string) => Promise<void> | void): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-archive-listing-test-"))
	const archiveDir = join(parent, "archive")
	mkdirSync(archiveDir, { recursive: true })
	try {
		await run(archiveDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const manifest = (
	generationId: string,
	signal: string,
	rangeDate: string,
	rowCount: number,
	shardSha = "a".repeat(64),
	shardBytes = 4096,
): ArchiveGenerationManifest => ({
	formatVersion: 3,
	generationId,
	signal,
	rangeStart: rangeDate,
	rangeEndExclusive: nextMidnightUtc(rangeDate),
	checkpointId: randomUUID(),
	checkpointManifestFingerprint: "cid:2026-01-01:100",
	createdAt: "2026-06-02T00:00:00.000Z",
	mapleVersion: MAPLE_VERSION,
	chdbVersion: CHDB_VERSION,
	schemaFingerprint: SCHEMA_FINGERPRINT,
	sourceRowCount: rowCount,
	archivedRowCount: rowCount,
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
			name: "00-0000.parquet",
			rowCount,
			minEventTimeUnixNano: `${BigInt(Date.parse(`${rangeDate}T00:00:00.000Z`)) * 1_000_000n}`,
			maxEventTimeUnixNano: `${BigInt(Date.parse(`${rangeDate}T00:30:00.000Z`)) * 1_000_000n}`,
			sha256: shardSha,
			bytes: shardBytes,
			columns: ["TimestampTime", "ServiceName"],
			complexDigest: "123456789",
			complexDigestAlgorithm: "cityhash64-multiset-v3",
		},
	],
})

/** Seed a complete, promoted generation on disk (manifest + shard + active pointer). */
const seedActiveGeneration = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
	rowCount: number,
): void => {
	const shardsDir = shardsRoot(archiveDir, signal, rangeDate, generationId)
	mkdirSync(shardsDir, { recursive: true })
	const shardPath = join(shardsDir, "00-0000.parquet")
	const shardContent = "PAR1"
	writeFileSync(shardPath, shardContent)
	const shardStat = statSync(shardPath)
	const shardSha = sha256Hex(shardContent)
	writeFileSync(
		generationManifestPath(archiveDir, signal, rangeDate, generationId),
		`${JSON.stringify(manifest(generationId, signal, rangeDate, rowCount, shardSha, shardStat.size))}\n`,
	)
	writeFileSync(
		activePointerPath(archiveDir, signal, rangeDate),
		`${JSON.stringify({
			formatVersion: 1,
			generationId,
			signal,
			rangeStart: rangeDate,
			selectedAt: "2026-06-02T00:00:00.000Z",
		})}\n`,
	)
}

/** Seed a superseded generation: manifest + shard present, but NOT active. */
const seedSupersededGeneration = (
	archiveDir: string,
	signal: string,
	rangeDate: string,
	generationId: string,
	rowCount: number,
): void => {
	const shardsDir = shardsRoot(archiveDir, signal, rangeDate, generationId)
	mkdirSync(shardsDir, { recursive: true })
	const shardPath = join(shardsDir, "00-0000.parquet")
	const shardContent = "PAR1-old"
	writeFileSync(shardPath, shardContent)
	const shardStat = statSync(shardPath)
	const shardSha = sha256Hex(shardContent)
	writeFileSync(
		generationManifestPath(archiveDir, signal, rangeDate, generationId),
		`${JSON.stringify(manifest(generationId, signal, rangeDate, rowCount, shardSha, shardStat.size))}\n`,
	)
}

describe("archive listing", () => {
	it("lists the active generation with its shard paths and excludes superseded generations", async () => {
		await withArchive(async (archiveDir) => {
			const old = randomUUID()
			const active = randomUUID()
			seedSupersededGeneration(archiveDir, "traces", "2026-06-01", old, 5)
			seedActiveGeneration(archiveDir, "traces", "2026-06-01", active, 10)
			const listing = listActiveGenerations(archiveDir)
			strictEqual(listing.active.length, 1)
			const summary = listing.active[0]!
			strictEqual(summary.generationId, active)
			strictEqual(summary.archivedRowCount, 10)
			strictEqual(summary.shardCount, 1)
			strictEqual(summary.shardPaths.length, 1)
			ok(summary.shardPaths[0]!.endsWith("00-0000.parquet"))
			strictEqual(summary.shardBytes, 4)
			deepStrictEqual(listing.signals, ["traces"])
		})
	})

	it("returns empty when no archive exists", async () => {
		await withArchive(async (archiveDir) => {
			const listing = listActiveGenerations(archiveDir)
			strictEqual(listing.active.length, 0)
		})
	})

	it("lists metadata without hashing shard contents", async () => {
		await withArchive(async (archiveDir) => {
			const generationId = randomUUID()
			seedActiveGeneration(archiveDir, "logs", "2026-06-01", generationId, 3)
			const shardPath = join(
				shardsRoot(archiveDir, "logs", "2026-06-01", generationId),
				"00-0000.parquet",
			)
			writeFileSync(shardPath, "XXXX")
			const listing = listActiveGenerations(archiveDir)
			strictEqual(listing.integrity, "metadata-only")
			strictEqual(listing.active.length, 1)
		})
	})

	it("explicit verification streams multi-buffer shards and rejects same-size tampering", async () => {
		await withArchive(async (archiveDir) => {
			const generationId = randomUUID()
			const content = Buffer.alloc(ARCHIVE_VERIFY_BUFFER_BYTES * 2 + 17, 0x61)
			const shardsDir = shardsRoot(archiveDir, "logs", "2026-06-01", generationId)
			mkdirSync(shardsDir, { recursive: true })
			const shardPath = join(shardsDir, "00-0000.parquet")
			writeFileSync(shardPath, content)
			writeFileSync(
				generationManifestPath(archiveDir, "logs", "2026-06-01", generationId),
				`${JSON.stringify(
					manifest(
						generationId,
						"logs",
						"2026-06-01",
						3,
						createHash("sha256").update(content).digest("hex"),
						content.length,
					),
				)}\n`,
			)
			writeFileSync(
				activePointerPath(archiveDir, "logs", "2026-06-01"),
				`${JSON.stringify({
					formatVersion: 1,
					generationId,
					signal: "logs",
					rangeStart: "2026-06-01",
					selectedAt: "2026-06-02T00:00:00.000Z",
				})}\n`,
			)
			const verified = await verifyActiveGenerations(archiveDir, "logs")
			strictEqual(verified.shardCount, 1)
			strictEqual(verified.verifiedBytes, content.length)
			content[0] = 0x62
			writeFileSync(shardPath, content)
			await rejects(verifyActiveGenerations(archiveDir, "logs"), /SHA-256 mismatch/)
		})
	})

	it("resolves active parquet paths across ranges in ascending order", async () => {
		await withArchive(async (archiveDir) => {
			seedActiveGeneration(archiveDir, "logs", "2026-06-02", randomUUID(), 3)
			seedActiveGeneration(archiveDir, "logs", "2026-06-01", randomUUID(), 7)
			const paths = activeParquetPaths(archiveDir, "logs")
			strictEqual(paths.length, 2)
			// Ascending range order: June 1 before June 2.
			ok(paths[0]!.includes("2026-06-01"))
			ok(paths[1]!.includes("2026-06-02"))
		})
	})

	it("skips a malformed active pointer without hiding other ranges", async () => {
		await withArchive(async (archiveDir) => {
			seedActiveGeneration(archiveDir, "traces", "2026-06-01", randomUUID(), 4)
			// Corrupt the pointer for a second range.
			mkdirSync(join(archiveDir, "traces", "2026-06-02"), { recursive: true })
			writeFileSync(activePointerPath(archiveDir, "traces", "2026-06-02"), "{bad json")
			const listing = listActiveGenerations(archiveDir)
			strictEqual(listing.active.length, 1)
			strictEqual(listing.active[0]!.rangeStart, "2026-06-01")
		})
	})

	it("activeParquetPaths throws when any relevant range is malformed (no partial DuckDB output)", async () => {
		await withArchive(async (archiveDir) => {
			seedActiveGeneration(archiveDir, "traces", "2026-06-01", randomUUID(), 4)
			// Corrupt the pointer for a second range of the SAME signal.
			mkdirSync(join(archiveDir, "traces", "2026-06-02"), { recursive: true })
			writeFileSync(activePointerPath(archiveDir, "traces", "2026-06-02"), "{bad json")
			throwsSync(() => activeParquetPaths(archiveDir, "traces"), /malformed range/)
		})
	})

	it("activeParquetPaths succeeds when a DIFFERENT signal has errors", async () => {
		await withArchive(async (archiveDir) => {
			seedActiveGeneration(archiveDir, "traces", "2026-06-01", randomUUID(), 4)
			// Corrupt a LOGS range; traces must still be queryable.
			mkdirSync(join(archiveDir, "logs", "2026-06-02"), { recursive: true })
			writeFileSync(activePointerPath(archiveDir, "logs", "2026-06-02"), "{bad json")
			const paths = activeParquetPaths(archiveDir, "traces")
			strictEqual(paths.length, 1)
		})
	})
})

describe("archive catalog rebuild", () => {
	it("serializes operator rebuilds with archive create and GC", async () => {
		await withArchive(async (archiveDir) => {
			const dataDir = join(archiveDir, "..", "data")
			mkdirSync(dataDir, { recursive: true })
			await withMaintenanceLock(dataDir, randomUUID(), async () => {
				await rejects(
					rebuildCatalogWithMaintenanceLock(dataDir, archiveDir, "traces", randomUUID()),
					/maintenance.*(?:active|busy|held)|live owner/i,
				)
			})
		})
	})

	it("rebuilds the catalog from manifests after truncation, including superseded generations", async () => {
		await withArchive(async (archiveDir) => {
			const old = randomUUID()
			const active = randomUUID()
			seedSupersededGeneration(archiveDir, "traces", "2026-06-01", old, 5)
			seedActiveGeneration(archiveDir, "traces", "2026-06-01", active, 10)
			// Truncate the catalog if it exists, then rebuild.
			const entries = await rebuildCatalog(archiveDir, "traces")
			// Both the superseded and the active generation appear, because the
			// catalog indexes all retained generations.
			strictEqual(entries.length, 2)
			const ids = entries.map((e) => e.generationId).sort()
			deepStrictEqual(ids, [active, old].sort())
			ok(existsSync(catalogPath(archiveDir, "traces")))
		})
	})

	it("fails closed and preserves the existing catalog when a generation is missing its manifest", async () => {
		await withArchive(async (archiveDir) => {
			// Seed a valid active generation first and build its catalog.
			seedActiveGeneration(archiveDir, "traces", "2026-06-01", randomUUID(), 8)
			await rebuildCatalog(archiveDir, "traces")
			const catalogFile = catalogPath(archiveDir, "traces")
			const originalCatalog = readFileSync(catalogFile, "utf8")
			// Add a stray generation dir with no manifest.
			const stray = randomUUID()
			mkdirSync(generationsRoot(archiveDir, "traces", "2026-06-01"), { recursive: true })
			mkdirSync(join(generationsRoot(archiveDir, "traces", "2026-06-01"), stray), { recursive: true })
			// Rebuild must THROW (preflight fails) and preserve the existing catalog.
			await rejects(rebuildCatalog(archiveDir, "traces"), /missing its manifest/)
			strictEqual(
				readFileSync(catalogFile, "utf8"),
				originalCatalog,
				"existing catalog preserved on error",
			)
		})
	})

	it("produces a catalog with one valid JSON line per generation", async () => {
		await withArchive(async (archiveDir) => {
			seedActiveGeneration(archiveDir, "logs", "2026-06-01", randomUUID(), 12)
			await rebuildCatalog(archiveDir, "logs")
			const lines = readFileSync(catalogPath(archiveDir, "logs"), "utf8").trim().split("\n")
			strictEqual(lines.length, 1)
			const entry = JSON.parse(lines[0]!) as { signal: string; archivedRowCount: number }
			strictEqual(entry.signal, "logs")
			strictEqual(entry.archivedRowCount, 12)
		})
	})
})

const sha256Hex = (content: string): string => createHash("sha256").update(content).digest("hex")

const throwsSync = (fn: () => unknown, pattern: RegExp): void => {
	try {
		fn()
		throw new Error("expected function to throw")
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		if (!pattern.test(msg)) throw new Error(`expected ${pattern}, got: ${msg}`)
	}
}
