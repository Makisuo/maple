import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Chdb } from "../chdb"
import { type ArchiveSignal } from "./signals"

// Bounded Parquet shard export from a restored checkpoint's scratch chDB.
//
// The export runs `SELECT ... INTO OUTFILE '...' FORMAT Parquet` directly on the
// restored instance. The result is a write side effect; it is never returned
// into JavaScript. One Parquet file is written per bounded slice.
//
// Sharding strategy (round-4, replaces the round-3 part-interval plan): a sealed
// UTC day is partitioned by UTC-hour windows, then within each hour by a
// (_part, _part_offset) cursor with LIMIT/OFFSET paging when a single hour
// exceeds the configured row or byte bound. Every export AND source-validation
// query carries the fixed UTC date+hour predicate, so non-contiguous matching
// offsets within a part are handled naturally — a hole between matching rows is
// skipped by the predicate, not assumed absent. SYSTEM STOP MERGES freezes the
// layout for the export's duration, making the (_part, _part_offset) ORDER BY
// deterministic (no concurrent merges, restored scratch has no writers). Each
// physical shard is bounded by BOTH maxShardRows and maxShardBytes (estimated
// uncompressed). A shard name encodes its slice: HH-NNNN.parquet.
//
// Validation per shard (proven against the round-3 adversarial scenarios):
//   H-1  Parquet reopen: row count, UTC day, UTC hour (a 19-byte garbage file fails).
//   H-A  Recursive schema compare: normalizes only the measured chDB→Parquet
//        transforms, compares the rest exactly — catches Array(UInt64)≠Array(String).
//   H-B  Source-interval count: re-query the source with the SAME date+hour +
//        offset predicate; the shard's reopened row count must match.
//   H-C  Byte bound: total_uncompressed_size from Parquet metadata ≤ maxShardBytes.
//   H-D  Complex-value digest: sum(cityHash64(*)) over the source interval must
//        equal the same aggregate over the reopened Parquet. Binary-safe
//        (works on Array(DateTime64(9)) where toString()-hashing fails) and
//        value-sensitive (detects a changed map value with identical count/time).
//
// All five checks are grounded in measured chDB behavior, not assumptions: see
// /private/tmp/maple-orchestration/reports/gate2-round4-probes.md.

export interface ExportSettings {
	readonly writerThreads: number
	readonly rowGroupRows: number
	readonly maxShardRows: number
	readonly maxShardBytes: number
	/**
	 * Optional callback invoked after each shard is written and validated, before
	 * the next shard. Used by the adversarial merge-safety probe to inject an
	 * OPTIMIZE TABLE ... FINAL between shard exports, forcing a physical layout
	 * change that STOP MERGES must block.
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
	/**
	 * Complex-value digest read back from the reopened Parquet:
	 * sum(cityHash64(*)) rendered as a string. The manifest binds the source
	 * interval's digest to this so a corrupted/substituted complex value that
	 * preserves count and time extrema is still detected at read time.
	 */
	readonly complexDigest: string
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

/** The fixed UTC date + hour predicate appended to every source/export query. */
const hourPredicate = (signal: ArchiveSignal, rangeDate: string, hour: number): string =>
	`toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}' AND toHour(${signal.eventTimeColumn}, 'UTC') = ${hour}`

// ---------------------------------------------------------------------------
// Schema comparison (blocker #4) — recursive, grounded in measured transforms.
// ---------------------------------------------------------------------------

/** A source column's name and type, captured before export for round-trip comparison. */
interface SourceColumn {
	readonly name: string
	readonly type: string
}

/**
 * Capture the source table's schema (name + type) via DESCRIBE. The Parquet
 * shard's reopened schema is compared against this to prove the schema
 * round-tripped — not just that it has "some" columns.
 */
const captureSourceSchema = (db: Chdb, signal: ArchiveSignal): ReadonlyArray<SourceColumn> => {
	const rows = readRows(db.query(`DESCRIBE ${signal.name} FORMAT JSONEachRow`, "JSONEachRow"))
	const cols = rows.map((r) => ({ name: String(r.name), type: String(r.type) }))
	if (cols.length === 0) throw new Error(`source table ${signal.name} has no columns`)
	return cols
}

/**
 * Tokenize a ClickHouse type string into a head token and balanced parenthesized
 * inner arguments, e.g. `Array(Map(String, String))` → { head: "Array", inner:
 * "Map(String, String)" }. Returns null for a leaf type with no parentheses.
 */
const splitType = (type: string): { head: string; inner: string } | null => {
	const open = type.indexOf("(")
	if (open < 0) return null
	const head = type.slice(0, open).trim()
	if (!type.endsWith(")")) return null
	const inner = type.slice(open + 1, -1)
	return { head, inner }
}

/**
 * Split a comma-separated argument list at top-level commas (ignoring commas
 * inside nested parentheses), so `Map(K, V)` arg lists and `Tuple` args parse.
 */
const splitArgs = (inner: string): string[] => {
	const args: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!
		if (ch === "(") depth++
		else if (ch === ")") depth--
		else if (ch === "," && depth === 0) {
			args.push(inner.slice(start, i).trim())
			start = i + 1
		}
	}
	const last = inner.slice(start).trim()
	if (last.length > 0) args.push(last)
	return args
}

