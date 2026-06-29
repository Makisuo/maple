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
	const sql = `SELECT count() FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}'`
	return parseCount(db.query(sql, "JSONEachRow"))
}

/** Count rows in one UTC hour of a date. */
const countRowsForHour = (db: Chdb, signal: ArchiveSignal, rangeDate: string, hour: number): number => {
	const sql =
		`SELECT count() FROM ${signal.name} ` +
		`WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}' AND toHour(${signal.eventTimeColumn}, 'UTC') = ${hour}`
	return parseCount(db.query(sql, "JSONEachRow"))
}

/**
 * Estimate the uncompressed byte size of one row by sampling. Used to decide
 * whether a single hour needs sub-splitting. Returns bytes-per-row (minimum 1).
 */
const estimateBytesPerRow = (db: Chdb, signal: ArchiveSignal, rangeDate: string, hour: number): number => {
	// Sample up to 100 rows and estimate their uncompressed RowBinary wire length.
	// 'RowBinary' MUST be a quoted string literal — the bare token `RowBinary` is
	// an unknown identifier in chDB (code 47). This is a rough estimate; the
	// post-write parquet_metadata check is authoritative for the byte bound.
	const sql =
		`SELECT avg(length(formatRow('RowBinary', *))) AS bytes_per_row ` +
		`FROM (SELECT * FROM ${signal.name} ` +
		`WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}' AND toHour(${signal.eventTimeColumn}, 'UTC') = ${hour} LIMIT 100)`
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
/**
 * Escape a filesystem path for safe embedding in a ClickHouse single-quoted
 * string literal. Escapes backslashes AND single quotes so neither can break
 * out of the literal or introduce escape sequences.
 */
const sqlLiteral = (path: string): string => path.replace(/\\/g, "\\\\").replace(/'/g, "\\'")

/**
 * Refuse operator-controlled archive paths containing single quotes or
 * backslashes before export (M-1). The constraint is surfaced visibly rather
 * than silently escaped.
 */
const assertSafePath = (path: string): void => {
	if (/'/.test(path)) throw new Error(`archive path must not contain a single quote: ${path}`)
	if (/\\/.test(path)) throw new Error(`archive path must not contain a backslash: ${path}`)
}

/** A source column's name and type, captured before export for round-trip comparison. */
interface SourceColumn {
	readonly name: string
	readonly type: string
}

/**
 * Capture the source table's schema (name + type) via DESCRIBE. The Parquet
 * shard's reopened schema is compared against this to prove the schema
 * round-tripped exactly — not just that it has "some" columns.
 */
const captureSourceSchema = (db: Chdb, signal: ArchiveSignal): ReadonlyArray<SourceColumn> => {
	const rows = readRows(db.query(`DESCRIBE ${signal.name} FORMAT JSONEachRow`, "JSONEachRow"))
	const cols = rows.map((r) => ({ name: String(r.name), type: String(r.type) }))
	if (cols.length === 0) throw new Error(`source table ${signal.name} has no columns`)
	return cols
}

/**
 * Compare a reopened Parquet shard's schema against the captured source schema.
 * Every source column name and base type must be present in the Parquet. The
 * base type strips parameterized wrappers that ClickHouse uses but Parquet does
 * not preserve:
 *   LowCardinality(String) -> String   (Parquet has no LowCardinality concept)
 *   Nullable(T)            -> T
 *   DateTime64(9, 'UTC')   -> DateTime64
 *   Map(K, V)              -> Map
 */
const compareSchema = (
	source: ReadonlyArray<SourceColumn>,
	parquetRows: ReadonlyArray<Record<string, unknown>>,
	shardPath: string,
): ReadonlyArray<string> => {
	const parquetCols = parquetRows.map((r) => ({ name: String(r.name), type: String(r.type) }))
	if (parquetCols.length === 0) {
		throw new Error(
			`archive shard validation failed: ${shardPath} reopened with no columns (schema lost)`,
		)
	}
	const baseType = (t: string): string => {
		let type = t.trim()
		// Unwrap LowCardinality(...) and Nullable(...) to the inner type's base.
		const lc = /^LowCardinality\((.+)\)$/i
		const nl = /^Nullable\((.+)\)$/i
		for (let i = 0; i < 4; i++) {
			const m1 = lc.exec(type)
			const m2 = nl.exec(type)
			if (m1) type = m1[1]!
			else if (m2) type = m2[1]!
			else break
		}
		// Parquet widens DateTime (UInt32 seconds) to DateTime64 on export; treat
		// them as the same base type.
		const base = type.split("(")[0]!.trim()
		return base === "DateTime" ? "DateTime64" : base
	}
	for (const src of source) {
		const match = parquetCols.find((p) => p.name === src.name && baseType(p.type) === baseType(src.type))
		if (!match) {
			throw new Error(
				`archive shard validation failed: ${shardPath} missing source column ${src.name} (${src.type}); ` +
					`got [${parquetCols.map((c) => `${c.name}:${c.type}`).join(", ")}]`,
			)
		}
	}
	return parquetCols.map((c) => c.name)
}

const validateShard = (
	db: Chdb,
	shardPath: string,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
	expectedRows: number,
	sourceSchema: ReadonlyArray<SourceColumn>,
): { rowCount: number; minEventTime: string; maxEventTime: string; columns: ReadonlyArray<string> } => {
	const lit = sqlLiteral(shardPath)
	// Reopen the Parquet file via chDB's file() table function. If the file is
	// not valid Parquet, this query throws (H-1: the prior code accepted a
	// 19-byte invalid file).
	const rowCount = parseCount(db.query(`SELECT count() FROM file('${lit}', Parquet)`, "JSONEachRow"))
	if (rowCount === 0) {
		throw new Error(
			`archive shard validation failed: ${shardPath} reopened with 0 rows (empty or corrupt Parquet)`,
		)
	}
	// Per-shard row count must match the intended slice size (H-B).
	if (rowCount !== expectedRows) {
		throw new Error(
			`archive shard validation failed: ${shardPath} has ${rowCount} rows, expected ${expectedRows}`,
		)
	}
	// Verify the UTC DATE of all rows matches the sealed day (not just the hour —
	// the same hour on a different day must fail).
	const dateSql = `SELECT min(toDate(${signal.eventTimeColumn}, 'UTC')) AS dmn, max(toDate(${signal.eventTimeColumn}, 'UTC')) AS dmx FROM file('${lit}', Parquet)`
	const dateRow = readRows(db.query(dateSql, "JSONEachRow"))[0]
	const dmn = String(dateRow?.dmn ?? "")
	const dmx = String(dateRow?.dmx ?? "")
	if (dmn !== rangeDate || dmx !== rangeDate) {
		throw new Error(
			`archive shard validation failed: ${shardPath} contains rows outside date ${rangeDate} (min=${dmn}, max=${dmx})`,
		)
	}
	// Verify all rows fall within the expected hour window.
	const hourSql =
		`SELECT min(toHour(${signal.eventTimeColumn}, 'UTC')) AS hmn, max(toHour(${signal.eventTimeColumn}, 'UTC')) AS hmx ` +
		`FROM file('${lit}', Parquet)`
	const hourRow = readRows(db.query(hourSql, "JSONEachRow"))[0]
	const hmn = Number(hourRow?.hmn ?? -1)
	const hmx = Number(hourRow?.hmx ?? -1)
	if (hmn !== hour || hmx !== hour) {
		throw new Error(
			`archive shard validation failed: ${shardPath} contains rows outside hour ${hour} (min=${hmn}, max=${hmx})`,
		)
	}
	// Read back time bounds from the reopened file.
	const boundsSql =
		`SELECT min(${signal.eventTimeColumn}) AS mn, max(${signal.eventTimeColumn}) AS mx ` +
		`FROM file('${lit}', Parquet)`
	const boundsRow = readRows(db.query(boundsSql, "JSONEachRow"))[0]
	const minEventTime = String(boundsRow?.mn ?? "")
	const maxEventTime = String(boundsRow?.mx ?? "")
	// Compare the reopened Parquet schema against the source table schema (exact
	// name + base type). A DESCRIBE failure is NOT swallowed (H-A).
	const descSql = `DESCRIBE file('${lit}', Parquet) FORMAT JSONEachRow`
	const parquetSchemaRows = readRows(db.query(descSql, "JSONEachRow"))
	const columns = compareSchema(sourceSchema, parquetSchemaRows, shardPath)
	return { rowCount, minEventTime, maxEventTime, columns }
}

/**
 * Validate the UNCOMPRESSED size of a shard against the byte bound (H-C). The
 * plan's bound is on estimated uncompressed bytes, not compressed on-disk size;
 * compression can keep a 1 GiB-uncompressed shard under a 256 MiB compressed
 * ceiling, so the on-disk stat is insufficient. We reopen the Parquet and sum
 * the uncompressed column sizes from its metadata.
 */
const validateShardBytes = (db: Chdb, shardPath: string, maxShardBytes: number): number => {
	const lit = sqlLiteral(shardPath)
	// Read the total uncompressed size from Parquet metadata. ClickHouse's real
	// interface is `file('<path>', ParquetMetadata)` exposing
	// `total_uncompressed_size` — NOT DuckDB's `parquet_metadata()` function
	// (which does not exist in bundled chDB).
	const sql = `SELECT total_uncompressed_size AS uncompressed FROM file('${lit}', ParquetMetadata)`
	const row = readRows(db.query(sql, "JSONEachRow"))[0]
	const uncompressed = Number(row?.uncompressed ?? 0)
	if (uncompressed > maxShardBytes) {
		throw new Error(
			`archive shard exceeds maxShardBytes uncompressed (${uncompressed} > ${maxShardBytes}): ${shardPath}; ` +
				`recalibrate with a finer split`,
		)
	}
	// Also record the on-disk compressed size for the shard record.
	return statSync(shardPath).size
}

/**
 * Export one signal for a sealed UTC day as bounded Parquet shards under
 * `shardsDir`. Within each UTC hour, if the estimated row count or byte budget
 * is exceeded, the hour is sub-split using a deterministic ORDER BY
 * (_part, _part_offset) cursor so sub-shards form an exact partition of the
 * hour's rows (no overlaps, no gaps). Each shard is validated by reopening it.
 */
export const exportSignalShards = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	shardsDir: string,
	settings: ExportSettings,
): WrittenShard[] => {
	assertSafePath(shardsDir)
	// Capture the source table schema once for exact round-trip comparison.
	const sourceSchema = captureSourceSchema(db, signal)
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
			assertSafePath(path)
			if (existsSync(path))
				throw new Error(`archive shard already exists; refusing to overwrite: ${path}`)
			// Deterministic cursor: ORDER BY (_part, _part_offset) makes LIMIT/OFFSET
			// an exact partition of the hour's rows. Without ORDER BY, ClickHouse
			// LIMIT/OFFSET returns rows in unspecified order and sub-shards could
			// overlap or miss rows (CR-1). The (_part, _part_offset) virtual columns
			// are a stable per-part row identifier and avoid the repetition hazard.
			const offset = seq * rowsPerShard
			// The last shard gets the remainder (may be smaller than rowsPerShard).
			const expectedRows = Math.min(rowsPerShard, hourRows - offset)
			if (expectedRows <= 0) break
			const lit = sqlLiteral(path)
			db.query(
				`SELECT * FROM ${signal.name} ` +
					`WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}' ` +
					`AND toHour(${signal.eventTimeColumn}, 'UTC') = ${hour} ` +
					`ORDER BY (_part, _part_offset) ` +
					`LIMIT ${expectedRows} OFFSET ${offset} ` +
					`INTO OUTFILE '${lit}' FORMAT Parquet ` +
					`SETTINGS max_threads = ${settings.writerThreads}, ` +
					`output_format_parquet_row_group_size = ${settings.rowGroupRows}`,
				"Null",
			)
			// Reopen and validate the written Parquet (H-1, H-A, H-B). The
			// authoritative row count comes from REOPENING the Parquet file, and is
			// checked against the intended slice size, hour bounds, UTC date, and the
			// exact source schema (name + type).
			const validated = validateShard(db, path, signal, rangeDate, hour, expectedRows, sourceSchema)
			const bytes = validateShardBytes(db, path, settings.maxShardBytes)
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
