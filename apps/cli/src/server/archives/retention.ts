import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Chdb } from "../chdb"
import { durableJson, durableRemove, durableRename, durableWrite, syncDirectory } from "../durable-files"
import { withMaintenanceLock } from "../checkpoints"
import { computeMultisetDigest, captureSourceSchema } from "./export"
import { assertCatalogExact, listActiveGenerations, rebuildCatalog, verifyActiveGeneration } from "./listing"
import { readArchiveGenerationManifest } from "./manifest"
import { ARCHIVE_SIGNALS, type ArchiveSignalName } from "./signals"
import {
	archiveRoot,
	assertNoSymlink,
	generationManifestPath,
	rangeRoot,
	shardsRoot,
	validateArchiveId,
	validateRangeDate,
	validateSealedRangeDate,
} from "./paths"

const LEDGER_FORMAT_VERSION = 1
const EXPIRATION_FORMAT_VERSION = 3
const TOKEN_BYTES = 32
const SHA256 = /^[0-9a-f]{64}$/

export interface RetiredSignalEvidence {
	readonly signal: ArchiveSignalName
	readonly generationId: string
	readonly manifestSha256: string
	readonly archivedRowCount: number
	readonly contentDigest: string
}

export interface RetiredDayRecord {
	readonly rangeDate: string
	readonly retiredAt: string
	readonly signals: ReadonlyArray<RetiredSignalEvidence>
}

export interface RetiredDayLedger {
	readonly formatVersion: 1
	readonly retiredDays: ReadonlyArray<RetiredDayRecord>
}

interface ExpireOperation {
	readonly formatVersion: 3
	readonly operationId: string
	readonly rangeDate: string
	readonly completedSignals: ReadonlyArray<ArchiveSignalName>
	readonly removingSignal: ArchiveSignalName | null
	readonly archivedGenerations: Readonly<Record<ArchiveSignalName, string>>
}

type Db = Pick<Chdb, "query" | "exec">

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
	const expected = new Set(keys)
	for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`)
	for (const key of Object.keys(value))
		if (!expected.has(key)) throw new Error(`${label} has unknown field ${key}`)
}

const requiredString = (value: Record<string, unknown>, key: string, label: string): string => {
	const field = value[key]
	if (typeof field !== "string" || field.length === 0) throw new Error(`${label}.${key} must be a string`)
	return field
}

const requiredCount = (value: Record<string, unknown>, key: string, label: string): number => {
	const field = value[key]
	if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0)
		throw new Error(`${label}.${key} must be a non-negative safe integer`)
	return field
}

const parseSignalEvidence = (value: unknown): RetiredSignalEvidence => {
	if (!isRecord(value)) throw new Error("retired-day signal evidence must be a record")
	exactKeys(
		value,
		["signal", "generationId", "manifestSha256", "archivedRowCount", "contentDigest"],
		"retired-day signal evidence",
	)
	const signal = requiredString(value, "signal", "retired-day signal evidence")
	if (!ARCHIVE_SIGNALS.some((candidate) => candidate.name === signal))
		throw new Error(`unknown retired-day signal: ${signal}`)
	const manifestSha256 = requiredString(value, "manifestSha256", "retired-day signal evidence")
	if (!SHA256.test(manifestSha256)) throw new Error("retired-day manifestSha256 must be lowercase SHA-256")
	const contentDigest = requiredString(value, "contentDigest", "retired-day signal evidence")
	if (!/^\d+:\d+:\d+:\d+$/.test(contentDigest))
		throw new Error("retired-day contentDigest must be a canonical bounded multiset digest")
	return {
		signal: signal as ArchiveSignalName,
		generationId: validateArchiveId(
			requiredString(value, "generationId", "retired-day signal evidence"),
			"retired-day generation",
		),
		manifestSha256,
		archivedRowCount: requiredCount(value, "archivedRowCount", "retired-day signal evidence"),
		contentDigest,
	}
}

const parseDayRecord = (value: unknown): RetiredDayRecord => {
	if (!isRecord(value)) throw new Error("retired-day record must be a record")
	exactKeys(value, ["rangeDate", "retiredAt", "signals"], "retired-day record")
	const signalsRaw = value.signals
	if (!Array.isArray(signalsRaw)) throw new Error("retired-day signals must be an array")
	const signals = signalsRaw.map(parseSignalEvidence)
	const names = signals.map((signal) => signal.signal)
	if (names.length !== ARCHIVE_SIGNALS.length || new Set(names).size !== ARCHIVE_SIGNALS.length)
		throw new Error("retired-day record must contain each raw signal exactly once")
	for (let index = 0; index < ARCHIVE_SIGNALS.length; index++)
		if (names[index] !== ARCHIVE_SIGNALS[index]!.name)
			throw new Error("retired-day signals are not in canonical order")
	const retiredAt = requiredString(value, "retiredAt", "retired-day record")
	const retiredMillis = Date.parse(retiredAt)
	if (Number.isNaN(retiredMillis) || new Date(retiredMillis).toISOString() !== retiredAt)
		throw new Error("retired-day retiredAt must be canonical ISO-8601")
	return {
		rangeDate: validateRangeDate(requiredString(value, "rangeDate", "retired-day record")),
		retiredAt,
		signals,
	}
}

export const parseRetiredDayLedger = (value: unknown): RetiredDayLedger => {
	if (!isRecord(value)) throw new Error("retired-day ledger must be a record")
	exactKeys(value, ["formatVersion", "retiredDays"], "retired-day ledger")
	if (value.formatVersion !== LEDGER_FORMAT_VERSION)
		throw new Error(`unsupported retired-day ledger formatVersion: ${String(value.formatVersion)}`)
	if (!Array.isArray(value.retiredDays)) throw new Error("retired-day ledger retiredDays must be an array")
	const retiredDays = value.retiredDays.map(parseDayRecord)
	const dates = retiredDays.map((day) => day.rangeDate)
	if (dates.some((date, index) => index > 0 && dates[index - 1]! >= date))
		throw new Error("retired-day ledger dates must be unique and sorted")
	return { formatVersion: LEDGER_FORMAT_VERSION, retiredDays }
}

export const retiredDayLedgerPath = (dataDir: string): string => `${resolve(dataDir)}.retired-days.json`
export const maintenanceTokenPath = (dataDir: string): string => `${resolve(dataDir)}.maintenance-token`

const readRealFile = (path: string, label: string): string => {
	const stat = lstatSync(path)
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a real file: ${path}`)
	return readFileSync(path, "utf8")
}