/**
 * Normalize a ClickHouse type the way chDB's Parquet writer does, per the
 * measured round-trip in gate2-round4-probes.md:
 *   LowCardinality(T)              → normalize(T)
 *   DateTime                       → DateTime64(3, 'UTC')
 *   DateTime64(N)                  → DateTime64(N, 'UTC')
 *   Map(K, V)                      → Map(normalize(K), normalize(V))
 *   Array(T)                       → Array(normalize(T))
 *   Nullable(T)                    → Nullable(normalize(T))
 *   leaf (String, UInt*, Int*, Float*, Bool, …) → unchanged
 *
 * Only these transforms are applied; everything else compares exactly. This is
 * what makes parameterized types survive the comparison (Array(UInt64) stays
 * Array(UInt64)) while the lossy round-3 collapse (head token only) is fixed.
 */
export const normalizeType = (type: string): string => {
	const t = type.trim()
	const split = splitType(t)
	if (!split) {
		// Leaf types with no parameters. DateTime widens; DateTime64(N) gains UTC.
		// DateTime64 already parameterized is handled in the recursive branch below.
		if (/^DateTime$/.test(t)) return "DateTime64(3, 'UTC')"
		return t
	}
	const { head, inner } = split
	if (/^LowCardinality$/i.test(head)) {
		// LowCardinality has exactly one argument; unwrap and recurse.
		return normalizeType(inner)
	}
	if (/^DateTime64$/i.test(head)) {
		// Source DateTime64(9) → Parquet DateTime64(9, 'UTC'). The first arg is the
		// precision; add the UTC timezone. (If a timezone is already present we
		// normalize it to 'UTC' to match the measured output.)
		const args = splitArgs(inner)
		const precision = args[0] ?? "9"
		return `DateTime64(${precision}, 'UTC')`
	}
	if (/^Map$/i.test(head)) {
		const args = splitArgs(inner)
		return `Map(${args.map(normalizeType).join(", ")})`
	}
	if (/^Array$/i.test(head)) {
		return `Array(${normalizeType(inner)})`
	}
	if (/^Nullable$/i.test(head)) {
		return `Nullable(${normalizeType(inner)})`
	}
	// Any other parameterized type (e.g. Decimal, FixedString, Enum): keep its
	// head + raw inner so an unexpected type fails closed rather than collapsing.
	return `${head}(${inner})`
}

/**
 * Build a SQL expression whose sum over a slice is a NULL-safe, DateTime-stable,
 * value-sensitive complex-value digest that matches source ↔ reopened Parquet
 * for EVERY production table. A plain `sum(cityHash64(*))` fails two ways (both
 * measured, both verified in gate2-round4-probes.md and the six-signal smoke):
 *
 *   1. `cityHash64(col)` returns NULL when ANY column is NULL (the histogram
 *      tables' `Min`/`Max Nullable(Float64)` are NULL when unset), collapsing
 *      the whole digest to NULL/empty.
 *   2. A bare `DateTime` column widens to `DateTime64(3,'UTC')` on the Parquet
 *      side, and the precision change alters the binary hash.
 *
 * The fix is a per-column contribution: a DISTINCT sentinel constant for NULL
 * (so a NULL never propagates and a NULL↔value flip always changes the sum),
 * otherwise `toUInt64(cityHash64(normalized(col)))` where bare DateTime is cast
 * to its Parquet DateTime64(3,'UTC') form first. Every other type (String,
 * UInt*, Map, Array, Nullable, DateTime64(N), LowCardinality) hashes identically
 * on both sides. Returns e.g. `if(isNull(OrgId), 1000003, toUInt64(cityHash64(OrgId))) + ...`.
 */
