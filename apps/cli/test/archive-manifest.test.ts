import { describe, it } from "@effect/vitest"
import { ok, strictEqual, throws } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
	activePointerPath,
	catalogPath,
	generationManifestPath,
	generationsRoot,
	rangeRoot,
} from "../src/server/archives/paths"
import { parseArchiveActivePointer, parseArchiveGenerationManifest } from "../src/server/archives/manifest"
import { TUNING_CONFIG_FORMAT_VERSION } from "../src/server/archives/config"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"
import { randomUUID } from "node:crypto"

const withArchive = async (run: (archiveDir: string) => Promise<void> | void): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-archive-manifest-test-"))
	const archiveDir = join(parent, "archive")
	mkdirSync(archiveDir, { recursive: true })
	try {
		await run(archiveDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const validGenerationManifest = (overrides: Record<string, unknown> = {}) => ({
	formatVersion: 3,
	generationId: randomUUID(),
	signal: "traces",
	rangeStart: "2026-06-01",
	rangeEndExclusive: "2026-06-02T00:00:00.000Z",
	checkpointId: randomUUID(),
	checkpointManifestFingerprint: "cid:2026-01-01:100",
	createdAt: "2026-06-02T00:00:00.000Z",
	mapleVersion: MAPLE_VERSION,
	chdbVersion: CHDB_VERSION,
	schemaFingerprint: SCHEMA_FINGERPRINT,
	sourceRowCount: 100,
	archivedRowCount: 100,
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
			rowCount: 100,
			minEventTimeUnixNano: `${BigInt(Date.parse("2026-06-01T00:00:00.000Z")) * 1_000_000n}`,
			maxEventTimeUnixNano: `${BigInt(Date.parse("2026-06-01T00:30:00.000Z")) * 1_000_000n}`,
			sha256: "a".repeat(64),
			bytes: 4096,
			columns: ["TimestampTime", "ServiceName"],
			complexDigest: "123456789",
			complexDigestAlgorithm: "cityhash64-multiset-v3",
		},
	],
	...overrides,
})

describe("archive generation manifest parser", () => {
	it("parses a valid manifest and binds it to its location", () => {
		const generationId = randomUUID()
		const manifest = validGenerationManifest({ generationId })
		const parsed = parseArchiveGenerationManifest(manifest, "traces", "2026-06-01", generationId)
		strictEqual(parsed.generationId, generationId)
		strictEqual(parsed.signal, "traces")
		strictEqual(parsed.shards.length, 1)
		strictEqual(parsed.shards[0]!.bytes, 4096)
	})

	it("rejects an unknown (future) format version", () => {
		throws(
			() => parseArchiveGenerationManifest({ ...validGenerationManifest(), formatVersion: 99 }),
			/unsupported archive manifest formatVersion 99/,
		)
	})

	it("rejects an older (v1) format version fail-closed (round 5)", () => {
		// A round-4 v1 manifest carried timezone-dependent time evidence and a
		// commutative digest; the reader must not silently re-interpret it.
		throws(
			() => parseArchiveGenerationManifest({ ...validGenerationManifest(), formatVersion: 1 }),
			/unsupported archive manifest formatVersion 1/,
		)
	})

	it("rejects a v2 manifest fail-closed (config-identity semantics changed)", () => {
		// v3 introduced the structured, SHA-256-bound tuningConfig identity. A v2
		// manifest (bare tuningConfigName) is incompatible; silently treating the
		// missing field as null would lose the config identity. Re-export required.
		throws(
			() => parseArchiveGenerationManifest({ ...validGenerationManifest(), formatVersion: 2 }),
			/unsupported archive manifest formatVersion 2.*v3 introduced the structured tuningConfig identity/,
		)
	})

	it("rejects a signal mismatch with its directory", () => {
		throws(
			() => parseArchiveGenerationManifest(validGenerationManifest(), "logs", "2026-06-01"),
			/signal mismatch/,
		)
	})

	it("rejects a range mismatch with its directory", () => {
		throws(
			() => parseArchiveGenerationManifest(validGenerationManifest(), "traces", "2026-06-02"),
			/range mismatch/,
		)
	})

	it("rejects a generation id mismatch with its directory", () => {
		throws(
			() =>
				parseArchiveGenerationManifest(
					validGenerationManifest(),
					"traces",
					"2026-06-01",
					randomUUID(),
				),
			/generation mismatch/,
		)
	})

	it("rejects an unknown signal name", () => {
		throws(
			() => parseArchiveGenerationManifest(validGenerationManifest({ signal: "bogus" })),
			/unknown archive signal/,
		)
	})

	it("rejects a negative source row count", () => {
		throws(
			() => parseArchiveGenerationManifest(validGenerationManifest({ sourceRowCount: -1 })),
			/sourceRowCount/,
		)
	})

	it("rejects parseable but non-canonical manifest timestamps", () => {
		for (const [field, value] of [
			["createdAt", "2026-06-02T02:00:00.000+02:00"],
			["createdAt", "2026-06-02T00:00:00Z"],
			["rangeEndExclusive", "2026-06-02 00:00:00Z"],
		] as const) {
			throws(
				() => parseArchiveGenerationManifest(validGenerationManifest({ [field]: value })),
				/invalid archive manifest field|canonical UTC ISO-8601/i,
			)
		}
	})

	it("rejects a malformed shard name", () => {
		const bad = validGenerationManifest({
			shards: [{ ...validGenerationManifest().shards[0]!, name: "../escape.parquet" }],
		})
		throws(() => parseArchiveGenerationManifest(bad), /shard name/)
	})

	it("rejects a missing tuning block", () => {
		const bad = validGenerationManifest()
		delete (bad as Record<string, unknown>).tuning
		throws(() => parseArchiveGenerationManifest(bad), /tuning/)
	})

	it("rejects an unknown top-level key", () => {
		throws(
			() => parseArchiveGenerationManifest(validGenerationManifest({ rogue: true })),
			/unknown archive manifest field: rogue/,
		)
	})

	it("reads a manifest from disk bound to its location", async () => {
		await withArchive(async (archiveDir) => {
			const { readArchiveGenerationManifest } = await import("../src/server/archives/manifest")
			const generationId = randomUUID()
			const manifestPath = generationManifestPath(archiveDir, "traces", "2026-06-01", generationId)
			mkdirSync(dirname(manifestPath), { recursive: true })
			writeFileSync(manifestPath, `${JSON.stringify(validGenerationManifest({ generationId }))}\n`)
			const read = readArchiveGenerationManifest(archiveDir, "traces", "2026-06-01", generationId)
			strictEqual(read.generationId, generationId)
		})
	})
})