export const readRetiredDayLedger = (dataDir: string): RetiredDayLedger => {
	const path = retiredDayLedgerPath(dataDir)
	if (!existsSync(path)) return { formatVersion: LEDGER_FORMAT_VERSION, retiredDays: [] }
	return parseRetiredDayLedger(JSON.parse(readRealFile(path, "retired-day ledger")) as unknown)
}

export const ensureMaintenanceToken = async (dataDir: string): Promise<string> => {
	const path = maintenanceTokenPath(dataDir)
	if (!existsSync(path)) await durableWrite(path, `${randomBytes(TOKEN_BYTES).toString("hex")}\n`)
	const token = readRealFile(path, "maintenance token").trim()
	if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("maintenance token is malformed")
	return token
}

export const maintenanceTokenMatches = (expected: string, supplied: string | null): boolean => {
	if (supplied === null) return false
	const left = Buffer.from(expected)
	const right = Buffer.from(supplied)
	return left.length === right.length && timingSafeEqual(left, right)
}

const eventDateKey: Readonly<Record<string, string>> = {
	traces: "start_time",
	logs: "timestamp",
	metrics_sum: "timestamp",
	metrics_gauge: "timestamp",
	metrics_histogram: "timestamp",
	metrics_exponential_histogram: "timestamp",
}

export class RetiredDayAuthority {
	readonly #dataDir: string
	#ledger: RetiredDayLedger
	#dates: Set<string>

	constructor(dataDir: string) {
		this.#dataDir = dataDir
		this.#ledger = readRetiredDayLedger(dataDir)
		this.#dates = new Set(this.#ledger.retiredDays.map((day) => day.rangeDate))
	}

	isRetired(rangeDate: string): boolean {
		return this.#dates.has(rangeDate)
	}

	hasRetiredDays(): boolean {
		return this.#dates.size > 0
	}

	record(rangeDate: string): RetiredDayRecord | undefined {
		return this.#ledger.retiredDays.find((day) => day.rangeDate === rangeDate)
	}

	assertBatchAllowed(datasource: string, ndjson: string): void {
		const filtered = this.filterBatch(datasource, ndjson)
		if (filtered.rejected > 0)
			throw new Error(`telemetry batch contains ${filtered.rejected} row(s) from a retired UTC day`)
	}