const digestSumExpression = (sourceSchema: ReadonlyArray<SourceColumn>): string =>
	sourceSchema
		.map((c, i) => {
			const cast = c.type.trim() === "DateTime" ? `toDateTime64(${c.name}, 3, 'UTC')` : c.name
			const sentinel = 1_000_003 * (i + 1)
			return `if(isNull(${c.name}), ${sentinel}, toUInt64(cityHash64(${cast})))`
		})
		.join(" + ")

/**
 * Compare a reopened Parquet shard's schema against the captured source schema.
 * Source types are normalized to their Parquet-round-trip form, then compared
 * exactly — so parameterized inner types survive (Array(UInt64) ≠ Array(String))
 * while the measured lossless transforms (LowCardinality unwrap, DateTime widen,
 * timezone add) are tolerated. Exact column name, count, and order are enforced.
 */
export const compareSchema = (
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
	// Enforce exact column set and order: every source column must have a
	// positionally-matching Parquet column with an exactly-equal normalized type,
	// and no extra Parquet columns may exist (a drift that adds/drops/reorders
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
		const srcNorm = normalizeType(src.type)
		const parNorm = normalizeType(par.type)
		if (srcNorm !== parNorm) {
			throw new Error(
				`archive shard validation failed: ${shardPath} column ${src.name} type mismatch: source ${src.type} (→${srcNorm}), Parquet ${par.type} (→${parNorm})`,
			)
		}
	}
	return parquetCols.map((c) => c.name)
}

// ---------------------------------------------------------------------------
// Per-shard validation (H-1 reopen, H-A schema, H-B source count, H-D digest).
// ---------------------------------------------------------------------------

