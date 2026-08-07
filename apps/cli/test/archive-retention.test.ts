import { describe, it } from "@effect/vitest"
import { rejects, strictEqual, throws } from "node:assert"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	assertSealedUtcDay,
	expireArchiveDay,
	parseRetiredDayLedger,
	readRetiredDayLedger,
	retiredDayLedgerPath,
	RetiredDayAuthority,
	retireLiveDayInServer,
} from "../src/server/archives/retention"
import { ARCHIVE_SIGNALS, type ArchiveSignalName } from "../src/server/archives/signals"
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
import { RequestQuiescenceGate, SCHEMA_FINGERPRINT } from "../src/server/serve"

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

const seed = (archiveDir: string, signal: ArchiveSignalName, date: string): string => {
	const generationId = randomUUID()
	const shardDir = shardsRoot(archiveDir, signal, date, generationId)
	mkdirSync(shardDir, { recursive: true })
	const shard = join(shardDir, "00.parquet")
	writeFileSync(shard, "PAR1")
	const eventTimeColumn = ARCHIVE_SIGNALS.find((candidate) => candidate.name === signal)!.eventTimeColumn
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
				sha256: sha256("PAR1"),
				bytes: statSync(shard).size,
				columns: [eventTimeColumn],
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

const fixture = async (
	run: (root: string, dataDir: string, archiveDir: string, scratchRoot: string) => Promise<void>,
): Promise<void> => {
	const root = mkdtempSync(join(tmpdir(), "maple-retention-"))
	const dataDir = join(root, "data")
	const archiveDir = join(root, "archive")
	const scratchRoot = join(root, "scratch")
	mkdirSync(dataDir)
	mkdirSync(archiveDir)
	mkdirSync(scratchRoot)
	try {
		await run(root, dataDir, archiveDir, scratchRoot)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

const seedCompleteDay = async (
	archiveDir: string,
	date: string,
): Promise<Record<ArchiveSignalName, string>> => {
	const generations = Object.fromEntries(
		ARCHIVE_SIGNALS.map((signal) => [signal.name, seed(archiveDir, signal.name, date)]),
	) as Record<ArchiveSignalName, string>
	for (const signal of ARCHIVE_SIGNALS) await rebuildCatalog(archiveDir, signal.name)
	return generations
}

const mockDb = (options: {
	readonly date: string
	readonly liveDigest?: string
	readonly archiveDigest?: string
	readonly corruptDuringDigest?: () => void
}) => {
	const counts = new Map(ARCHIVE_SIGNALS.map((signal) => [signal.name, 1]))
	const execs: string[] = []
	let digestQueries = 0
	return {
		counts,
		execs,
		db: {
			query(sql: string): string {
				const described = ARCHIVE_SIGNALS.find(
					(signal) => sql === `DESCRIBE ${signal.name} FORMAT JSONEachRow`,
				)
				if (described)
					return `${JSON.stringify({ name: described.eventTimeColumn, type: "DateTime64(9)" })}\n`
				const counted = ARCHIVE_SIGNALS.find((signal) => sql.includes(`FROM ${signal.name} WHERE`))
				if (sql.startsWith("SELECT DISTINCT") && counted)
					return counts.get(counted.name) === 0
						? ""
						: `${JSON.stringify({ rangeDate: options.date })}\n`
				if (sql.startsWith("SELECT count()") && counted)
					return `${JSON.stringify({ count: counts.get(counted.name) })}\n`
				if (sql.startsWith("SELECT concat")) {
					digestQueries++
					if (digestQueries === 1) options.corruptDuringDigest?.()
					return `${JSON.stringify({ d: sql.includes("file('") ? (options.archiveDigest ?? "1:2:3:4") : (options.liveDigest ?? "1:2:3:4") })}\n`
				}
				throw new Error(`unexpected query: ${sql}`)
			},
			exec(sql: string): void {
				execs.push(sql)
				const signal = ARCHIVE_SIGNALS.find((candidate) => sql.includes(`TABLE ${candidate.name} `))
				if (!signal) throw new Error(`unexpected exec: ${sql}`)
				counts.set(signal.name, 0)
			},
		},
	}
}

const writeRetiredLedger = (
	dataDir: string,
	date: string,
	generations: Record<ArchiveSignalName, string>,
): void => {
	writeFileSync(
		retiredDayLedgerPath(dataDir),
		`${JSON.stringify({
			formatVersion: 1,
			retiredDays: [
				{
					rangeDate: date,
					retiredAt: "2026-01-03T00:00:00.000Z",
					signals: ARCHIVE_SIGNALS.map((signal) => ({
						signal: signal.name,
						generationId: generations[signal.name],
						manifestSha256: "a".repeat(64),
						archivedRowCount: 1,
						contentDigest: "1:2:3:4",
					})),
				},
			],
		})}\n`,
	)
}

describe("durable retired-day authority", () => {
	it("rejects malformed or non-canonical ledgers", () => {
		throws(
			() => parseRetiredDayLedger({ formatVersion: 1, retiredDays: [], extra: true }),
			/unknown field extra/,
		)
	})

	it("rejects late OTLP rows before insertion", async () =>
		fixture(async (_root, dataDir) => {
			const date = "2026-01-01"
			const generations = Object.fromEntries(
				ARCHIVE_SIGNALS.map((signal) => [signal.name, randomUUID()]),
			) as Record<ArchiveSignalName, string>
			writeRetiredLedger(dataDir, date, generations)
			const authority = new RetiredDayAuthority(dataDir)
			await rejects(
				async () =>
					authority.assertBatchAllowed(
						"logs",
						`${JSON.stringify({ timestamp: `${date} 12:00:00.000000000` })}`,
					),
				/retired UTC day/,
			)
		}))

	it("filters retired rows while preserving current rows in a mixed batch", async () =>
		fixture(async (_root, dataDir) => {
			const date = "2026-01-01"
			const generations = Object.fromEntries(
				ARCHIVE_SIGNALS.map((signal) => [signal.name, randomUUID()]),
			) as Record<ArchiveSignalName, string>
			writeRetiredLedger(dataDir, date, generations)
			const filtered = new RetiredDayAuthority(dataDir).filterBatch(
				"logs",
				[
					JSON.stringify({ timestamp: `${date} 12:00:00.000000000`, body: "late" }),
					JSON.stringify({ timestamp: "2026-01-04 12:00:00.000000000", body: "current" }),
				].join("\n"),
			)
			strictEqual(filtered.rejected, 1)
			strictEqual(filtered.accepted, 1)
			strictEqual(JSON.parse(filtered.ndjson).body, "current")
		}))

	it("replays retirement after checkpoint restoration before serving", async () =>
		fixture(async (_root, dataDir) => {
			const date = "2026-01-01"
			const generations = Object.fromEntries(
				ARCHIVE_SIGNALS.map((signal) => [signal.name, randomUUID()]),
			) as Record<ArchiveSignalName, string>
			writeRetiredLedger(dataDir, date, generations)
			const mocked = mockDb({ date })
			new RetiredDayAuthority(dataDir).replay(mocked.db)
			for (const signal of ARCHIVE_SIGNALS) strictEqual(mocked.counts.get(signal.name), 0)
			strictEqual(
				mocked.execs.every((sql) => sql.includes("toDate(") && sql.includes("'UTC'")),
				true,
			)
		}))
})

describe("server-coordinated live retirement", () => {
	it("commits authority before exact UTC deletion", async () =>
		fixture(async (_root, dataDir, archiveDir) => {
			await seedCompleteDay(archiveDir, "2026-01-01")
			const mocked = mockDb({ date: "2026-01-01" })
			await retireLiveDayInServer({
				db: mocked.db,
				authority: new RetiredDayAuthority(dataDir),
				archiveDir,
				rangeDate: "2026-01-01",
				now: Date.parse("2026-01-03T00:00:00.000Z"),
			})
			strictEqual(readRetiredDayLedger(dataDir).retiredDays.length, 1)
			strictEqual(existsSync(join(dataDir, "retention")), false)
			strictEqual(mocked.execs.length, ARCHIVE_SIGNALS.length)
			strictEqual(
				mocked.execs.every((sql) => sql.includes("DELETE WHERE") && !sql.includes("DROP PARTITION")),
				true,
			)
		}))

	it("refuses equal-count, different-content data before deletion", async () =>
		fixture(async (_root, dataDir, archiveDir) => {
			await seedCompleteDay(archiveDir, "2026-01-01")
			const mocked = mockDb({
				date: "2026-01-01",
				liveDigest: "1:2:3:41",
				archiveDigest: "1:2:3:42",
			})
			await rejects(
				retireLiveDayInServer({
					db: mocked.db,
					authority: new RetiredDayAuthority(dataDir),
					archiveDir,
					rangeDate: "2026-01-01",
					now: Date.parse("2026-01-03T00:00:00.000Z"),
				}),
				/content digest mismatch/,
			)
			strictEqual(mocked.execs.length, 0)
			strictEqual(existsSync(retiredDayLedgerPath(dataDir)), false)
		}))

	it("re-hashes shards after evidence collection and before commit", async () =>
		fixture(async (_root, dataDir, archiveDir) => {
			const generations = await seedCompleteDay(archiveDir, "2026-01-01")
			const shard = join(shardsRoot(archiveDir, "logs", "2026-01-01", generations.logs), "00.parquet")
			const mocked = mockDb({
				date: "2026-01-01",
				corruptDuringDigest: () => writeFileSync(shard, "NOPE"),
			})
			await rejects(
				retireLiveDayInServer({
					db: mocked.db,
					authority: new RetiredDayAuthority(dataDir),
					archiveDir,
					rangeDate: "2026-01-01",
					now: Date.parse("2026-01-03T00:00:00.000Z"),
				}),
				/SHA-256 mismatch/,
			)
			strictEqual(mocked.execs.length, 0)
		}))

	it("enforces an explicit UTC sealing lag", () => {
		strictEqual(assertSealedUtcDay("2026-01-01", 24, Date.parse("2026-01-03T00:00:00Z")), "2026-01-01")
		throws(() => assertSealedUtcDay("2026-01-01", 24, Date.parse("2026-01-02T23:59:59Z")), /not sealed/)
	})
})

describe("request quiescence", () => {
	it("closes admission and drains already accepted work", async () => {
		const gate = new RequestQuiescenceGate()
		const leave = gate.enter()!
		let ran = false
		const exclusive = gate.exclusive(async () => {
			ran = true
		})
		strictEqual(gate.enter(), null)
		strictEqual(ran, false)
		leave()
		await exclusive
		strictEqual(ran, true)
		strictEqual(typeof gate.enter(), "function")
	})
})

describe("archive expiration", () => {
	it("expires only an already-retired complete day", async () =>
		fixture(async (_root, dataDir, archiveDir, scratchRoot) => {
			const date = "2026-01-01"
			const generations = await seedCompleteDay(archiveDir, date)
			writeRetiredLedger(dataDir, date, generations)
			await expireArchiveDay({ dataDir, archiveDir, scratchRoot, rangeDate: date })
			for (const signal of ARCHIVE_SIGNALS)
				strictEqual(existsSync(rangeRoot(archiveDir, signal.name, date)), false)
		}))

	it("refuses to delete the only archive copy of a live day", async () =>
		fixture(async (_root, dataDir, archiveDir, scratchRoot) => {
			const date = "2026-01-01"
			await seedCompleteDay(archiveDir, date)
			await rejects(
				expireArchiveDay({ dataDir, archiveDir, scratchRoot, rangeDate: date }),
				/is not retired/,
			)
			strictEqual(existsSync(rangeRoot(archiveDir, "logs", date)), true)
		}))

	it("resumes absence only after a durable per-signal removal intent", async () =>
		fixture(async (_root, dataDir, archiveDir, scratchRoot) => {
			const date = "2026-01-01"
			const generations = await seedCompleteDay(archiveDir, date)
			writeRetiredLedger(dataDir, date, generations)
			const journalDir = join(archiveDir, ".retention")
			mkdirSync(journalDir, { recursive: true })
			writeFileSync(
				join(journalDir, "expire.json"),
				`${JSON.stringify({
					formatVersion: 3,
					operationId: randomUUID(),
					rangeDate: date,
					completedSignals: [],
					removingSignal: "logs",
					archivedGenerations: generations,
				})}\n`,
			)
			rmSync(rangeRoot(archiveDir, "logs", date), { recursive: true })
			await expireArchiveDay({ dataDir, archiveDir, scratchRoot, rangeDate: date })
			for (const signal of ARCHIVE_SIGNALS)
				strictEqual(existsSync(rangeRoot(archiveDir, signal.name, date)), false)
		}))

	it("rejects altered progress that skips a canonical signal", async () =>
		fixture(async (_root, dataDir, archiveDir, scratchRoot) => {
			const date = "2026-01-01"
			const generations = await seedCompleteDay(archiveDir, date)
			writeRetiredLedger(dataDir, date, generations)
			const journalDir = join(archiveDir, ".retention")
			mkdirSync(journalDir, { recursive: true })
			writeFileSync(
				join(journalDir, "expire.json"),
				`${JSON.stringify({
					formatVersion: 3,
					operationId: randomUUID(),
					rangeDate: date,
					completedSignals: ["traces"],
					removingSignal: null,
					archivedGenerations: generations,
				})}\n`,
			)
			await rejects(
				expireArchiveDay({ dataDir, archiveDir, scratchRoot, rangeDate: date }),
				/canonical completed prefix/,
			)
			strictEqual(existsSync(rangeRoot(archiveDir, "logs", date)), true)
		}))
})
