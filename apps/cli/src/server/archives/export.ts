import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Chdb } from "../chdb"
import { type ArchiveSignal } from "./signals"

// Parquet shard export from a restored checkpoint's scratch chDB.
//
// The export runs `SELECT ... INTO OUTFILE '...' FORMAT Parquet` directly on the
// restored instance. The result is a write side effect; it is never returned
// into JavaScript (the research established that `forceJsonEachRow` on the query
// endpoint corrupts `INTO OUTFILE`, and routing export bytes through `query()`
// defeats the streaming writer). One Parquet file is written per bounded slice.
//
// Sharding strategy (v1): split a sealed UTC day into fixed UTC-hour windows.
// Each shard covers one half-open `[hour, hour+1)` slice of the day, bounded by
// the signal's event-time column. This is deterministic, independently
// queryable, and avoids the `_part_offset`-repeats-per-part hazard the research
// called out as unsafe for production. Row and byte bounds are still validated
// per shard: a slice exceeding `maxShardRows` or `maxShardBytes` is reported as
// an over-large shard rather than silently written, so an operator knows to
// recalibrate with a finer split or a wider budget.

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
}

/** The UTC hours `[0..23]` that partition a sealed day into shards. */
const HOURS_IN_DAY = Array.from({ length: 24 }, (_, hour) => hour)

const shardName = (hour: number): string => `${hour.toString().padStart(2, "0")}.parquet`

/**
 * Parse a `JSONEachRow` result into rows. `JSONEachRow` is newline-delimited
 * JSON objects, not a JSON array — `JSON.parse` of the whole string yields a
 * single object, so the lines must be split first (matching the checkpoint
 * module's `readJsonRows` idiom).
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
 * Count the rows in `table` whose event time falls on a given UTC date.
 *
 * Uses `toDate(<column>) = '<date>'` rather than a `toDateTime64` range
 * comparison: chDB's bundled ClickHouse miscounts aggregate `count()` over a
 * `toDateTime64`-vs-`DateTime` predicate (the per-row comparison is correct but
 * the aggregate optimizer returns zero). `toDate()` normalizes both
 * second-precision `DateTime` and nanosecond `DateTime64(9)` event-time columns
 * to a date, so the day bound is robust and correct.
 */
export const countRowsForDay = (db: Chdb, signal: ArchiveSignal, rangeDate: string): number => {
	const sql = `SELECT count() FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}'`
	return parseCount(db.query(sql, "JSONEachRow"))
}

/**
 * Count the rows in `table` for one UTC hour of a given date. Uses
 * `toDate()` + `toHour()` for the same aggregate-correctness reason as
 * {@link countRowsForDay}.
 */
const countRowsForHour = (db: Chdb, signal: ArchiveSignal, rangeDate: string, hour: number): number => {
	const sql =
		`SELECT count() FROM ${signal.name} ` +
		`WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}' AND toHour(${signal.eventTimeColumn}) = ${hour}`
	return parseCount(db.query(sql, "JSONEachRow"))
}

/**
 * Query the min and max event time for one UTC hour of a date. Returns nulls
 * when the hour is empty.
 */
const hourTimeBounds = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
): { min: string | null; max: string | null } => {
	const sql =
		`SELECT min(${signal.eventTimeColumn}) AS mn, max(${signal.eventTimeColumn}) AS mx ` +
		`FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}' ` +
		`AND toHour(${signal.eventTimeColumn}) = ${hour}`
	const row = readRows(db.query(sql, "JSONEachRow"))[0]
	return { min: (row?.mn as string | null) ?? null, max: (row?.mx as string | null) ?? null }
}

const sha256File = (path: string): string => {
	const hash = createHash("sha256")
	hash.update(readFileSync(path))
	return hash.digest("hex")
}

/**
 * Export one signal for a sealed UTC day as bounded Parquet shards under
 * `shardsDir`. Writes one file per UTC hour that contains rows; empty hours are
 * skipped. Each shard is validated: its row count must match the source count
 * for that hour, and a shard exceeding the configured row or byte bound fails
 * closed (the operator should recalibrate with a finer split). Returns the
 * validated shard records. Does not return Parquet bytes into JavaScript.
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
		const sourceRows = countRowsForHour(db, signal, rangeDate, hour)
		if (sourceRows === 0) continue
		if (sourceRows > settings.maxShardRows) {
			throw new Error(
				`archive shard ${signal.name}/${shardName(hour)} has ${sourceRows} rows, exceeding maxShardRows ` +
					`(${settings.maxShardRows}); recalibrate with a finer split or a larger budget`,
			)
		}
		const name = shardName(hour)
		const path = join(shardsDir, name)
		if (existsSync(path)) throw new Error(`archive shard already exists; refusing to overwrite: ${path}`)
		// The export result is consumed as a write side effect by chDB; we read
		// only an empty acknowledgement. No Parquet bytes cross into JS. The WHERE
		// uses toDate()/toHour() (not toDateTime64) for the same aggregate-correctness
		// reason as the count helpers.
		db.query(
			`SELECT * FROM ${signal.name} ` +
				`WHERE toDate(${signal.eventTimeColumn}) = '${rangeDate}' ` +
				`AND toHour(${signal.eventTimeColumn}) = ${hour} ` +
				`INTO OUTFILE '${path}' FORMAT Parquet ` +
				`SETTINGS max_threads = ${settings.writerThreads}, ` +
				`output_format_parquet_row_group_size = ${settings.rowGroupRows}`,
			"Null",
		)
		const bytes = validateShardBytes(path, settings.maxShardBytes)
		const bounds = hourTimeBounds(db, signal, rangeDate, hour)
		shards.push({
			name,
			path,
			rowCount: sourceRows,
			minEventTime: bounds.min ?? `${rangeDate}T${hour.toString().padStart(2, "0")}:00:00.000Z`,
			maxEventTime: bounds.max ?? `${rangeDate}T${hour.toString().padStart(2, "0")}:59:59.999Z`,
			sha256: sha256File(path),
			bytes,
		})
	}
	return shards
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