const validateShard = (
	db: Chdb,
	shardPath: string,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
	expectedRows: number,
	sourceSchema: ReadonlyArray<SourceColumn>,
	/** The deterministic page bounds the shard's rows came from (source re-query). */
	pageOffset: number,
	pageLimit: number,
): {
	rowCount: number
	minEventTime: string
	maxEventTime: string
	columns: ReadonlyArray<string>
	complexDigest: string
} => {
	const lit = sqlLiteral(shardPath)
	const pred = hourPredicate(signal, rangeDate, hour)
	// Reopen the Parquet file via chDB's file() table function. If the file is
	// not valid Parquet, this query throws (H-1: the prior code accepted a
	// 19-byte invalid file).
	const rowCount = parseCount(db.query(`SELECT count() FROM file('${lit}', Parquet)`, "JSONEachRow"))
	if (rowCount === 0) {
		throw new Error(
			`archive shard validation failed: ${shardPath} reopened with 0 rows (empty or corrupt Parquet)`,
		)
	}
	// Per-shard row count must match the planned slice size (H-B).
	if (rowCount !== expectedRows) {
		throw new Error(
			`archive shard validation failed: ${shardPath} has ${rowCount} rows, expected ${expectedRows}`,
		)
	}
	// Verify the UTC DATE of all rows matches the sealed day.
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
	// Compare the reopened Parquet schema against the source table schema (H-A).
	const descSql = `DESCRIBE file('${lit}', Parquet) FORMAT JSONEachRow`
	const parquetSchemaRows = readRows(db.query(descSql, "JSONEachRow"))
	const columns = compareSchema(sourceSchema, parquetSchemaRows, shardPath)
	// H-B + H-D source re-query: re-select the EXACT same rows the shard holds by
	// re-running the identical date+hour predicate + deterministic (_part,
	// _part_offset) ORDER BY + the same LIMIT/OFFSET page. We bind by PAGE
	// POSITION, not by _part_offset value: _part_offset repeats across parts, so
	// a `_part_offset IN (...)` membership test would over-match other parts'
	// rows. The subquery here is byte-for-byte the same row selection as the
	// export query, so count and complex-value digest are directly comparable.
	const sourceSliceSubquery =
		`(SELECT * FROM ${signal.name} WHERE ${pred} ` +
		`ORDER BY (_part, _part_offset) LIMIT ${pageLimit} OFFSET ${pageOffset}) AS _src`
	const sourceCountSql = `SELECT count() AS sc FROM ${sourceSliceSubquery}`
	const sourceRow = readRows(db.query(sourceCountSql, "JSONEachRow"))[0]
	const sourceCount = Number(sourceRow?.sc ?? 0)
	if (sourceCount !== rowCount) {
		throw new Error(
			`archive shard validation failed: ${shardPath} source slice has ${sourceCount} rows but Parquet has ${rowCount}`,
		)
	}
	// H-D: complex-value digest. A NULL-safe, DateTime-normalized per-column
	// sum (see digestSumExpression) over the source slice must equal the same
	// expression over the reopened Parquet. This is value-sensitive (detects a
	// changed map/array/NULL value that keeps identical count and time extrema —
	// the gap H-B alone leaves open) and robust to the two measured behaviors that
	// defeat a plain `sum(cityHash64(*))`:
	//   - cityHash64 returns NULL when any column is NULL (histogram Min/Max);
	//   - bare DateTime hashes differently after Parquet widens it to DateTime64(3).
	// See digestSumExpression and gate2-round4-probes.md.
	const sumExpr = digestSumExpression(sourceSchema)
	// Source page is selected in a subquery so the ORDER BY _part (needed for the
	// deterministic LIMIT/OFFSET page) does not collide with the outer sum.
	const colList = sourceSchema.map((c) => c.name).join(", ")
	const srcDigestSql =
		`SELECT toString(sum(${sumExpr})) AS d FROM ` +
		`(SELECT ${colList} FROM ${signal.name} WHERE ${pred} ` +
		`ORDER BY (_part, _part_offset) LIMIT ${pageLimit} OFFSET ${pageOffset})`
	const srcDigestRow = readRows(db.query(srcDigestSql, "JSONEachRow"))[0]
	const srcDigest = String(srcDigestRow?.d ?? "")
	const parDigestSql = `SELECT toString(sum(${sumExpr})) AS d FROM file('${lit}', Parquet)`
	const parDigestRow = readRows(db.query(parDigestSql, "JSONEachRow"))[0]
	const parDigest = String(parDigestRow?.d ?? "")
	if (srcDigest.length === 0 || parDigest.length === 0) {
		throw new Error(
			`archive shard validation failed: ${shardPath} complex-value digest is empty (src=${srcDigest}, par=${parDigest}); NULL handling regression`,
		)
	}
	if (srcDigest !== parDigest) {
		throw new Error(
			`archive shard validation failed: ${shardPath} complex-value digest mismatch: source ${srcDigest} != Parquet ${parDigest}`,
		)
	}
	return { rowCount, minEventTime, maxEventTime, columns, complexDigest: parDigest }
}

/**
 * Validate the UNCOMPRESSED size of a shard against the byte bound (H-C). The
 * plan's bound is on estimated uncompressed bytes, not compressed on-disk size;
 * compression can keep a 1 GiB-uncompressed shard under a 256 MiB compressed
 * ceiling, so the on-disk stat is insufficient. We reopen the Parquet metadata
 * and read `total_uncompressed_size`.
 */
