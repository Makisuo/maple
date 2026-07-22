import { describe, it } from "@effect/vitest"
import { ok, rejects, strictEqual } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import {
	activePointerPath,
	assertNoSymlink,
	assertNoSymlinkSync,
	buildingGenerationRoot,
	catalogPath,
	ensurePrivateDirectory,
	generationManifestPath,
	rangeRoot,
	shardsRoot,
} from "../src/server/archives/paths"
import { appendCatalog, promoteGeneration } from "../src/server/archives/generation"
import { rebuildCatalog, listActiveGenerations } from "../src/server/archives/listing"
import { type ArchiveGenerationManifest } from "../src/server/archives/manifest"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"

// External-sentinel tests proving archive-root path escapes are closed (C-1).
// These mirror the reviewer's deterministic probes: a symlinked descendant must
// fail closed and the outside target must be untouched.

const withArchive = async (
	run: (archiveDir: string, outside: string) => Promise<void> | void,
): Promise<void> => {
	const parent = mkdtempSync(join(tmpdir(), "maple-archive-pathsafe-"))
	const archiveDir = join(parent, "archive")
	const outside = join(parent, "outside")
	mkdirSync(archiveDir, { recursive: true })
	mkdirSync(outside, { recursive: true })
	try {
		await run(archiveDir, outside)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

const manifest = (
	generationId: string,
	signal = "traces",
	rowCount = 10,
	shardSha = "a".repeat(64),
	shardBytes = 4096,
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
			minEventTimeUnixNano: `${BigInt(Date.parse("2026-06-01T00:00:00.000Z")) * 1_000_000n}`,
			maxEventTimeUnixNano: `${BigInt(Date.parse("2026-06-01T00:30:00.000Z")) * 1_000_000n}`,
			sha256: shardSha,
			bytes: shardBytes,
			columns: ["TimestampTime", "ServiceName"],
			complexDigest: "123456789",
			complexDigestAlgorithm: "cityhash64-multiset-v3",
		},
	],
})

const seedBuilding = (archiveDir: string, generationId: string): string => {
	const building = buildingGenerationRoot(archiveDir, generationId)
	const shards = join(building, "shards")
	mkdirSync(shards, { recursive: true })
	writeFileSync(join(shards, "00.parquet"), "PAR1-placeholder")
	return building
}

