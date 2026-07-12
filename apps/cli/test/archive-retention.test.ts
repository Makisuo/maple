import { describe, it } from "@effect/vitest"
import { rejects, strictEqual } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expireArchiveDay, retireLiveDay } from "../src/server/archives/retention"
import { ARCHIVE_SIGNALS } from "../src/server/archives/signals"
import {
	activePointerPath,
	generationManifestPath,
	nextMidnightUtc,
	rangeRoot,
	shardsRoot,
} from "../src/server/archives/paths"
import { rebuildCatalog } from "../src/server/archives/listing"
import type { ArchiveGenerationManifest } from "../src/server/archives/manifest"
import { CHDB_VERSION, MAPLE_VERSION } from "../src/version"
import { SCHEMA_FINGERPRINT } from "../src/server/serve"

const seed = (archiveDir: string, signal: string, date: string): string => {
	const generationId = randomUUID()
	const shardDir = shardsRoot(archiveDir, signal, date, generationId)
	mkdirSync(shardDir, { recursive: true })
	const shard = join(shardDir, "00.parquet")
	writeFileSync(shard, "PAR1")
	const manifest: ArchiveGenerationManifest = {
		formatVersion: 3,
		generationId,
		signal,
		rangeStart: date,
		rangeEndExclusive: nextMidnightUtc(date),
		checkpointId: randomUUID(),
		checkpointManifestFingerprint: "checkpoint:test:4",
		createdAt: new Date().toISOString(),
		mapleVersion: MAPLE_VERSION,
		chdbVersion: CHDB_VERSION,
		schemaFingerprint: SCHEMA_FINGERPRINT,
		sourceRowCount: 1,
		archivedRowCount: 1,
		tuning: {
			writerThreads: 1,
			rowGroupRows: 1,
			maxShardRows: 1,
			maxShardBytes: 1024,
			targetChunkBytes: 1024,
			minFreeSpaceReserve: 1,
		},
		tuningConfig: null,
		shards: [
			{
				name: "00.parquet",
				rowCount: 1,
				minEventTimeUnixNano: `${BigInt(Date.parse(`${date}T00:00:00.000Z`)) * 1_000_000n}`,
				maxEventTimeUnixNano: `${BigInt(Date.parse(`${date}T00:30:00.000Z`)) * 1_000_000n}`,
				sha256: createHash("sha256").update("PAR1").digest("hex"),
				bytes: statSync(shard).size,
				columns: ["Timestamp"],
				complexDigest: "1",
				complexDigestAlgorithm: "cityhash64-multiset-v3",
			},
		],
	}
	writeFileSync(
		generationManifestPath(archiveDir, signal, date, generationId),
		`${JSON.stringify(manifest)}\n`,
	)
	writeFileSync(
		activePointerPath(archiveDir, signal, date),
		`${JSON.stringify({ formatVersion: 1, generationId, signal, rangeStart: date, selectedAt: new Date().toISOString() })}\n`,
	)
	return generationId
}

