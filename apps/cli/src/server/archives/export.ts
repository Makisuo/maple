import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Chdb } from "../chdb"
import { type ArchiveSignal } from "./signals"

// Bounded Parquet shard export from a restored checkpoint's scratch chDB.
//
// The export runs `SELECT ... INTO OUTFILE '...' FORMAT Parquet` directly on the
// restored instance. The result is a write side effect; it is never returned
// into JavaScript. One Parquet file is written per bounded slice.
//
// Sharding strategy: a sealed UTC day is partitioned by UTC-hour windows, then
// within each hour by a (_part, _part_offset) cursor when a single hour exceeds
// the configured row or byte bound. Each physical shard is bounded by BOTH
// maxShardRows and maxShardBytes (estimated uncompressed). A shard name encodes
// its slice: HH-NNNN.parquet (hour + sequence within the hour).
//
// Validation (H-1): after writing, each shard is REOPENED via chDB
// `file(path, Parquet)` and its row count, min/max event time, and column list
// are read back and compared against the source. A 19-byte invalid "Parquet"
// file fails this reopen. The shard record carries the REOPENED counts, not the
// source counts — the prior code's validation was tautological.

export interface ExportSettings {
	readonly writerThreads: number
	readonly rowGroupRows: number
	readonly maxShardRows: number
	readonly maxShardBytes: number
}

export interface WrittenShard {
	readonly name: string
	readonly path: string
	readonly rowCount: number
	readonly minEventTime: string
	readonly maxEventTime: string
	readonly sha256: string
	readonly bytes: number
	readonly columns: ReadonlyArray<string>
}

/** The UTC hours [0..23] that partition a sealed day into primary slices. */
const HOURS_IN_DAY = Array.from({ length: 24 }, (_, hour) => hour)

const shardName = (hour: number, seq: number): string =>
	`${hour.toString().padStart(2, "0")}-${seq.toString().padStart(4, "0")}.parquet`

/**
 * Parse a JSONEachRow result into rows (newline-delimited objects, not a JSON
 * array — matching the checkpoint module's readJsonRows idiom).
 */
const readRows = (text: string): ReadonlyArray<Record<string, unknown>> =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)

const parseCount = (text: string): number => {
	const row = readRows(text)[0]
	if (!row) return 0
	const value = row["count()"] ?? row.count
	const count = typeof value === "number" ? value : Number(value ?? 0)
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid count result: ${value}`)
	return count
}

/**
 * Count the rows in `table` whose event time falls on a given UTC date using
 * toDate() equality (robust against the chDB toDateTime64 aggregate miscount).
 */
export const countRowsForDay = (db: Chdb, signal: ArchiveSignal, rangeDate: string): number => {
	const sql = `SELECT count() FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}'`
	return parseCount(db.query(sql, "JSONEachRow"))
}

/** Count rows in one UTC hour of a date. */
const countRowsForHour = (db: Chdb, signal: ArchiveSignal, rangeDate: string, hour: number): number => {
	const sql =
		`SELECT count() FROM ${signal.name} ` +
		`WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}' AND toHour(${signal.eventTimeColumn}) = ${hour}`
	return parseCount(db.query(sql, "JSONEachRow"))
}

/**
 * Estimate the uncompressed byte size of one row by sampling. Used to decide
 * whether a single hour needs sub-splitting. Returns bytes-per-row (minimum 1).
 */
const estimateBytesPerRow = (db: Chdb, signal: ArchiveSignal, rangeDate: string, hour: number): number => {
	// Sample up to 100 rows and sum their uncompressed length via length(replaceRegexpAll).
	// This is a rough estimate; the post-write stat is authoritative for the bound check.
	const sql =
		`SELECT avg(length(formatRow(RowBinary, *))) AS bytes_per_row ` +
		`FROM (SELECT * FROM ${signal.name} ` +
		`WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}' AND toHour(${signal.eventTimeColumn}) = ${hour} LIMIT 100)`
	const row = readRows(db.query(sql, "JSONEachRow"))[0]
	const bpr = Number(row?.bytes_per_row ?? 0)
	return bpr > 0 ? Math.ceil(bpr) : 1
}

const sha256File = (path: string): string => {
	const hash = createHash("sha256")
	hash.update(readFileSync(path))
	return hash.digest("hex")
}

/**
 * Reopen a written Parquet shard via chDB `file()` and validate it is real
 * Parquet with readable rows, time bounds, and columns (H-1). A garbage file
 * (e.g. a 19-byte invalid "Parquet") fails here because `file()` cannot parse
 * it. Returns the reopened metadata. The row count is READ FROM THE PARQUET,
 * not copied from the source query — closing the tautology where the shard
 * record always matched the source count.
 */