describe("archive active pointer parser", () => {
	it("parses a valid pointer", () => {
		const parsed = parseArchiveActivePointer({
			formatVersion: 1,
			generationId: randomUUID(),
			signal: "logs",
			rangeStart: "2026-06-01",
			selectedAt: "2026-06-02T00:00:00.000Z",
		})
		strictEqual(parsed.signal, "logs")
	})

	it("rejects an unknown format version", () => {
		throws(
			() =>
				parseArchiveActivePointer({
					formatVersion: 3,
					generationId: randomUUID(),
					signal: "logs",
					rangeStart: "2026-06-01",
					selectedAt: "2026-06-02T00:00:00.000Z",
				}),
			/unsupported/,
		)
	})
})

describe("archive path model", () => {
	it("places generations under signal/range/generations", async () => {
		await withArchive(async (archiveDir) => {
			const gen = generationsRoot(archiveDir, "traces", "2026-06-01")
			ok(gen.endsWith(join("traces", "2026-06-01", "generations")))
		})
	})

	it("rejects an invalid range date", () => {
		throws(() => rangeRoot("/tmp/a", "traces", "2026-6-1"), /range date/)
	})

	it("rejects a malformed generation id in path construction", () => {
		throws(() => generationManifestPath("/tmp/a", "traces", "2026-06-01", "not-a-uuid"), /generation/)
	})

	it("catalog and active pointer live under the signal/range roots", async () => {
		await withArchive(async (archiveDir) => {
			const cat = catalogPath(archiveDir, "traces")
			ok(cat.endsWith(join("traces", "catalog.jsonl")))
			const active = activePointerPath(archiveDir, "traces", "2026-06-01")
			ok(active.endsWith(join("traces", "2026-06-01", "active.json")))
		})
	})
})