const validateShardBytes = (db: Chdb, shardPath: string, maxShardBytes: number): number => {
	const lit = sqlLiteral(shardPath)
	// ClickHouse's real interface is `file('<path>', ParquetMetadata)` exposing
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

// ---------------------------------------------------------------------------
// Sharding plan (blockers #1 + #5) — OFFSET paging within the date+hour
// predicate, byte-aware so a wide-row hour splits by bytes too.
// ---------------------------------------------------------------------------

/**
 * A planned shard: which hour, the LIMIT/OFFSET page within that hour, and how
 * many rows it will contain. Each shard re-exports with the SAME date+hour
 * predicate plus `ORDER BY (_part, _part_offset) LIMIT n OFFSET m`. With merges
 * stopped and no concurrent writers (a restored scratch checkpoint), that ORDER
 * BY is deterministic, so non-contiguous matching offsets are paged correctly
 * — a hole between matching rows is skipped by the predicate, not assumed away.
 */
interface ShardPlan {
	readonly hour: number
	readonly seq: number
	readonly offset: number
	readonly limit: number
	readonly expectedRows: number
}

/**
 * Count the source rows for one UTC hour of a sealed date. Used both to decide
 * whether paging is needed and to size each page.
 */
const countHourRows = (db: Chdb, signal: ArchiveSignal, rangeDate: string, hour: number): number => {
	const sql = `SELECT count() FROM ${signal.name} WHERE ${hourPredicate(signal, rangeDate, hour)}`
	return parseCount(db.query(sql, "JSONEachRow"))
}

/**
 * Estimate the average uncompressed bytes per row for one hour by exporting a
 * small probe slice (up to PROBE_ROWS) and reading total_uncompressed_size.
 * Falls back to 0 (no byte splitting, row-only) if the hour is empty or the
 * probe yields no metadata. The probe shard is removed after measurement.
 */
const PROBE_ROWS = 256
const estimateBytesPerRow = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
	hourRows: number,
	probePath: string,
	settings: ExportSettings,
): number => {
	if (hourRows === 0) return 0
	const limit = Math.min(PROBE_ROWS, hourRows)
	// Remove any stale probe file first: INTO OUTFILE refuses to overwrite, and
	// this path is reused across hours (and would collide with a prior probe).
	rmSync(probePath, { force: true })
	db.query(
		`SELECT * FROM ${signal.name} WHERE ${hourPredicate(signal, rangeDate, hour)} ` +
			`ORDER BY (_part, _part_offset) LIMIT ${limit} ` +
			`INTO OUTFILE '${sqlLiteral(probePath)}' FORMAT Parquet ` +
			`SETTINGS max_threads = ${settings.writerThreads}, ` +
			`output_format_parquet_row_group_size = ${settings.rowGroupRows}`,
		"Null",
	)
	const row = readRows(
		db.query(
			`SELECT total_uncompressed_size AS u FROM file('${sqlLiteral(probePath)}', ParquetMetadata)`,
			"JSONEachRow",
		),
	)[0]
	const probeRows = parseCount(
		db.query(`SELECT count() FROM file('${sqlLiteral(probePath)}', Parquet)`, "JSONEachRow"),
	)
	const bytesPerRow = probeRows <= 0 ? 0 : Number(row?.u ?? 0) / probeRows
	// Remove the probe immediately so it never reaches the promote step or
	// collides with the next hour's probe at the same path.
	rmSync(probePath, { force: true })
	return bytesPerRow
}

/**
 * Build the shard plan for one hour: split into pages of at most maxShardRows
 * AND at most maxShardBytes (estimated). The rows-per-shard is the smaller of
 * the row limit and the byte-budget-derived row limit, so a wide-row hour
 * splits by bytes even when it is under the row limit.
 */
export const planHourShards = (
	hour: number,
	hourRows: number,
	bytesPerRow: number,
	settings: ExportSettings,
): ShardPlan[] => {
	if (hourRows === 0) return []
	const maxByRows = settings.maxShardRows
	// Rows that fit in the byte budget. Use ceil so a single row never exceeds it
	// silently; validateShardBytes still enforces the hard ceiling after export.
	const maxByBytes =
		bytesPerRow > 0 ? Math.max(1, Math.floor(settings.maxShardBytes / bytesPerRow)) : maxByRows
	const rowsPerShard = Math.max(1, Math.min(maxByRows, maxByBytes))
	const shardCount = Math.max(1, Math.ceil(hourRows / rowsPerShard))
	// Distribute as evenly as possible (each shard either `base` or `base+1` rows).
	const base = Math.floor(hourRows / shardCount)
	const remainder = hourRows % shardCount
	const plans: ShardPlan[] = []
	let offset = 0
	for (let seq = 0; seq < shardCount; seq++) {
		const limit = base + (seq < remainder ? 1 : 0)
		if (limit <= 0) break
		plans.push({ hour, seq, offset, limit, expectedRows: limit })
		offset += limit
	}
	return plans
}