	filterBatch(
		datasource: string,
		ndjson: string,
	): { readonly ndjson: string; readonly accepted: number; readonly rejected: number } {
		const key = eventDateKey[datasource]
		if (!key) throw new Error(`unknown raw telemetry datasource: ${datasource}`)
		const accepted: string[] = []
		let rejected = 0
		for (const line of ndjson.split("\n")) {
			if (line.length === 0) continue
			const row = JSON.parse(line) as Record<string, unknown>
			const timestamp = row[key]
			if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2} /.test(timestamp))
				throw new Error(`encoded ${datasource} row has no canonical UTC timestamp`)
			const rangeDate = timestamp.slice(0, 10)
			if (this.isRetired(rangeDate)) rejected++
			else accepted.push(line)
		}
		return { ndjson: accepted.join("\n"), accepted: accepted.length, rejected }
	}

	async commit(record: RetiredDayRecord): Promise<void> {
		const parsed = parseDayRecord(record)
		const existing = this.record(parsed.rangeDate)
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(parsed))
				throw new Error(`retired-day evidence changed for ${parsed.rangeDate}`)
			return
		}
		const retiredDays = [...this.#ledger.retiredDays, parsed].sort((a, b) =>
			a.rangeDate.localeCompare(b.rangeDate),
		)
		const next = parseRetiredDayLedger({ formatVersion: LEDGER_FORMAT_VERSION, retiredDays })
		await durableJson(retiredDayLedgerPath(this.#dataDir), next)
		this.#ledger = next
		this.#dates.add(parsed.rangeDate)
	}

	replay(db: Db): void {
		removeRetiredDays(db, [...this.#dates])
	}

	replayDay(db: Db, rangeDate: string): void {
		if (!this.isRetired(rangeDate)) throw new Error(`UTC day ${rangeDate} is not retired`)
		removeUtcDay(db, rangeDate)
	}
}

const parseCount = (text: string, label: string): number => {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0)
	const row = line ? (JSON.parse(line) as Record<string, unknown>) : {}
	const count = Number(row.count ?? row["count()"] ?? 0)
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid ${label} count`)
	return count
}

const liveCount = (db: Db, table: string, column: string, rangeDate: string): number =>
	parseCount(
		db.query(
			`SELECT count() AS count FROM ${table} WHERE toDate(${column}, 'UTC') = '${rangeDate}'`,
			"JSONEachRow",
		),
		`${table}/${rangeDate}`,
	)

const removeUtcDay = (db: Db, rangeDate: string): void => {
	for (const signal of ARCHIVE_SIGNALS) {
		db.exec(
			`ALTER TABLE ${signal.name} DELETE WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}' SETTINGS mutations_sync = 2`,
		)
		if (liveCount(db, signal.name, signal.eventTimeColumn, rangeDate) !== 0)
			throw new Error(`retired UTC day remains in ${signal.name}/${rangeDate}`)
	}
}

const sqlDates = (dates: readonly string[]): string => dates.map((date) => `'${date}'`).join(", ")

/** Startup repair is bounded by table count, not ledger length. */
const removeRetiredDays = (db: Db, dates: readonly string[]): void => {
	if (dates.length === 0) return
	const allDates = sqlDates(dates)
	for (const signal of ARCHIVE_SIGNALS) {
		const rows = db.query(
			`SELECT DISTINCT toString(toDate(${signal.eventTimeColumn}, 'UTC')) AS rangeDate FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}, 'UTC') IN (${allDates})`,
			"JSONEachRow",
		)
		const present = rows
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => (JSON.parse(line) as { rangeDate?: unknown }).rangeDate)
			.filter((date): date is string => typeof date === "string" && dates.includes(date))
		if (present.length === 0) continue
		db.exec(
			`ALTER TABLE ${signal.name} DELETE WHERE toDate(${signal.eventTimeColumn}, 'UTC') IN (${sqlDates(present)}) SETTINGS mutations_sync = 2`,
		)
		const remaining = parseCount(
			db.query(
				`SELECT count() AS count FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}, 'UTC') IN (${sqlDates(present)})`,
				"JSONEachRow",
			),
			`${signal.name}/retired-days`,
		)
		if (remaining !== 0) throw new Error(`retired UTC days remain in ${signal.name}`)
	}
}