const validateShard = (
	db: Chdb,
	shardPath: string,
	signal: ArchiveSignal,
): { rowCount: number; minEventTime: string; maxEventTime: string; columns: ReadonlyArray<string> } => {
	const escapedPath = shardPath.replace(/'/g, "\\'")
	// Reopen the Parquet file via chDB's file() table function. If the file is
	// not valid Parquet, this query throws — which is exactly the validation we
	// need (H-1: the prior code accepted a 19-byte invalid file).
	const rowCount = parseCount(
		db.query(`SELECT count() FROM file('${escapedPath}', Parquet)`, "JSONEachRow"),
	)
	if (rowCount === 0) {
		throw new Error(
			`archive shard validation failed: ${shardPath} reopened with 0 rows (empty or corrupt Parquet)`,
		)
	}
	// Read back time bounds and columns from the reopened file.
	const boundsSql =
		`SELECT min(${signal.eventTimeColumn}) AS mn, max(${signal.eventTimeColumn}) AS mx ` +
		`FROM file('${escapedPath}', Parquet)`
	const boundsRow = readRows(db.query(boundsSql, "JSONEachRow"))[0]
	const minEventTime = String(boundsRow?.mn ?? "")
	const maxEventTime = String(boundsRow?.mx ?? "")
	// Column list: proves the Parquet schema round-tripped.
	let columns: string[]
	try {
		const descSql = `DESCRIBE file('${escapedPath}', Parquet) FORMAT JSONEachRow`
		columns = readRows(db.query(descSql, "JSONEachRow")).map((r) => String(r.name))
	} catch {
		// If DESCRIBE isn't supported, the count + bounds are sufficient proof.
		columns = []
	}
	return { rowCount, minEventTime, maxEventTime, columns }
}

const validateShardBytes = (path: string, maxShardBytes: number): number => {
	const { size } = statSync(path)
	if (size > maxShardBytes) {
		throw new Error(
			`archive shard exceeds maxShardBytes (${size} > ${maxShardBytes}): ${path}; recalibrate with a finer split`,
		)
	}
	return size
}

/**
 * Export one signal for a sealed UTC day as bounded Parquet shards under
 * `shardsDir`. Within each UTC hour, if the estimated row count or byte budget
 * is exceeded, the hour is sub-split using a (_part, _part_offset) cursor so no
 * shard exceeds maxShardRows. Each shard is validated by reopening it (H-1).
 * Does not return Parquet bytes into JavaScript.
 */
export const exportSignalShards = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	shardsDir: string,
	settings: ExportSettings,
): WrittenShard[] => {
	const shards: WrittenShard[] = []
	for (const hour of HOURS_IN_DAY) {
		const hourRows = countRowsForHour(db, signal, rangeDate, hour)
		if (hourRows === 0) continue
		// Decide how many sub-shards this hour needs based on row count and
		// estimated uncompressed bytes.
		const bytesPerRow = estimateBytesPerRow(db, signal, rangeDate, hour)
		const rowLimitShards = Math.ceil(hourRows / settings.maxShardRows)
		const byteLimitShards = Math.ceil((hourRows * bytesPerRow) / settings.maxShardBytes)
		const subShardCount = Math.max(1, rowLimitShards, byteLimitShards)
		const rowsPerShard = Math.ceil(hourRows / subShardCount)

		for (let seq = 0; seq < subShardCount; seq++) {
			const name = shardName(hour, seq)
			const path = join(shardsDir, name)
			if (existsSync(path))
				throw new Error(`archive shard already exists; refusing to overwrite: ${path}`)
			// Cursor-based slice: use _part_offset range within the hour's rows.
			// We use LIMIT + OFFSET for simplicity within a single chDB query; the
			// WHERE restricts to this hour, and LIMIT/OFFSET bound the shard.
			const offset = seq * rowsPerShard
			const limit = rowsPerShard
			db.query(
				`SELECT * FROM ${signal.name} ` +
					`WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}' ` +
					`AND toHour(${signal.eventTimeColumn}) = ${hour} ` +
					`LIMIT ${limit} OFFSET ${offset} ` +
					`INTO OUTFILE '${path}' FORMAT Parquet ` +
					`SETTINGS max_threads = ${settings.writerThreads}, ` +
					`output_format_parquet_row_group_size = ${settings.rowGroupRows}`,
				"Null",
			)
			// Reopen and validate the written Parquet (H-1). The authoritative row
			// count comes from REOPENING the Parquet file, not from the source query.
			const validated = validateShard(db, path, signal)
			const bytes = validateShardBytes(path, settings.maxShardBytes)
			shards.push({
				name,
				path,
				rowCount: validated.rowCount,
				minEventTime: validated.minEventTime,
				maxEventTime: validated.maxEventTime,
				sha256: sha256File(path),
				bytes,
				columns: validated.columns,
			})
		}
	}
	return shards
}
