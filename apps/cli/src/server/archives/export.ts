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
	/**
	 * Optional callback invoked after each shard is written and validated, before
	 * the next shard. Used by the adversarial merge-safety probe to inject an
	 * OPTIMIZE TABLE ... FINAL between shard exports, forcing a physical layout
	 * change that the static-snapshot plan must detect.
	 */
	readonly afterShardValidated?: (db: Chdb, signal: ArchiveSignal) => void
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
	// Enforce exact column set and order: every source column must have a
	// positionally-matching Parquet column with a compatible base type, and no
	// extra Parquet columns may exist (a schema drift that adds/drops/reorders
	// columns fails closed).
	if (parquetCols.length !== source.length) {
		throw new Error(
			`archive shard validation failed: ${shardPath} column count mismatch: source ${source.length}, Parquet ${parquetCols.length}`,
		)
	}
	for (let i = 0; i < source.length; i++) {
		const src = source[i]!
		const par = parquetCols[i]!
		if (src.name !== par.name) {
			throw new Error(
				`archive shard validation failed: ${shardPath} column ${i} name mismatch: source ${src.name}, Parquet ${par.name}`,
			)
		}
		if (baseType(par.type) !== baseType(src.type)) {
			throw new Error(
				`archive shard validation failed: ${shardPath} column ${src.name} base type mismatch: source ${baseType(src.type)} (${src.type}), Parquet ${baseType(par.type)} (${par.type})`,
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
	part: string,
	offsetLo: number,
	offsetHi: number,
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
	// Source-interval validation: re-query the SOURCE table for the same
	// (part, offset) interval and compare count + time bounds with the reopened
	// Parquet. This proves the shard contains exactly the source rows for this
	// physical interval, closing the gap where a wrong-but-valid row set could
	// pass (cross-check HIGH #2).
	// Time bounds are compared via toUnixTimestamp64Nano (timezone-independent):
	// the source min/max renders in the session timezone while the Parquet reopen
	// renders in UTC, so string comparison would always mismatch. Cast to
	// DateTime64 first so both DateTime and DateTime64 columns work.
	const nanoCol = `toUnixTimestamp64Nano(toDateTime64(${signal.eventTimeColumn}, 9))`
	const partLit = sqlLiteral(part)
	const sourceSql =
		`SELECT count() AS sc, min(${nanoCol}) AS smn, max(${nanoCol}) AS smx ` +
		`FROM ${signal.name} WHERE _part = '${partLit}' ` +
		`AND _part_offset >= ${offsetLo} AND _part_offset <= ${offsetHi}`
	const sourceRow = readRows(db.query(sourceSql, "JSONEachRow"))[0]
	const sourceCount = Number(sourceRow?.sc ?? 0)
	if (sourceCount !== rowCount) {
		throw new Error(
			`archive shard validation failed: ${shardPath} source interval has ${sourceCount} rows but Parquet has ${rowCount}`,
		)
	}
	const sourceMinNano = String(sourceRow?.smn ?? "")
	const sourceMaxNano = String(sourceRow?.smx ?? "")
	// Re-query the Parquet bounds in the same timezone-independent form.
	const parquetBoundsNanoSql =
		`SELECT min(${nanoCol}) AS mn, max(${nanoCol}) AS mx ` + `FROM file('${lit}', Parquet)`
	const parquetBoundsNanoRow = readRows(db.query(parquetBoundsNanoSql, "JSONEachRow"))[0]
	const parquetMinNano = String(parquetBoundsNanoRow?.mn ?? "")
	const parquetMaxNano = String(parquetBoundsNanoRow?.mx ?? "")
	if (sourceMinNano !== parquetMinNano || sourceMaxNano !== parquetMaxNano) {
		throw new Error(
			`archive shard validation failed: ${shardPath} source time bounds [${sourceMinNano}, ${sourceMaxNano}] != Parquet [${parquetMinNano}, ${parquetMaxNano}] (nanos)`,
		)
	}
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
 * A physical shard plan: which part, which offset interval, and how many rows.
 * The plan is enumerated ONCE before any export query, so a merge between shard
 * queries changes the layout but the plan still targets exact immutable
 * part+offset locations. After export, the plan is re-verified against the live
 * part inventory; if any planned part no longer exists, the export fails closed.
 */
interface ShardPlan {
	readonly part: string
	readonly offsetLo: number
	readonly offsetHi: number
	readonly expectedRows: number
	readonly hour: number
	readonly seq: number
}

/**
 * Enumerate the physical part inventory for one UTC hour of a date. Returns one
 * entry per active part with its row count and _part_offset range. This freezes
 * the shard plan: each shard will target a specific part by name + offset range,
 * not a relative LIMIT/OFFSET.
 */
const enumeratePartsForHour = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
): ReadonlyArray<{ part: string; rows: number; lo: number; hi: number }> => {
	const sql =
		`SELECT _part AS part, count() AS rows, ` +
		`min(_part_offset) AS lo, max(_part_offset) AS hi ` +
		`FROM ${signal.name} ` +
		`WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}' ` +
		`AND toHour(${signal.eventTimeColumn}, 'UTC') = ${hour} ` +
		`GROUP BY _part ORDER BY _part`
	const rows = readRows(db.query(sql, "JSONEachRow"))
	return rows.map((r) => ({
		part: String(r.part),
		rows: Number(r.rows),
		lo: Number(r.lo),
		hi: Number(r.hi),
	}))
}

/**
 * Re-verify the hour's total row count after all shards are exported. A merge
 * may have changed the part layout (part names), but the per-shard validation
 * already proved each shard contains the correct rows for its part+offset
 * interval. The post-hour check verifies the hour's TOTAL row count is unchanged
 * — if a merge added or removed rows, or the data was concurrently modified,
 * the total drifts and the export fails closed. This is robust against layout
 * changes (part name churn) while still detecting data loss/gain.
 */
const verifyHourTotalUnchanged = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
	plannedTotal: number,
): void => {
	const live = enumeratePartsForHour(db, signal, rangeDate, hour)
	const liveTotal = live.reduce((sum, p) => sum + p.rows, 0)
	if (liveTotal !== plannedTotal) {
		throw new Error(
			`archive export layout changed: hour ${hour} total rows changed from ${plannedTotal} to ${liveTotal}; ` +
				`aborting to prevent silent corruption`,
		)
	}
}

/**
 * Build the shard plan for one hour by splitting each part's offset range into
 * bounded intervals. Each shard targets `WHERE _part = '<part>' AND _part_offset
 * BETWEEN <lo> AND <hi>` — a physical predicate that targets exact rows by their
 * immutable location, not a relative OFFSET that drifts when parts merge.
 */
const planHourShards = (
	parts: ReadonlyArray<{ part: string; rows: number; lo: number; hi: number }>,
	hour: number,
	maxShardRows: number,
): ShardPlan[] => {
	const plans: ShardPlan[] = []
	let seq = 0
	for (const part of parts) {
		// Split this part's offset range into bounded intervals.
		const subCount = Math.max(1, Math.ceil(part.rows / maxShardRows))
		const rowsPerShard = Math.ceil(part.rows / subCount)
		for (let s = 0; s < subCount; s++) {
			const offsetLo = part.lo + s * rowsPerShard
			const offsetHi = Math.min(part.lo + (s + 1) * rowsPerShard - 1, part.hi)
			const expectedRows = offsetHi - offsetLo + 1
			if (expectedRows <= 0) break
			plans.push({ part: part.part, offsetLo, offsetHi, expectedRows, hour, seq })
			seq++
		}
	}
	return plans
}

/**
 * Export one signal for a sealed UTC day as bounded Parquet shards under
 * `shardsDir`. Uses a static-snapshot physical plan:
 *
 * 1. For each UTC hour, enumerate the active parts and their _part_offset ranges
 *    (freezing the layout).
 * 2. Split each part's range into bounded intervals (one Parquet file each).
 * 3. Export each shard via `WHERE _part = '<part>' AND _part_offset BETWEEN <lo>
 *    AND <hi>` — a physical predicate targeting exact immutable rows.
 * 4. After all shards for the hour, re-enumerate and verify every planned part
 *    still exists with the same row count. If a merge changed the layout, fail.
 * 5. Each written shard is validated by reopening it (H-1).
 */
export const exportSignalShards = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	shardsDir: string,
	settings: ExportSettings,
): WrittenShard[] => {
	assertSafePath(shardsDir)
	// Freeze merges for the duration of the export so the part inventory is
	// stable. Without this, a background merge on the restored scratch store can
	// change part names between enumeration, export, and source-interval
	// validation, causing stale-part false failures (or worse, silent corruption
	// if the merge completed mid-export on the old OFFSET approach).
	db.exec(`SYSTEM STOP MERGES ${signal.name}`)
	const sourceSchema = captureSourceSchema(db, signal)
	const shards: WrittenShard[] = []
	try {
		for (const hour of HOURS_IN_DAY) {
			const parts = enumeratePartsForHour(db, signal, rangeDate, hour)
			if (parts.length === 0) continue
			const plans = planHourShards(parts, hour, settings.maxShardRows)
			for (const plan of plans) {
				const name = shardName(hour, plan.seq)
				const path = join(shardsDir, name)
				assertSafePath(path)
				if (existsSync(path))
					throw new Error(`archive shard already exists; refusing to overwrite: ${path}`)
				const lit = sqlLiteral(path)
				// Physical predicate: target exact part + offset interval. This is
				// merge-safe — a merge of a DIFFERENT part cannot change this shard's
				// rows. If THIS part merges away, the post-export verifyPartsUnchanged
				// catches it.
				db.query(
					`SELECT * FROM ${signal.name} ` +
						`WHERE _part = '${sqlLiteral(plan.part)}' ` +
						`AND _part_offset >= ${plan.offsetLo} AND _part_offset <= ${plan.offsetHi} ` +
						`INTO OUTFILE '${lit}' FORMAT Parquet ` +
						`SETTINGS max_threads = ${settings.writerThreads}, ` +
						`output_format_parquet_row_group_size = ${settings.rowGroupRows}`,
					"Null",
				)
				const validated = validateShard(
					db,
					path,
					signal,
					rangeDate,
					hour,
					plan.expectedRows,
					sourceSchema,
					plan.part,
					plan.offsetLo,
					plan.offsetHi,
				)
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
				// Allow the adversarial probe to inject a layout change (e.g.
				// OPTIMIZE TABLE ... FINAL) between shard exports. The post-hour
				// verifyPartsUnchanged must then detect the stale plan and abort.
				settings.afterShardValidated?.(db, signal)
			}
			// After all shards for this hour, verify the total row count is unchanged.
			// A merge may have renamed parts, but the per-shard source-interval
			// validation already proved each shard's data. This catches data loss/gain.
			const plannedTotal = parts.reduce((sum, p) => sum + p.rows, 0)
			verifyHourTotalUnchanged(db, signal, rangeDate, hour, plannedTotal)
		}
		return shards
	} finally {
		// Always restart merges, even on failure, so the scratch store is clean.
		db.exec(`SYSTEM START MERGES ${signal.name}`)
	}
}
