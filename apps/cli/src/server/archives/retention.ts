import { existsSync, lstatSync, readFileSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { durableJson, durableRemove, durableRename, syncDirectory } from "../durable-files"
import { postLoopbackLocalQuery, withMaintenanceLock } from "../checkpoints"
import { assertCatalogExact, listActiveGenerations, rebuildCatalog, verifyActiveGeneration } from "./listing"
import { ARCHIVE_SIGNALS, type ArchiveSignalName } from "./signals"
import { archiveRoot, assertNoSymlink, rangeRoot, validateRangeDate } from "./paths"

interface ExpireOperation {
	readonly formatVersion: 1
	readonly operationId: string
	readonly rangeDate: string
	readonly completedSignals: ReadonlyArray<string>
	readonly archivedGenerations: Readonly<Record<string, string>>
}

interface RetireOperation extends ExpireOperation {
	readonly archivedCounts: Readonly<Record<string, number>>
}

const expirationRecord = (archiveDir: string): string =>
	join(archiveRoot(archiveDir), ".retention", "expire.json")
const expirationTomb = (archiveDir: string, date: string, signal: string): string =>
	join(archiveRoot(archiveDir), ".retention", "expired", date, signal)
const retirementRecord = (dataDir: string): string => join(dataDir, "retention", "retire-live.json")

const readRecord = <T>(path: string): T | null => {
	if (!existsSync(path)) return null
	const stat = lstatSync(path)
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new Error(`retention record is not a real file: ${path}`)
	return JSON.parse(readFileSync(path, "utf8")) as T
}

const completeArchiveDay = (
	archiveDir: string,
	rangeDate: string,
): {
	readonly counts: Record<string, number>
	readonly generations: Record<string, string>
} => {
	const listing = listActiveGenerations(archiveDir)
	const errors = listing.errors.filter((e) => e.rangeStart === rangeDate)
	if (errors.length > 0)
		throw new Error(`archive date ${rangeDate} is malformed: ${errors.map((e) => e.error).join("; ")}`)
	const counts: Record<string, number> = {}
	const generations: Record<string, string> = {}
	for (const signal of ARCHIVE_SIGNALS) {
		const matches = listing.active.filter((g) => g.signal === signal.name && g.rangeStart === rangeDate)
		if (matches.length !== 1)
			throw new Error(`archive date ${rangeDate} lacks one active ${signal.name} generation`)
		counts[signal.name] = matches[0]!.archivedRowCount
		generations[signal.name] = matches[0]!.generationId
	}
	return { counts, generations }
}

/** Expire one complete archived UTC day. Resumes safely after interruption. */
export const expireArchiveDay = async (dataDir: string, archiveDir: string, range: string): Promise<void> => {
	const rangeDate = validateRangeDate(range)
	await withMaintenanceLock(dataDir, randomUUID(), async () => {
		const path = expirationRecord(archiveDir)
		let op = readRecord<ExpireOperation>(path)
		if (!op) {
			const evidence = completeArchiveDay(archiveDir, rangeDate)
			for (const signal of ARCHIVE_SIGNALS) assertCatalogExact(archiveDir, signal.name)
			op = {
				formatVersion: 1,
				operationId: randomUUID(),
				rangeDate,
				completedSignals: [],
				archivedGenerations: evidence.generations,
			}
			await durableJson(path, op)
		} else if (op.formatVersion !== 1 || op.rangeDate !== rangeDate) {
			throw new Error(`unfinished archive expiration for ${op.rangeDate}`)
		}
		for (const signal of ARCHIVE_SIGNALS) {
			if (op.completedSignals.includes(signal.name)) continue
			const source = rangeRoot(archiveDir, signal.name, rangeDate)
			const tomb = expirationTomb(archiveDir, rangeDate, signal.name)
			await assertNoSymlink(archiveRoot(archiveDir), source, "archive expiration source")
			await assertNoSymlink(archiveRoot(archiveDir), tomb, "archive expiration tombstone")
			if (existsSync(source)) {
				const listing = listActiveGenerations(archiveDir)
				const matches = listing.active.filter(
					(g) => g.signal === signal.name && g.rangeStart === rangeDate,
				)
				if (
					matches.length !== 1 ||
					matches[0]!.generationId !== op.archivedGenerations[signal.name]
				) {
					throw new Error(
						`archive generation changed after expiration intent: ${signal.name}/${rangeDate}`,
					)
				}
			}
			if (existsSync(source) && !existsSync(tomb)) {
				await mkdir(dirname(tomb), { recursive: true, mode: 0o700 })
				await durableRename(source, tomb)
			}
			if (existsSync(tomb)) {
				await rm(tomb, { recursive: true, force: true })
				await syncDirectory(dirname(tomb))
			}
			await rebuildCatalog(archiveDir, signal.name as ArchiveSignalName)
			op = { ...op, completedSignals: [...op.completedSignals, signal.name] }
			await durableJson(path, op)
		}
		await durableRemove(path)
	})
}

const liveCount = async (
	query: typeof postLoopbackLocalQuery,
	port: number,
	table: string,
	column: string,
	date: string,
): Promise<number> => {
	const value = await query(
		port,
		`SELECT count() AS count FROM ${table} WHERE toDate(${column}) = toDate('${date}')`,
	)
	const row = Array.isArray(value) ? value[0] : null
	const count = Number(row && typeof row === "object" ? (row as Record<string, unknown>).count : NaN)
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid live count for ${table}/${date}`)
	return count
}

/** Remove one verified archived UTC-day partition from all six live raw tables. */
export const retireLiveDay = async (options: {
	readonly dataDir: string
	readonly archiveDir: string
	readonly rangeDate: string
	readonly port: number
	readonly query?: typeof postLoopbackLocalQuery
}): Promise<void> => {
	const rangeDate = validateRangeDate(options.rangeDate)
	const query = options.query ?? postLoopbackLocalQuery
	await withMaintenanceLock(options.dataDir, randomUUID(), async () => {
		const path = retirementRecord(options.dataDir)
		let op = readRecord<RetireOperation>(path)
		if (!op) {
			const evidence = completeArchiveDay(options.archiveDir, rangeDate)
			const archivedCounts = evidence.counts
			for (const signal of ARCHIVE_SIGNALS) {
				await verifyActiveGeneration(options.archiveDir, signal.name, rangeDate)
				const count = await liveCount(
					query,
					options.port,
					signal.name,
					signal.eventTimeColumn,
					rangeDate,
				)
				if (count !== archivedCounts[signal.name]) {
					throw new Error(
						`refusing live retirement: ${signal.name}/${rangeDate} live=${count} archive=${archivedCounts[signal.name]}`,
					)
				}
			}
			op = {
				formatVersion: 1,
				operationId: randomUUID(),
				rangeDate,
				completedSignals: [],
				archivedCounts,
				archivedGenerations: evidence.generations,
			}
			await durableJson(path, op)
		} else if (op.formatVersion !== 1 || op.rangeDate !== rangeDate) {
			throw new Error(`unfinished live retirement for ${op.rangeDate}`)
		}
		for (const signal of ARCHIVE_SIGNALS) {
			if (op.completedSignals.includes(signal.name)) continue
			const listing = listActiveGenerations(options.archiveDir)
			const archived = listing.active.filter(
				(g) => g.signal === signal.name && g.rangeStart === rangeDate,
			)
			if (archived.length !== 1 || archived[0]!.generationId !== op.archivedGenerations[signal.name]) {
				throw new Error(
					`archive generation changed after live-retirement intent: ${signal.name}/${rangeDate}`,
				)
			}
			const before = await liveCount(
				query,
				options.port,
				signal.name,
				signal.eventTimeColumn,
				rangeDate,
			)
			if (before !== 0 && before !== op.archivedCounts[signal.name]) {
				throw new Error(`live partition changed after retirement intent: ${signal.name}/${rangeDate}`)
			}
			if (before !== 0)
				await query(options.port, `ALTER TABLE ${signal.name} DROP PARTITION '${rangeDate}'`)
			const after = await liveCount(query, options.port, signal.name, signal.eventTimeColumn, rangeDate)
			if (after !== 0)
				throw new Error(`live partition retirement did not empty ${signal.name}/${rangeDate}`)
			op = { ...op, completedSignals: [...op.completedSignals, signal.name] }
			await durableJson(path, op)
		}
		await durableRemove(path)
	})
}
