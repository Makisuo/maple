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
	formatVersion: 1,
	generationId: randomUUID(),
	signal: "traces",
	rangeStart: "2026-06-01",
	rangeEndExclusive: "2026-06-01T23:59:59.999999999Z",
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
	tuningConfigName: null,
	shards: [
		{
			name: "00-0000.parquet",
			rowCount: 100,
			minEventTime: "2026-06-01T00:00:00.000Z",
			maxEventTime: "2026-06-01T00:30:00.000Z",
			sha256: "abc".repeat(22).slice(0, 64),
			bytes: 4096,
			columns: ["TimestampTime", "ServiceName"],
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

	it("rejects an unknown format version", () => {
		throws(
			() => parseArchiveGenerationManifest({ ...validGenerationManifest(), formatVersion: 2 }),
			/unsupported/,
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
					formatVersion: 2,
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