const fixture = async (run: (dataDir: string, archiveDir: string) => Promise<void>): Promise<void> => {
	const root = mkdtempSync(join(tmpdir(), "maple-retention-"))
	const dataDir = join(root, "data")
	const archiveDir = join(root, "archive")
	mkdirSync(dataDir)
	mkdirSync(archiveDir)
	try {
		await run(dataDir, archiveDir)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

describe("archive active-day expiration", () => {
	it("expires one complete day across all six signals", async () =>
		fixture(async (dataDir, archiveDir) => {
			const date = "2026-01-01"
			for (const signal of ARCHIVE_SIGNALS) seed(archiveDir, signal.name, date)
			for (const signal of ARCHIVE_SIGNALS) await rebuildCatalog(archiveDir, signal.name)
			await expireArchiveDay(dataDir, archiveDir, date)
			for (const signal of ARCHIVE_SIGNALS)
				strictEqual(existsSync(rangeRoot(archiveDir, signal.name, date)), false)
		}))

	it("fails closed when any signal is missing", async () =>
		fixture(async (dataDir, archiveDir) => {
			const date = "2026-01-01"
			for (const signal of ARCHIVE_SIGNALS.slice(1)) seed(archiveDir, signal.name, date)
			for (const signal of ARCHIVE_SIGNALS.slice(1)) await rebuildCatalog(archiveDir, signal.name)
			await rejects(expireArchiveDay(dataDir, archiveDir, date), /lacks one active logs generation/)
			strictEqual(existsSync(rangeRoot(archiveDir, "traces", date)), true)
		}))

	it("resumes after a range was tombstoned but not journaled complete", async () =>
		fixture(async (dataDir, archiveDir) => {
			const date = "2026-01-01"
			const archivedGenerations: Record<string, string> = {}
			for (const signal of ARCHIVE_SIGNALS)
				archivedGenerations[signal.name] = seed(archiveDir, signal.name, date)
			for (const signal of ARCHIVE_SIGNALS) await rebuildCatalog(archiveDir, signal.name)
			const tombParent = join(archiveDir, ".retention", "expired", date)
			mkdirSync(tombParent, { recursive: true })
			writeFileSync(
				join(archiveDir, ".retention", "expire.json"),
				`${JSON.stringify({ formatVersion: 1, operationId: randomUUID(), rangeDate: date, completedSignals: [], archivedGenerations })}\n`,
			)
			renameSync(rangeRoot(archiveDir, "logs", date), join(tombParent, "logs"))
			await expireArchiveDay(dataDir, archiveDir, date)
			for (const signal of ARCHIVE_SIGNALS)
				strictEqual(existsSync(rangeRoot(archiveDir, signal.name, date)), false)
		}))
})

describe("verified live-day retirement", () => {
	it("drops all raw partitions only after live/archive counts match", async () =>
		fixture(async (dataDir, archiveDir) => {
			const date = "2026-01-01"
			for (const signal of ARCHIVE_SIGNALS) seed(archiveDir, signal.name, date)
			for (const signal of ARCHIVE_SIGNALS) await rebuildCatalog(archiveDir, signal.name)
			const counts = new Map(ARCHIVE_SIGNALS.map((s) => [s.name, 1]))
			const query = async (_port: number, sql: string): Promise<unknown> => {
				const table = ARCHIVE_SIGNALS.find(
					(s) => sql.includes(`TABLE ${s.name}`) || sql.includes(`FROM ${s.name}`),
				)?.name
				if (!table) throw new Error("unknown table")
				if (sql.startsWith("ALTER TABLE")) {
					counts.set(table, 0)
					return []
				}
				return [{ count: counts.get(table) }]
			}
			await retireLiveDay({ dataDir, archiveDir, rangeDate: date, port: 4418, query })
			for (const signal of ARCHIVE_SIGNALS) strictEqual(counts.get(signal.name), 0)
		}))

	it("fails closed before dropping live data when an archived shard is corrupt", async () =>
		fixture(async (dataDir, archiveDir) => {
			const date = "2026-01-01"
			const generations = new Map<string, string>()
			for (const signal of ARCHIVE_SIGNALS)
				generations.set(signal.name, seed(archiveDir, signal.name, date))
			for (const signal of ARCHIVE_SIGNALS) await rebuildCatalog(archiveDir, signal.name)
			writeFileSync(
				join(shardsRoot(archiveDir, "logs", date, generations.get("logs")!), "00.parquet"),
				"NOPE",
			)
			let queryCalls = 0
			const query = async (): Promise<unknown> => {
				queryCalls++
				return [{ count: 1 }]
			}
			await rejects(
				retireLiveDay({ dataDir, archiveDir, rangeDate: date, port: 4418, query }),
				/SHA-256 mismatch/,
			)
			strictEqual(queryCalls, 0)
		}))

	it("resumes when one partition was dropped before progress was journaled", async () =>
		fixture(async (dataDir, archiveDir) => {
			const date = "2026-01-01"
			const archivedGenerations: Record<string, string> = {}
			for (const signal of ARCHIVE_SIGNALS)
				archivedGenerations[signal.name] = seed(archiveDir, signal.name, date)
			for (const signal of ARCHIVE_SIGNALS) await rebuildCatalog(archiveDir, signal.name)
			const archivedCounts = Object.fromEntries(ARCHIVE_SIGNALS.map((s) => [s.name, 1]))
			mkdirSync(join(dataDir, "retention"), { recursive: true })
			writeFileSync(
				join(dataDir, "retention", "retire-live.json"),
				`${JSON.stringify({ formatVersion: 1, operationId: randomUUID(), rangeDate: date, completedSignals: [], archivedCounts, archivedGenerations })}\n`,
			)
			const counts = new Map(ARCHIVE_SIGNALS.map((s) => [s.name, s.name === "logs" ? 0 : 1]))
			const query = async (_port: number, sql: string): Promise<unknown> => {
				const table = ARCHIVE_SIGNALS.find(
					(s) => sql.includes(`TABLE ${s.name}`) || sql.includes(`FROM ${s.name}`),
				)?.name
				if (!table) throw new Error("unknown table")
				if (sql.startsWith("ALTER TABLE")) {
					counts.set(table, 0)
					return []
				}
				return [{ count: counts.get(table) }]
			}
			await retireLiveDay({ dataDir, archiveDir, rangeDate: date, port: 4418, query })
			for (const signal of ARCHIVE_SIGNALS) strictEqual(counts.get(signal.name), 0)
		}))
})