/**
 * Export one signal for a sealed UTC day as bounded Parquet shards under
 * `shardsDir`. Flow:
 *
 * 1. SYSTEM STOP MERGES freezes the part layout. The try/finally begins
 *    IMMEDIATELY after a successful stop so any later failure (schema capture,
 *    planning, write, validation, callback) always restarts merges.
 * 2. For each UTC hour with rows: count rows, estimate bytes/row, build a page
 *    plan bounded by rows AND bytes.
 * 3. Export each page with the fixed date+hour predicate + `ORDER BY
 *    (_part, _part_offset) LIMIT n OFFSET m` — deterministic under the freeze.
 * 4. Validate each shard (reopen, schema, source count, complex digest, bytes).
 * 5. After all shards for the hour, re-count and verify the hour total is
 *    unchanged (detects concurrent data loss/gain even though merges are frozen).
 */
export const exportSignalShards = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	shardsDir: string,
	settings: ExportSettings,
): WrittenShard[] => {
	assertSafePath(shardsDir)
	// Freeze merges so the (_part, _part_offset) ORDER BY is stable across the
	// export and source-validation queries. The try begins right here so a
	// failure at ANY later point restarts merges (blocker #2).
	db.exec(`SYSTEM STOP MERGES ${signal.name}`)
	const shards: WrittenShard[] = []
	let probePath = ""
	try {
		const sourceSchema = captureSourceSchema(db, signal)
		probePath = join(shardsDir, ".probe.parquet")
		for (const hour of HOURS_IN_DAY) {
			const hourRows = countHourRows(db, signal, rangeDate, hour)
			if (hourRows === 0) continue
			const bytesPerRow = estimateBytesPerRow(
				db,
				signal,
				rangeDate,
				hour,
				hourRows,
				probePath,
				settings,
			)
			const plans = planHourShards(hour, hourRows, bytesPerRow, settings)
			for (const plan of plans) {
				const name = shardName(hour, plan.seq)
				const path = join(shardsDir, name)
				assertSafePath(path)
				if (existsSync(path))
					throw new Error(`archive shard already exists; refusing to overwrite: ${path}`)
				const lit = sqlLiteral(path)
				// The exact source slice for this shard: date+hour predicate plus the
				// deterministic (_part, _part_offset) page. validation re-queries the
				// source with a row-number subquery that reproduces the SAME page, so
				// source re-query and Parquet reopen cover identical rows.
				db.query(
					`SELECT * FROM ${signal.name} WHERE ${hourPredicate(signal, rangeDate, hour)} ` +
						`ORDER BY (_part, _part_offset) LIMIT ${plan.limit} OFFSET ${plan.offset} ` +
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
					// Source re-query reproduces the SAME page: identical predicate +
					// (_part, _part_offset) ORDER BY + LIMIT/OFFSET. See validateShard
					// for why this binds by page position, not _part_offset value.
					plan.offset,
					plan.limit,
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
					complexDigest: validated.complexDigest,
				})
				// Allow the adversarial probe to inject a layout change (e.g.
				// OPTIMIZE TABLE ... FINAL) between shard exports. STOP MERGES must
				// block it; the post-hour total check would catch any drift anyway.
				settings.afterShardValidated?.(db, signal)
			}
			// After all shards for this hour, verify the total row count is unchanged.
			const liveTotal = countHourRows(db, signal, rangeDate, hour)
			if (liveTotal !== hourRows) {
				throw new Error(
					`archive export hour ${hour} row count changed from ${hourRows} to ${liveTotal} during export; aborting`,
				)
			}
		}
		return shards
	} finally {
		// Remove the byte-estimation probe shard if it was created.
		if (probePath && existsSync(probePath)) {
			try {
				rmSync(probePath)
			} catch {
				// best-effort cleanup; the promote step never sees .probe.parquet
			}
		}
		// Always restart merges, even on failure, so the scratch store is clean.
		db.exec(`SYSTEM START MERGES ${signal.name}`)
	}
}