export const assertSealedUtcDay = (range: string, sealingLagHours = 24, now = Date.now()): string => {
	return validateSealedRangeDate(range, sealingLagHours, now)
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")
const safeSqlPath = (path: string): string => {
	if (path.includes("'") || path.includes("\\")) throw new Error(`unsafe archive path for chDB: ${path}`)
	return path
}

const completeArchiveDay = (archiveDir: string, rangeDate: string) => {
	const listing = listActiveGenerations(archiveDir)
	const errors = listing.errors.filter((error) => error.rangeStart === rangeDate || error.rangeStart === "")
	if (errors.length > 0)
		throw new Error(
			`archive date ${rangeDate} is malformed: ${errors.map((error) => error.error).join("; ")}`,
		)
	return ARCHIVE_SIGNALS.map((signal) => {
		const matches = listing.active.filter(
			(generation) => generation.signal === signal.name && generation.rangeStart === rangeDate,
		)
		if (matches.length !== 1)
			throw new Error(`archive date ${rangeDate} lacks one active ${signal.name} generation`)
		return { signal, summary: matches[0]! }
	})
}

/**
 * Execute the destructive boundary inside the live server while ingest and
 * local queries are quiesced by the caller. The durable ledger is committed
 * before any DELETE. A crash after that boundary is repaired by startup replay;
 * a crash before it leaves all live data intact.
 */
export const retireLiveDayInServer = async (options: {
	readonly db: Db
	readonly authority: RetiredDayAuthority
	readonly archiveDir: string
	readonly rangeDate: string
	readonly sealingLagHours?: number
	readonly now?: number
}): Promise<RetiredDayRecord> => {
	const rangeDate = assertSealedUtcDay(
		options.rangeDate,
		options.sealingLagHours ?? 24,
		options.now ?? Date.now(),
	)
	const committed = options.authority.record(rangeDate)
	if (committed) {
		options.authority.replayDay(options.db, rangeDate)
		return committed
	}

	const complete = completeArchiveDay(options.archiveDir, rangeDate)
	const evidence: RetiredSignalEvidence[] = []
	for (const { signal, summary } of complete) {
		await verifyActiveGeneration(options.archiveDir, signal.name, rangeDate)
		const manifestPath = generationManifestPath(
			options.archiveDir,
			signal.name,
			rangeDate,
			summary.generationId,
		)
		const manifest = readArchiveGenerationManifest(
			options.archiveDir,
			signal.name,
			rangeDate,
			summary.generationId,
		)
		const count = liveCount(options.db, signal.name, signal.eventTimeColumn, rangeDate)
		if (count !== manifest.archivedRowCount)
			throw new Error(
				`refusing live retirement: ${signal.name}/${rangeDate} live=${count} archive=${manifest.archivedRowCount}`,
			)
		const schema = captureSourceSchema(options.db, signal)
		const liveDigest = computeMultisetDigest(
			options.db,
			schema,
			`${signal.name} WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}'`,
		)
		let archiveDigest = liveDigest
		if (manifest.archivedRowCount > 0) {
			const glob = safeSqlPath(
				join(
					shardsRoot(options.archiveDir, signal.name, rangeDate, summary.generationId),
					"*.parquet",
				),
			)
			archiveDigest = computeMultisetDigest(options.db, schema, `file('${glob}', Parquet)`)
		}
		if (liveDigest !== archiveDigest)
			throw new Error(`refusing live retirement: ${signal.name}/${rangeDate} content digest mismatch`)
		evidence.push({
			signal: signal.name,
			generationId: summary.generationId,
			manifestSha256: sha256File(manifestPath),
			archivedRowCount: manifest.archivedRowCount,
			contentDigest: archiveDigest,
		})
	}

	// Re-read identities and re-hash every shard immediately before the durable
	// commit. No destructive step can resume from stale verification evidence.
	for (const item of evidence) {
		await verifyActiveGeneration(options.archiveDir, item.signal, rangeDate)
		const current = completeArchiveDay(options.archiveDir, rangeDate).find(
			(candidate) => candidate.signal.name === item.signal,
		)!
		if (current.summary.generationId !== item.generationId)
			throw new Error(
				`archive generation changed before retirement commit: ${item.signal}/${rangeDate}`,
			)
		const actualManifestSha = sha256File(
			generationManifestPath(options.archiveDir, item.signal, rangeDate, item.generationId),
		)
		if (actualManifestSha !== item.manifestSha256)
			throw new Error(`archive manifest changed before retirement commit: ${item.signal}/${rangeDate}`)
	}

	const record: RetiredDayRecord = {
		rangeDate,
		retiredAt: new Date(options.now ?? Date.now()).toISOString(),
		signals: evidence,
	}
	await options.authority.commit(record)
	removeUtcDay(options.db, rangeDate)
	return record
}

const expirationRecord = (archiveDir: string): string =>
	join(archiveRoot(archiveDir), ".retention", "expire.json")
const expirationTomb = (archiveDir: string, date: string, signal: string): string =>
	join(archiveRoot(archiveDir), ".retention", "expired", date, signal)

const parseExpireOperation = (value: unknown): ExpireOperation => {
	if (!isRecord(value)) throw new Error("archive expiration journal must be a record")
	exactKeys(
		value,
		[
			"formatVersion",
			"operationId",
			"rangeDate",
			"completedSignals",
			"removingSignal",
			"archivedGenerations",
		],
		"archive expiration journal",
	)
	if (value.formatVersion !== EXPIRATION_FORMAT_VERSION)
		throw new Error(`unsupported archive expiration journal version: ${String(value.formatVersion)}`)
	if (!Array.isArray(value.completedSignals)) throw new Error("completedSignals must be an array")
	const completedSignals = value.completedSignals.map((signal) => {
		if (typeof signal !== "string" || !ARCHIVE_SIGNALS.some((candidate) => candidate.name === signal))
			throw new Error(`invalid completed signal: ${String(signal)}`)
		return signal as ArchiveSignalName
	})
	if (new Set(completedSignals).size !== completedSignals.length)
		throw new Error("completedSignals contains duplicates")
	for (let index = 0; index < completedSignals.length; index++)
		if (completedSignals[index] !== ARCHIVE_SIGNALS[index]!.name)
			throw new Error("completedSignals must be a canonical completed prefix")
	const removingSignal = value.removingSignal
	if (
		removingSignal !== null &&
		(typeof removingSignal !== "string" ||
			!ARCHIVE_SIGNALS.some((candidate) => candidate.name === removingSignal))
	)
		throw new Error(`invalid removingSignal: ${String(removingSignal)}`)
	const expectedRemoving = ARCHIVE_SIGNALS[completedSignals.length]?.name ?? null
	if (removingSignal !== null && removingSignal !== expectedRemoving)
		throw new Error("removingSignal must be the next canonical signal")
	if (!isRecord(value.archivedGenerations)) throw new Error("archivedGenerations must be a record")
	exactKeys(
		value.archivedGenerations,
		ARCHIVE_SIGNALS.map((signal) => signal.name),
		"archivedGenerations",
	)
	const archivedGenerations = Object.fromEntries(
		ARCHIVE_SIGNALS.map((signal) => [
			signal.name,
			validateArchiveId(
				requiredString(
					value.archivedGenerations as Record<string, unknown>,
					signal.name,
					"archivedGenerations",
				),
				"archive expiration generation",
			),
		]),
	) as Record<ArchiveSignalName, string>
	return {
		formatVersion: EXPIRATION_FORMAT_VERSION,
		operationId: validateArchiveId(
			requiredString(value, "operationId", "archive expiration journal"),
			"archive expiration operation",
		),
		rangeDate: validateRangeDate(requiredString(value, "rangeDate", "archive expiration journal")),
		completedSignals,
		removingSignal: removingSignal as ArchiveSignalName | null,
		archivedGenerations,
	}
}

const readExpireOperation = (path: string): ExpireOperation | null => {
	if (!existsSync(path)) return null
	return parseExpireOperation(JSON.parse(readRealFile(path, "archive expiration journal")) as unknown)
}

/** Expire one already-retired archived UTC day. Resumes safely after interruption. */
export const expireArchiveDay = async (options: {
	readonly dataDir: string
	readonly archiveDir: string
	readonly scratchRoot: string
	readonly rangeDate: string
}): Promise<void> => {
	const rangeDate = validateRangeDate(options.rangeDate)
	await withMaintenanceLock(options.dataDir, randomUUID(), async () => {
		const { reconcileArchiveGeneration } = await import("./generation")
		await reconcileArchiveGeneration(options.dataDir, options.archiveDir, options.scratchRoot)
		const retired = readRetiredDayLedger(options.dataDir).retiredDays.find(
			(day) => day.rangeDate === rangeDate,
		)
		if (!retired) throw new Error(`refusing archive expiration: UTC day ${rangeDate} is not retired`)
		const path = expirationRecord(options.archiveDir)
		let op = readExpireOperation(path)
		if (!op) {
			const complete = completeArchiveDay(options.archiveDir, rangeDate)
			for (const signal of ARCHIVE_SIGNALS) assertCatalogExact(options.archiveDir, signal.name)
			const archivedGenerations = Object.fromEntries(
				complete.map(({ signal, summary }) => [signal.name, summary.generationId]),
			) as Record<ArchiveSignalName, string>
			for (const item of retired.signals)
				if (archivedGenerations[item.signal] !== item.generationId)
					throw new Error(
						`active archive generation differs from retired authority: ${item.signal}/${rangeDate}`,
					)
			op = {
				formatVersion: EXPIRATION_FORMAT_VERSION,
				operationId: randomUUID(),
				rangeDate,
				completedSignals: [],
				removingSignal: null,
				archivedGenerations,
			}
			await durableJson(path, op)
		} else if (op.rangeDate !== rangeDate) {
			throw new Error(`unfinished archive expiration for ${op.rangeDate}`)
		}
		for (const signal of ARCHIVE_SIGNALS) {
			if (op.completedSignals.includes(signal.name)) continue
			if (op.removingSignal !== null && op.removingSignal !== signal.name)
				throw new Error(`archive expiration journal is out of canonical order at ${signal.name}`)
			const source = rangeRoot(options.archiveDir, signal.name, rangeDate)
			const tomb = expirationTomb(options.archiveDir, rangeDate, signal.name)
			await assertNoSymlink(archiveRoot(options.archiveDir), source, "archive expiration source")
			await assertNoSymlink(archiveRoot(options.archiveDir), tomb, "archive expiration tombstone")
			if (op.removingSignal === null && !existsSync(source))
				throw new Error(
					`archive expiration source vanished before durable removal intent: ${signal.name}/${rangeDate}`,
				)
			if (existsSync(source)) {
				const listing = listActiveGenerations(options.archiveDir)
				const relevantErrors = listing.errors.filter(
					(error) =>
						error.signal === signal.name &&
						(error.rangeStart === rangeDate || error.rangeStart === ""),
				)
				if (relevantErrors.length > 0)
					throw new Error(`archive became malformed during expiration: ${signal.name}/${rangeDate}`)
				const current = listing.active.filter(
					(candidate) => candidate.signal === signal.name && candidate.rangeStart === rangeDate,
				)
				if (current.length !== 1 || current[0]!.generationId !== op.archivedGenerations[signal.name])
					throw new Error(
						`archive generation changed after expiration intent: ${signal.name}/${rangeDate}`,
					)
				await verifyActiveGeneration(options.archiveDir, signal.name, rangeDate)
			}
			if (existsSync(source) && existsSync(tomb))
				throw new Error(
					`archive expiration has both source and tombstone: ${signal.name}/${rangeDate}`,
				)
			if (op.removingSignal === null) {
				op = { ...op, removingSignal: signal.name }
				await durableJson(path, op)
			}
			if (existsSync(source) && !existsSync(tomb)) {
				await mkdir(dirname(tomb), { recursive: true, mode: 0o700 })
				await durableRename(source, tomb)
			}
			if (existsSync(tomb)) {
				await rm(tomb, { recursive: true, force: true })
				await syncDirectory(dirname(tomb))
			}
			await rebuildCatalog(options.archiveDir, signal.name)
			op = {
				...op,
				completedSignals: [...op.completedSignals, signal.name],
				removingSignal: null,
			}
			await durableJson(path, op)
		}
		await durableRemove(path)
	})
}

export const retireLiveDay = async (options: {
	readonly dataDir: string
	readonly archiveDir: string
	readonly scratchRoot: string
	readonly rangeDate: string
	readonly port: number
	readonly sealingLagHours?: number
	readonly request?: typeof fetch
}): Promise<void> => {
	const rangeDate = assertSealedUtcDay(options.rangeDate, options.sealingLagHours ?? 24)
	await withMaintenanceLock(options.dataDir, randomUUID(), async () => {
		const { reconcileArchiveGeneration } = await import("./generation")
		await reconcileArchiveGeneration(options.dataDir, options.archiveDir, options.scratchRoot)
		const token = readRealFile(maintenanceTokenPath(options.dataDir), "maintenance token").trim()
		const request = options.request ?? fetch
		const response = await request(`http://127.0.0.1:${options.port}/local/retention/retire`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-maple-maintenance-token": token },
			body: JSON.stringify({
				archiveDir: resolve(options.archiveDir),
				rangeDate,
				sealingLagHours: options.sealingLagHours ?? 24,
			}),
		})
		if (!response.ok)
			throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`)
	})
}