describe("archive path safety — symlink escapes (C-1)", () => {
	it("ensurePrivateDirectory creates a fresh archive root and nested dir safely", async () => {
		await withArchive(async (archiveDir) => {
			// A completely fresh nested path: archive root exists but the signal/
			// range/generations chain does not. Must create all without ENOENT.
			const nested = join(archiveDir, "traces", "2026-06-01", "generations", "sub")
			await ensurePrivateDirectory(nested, archiveDir)
			ok(existsSync(nested), "nested dir created")
		})
	})

	it("ensurePrivateDirectory refuses a symlinked ancestor beneath the archive root", async () => {
		await withArchive(async (archiveDir, outside) => {
			// <archive>/traces -> outside/traces-evil
			mkdirSync(join(outside, "traces-evil"), { recursive: true })
			symlinkSync(join(outside, "traces-evil"), join(archiveDir, "traces"))
			// Creating a dir under the symlinked signal root must fail.
			await rejects(
				ensurePrivateDirectory(join(archiveDir, "traces", "2026-06-01"), archiveDir),
				/symlink/,
			)
		})
	})

	it("assertNoSymlink refuses a symlinked signal root", async () => {
		await withArchive(async (archiveDir, outside) => {
			mkdirSync(join(outside, "traces-evil"), { recursive: true })
			symlinkSync(join(outside, "traces-evil"), join(archiveDir, "traces"))
			await rejects(
				assertNoSymlink(archiveDir, rangeRoot(archiveDir, "traces", "2026-06-01"), "test"),
				/symlink/,
			)
		})
	})

	it("assertNoSymlinkSync refuses a symlinked catalog path", async () => {
		await withArchive(async (archiveDir, outside) => {
			const sentinel = join(outside, "catalog-sentinel.jsonl")
			writeFileSync(sentinel, "sensitive")
			mkdirSync(signalRootPath(archiveDir, "traces"), { recursive: true })
			symlinkSync(sentinel, catalogPath(archiveDir, "traces"))
			throwsSync(
				() => assertNoSymlinkSync(archiveDir, catalogPath(archiveDir, "traces"), "catalog"),
				/symlink/,
			)
			// The outside sentinel is untouched.
			strictEqual(readFileSync(sentinel, "utf8"), "sensitive")
		})
	})

	it("promoteGeneration refuses a symlinked signal root and does not write outside", async () => {
		await withArchive(async (archiveDir, outside) => {
			// Point the signal root at an outside dir.
			mkdirSync(join(outside, "traces-out"), { recursive: true })
			symlinkSync(join(outside, "traces-out"), join(archiveDir, "traces"))
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
					{},
				),
				/symlink/,
			)
			// No generation manifest or pointer was created outside the root.
			ok(
				!existsSync(
					join(outside, "traces-out", "2026-06-01", "generations", generationId, "manifest.json"),
				),
			)
			ok(!existsSync(join(outside, "traces-out", "2026-06-01", "active.json")))
		})
	})

	it("appendCatalog refuses a symlinked catalog and leaves the outside target untouched", async () => {
		await withArchive(async (archiveDir, outside) => {
			const sentinel = join(outside, "catalog-sentinel.jsonl")
			writeFileSync(sentinel, "preserve")
			mkdirSync(signalRootPath(archiveDir, "traces"), { recursive: true })
			symlinkSync(sentinel, catalogPath(archiveDir, "traces"))
			await rejects(appendCatalog(archiveDir, "traces", manifest(randomUUID())), /symlink|real file/)
			strictEqual(readFileSync(sentinel, "utf8"), "preserve")
		})
	})

	it("rebuildCatalog refuses a symlinked catalog and leaves the outside target untouched", async () => {
		await withArchive(async (archiveDir, outside) => {
			const sentinel = join(outside, "catalog-sentinel.jsonl")
			writeFileSync(sentinel, "preserve")
			mkdirSync(signalRootPath(archiveDir, "traces"), { recursive: true })
			symlinkSync(sentinel, catalogPath(archiveDir, "traces"))
			await rejects(rebuildCatalog(archiveDir, "traces"), /symlink/)
			strictEqual(readFileSync(sentinel, "utf8"), "preserve")
		})
	})

	it("listActiveGenerations surfaces a malformed pointer as an error instead of silently skipping", async () => {
		await withArchive(async (archiveDir) => {
			// A valid active generation for traces/2026-06-01.
			const generationId = randomUUID()
			const shardsDir = shardsRoot(archiveDir, "traces", "2026-06-01", generationId)
			mkdirSync(shardsDir, { recursive: true })
			const shardContent = "PAR1"
			writeFileSync(join(shardsDir, "00-0000.parquet"), shardContent)
			const shardSha = createHash("sha256").update(shardContent).digest("hex")
			const shardBytes = shardContent.length
			writeFileSync(
				generationManifestPath(archiveDir, "traces", "2026-06-01", generationId),
				`${JSON.stringify(manifest(generationId, undefined, undefined, shardSha, shardBytes))}\n`,
			)
			writeFileSync(
				activePointerPath(archiveDir, "traces", "2026-06-01"),
				`${JSON.stringify({ formatVersion: 1, generationId, signal: "traces", rangeStart: "2026-06-01", selectedAt: "2026-06-02T00:00:00.000Z" })}\n`,
			)
			// A malformed pointer for a second range.
			mkdirSync(rangeRoot(archiveDir, "traces", "2026-06-02"), { recursive: true })
			writeFileSync(activePointerPath(archiveDir, "traces", "2026-06-02"), "{bad json")
			const listing = listActiveGenerations(archiveDir)
			strictEqual(listing.active.length, 1)
			strictEqual(listing.active[0]!.rangeStart, "2026-06-01")
			ok(listing.errors.length >= 1, "malformed pointer surfaced as error")
			ok(
				listing.errors.some((e) => e.rangeStart === "2026-06-02"),
				"the corrupt range is named",
			)
		})
	})

	it("listActiveGenerations rejects a pointer whose recorded signal/range mismatches its directory", async () => {
		await withArchive(async (archiveDir) => {
			// Pointer physically under traces/2026-06-01 but claiming logs/2025-01-01.
			mkdirSync(rangeRoot(archiveDir, "traces", "2026-06-01"), { recursive: true })
			writeFileSync(
				activePointerPath(archiveDir, "traces", "2026-06-01"),
				`${JSON.stringify({ formatVersion: 1, generationId: randomUUID(), signal: "logs", rangeStart: "2025-01-01", selectedAt: "2026-06-02T00:00:00.000Z" })}\n`,
			)
			const listing = listActiveGenerations(archiveDir)
			strictEqual(listing.active.length, 0)
			ok(listing.errors.some((e) => e.rangeStart === "2026-06-01" && /mismatch/.test(e.error)))
		})
	})
})