describe("archive manifest tuningConfig identity", () => {
	it("parses a structured tuningConfig identity (configName + sha256 + formatVersion)", () => {
		const generationId = randomUUID()
		const manifest = validGenerationManifest({
			generationId,
			tuningConfig: { formatVersion: 1, configName: "calib-2026.json", sha256: "b".repeat(64) },
		})
		const parsed = parseArchiveGenerationManifest(manifest, "traces", "2026-06-01", generationId)
		ok(parsed.tuningConfig !== null)
		strictEqual(parsed.tuningConfig!.configName, "calib-2026.json")
		strictEqual(parsed.tuningConfig!.sha256, "b".repeat(64))
		strictEqual(parsed.tuningConfig!.formatVersion, 1)
	})

	it("preserves a loaded format-2 calibration config identity", () => {
		const generationId = randomUUID()
		const manifest = validGenerationManifest({
			generationId,
			tuningConfig: { formatVersion: 2, configName: "phase3b-tuning.json", sha256: "c".repeat(64) },
		})
		const parsed = parseArchiveGenerationManifest(manifest, "traces", "2026-06-01", generationId)
		strictEqual(parsed.tuningConfig!.formatVersion, 2)
		strictEqual(parsed.tuningConfig!.configName, "phase3b-tuning.json")
	})

	it("preserves a current format-3 calibration config identity", () => {
		const generationId = randomUUID()
		const manifest = validGenerationManifest({
			generationId,
			tuningConfig: {
				formatVersion: TUNING_CONFIG_FORMAT_VERSION,
				configName: "new-tuning.json",
				sha256: "d".repeat(64),
			},
		})
		const parsed = parseArchiveGenerationManifest(manifest, "traces", "2026-06-01", generationId)
		strictEqual(parsed.tuningConfig!.formatVersion, TUNING_CONFIG_FORMAT_VERSION)
	})

	it("accepts null tuningConfig (no config loaded)", () => {
		const generationId = randomUUID()
		const manifest = validGenerationManifest({ generationId, tuningConfig: null })
		const parsed = parseArchiveGenerationManifest(manifest, "traces", "2026-06-01", generationId)
		strictEqual(parsed.tuningConfig, null)
	})

	it("rejects a v3 manifest missing the tuningConfig key", () => {
		const manifest = validGenerationManifest()
		delete (manifest as Record<string, unknown>).tuningConfig
		throws(() => parseArchiveGenerationManifest(manifest), /tuningConfig \(required in formatVersion 3\)/)
	})

	it("rejects a legacy-shaped v3 manifest with tuningConfigName but no tuningConfig key", () => {
		const manifest = validGenerationManifest({ tuningConfigName: "calib-2026.json" })
		delete (manifest as Record<string, unknown>).tuningConfig
		throws(() => parseArchiveGenerationManifest(manifest), /tuningConfig \(required in formatVersion 3\)/)
	})

	it("rejects a tuningConfig with a malformed sha256", () => {
		const generationId = randomUUID()
		const manifest = validGenerationManifest({
			generationId,
			tuningConfig: { formatVersion: 1, configName: "c.json", sha256: "tooshort" },
		})
		throws(
			() => parseArchiveGenerationManifest(manifest, "traces", "2026-06-01", generationId),
			/must be 64 hex chars/,
		)
	})

	it("rejects an unknown tuningConfig subfield", () => {
		const generationId = randomUUID()
		const manifest = validGenerationManifest({
			generationId,
			tuningConfig: { formatVersion: 1, configName: "c.json", sha256: "b".repeat(64), rogue: "x" },
		})
		throws(
			() => parseArchiveGenerationManifest(manifest, "traces", "2026-06-01", generationId),
			/unknown archive manifest tuningConfig field: rogue/,
		)
	})

	it("rejects an unsafe tuningConfig configName", () => {
		const generationId = randomUUID()
		const manifest = validGenerationManifest({
			generationId,
			tuningConfig: { formatVersion: 1, configName: "../evil", sha256: "b".repeat(64) },
		})
		throws(
			() => parseArchiveGenerationManifest(manifest, "traces", "2026-06-01", generationId),
			/unsafe name/,
		)
	})
})

describe("archive manifest tuning", () => {
	it("rejects all-zero tuning", () => {
		throws(
			() =>
				parseArchiveGenerationManifest(
					validGenerationManifest({
						tuning: {
							writerThreads: 0,
							rowGroupRows: 0,
							maxShardRows: 0,
							maxShardBytes: 0,
							targetChunkBytes: 0,
							minFreeSpaceReserve: 0,
						},
					}),
				),
			/tuning field: writerThreads \(must be a positive integer\)/,
		)
	})

	it("rejects writerThreads greater than 32", () => {
		const tuning = validGenerationManifest().tuning
		throws(
			() =>
				parseArchiveGenerationManifest(
					validGenerationManifest({ tuning: { ...tuning, writerThreads: 33 } }),
				),
			/writerThreads must not exceed 32/,
		)
	})

	it("rejects rowGroupRows greater than maxShardRows", () => {
		const tuning = validGenerationManifest().tuning
		throws(
			() =>
				parseArchiveGenerationManifest(
					validGenerationManifest({
						tuning: { ...tuning, rowGroupRows: tuning.maxShardRows + 1 },
					}),
				),
			/rowGroupRows must not exceed maxShardRows/,
		)
	})

	it("rejects maxShardBytes smaller than rowGroupRows * 1024", () => {
		const tuning = validGenerationManifest().tuning
		throws(
			() =>
				parseArchiveGenerationManifest(
					validGenerationManifest({
						tuning: {
							...tuning,
							maxShardBytes: tuning.rowGroupRows * 1024 - 1,
						},
					}),
				),
			/maxShardBytes .* is too small for rowGroupRows/,
		)
	})

	it("rejects minFreeSpaceReserve greater than or equal to targetChunkBytes", () => {
		const tuning = validGenerationManifest().tuning
		throws(
			() =>
				parseArchiveGenerationManifest(
					validGenerationManifest({
						tuning: {
							...tuning,
							minFreeSpaceReserve: tuning.targetChunkBytes,
						},
					}),
				),
			/minFreeSpaceReserve must be smaller than targetChunkBytes/,
		)
	})

	it("rejects an unknown tuning key", () => {
		const tuning = validGenerationManifest().tuning
		throws(
			() =>
				parseArchiveGenerationManifest(
					validGenerationManifest({ tuning: { ...tuning, rogue: true } }),
				),
			/unknown archive manifest tuning field: rogue/,
		)
	})
})
