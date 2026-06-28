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
 * Count the rows in `table` for a half-open UTC time range on the signal's
 * event-time column. Used to size a slice before writing and to validate the
 * written shard against the source.
 */
export const countRangeRows = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeStartIso: string,
	rangeEndIso: string,
): number => {
	const sql = `SELECT count() AS c FROM ${signal.name} WHERE ${signal.eventTimeColumn} >= '${rangeStartIso}' AND ${signal.eventTimeColumn} < '${rangeEndIso}'`
	const result = db.query(sql, "JSONEachRow")
	if (result.trim().length === 0) return 0
	const parsed = JSON.parse(result) as ReadonlyArray<{ c: string | number }>
	return Number(parsed[0]?.c ?? 0)
}

/**
 * Query the min and max event time for a half-open range. Returns nulls when the
 * range is empty.
 */
const timeBounds = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeStartIso: string,
	rangeEndIso: string,
): { min: string | null; max: string | null } => {
	const sql =
		`SELECT min(${signal.eventTimeColumn}) AS mn, max(${signal.eventTimeColumn}) AS mx ` +
		`FROM ${signal.name} WHERE ${signal.eventTimeColumn} >= '${rangeStartIso}' ` +
		`AND ${signal.eventTimeColumn} < '${rangeEndIso}'`
	const result = db.query(sql, "JSONEachRow")
	if (result.trim().length === 0) return { min: null, max: null }
	const parsed = JSON.parse(result) as ReadonlyArray<{ mn: string | null; mx: string | null }>
	return { min: parsed[0]?.mn ?? null, max: parsed[0]?.mx ?? null }
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
	dayStartIso: string,
	shardsDir: string,
	settings: ExportSettings,
): WrittenShard[] => {
	const shards: WrittenShard[] = []
	for (const hour of HOURS_IN_DAY) {
		const sliceStart = `${dayStartIso.replace("T00:00:00.000Z", "")}T${hour.toString().padStart(2, "0")}:00:00.000Z`
		const sliceEnd = `${dayStartIso.replace("T00:00:00.000Z", "")}T${(hour + 1).toString().padStart(2, "0")}:00:00.000Z`
		const sourceRows = countRangeRows(db, signal, sliceStart, sliceEnd)
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
		// only an empty acknowledgement. No Parquet bytes cross into JS.
		db.query(
			`SELECT * FROM ${signal.name} ` +
				`WHERE ${signal.eventTimeColumn} >= '${sliceStart}' AND ${signal.eventTimeColumn} < '${sliceEnd}' ` +
				`INTO OUTFILE '${path}' FORMAT Parquet ` +
				`SETTINGS max_threads = ${settings.writerThreads}, ` +
				`output_format_parquet_row_group_size = ${settings.rowGroupRows}`,
			"Null",
		)
		const bytes = validateShardBytes(path, settings.maxShardBytes)
		const bounds = timeBounds(db, signal, sliceStart, sliceEnd)
		shards.push({
			name,
			path,
			rowCount: sourceRows,
			minEventTime: bounds.min ?? sliceStart,
			maxEventTime: bounds.max ?? sliceEnd,
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