describe("archive path safety — read-side symlink escapes (HIGH-1/HIGH-2)", () => {
	it("readArchiveGenerationManifest refuses a symlinked generation dir and does not read outside content", async () => {
		await withArchive(async (archiveDir, outside) => {
			const { readArchiveGenerationManifest } = await import("../src/server/archives/manifest")
			const generationId = randomUUID()
			// Plant a real generation outside the root with an attacker manifest.
			const outsideGen = join(outside, "evil-gen")
			mkdirSync(join(outsideGen, "shards"), { recursive: true })
			writeFileSync(join(outsideGen, "manifest.json"), `${JSON.stringify(manifest(generationId))}\n`)
			writeFileSync(join(outsideGen, "shards", "00.parquet"), "ATTACKER-SHARDS")
			// Symlink the in-root generation dir at the outside one.
			mkdirSync(generationsRootPath(archiveDir, "traces", "2026-06-01"), { recursive: true })
			symlinkSync(
				outsideGen,
				join(generationsRootPath(archiveDir, "traces", "2026-06-01"), generationId),
			)
			throwsSync(
				() => readArchiveGenerationManifest(archiveDir, "traces", "2026-06-01", generationId),
				/symlink/,
			)
		})
	})

	it("listActiveGenerations refuses a symlinked shard path and surfaces it as an error", async () => {
		await withArchive(async (archiveDir, outside) => {
			const generationId = randomUUID()
			// Build a valid generation with a real manifest + pointer.
			const shardsDir = shardsRoot(archiveDir, "traces", "2026-06-01", generationId)
			mkdirSync(shardsDir, { recursive: true })
			writeFileSync(join(shardsDir, "00.parquet"), "PAR1")
			writeFileSync(
				generationManifestPath(archiveDir, "traces", "2026-06-01", generationId),
				`${JSON.stringify(manifest(generationId))}\n`,
			)
			writeFileSync(
				activePointerPath(archiveDir, "traces", "2026-06-01"),
				`${JSON.stringify({ formatVersion: 1, generationId, signal: "traces", rangeStart: "2026-06-01", selectedAt: "2026-06-02T00:00:00.000Z" })}\n`,
			)
			// Now symlink the shard file at an outside target.
			writeFileSync(join(outside, "evil.parquet"), "ATTACKER-PARQUET")
			rmSync(join(shardsDir, "00.parquet"))
			symlinkSync(join(outside, "evil.parquet"), join(shardsDir, "00.parquet"))
			const listing = listActiveGenerations(archiveDir)
			// The symlinked shard must not appear in active paths.
			strictEqual(listing.active.length, 0)
			ok(
				listing.errors.some((e) => /shard path/.test(e.error)),
				"symlinked shard surfaced as error",
			)
		})
	})

	it("rebuildCatalog does not trust a symlinked generation dir's manifest", async () => {
		await withArchive(async (archiveDir, outside) => {
			const generationId = randomUUID()
			// Plant attacker manifest outside the root.
			const outsideGen = join(outside, "evil-gen")
			mkdirSync(join(outsideGen, "shards"), { recursive: true })
			writeFileSync(join(outsideGen, "manifest.json"), `${JSON.stringify(manifest(generationId))}\n`)
			// Symlink the in-root generation at the outside one.
			mkdirSync(generationsRootPath(archiveDir, "traces", "2026-06-01"), { recursive: true })
			symlinkSync(
				outsideGen,
				join(generationsRootPath(archiveDir, "traces", "2026-06-01"), generationId),
			)
			// rebuildCatalog must THROW (symlink detected at preflight) and not
			// trust the attacker's manifest.
			await rejects(rebuildCatalog(archiveDir, "traces"), /symlink/)
		})
	})
})

const signalRootPath = (archiveDir: string, signal: string): string => join(archiveDir, signal)

const generationsRootPath = (archiveDir: string, signal: string, rangeDate: string): string =>
	join(archiveDir, signal, rangeDate, "generations")

const throwsSync = (fn: () => unknown, pattern: RegExp): void => {
	try {
		fn()
		throw new Error("expected function to throw")
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error)
		if (!pattern.test(msg)) throw new Error(`expected ${pattern}, got: ${msg}`)
	}
}
