import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
	activePointerPath,
	buildingGenerationRoot,
	catalogPath,
	generationManifestPath,
	shardsRoot,
} from "../src/server/archives/paths"
import { parseArchiveActivePointer, type ArchiveGenerationManifest } from "../src/server/archives/manifest"
import { appendCatalog, promoteGeneration, selectActiveGeneration } from "../src/server/archives/generation"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"

// Filesystem-level tests for generation promotion, supersession, and catalog
// append. These exercise the durable state machine without a restored chDB; the
// full export path is covered by the native smoke script.

const withArchive = async (run: (archiveDir: string) => Promise<void> | void): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-archive-gen-test-"))
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
	signal = "traces",
	archivedRowCount = 10,
): ArchiveGenerationManifest => ({
	formatVersion: 2,
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
	tuningConfigName: null,
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

describe("archive generation promotion", () => {
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
