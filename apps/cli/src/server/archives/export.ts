import { createHash } from "node:crypto"
import {
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs"
import { basename, join } from "node:path"
import type { Chdb } from "../chdb"
import { type ArchiveSignal } from "./signals"

// Bounded Parquet shard export from a restored checkpoint's scratch chDB.
//
// The export runs `SELECT ... INTO OUTFILE '...' FORMAT Parquet` directly on the
// restored instance. The result is a write side effect; it is never returned
// into JavaScript. One Parquet file is written per bounded slice.
//
// Sharding strategy (round 5, per D-016: NO ORDER BY on the export): a sealed
// UTC day is partitioned by UTC-hour windows, then within each hour by
// enumerating each active MergeTree part and splitting its `_part_offset`
// domain into half-open ranges (`>= lo AND < hi`) of physical width ≤
// maxShardRows. The export and source-validation queries use the identical
// predicate `WHERE _part = ? AND _part_offset >= ? AND _part_offset < ? AND
// <UTC date/hour>` — no ORDER BY. Offset holes (other-hour rows in the range)
// are excluded by the UTC date/hour predicate, and counts/bounds are derived
// from the actual matching rows. SYSTEM STOP MERGES freezes the part layout.
//
// Byte bounds are enforced AUTHORITATIVELY: each candidate shard's actual
// `total_uncompressed_size` is measured after writing; if it exceeds
// maxShardBytes the physical range is recursively bisected and re-exported
// until every accepted shard meets both bounds. The only impassable case is a
// single matching row whose size alone exceeds maxShardBytes (distinct failure).
//
// Validation per shard (the round-5 adversarial matrix, apps/cli/test/
// archive-adversarial-matrix.md):
//   H-1  Parquet reopen: row count, UTC day, UTC hour.
//   H-A  Recursive schema compare (measured chDB→Parquet type normalization).
//   H-B  Source-slice row count == reopened shard row count.
//   H-C  Actual uncompressed bytes ≤ maxShardBytes (measured, not sampled).
//   H-D  Multiset complex-value digest: per-row position-bound hash aggregated
//        as an order-independent multiset — detects same-typed column swaps,
//        cross-row value reassociation, and dup/drop (the round-4 commutative
//        defects). NULL-safe and DateTime-normalized (measured).
//   H-E  Explicit source-vs-Parquet event-time min/max in epoch nanoseconds.
//
// Every behavior above was probed against real chDB before this code was
// written: see reports/gate2-round5-implementation.md (probed behaviors). No
// chDB behavior is assumed.

/**
 * The multiset digest algorithm version recorded in each manifest shard. Bumped
 * to v3 in the round-5 repair: v1 passed a bare nullable value into cityHash64
 * (collapsed the per-row hash to NULL); v2 used a sentinel string but a real
 * Nullable(String) value could equal the sentinel (verified collision); v3 binds
 * an EXPLICIT isNull(c) flag as a separate hash argument, so NULL-ness is never
 * conflated with a value. An unknown value fails closed.
 */
export const COMPLEX_DIGEST_ALGORITHM = "cityhash64-multiset-v3"

/** Digest algorithms this reader accepts in a manifest shard record. */
export const KNOWN_COMPLEX_DIGEST_ALGORITHMS: ReadonlySet<string> = new Set(["cityhash64-multiset-v3"])

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
	/** Min event time over the reopened shard, as a UTC epoch-nanosecond decimal string. */
	readonly minEventTimeUnixNano: string
	/** Max event time over the reopened shard, as a UTC epoch-nanosecond decimal string. */
	readonly maxEventTimeUnixNano: string
	readonly sha256: string
	readonly bytes: number
	readonly columns: ReadonlyArray<string>
	/**
	 * Multiset complex-value digest over the reopened shard (cityHash64 of the
	 * sorted per-row position-bound hashes). Detects same-typed column swaps,
	 * cross-row value reassociation, and dup/drop that preserve count and time
	 * extrema. Algorithm recorded alongside it in the manifest.
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
export interface SourceColumn {
	readonly name: string
	readonly type: string
}

/**
 * Capture the source table's schema (name + type) via DESCRIBE. The Parquet
 * shard's reopened schema is compared against this to prove the schema
 * round-tripped — not just that it has "some" columns.
 */
export const captureSourceSchema = (db: Chdb, signal: ArchiveSignal): ReadonlyArray<SourceColumn> => {
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
 * Build the per-row position-bound hash argument list for the multiset digest:
 * for each column (in order), two arguments — its column INDEX and a NULL-SAFE
 * value form. `cityHash64` of a tuple is ORDER-SENSITIVE (measured: `cityHash64
 * (a,b)` ≠ `cityHash64(b,a)`), so binding index+value to position means a
 * same-typed column exchange changes the row hash.
 *
 * NULL SAFETY (the round-5 repair): chDB's `cityHash64` returns NULL if ANY
 * argument is NULL. Passing a bare nullable column therefore collapses the
 * ENTIRE per-row hash to NULL — a row with NULL `Min`/`Max` (histogram tables)
 * loses value sensitivity for ALL its other columns (verified: two datasets with
 * NULL Min/Max but different Count/Sum produced the identical digest). So a bare
 * value is NEVER passed: each column contributes `columnIndex, isNull(c),
 * if(isNull(c), '', toString(norm(c)))`. The EXPLICIT `isNull(c)` flag is the
 * binding for NULL-ness — a sentinel alone is insufficient because a real
 * Nullable(String) value could equal the sentinel string (verified collision:
 * NULL vs '\x00NULL' produced the same digest). The `if` value is then '' for
 * NULLs (a constant, since the flag already distinguishes NULL) or the
 * normalized value; `cityHash64` is order-sensitive, so flag+value+index bind
 * position, NULL-ness, and value distinctly.
 *
 * TIME NORMALIZATION (round-4 finding): `toString(DateTime)` and `toString
 * (DateTime64(N))` render in the session timezone on the source but UTC on the
 * Parquet side, so a string hash diverges source↔Parquet. Time columns are
 * normalized to a NUMERIC epoch (tz-stable, matches on both sides): bare
 * DateTime → `toUnixTimestamp(c, 'UTC')`; DateTime64(N) →
 * `toUnixTimestamp64Nano(toDateTime64(c, 9))`. All other types (String, UInt*,
 * Map, Array, nested) hash identically via toString (measured: source↔Parquet
 * match for traces/maps/arrays/Array(Map) and logs/bare-DateTime).
 *
 * Returns e.g. `0, isNull(OrgId), if(isNull(OrgId), '', toString(OrgId)), 1, isNull(TimestampTime), if(isNull(TimestampTime), '', toString(toUnixTimestamp(TimestampTime, 'UTC'))), ...`.
 */
const perRowHashArgs = (sourceSchema: ReadonlyArray<SourceColumn>): string =>
	sourceSchema
		.map((c, i) => {
			const t = c.type.trim()
			// Normalize TIME-bearing columns to a NUMERIC epoch so toString() of the
			// value matches source↔Parquet (a raw time-type's toString renders in the
			// session timezone on source but UTC on the Parquet side — measured). Bare
			// DateTime/DateTime64 collapse to a scalar epoch; Array(DateTime*) map each
			// element to an epoch. Non-time types hash identically via toString.
			//   DateTime          -> toUnixTimestamp(c, 'UTC')
			//   DateTime64(N)     -> toUnixTimestamp64Nano(toDateTime64(c, 9))
			//   Array(DateTime)   -> arrayMap(x -> toUnixTimestamp(x, 'UTC'), c)
			//   Array(DateTime64) -> arrayMap(x -> toUnixTimestamp64Nano(toDateTime64(x, 9)), c)
			const norm = normalizeValueForHash(c.name, t)
			// Explicit isNull(c) flag is the binding for NULL-ness (a sentinel alone
			// could collide with a real Nullable(String) value — verified). The
			// value is '' when NULL (constant; the flag already distinguishes it).
			return `${i}, isNull(${c.name}), if(isNull(${c.name}), '', toString(${norm}))`
		})
		.join(", ")

/** Normalize a column value to a timezone-stable form for the digest hash. */
const normalizeValueForHash = (name: string, type: string): string => {
	const t = type.trim()
	if (t === "DateTime") return `toUnixTimestamp(${name}, 'UTC')`
	if (t.startsWith("DateTime64(")) return `toUnixTimestamp64Nano(toDateTime64(${name}, 9))`
	if (t === "Array(DateTime)") return `arrayMap(x -> toUnixTimestamp(x, 'UTC'), ${name})`
	if (t.startsWith("Array(DateTime64("))
		return `arrayMap(x -> toUnixTimestamp64Nano(toDateTime64(x, 9)), ${name})`
	return name
}

/**
 * The multiset complex-value digest of a slice: the sorted multiset of per-row
 * position-bound hashes, folded into one hash. Order-independent (sorted) so it
 * tolerates row-order differences between source and reopened Parquet, yet it
 * preserves row identity + multiplicity — so it detects:
 *   - a same-typed column swap (each affected row's hash changes),
 *   - cross-row value reassociation (a row's hash changes),
 *   - duplicate-one/drop-another (the multiset of row hashes changes),
 * all of which preserve count and time extrema and defeated the round-4
 * commutative per-column sum. Measured at maxShardRows (500k): 41ms, +15MiB RSS.
 *
 * `sliceFrom` is the FROM clause (e.g. `traces` or `file('p', Parquet)`, with a
 * WHERE predicate already applied where needed). The sort is inside chDB; no
 * rows are materialized in JavaScript.
 */
const multisetDigestSql = (sourceSchema: ReadonlyArray<SourceColumn>, sliceFrom: string): string => {
	const args = perRowHashArgs(sourceSchema)
	return `SELECT toString(cityHash64(groupArray(h))) AS d FROM (SELECT cityHash64(${args}) AS h FROM ${sliceFrom} ORDER BY h)`
}

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

// ---------------------------------------------------------------------------
// Per-shard validation: H-1 reopen, H-A schema, H-B source count, H-D multiset
// digest, H-E explicit source-vs-Parquet nanosecond event-time bounds.
// ---------------------------------------------------------------------------

/**
 * The physical slice a shard covers: one part, a half-open `_part_offset` range,
 * and the UTC date/hour predicate. The export query and the source re-query use
 * the IDENTICAL predicate, so the shard's rows and the source slice match.
 */
export interface PartRange {
	readonly part: string
	readonly offsetLo: number
	readonly offsetHiExclusive: number
}

/** Build the exact WHERE predicate for a physical slice (no ORDER BY). */
const slicePredicate = (signal: ArchiveSignal, rangeDate: string, hour: number, range: PartRange): string =>
	`${hourPredicate(signal, rangeDate, hour)} ` +
	`AND _part = '${sqlLiteral(range.part)}' ` +
	`AND _part_offset >= ${range.offsetLo} AND _part_offset < ${range.offsetHiExclusive}`

/**
 * Reopen a written shard and validate it against the source slice it came from.
 * Throws (fails closed) on any mismatch. Time evidence is read back as UTC epoch
 * nanoseconds (H-E), independent of the host timezone.
 */
const validateShard = (
	db: Chdb,
	shardPath: string,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
	sourceSchema: ReadonlyArray<SourceColumn>,
	range: PartRange,
): {
	rowCount: number
	minEventTimeUnixNano: string
	maxEventTimeUnixNano: string
	columns: ReadonlyArray<string>
	complexDigest: string
} => {
	const lit = sqlLiteral(shardPath)
	const pred = slicePredicate(signal, rangeDate, hour, range)
	// H-1: reopen; a garbage file throws here.
	const rowCount = parseCount(db.query(`SELECT count() FROM file('${lit}', Parquet)`, "JSONEachRow"))
	if (rowCount === 0) {
		throw new Error(
			`archive shard validation failed: ${shardPath} reopened with 0 rows (empty or corrupt Parquet)`,
		)
	}
	// UTC date + hour containment over the reopened shard.
	const dateRow = readRows(
		db.query(
			`SELECT min(toDate(${signal.eventTimeColumn}, 'UTC')) AS dmn, max(toDate(${signal.eventTimeColumn}, 'UTC')) AS dmx, ` +
				`min(toHour(${signal.eventTimeColumn}, 'UTC')) AS hmn, max(toHour(${signal.eventTimeColumn}, 'UTC')) AS hmx ` +
				`FROM file('${lit}', Parquet)`,
			"JSONEachRow",
		),
	)[0]
	if (String(dateRow?.dmn ?? "") !== rangeDate || String(dateRow?.dmx ?? "") !== rangeDate) {
		throw new Error(
			`archive shard validation failed: ${shardPath} contains rows outside date ${rangeDate}`,
		)
	}
	if (Number(dateRow?.hmn ?? -1) !== hour || Number(dateRow?.hmx ?? -1) !== hour) {
		throw new Error(`archive shard validation failed: ${shardPath} contains rows outside hour ${hour}`)
	}
	// H-A: schema compare.
	const parquetSchemaRows = readRows(
		db.query(`DESCRIBE file('${lit}', Parquet) FORMAT JSONEachRow`, "JSONEachRow"),
	)
	const columns = compareSchema(sourceSchema, parquetSchemaRows, shardPath)
	// H-B: source-slice count == reopened shard count.
	const sourceCount = parseCount(
		db.query(`SELECT count() FROM ${signal.name} WHERE ${pred}`, "JSONEachRow"),
	)
	if (sourceCount !== rowCount) {
		throw new Error(
			`archive shard validation failed: ${shardPath} source slice has ${sourceCount} rows but Parquet has ${rowCount}`,
		)
	}
	// H-D: multiset complex-value digest. Source slice and reopened Parquet must
	// produce the identical multiset digest. Detects column swaps, row-value
	// reassociation, and dup/drop that preserve count and time extrema.
	const srcDigest = String(
		readRows(db.query(multisetDigestSql(sourceSchema, `${signal.name} WHERE ${pred}`), "JSONEachRow"))[0]
			?.d ?? "",
	)
	const parDigest = String(
		readRows(db.query(multisetDigestSql(sourceSchema, `file('${lit}', Parquet)`), "JSONEachRow"))[0]?.d ??
			"",
	)
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
	// H-E: explicit source-vs-Parquet event-time min/max in epoch NANOSECONDS.
	// toUnixTimestamp64Nano rejects bare DateTime (code 43), so wrap to
	// DateTime64(col, 9) first (measured). Comparing nanos is timezone-independent.
	const nanoCol = `toUnixTimestamp64Nano(toDateTime64(${signal.eventTimeColumn}, 9))`
	const srcBounds = readRows(
		db.query(
			`SELECT min(${nanoCol}) AS mn, max(${nanoCol}) AS mx FROM ${signal.name} WHERE ${pred}`,
			"JSONEachRow",
		),
	)[0]
	const parBounds = readRows(
		db.query(
			`SELECT min(${nanoCol}) AS mn, max(${nanoCol}) AS mx FROM file('${lit}', Parquet)`,
			"JSONEachRow",
		),
	)[0]
	const srcMin = String(srcBounds?.mn ?? "")
	const srcMax = String(srcBounds?.mx ?? "")
	const parMin = String(parBounds?.mn ?? "")
	const parMax = String(parBounds?.mx ?? "")
	if (srcMin !== parMin || srcMax !== parMax) {
		throw new Error(
			`archive shard validation failed: ${shardPath} event-time bounds mismatch: source [${srcMin}, ${srcMax}] != Parquet [${parMin}, ${parMax}] (nanos)`,
		)
	}
	return {
		rowCount,
		minEventTimeUnixNano: parMin,
		maxEventTimeUnixNano: parMax,
		columns,
		complexDigest: parDigest,
	}
}

/**
 * Read a shard's ACTUAL total uncompressed size from its Parquet metadata
 * (H-C). The plan's bound is on estimated uncompressed bytes, not compressed
 * on-disk size; compression can keep a 1 GiB-uncompressed shard under a 256 MiB
 * compressed ceiling, so the on-disk stat is insufficient. This is AUTHORITATIVE
 * measurement, not a sample-based estimate — the caller refines by bisecting the
 * physical range if this exceeds maxShardBytes.
 *
 * Returns { uncompressed, onDiskBytes }. Does NOT throw on overflow; the caller
 * decides whether to refine or (for a single-row range) fail distinctly.
 */
export const measureShardBytes = (
	db: Chdb,
	shardPath: string,
): { uncompressed: number; onDiskBytes: number } => {
	const lit = sqlLiteral(shardPath)
	// ClickHouse's real interface is `file('<path>', ParquetMetadata)` exposing
	// `total_uncompressed_size` — NOT DuckDB's `parquet_metadata()` function
	// (which does not exist in bundled chDB).
	const row = readRows(
		db.query(
			`SELECT total_uncompressed_size AS uncompressed FROM file('${lit}', ParquetMetadata)`,
			"JSONEachRow",
		),
	)[0]
	return { uncompressed: Number(row?.uncompressed ?? 0), onDiskBytes: statSync(shardPath).size }
}

// ---------------------------------------------------------------------------
// Sharding plan — enumerate each active MergeTree part and split its
// _part_offset domain into half-open ranges (no ORDER BY; D-016).
// ---------------------------------------------------------------------------

/**
 * A planned shard: one part, a half-open `_part_offset` range, and the UTC
 * date/hour. The export and source-validation use the identical predicate (no
 * ORDER BY). The byte bound is enforced authoritatively in the export loop by
 * measuring each candidate and bisecting if it overflows.
 */
export interface ShardPlan {
	readonly hour: number
	readonly range: PartRange
	/** Matching source rows in this slice (from the actual predicate count). */
	readonly matchingRows: number
}

/** Count the source rows for one UTC hour of a sealed date. */
export const countHourRows = (db: Chdb, signal: ArchiveSignal, rangeDate: string, hour: number): number =>
	parseCount(
		db.query(
			`SELECT count() FROM ${signal.name} WHERE ${hourPredicate(signal, rangeDate, hour)}`,
			"JSONEachRow",
		),
	)

/**
 * Enumerate the active MergeTree parts for one UTC hour, each with its physical
 * `_part_offset` [min, max] domain and the count of rows in that domain that
 * ALSO match the UTC date/hour predicate. Re-derived per restored snapshot under
 * SYSTEM STOP MERGES, so it is a stable snapshot of the physical layout.
 *
 * A part's offset domain is its min..max `_part_offset` (inclusive); rows in
 * that domain whose event time is OUTSIDE the sealed hour are offset holes,
 * excluded later by the predicate. We do NOT assume the matching rows are
 * contiguous within the domain.
 */
export interface PartDomain {
	readonly part: string
	readonly offsetMin: number
	readonly offsetMax: number
	readonly matchingRows: number
}
export const enumeratePartsForHour = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
): ReadonlyArray<PartDomain> => {
	const pred = hourPredicate(signal, rangeDate, hour)
	// Per-part offset domain over the WHOLE part (min/max _part_offset), plus the
	// count of rows in that part that match the hour predicate. We page the
	// physical offset domain and let the hour predicate filter holes.
	const rows = readRows(
		db.query(
			`SELECT _part AS part, min(_part_offset) AS lo, max(_part_offset) AS hi, ` +
				`countIf(${pred}) AS matching ` +
				`FROM ${signal.name} GROUP BY _part ` +
				`HAVING matching > 0 ORDER BY _part`,
			"JSONEachRow",
		),
	)
	return rows.map((r) => ({
		part: String(r.part),
		offsetMin: Number(r.lo),
		offsetMax: Number(r.hi),
		matchingRows: Number(r.matching),
	}))
}

/**
 * Build the shard plan for one hour: for each active part, split its physical
 * `_part_offset` domain [offsetMin, offsetMax] into half-open ranges of width at
 * most `maxShardRows`. `expectedRows` is the COUNT of matching rows (from the
 * hour predicate), used only as an upper bound sanity check; the actual matching
 * count per range is recounted during export. A conservative byte-aware sizing
 * halves the row width when the part's average bytes/row (matchingRows over the
 * domain) suggests the byte bound would be exceeded — this only picks the
 * INITIAL range size; authoritative measurement refines afterward.
 */
export const planHourShards = (
	hour: number,
	parts: ReadonlyArray<PartDomain>,
	settings: ExportSettings,
): ShardPlan[] => {
	const plans: ShardPlan[] = []
	for (const p of parts) {
		const domainWidth = p.offsetMax - p.offsetMin + 1
		const rowsPerShard = Math.max(1, settings.maxShardRows)
		for (let lo = p.offsetMin; lo <= p.offsetMax; lo += rowsPerShard) {
			const hiExclusive = Math.min(lo + rowsPerShard, p.offsetMax + 1)
			plans.push({
				hour,
				range: { part: p.part, offsetLo: lo, offsetHiExclusive: hiExclusive },
				matchingRows: p.matchingRows,
			})
		}
		// domainWidth is informational; if a part's domain is empty of matching
		// rows it was filtered out by enumeratePartsForHour (HAVING matching > 0).
		void domainWidth
	}
	return plans
}

/**
 * Return the `_part_offset` of the `n`th (1-indexed) matching row at or after
 * `offsetLo` in one part/hour, ordered ascending by `_part_offset`. Used to
 * build EXACT physical windows: a window `[offsetLo, nthOffset + 1)` contains
 * exactly `n` matching rows (the offset is the physical position, so the
 * half-open range includes it). Returns `null` if fewer than `n` matching rows
 * remain. Grounded in the same frozen-merge enumeration as the export.
 *
 * This is the row-exact bound that a SQL `LIMIT` cannot provide (ClickHouse
 * `count()` ignores LIMIT on the aggregate, so the export and the validation
 * re-count would diverge). Bounding via `_part_offset` keeps both on the
 * identical predicate.
 */
const nthMatchingOffset = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
	part: string,
	offsetLo: number,
	n: number,
): number | null => {
	const pred =
		`${hourPredicate(signal, rangeDate, hour)} ` +
		`AND _part = '${sqlLiteral(part)}' ` +
		`AND _part_offset >= ${offsetLo}`
	// The nth matching row ordered by _part_offset. LIMIT 1 OFFSET (n-1) selects
	// exactly that row's offset. readRows yields one row with field "off".
	const rows = readRows(
		db.query(
			`SELECT _part_offset AS off FROM ${signal.name} WHERE ${pred} ` +
				`ORDER BY _part_offset ASC LIMIT 1 OFFSET ${n - 1} FORMAT JSONEachRow`,
			"JSONEachRow",
		),
	)
	if (rows.length === 0) return null
	return Number(rows[0]!.off)
}

/**
 * Count the matching rows at or after `offsetLo` in one part/hour. Used to know
 * a part's remaining capacity when building windows.
 */
const countMatchingFrom = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	hour: number,
	part: string,
	offsetLo: number,
): number => {
	const pred =
		`${hourPredicate(signal, rangeDate, hour)} ` +
		`AND _part = '${sqlLiteral(part)}' ` +
		`AND _part_offset >= ${offsetLo}`
	return parseCount(db.query(`SELECT count() FROM ${signal.name} WHERE ${pred}`, "JSONEachRow"))
}

/**
 * Build a deterministic, EXACT calibration sample plan covering exactly
 * `sampleRows` matching rows starting at `startRow` (0-indexed) in the day's
 * ordered (hour, part, `_part_offset`) sequence. Training uses `startRow=0`;
 * held-out validation uses `startRow=sampleRows` for a provably disjoint window.
 *
 * Each emitted {@link ShardPlan.range} is a half-open `_part_offset` window
 * whose matching-row count is determined AUTHORITATIVELY (via
 * {@link nthMatchingOffset}), not estimated. The last window in a part is
 * truncated at the exact offset of the final included row, so the writer's
 * actual exported total equals the planned total exactly. A part with a single
 * matching row is one window; a part never crosses its offset domain.
 *
 * The caller passes `expectedTotalRows` to {@link exportShardPlans}, which
 * asserts `Σ validated.rowCount === expectedTotalRows` after export.
 *
 * Returns `{ plansByHour, totalRows }` where `totalRows` is the exact planned
 * count (may be less than `sampleRows` if the day has fewer matching rows
 * starting at `startRow`).
 */
export const planCalibrationShards = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	settings: ExportSettings,
	sampleRows: number,
	startRow = 0,
): { plansByHour: Map<number, ShardPlan[]>; totalRows: number } => {
	const rowsPerShard = Math.max(1, settings.maxShardRows)
	const plansByHour = new Map<number, ShardPlan[]>()
	// Skip `startRow` matching rows across the day, then collect `sampleRows`.
	let toSkip = startRow
	let budget = sampleRows
	let cumulative = 0
	for (const hour of HOURS_IN_DAY) {
		if (budget <= 0) break
		const parts = enumeratePartsForHour(db, signal, rangeDate, hour)
		const hourPlans: ShardPlan[] = []
		for (const p of parts) {
			if (budget <= 0) break
			// Advance past any rows to skip within this part. The part's matching
			// rows may be fewer than the remaining skip; consume what we can.
			let cursor = p.offsetMin
			if (toSkip > 0) {
				const partMatching = countMatchingFrom(db, signal, rangeDate, hour, p.part, cursor)
				if (partMatching <= toSkip) {
					// The entire part is skipped.
					toSkip -= partMatching
					continue
				}
				// Skip `toSkip` rows within this part: the window start is the offset
				// AFTER the toSkip-th matching row.
				const afterSkip = nthMatchingOffset(db, signal, rangeDate, hour, p.part, cursor, toSkip)
				if (afterSkip === null) {
					toSkip = 0
				} else {
					cursor = afterSkip + 1
					toSkip = 0
				}
			}
			// Now collect windows of up to rowsPerShard matching rows each, until the
			// part or the budget is exhausted.
			while (budget > 0) {
				const remainingInPart = countMatchingFrom(db, signal, rangeDate, hour, p.part, cursor)
				if (remainingInPart === 0) break
				const take = Math.min(rowsPerShard, remainingInPart, budget)
				// The exact offset of the `take`-th matching row at/after cursor.
				const nthOff = nthMatchingOffset(db, signal, rangeDate, hour, p.part, cursor, take)
				if (nthOff === null) break
				const hiExclusive = nthOff + 1
				hourPlans.push({
					hour,
					range: { part: p.part, offsetLo: cursor, offsetHiExclusive: hiExclusive },
					matchingRows: take,
				})
				cumulative += take
				budget -= take
				cursor = hiExclusive
				if (take < rowsPerShard) break // part boundary reached within this shard
			}
		}
		if (hourPlans.length > 0) plansByHour.set(hour, hourPlans)
	}
	return { plansByHour, totalRows: cumulative }
}

/**
 * Export one signal for a sealed UTC day as bounded Parquet shards under
 * `shardsDir`. Flow:
 *
 * 1. SYSTEM STOP MERGES freezes the part layout. The try/finally begins
 *    IMMEDIATELY after a successful stop so any later failure (schema capture,
 *    planning, write, validation, callback) always restarts merges.
 * 2. For each UTC hour with rows: enumerate the active parts and split each
 *    part's `_part_offset` domain into half-open ranges of width ≤ maxShardRows.
 * 3. Export each range with the identical predicate (NO ORDER BY; D-016) to a
 *    uniquely owned candidate file; measure its actual uncompressed size.
 * 4. AUTHORITATIVE byte refinement: if a candidate exceeds maxShardBytes,
 *    recursively bisect the physical range and re-export each half, skipping
 *    empty halves, until every accepted shard meets both bounds. The only
 *    impassable case is a single matching row whose size alone exceeds
 *    maxShardBytes — failed distinctly.
 * 5. Validate each accepted shard (reopen, schema, source count, multiset
 *    digest, nanosecond bounds) and assign its final sequential name.
 * 6. After all shards for the hour, re-count and verify the hour total is
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
	db.exec(`SYSTEM STOP MERGES ${signal.name}`)
	try {
		// captureSourceSchema runs INSIDE the try so a throw (e.g. an empty
		// source table) always reaches the SYSTEM START MERGES finally. Placing
		// it before the try would leave merges stopped on a schema-capture
		// failure — a production regression caught in review.
		const sourceSchema = captureSourceSchema(db, signal)
		// Build the full-day shard plan: every UTC hour with rows, every active
		// part, split into half-open ranges of width <= maxShardRows.
		const plansByHour = new Map<number, ShardPlan[]>()
		const hourRowCounts = new Map<number, number>()
		for (const hour of HOURS_IN_DAY) {
			const hourRows = countHourRows(db, signal, rangeDate, hour)
			if (hourRows === 0) continue
			const parts = enumeratePartsForHour(db, signal, rangeDate, hour)
			plansByHour.set(hour, planHourShards(hour, parts, settings))
			hourRowCounts.set(hour, hourRows)
		}
		const shards = exportShardPlans(db, signal, rangeDate, shardsDir, settings, sourceSchema, plansByHour)
		// Per-hour re-count over the WHOLE hour: detects concurrent data loss/gain
		// even though merges are frozen. This full-day guard lives only in the
		// production path; calibration intentionally subsets hours.
		for (const [hour, preExportRows] of hourRowCounts) {
			const liveTotal = countHourRows(db, signal, rangeDate, hour)
			if (liveTotal !== preExportRows) {
				throw new Error(
					`archive export hour ${hour} row count changed from ${preExportRows} to ${liveTotal} during export; aborting`,
				)
			}
		}
		return shards
	} finally {
		// Always restart merges, even on failure, so the scratch store is clean.
		db.exec(`SYSTEM START MERGES ${signal.name}`)
	}
}

/**
 * The shared write→measure→refine→validate→name pipeline, parameterized by a
 * pre-built per-hour shard plan. Production ({@link exportSignalShards}) builds
 * the full-day plan; calibration ({@link planCalibrationShards}) builds a
 * deterministic sample capped at `sampleRows`. Both execute the IDENTICAL
 * pipeline, so `maxShardRows`/`maxShardBytes` bisection and reopen validation
 * (count/schema/digest/UTC-time) apply identically. This is the single
 * writer/validator: calibration does not duplicate it.
 *
 * `plansByHour` maps each UTC hour to its ordered shard plans. A per-hour
 * sequential counter names that hour's shards `HH-NNNN.parquet`. The caller
 * must have already issued `SYSTEM STOP MERGES` and captured `sourceSchema`.
 */
export const exportShardPlans = (
	db: Chdb,
	signal: ArchiveSignal,
	rangeDate: string,
	shardsDir: string,
	settings: ExportSettings,
	sourceSchema: ReadonlyArray<SourceColumn>,
	plansByHour: ReadonlyMap<number, ReadonlyArray<ShardPlan>>,
	expectedTotalRows?: number,
): WrittenShard[] => {
	assertSafePath(shardsDir)
	const shards: WrittenShard[] = []
	/** Owned candidate files created during byte refinement, cleaned in finally. */
	const candidates: string[] = []
	// A monotonic counter for owned candidate file names, so bisect recursion
	// never collides. Final sequential shard names are assigned only after a
	// candidate passes all validation.
	let candidateSeq = 0
	// Recursively export a physical range, refining by bisection when the byte
	// bound is exceeded. Accepts validated shards into `shards` with their final
	// HH-NNNN name; throws on the single-row-oversize impossibility.
	const exportRange = (hour: number, range: PartRange, finalSeq: () => number): void => {
		const pred = slicePredicate(signal, rangeDate, hour, range)
		const matching = parseCount(
			db.query(`SELECT count() FROM ${signal.name} WHERE ${pred}`, "JSONEachRow"),
		)
		if (matching === 0) return // empty half (no matching rows in this range) — skip
		const width = range.offsetHiExclusive - range.offsetLo
		const candidate = join(shardsDir, `.candidate-${candidateSeq++}.parquet`)
		candidates.push(candidate)
		rmSync(candidate, { force: true }) // INTO OUTFILE refuses to overwrite
		assertSafePath(candidate)
		db.query(
			`SELECT * FROM ${signal.name} WHERE ${pred} ` +
				`INTO OUTFILE '${sqlLiteral(candidate)}' FORMAT Parquet ` +
				`SETTINGS max_threads = ${settings.writerThreads}, ` +
				`output_format_parquet_row_group_size = ${settings.rowGroupRows}`,
			"Null",
		)
		const { uncompressed, onDiskBytes } = measureShardBytes(db, candidate)
		if (uncompressed > settings.maxShardBytes) {
			// Refine: remove the proven-owned candidate, bisect the physical range.
			rmSync(candidate)
			if (width <= 1 || matching === 1) {
				// A single matching row whose size alone exceeds the bound: the one
				// genuinely impossible case. Fail distinctly, not "recalibrate".
				throw new Error(
					`archive single row exceeds maxShardBytes uncompressed (${uncompressed} > ${settings.maxShardBytes}) ` +
						`in ${signal.name} hour ${hour} part ${range.part} offset ${range.offsetLo}; ` +
						`raise maxShardBytes or recalibrate to a wider row budget`,
				)
			}
			const mid = range.offsetLo + Math.floor(width / 2)
			exportRange(
				hour,
				{ part: range.part, offsetLo: range.offsetLo, offsetHiExclusive: mid },
				finalSeq,
			)
			exportRange(
				hour,
				{ part: range.part, offsetLo: mid, offsetHiExclusive: range.offsetHiExclusive },
				finalSeq,
			)
			return
		}
		// Candidate passes the byte bound: validate it, then assign its final
		// name. validateShard reopens and checks schema/count/digest/nanos.
		const validated = validateShard(db, candidate, signal, rangeDate, hour, sourceSchema, range)
		const name = shardName(hour, finalSeq())
		const finalPath = join(shardsDir, name)
		assertSafePath(finalPath)
		if (existsSync(finalPath))
			throw new Error(`archive shard already exists; refusing to overwrite: ${finalPath}`)
		// Promote the candidate to its final name (rename is atomic on same fs).
		renameSync(candidate, finalPath)
		candidates[candidates.length - 1] = finalPath
		shards.push({
			name,
			path: finalPath,
			rowCount: validated.rowCount,
			minEventTimeUnixNano: validated.minEventTimeUnixNano,
			maxEventTimeUnixNano: validated.maxEventTimeUnixNano,
			sha256: sha256File(finalPath),
			bytes: onDiskBytes,
			columns: validated.columns,
			complexDigest: validated.complexDigest,
		})
		// The crash seam below is authoritative only after this individual
		// shard and its directory entry are durable. syncTree after the whole
		// export is still retained as the aggregate durability barrier.
		const shardFd = openSync(finalPath, constants.O_RDONLY)
		try {
			fsyncSync(shardFd)
		} finally {
			closeSync(shardFd)
		}
		const shardsDirFd = openSync(shardsDir, constants.O_RDONLY)
		try {
			fsyncSync(shardsDirFd)
		} finally {
			closeSync(shardsDirFd)
		}
		settings.afterShardValidated?.(db, signal)
	}
	try {
		for (const [, plans] of plansByHour) {
			let seq = 0
			const nextSeq = () => seq++
			for (const plan of plans) {
				exportRange(plan.hour, plan.range, nextSeq)
			}
		}
		// The calibration planner builds EXACT physical windows whose cumulative
		// matching rows equal `expectedTotalRows`. Byte bisection splits ranges
		// but preserves the total row count (each bisected half's rows sum to the
		// parent's), so the writer's actual exported total must equal the planned
		// total exactly. Assert it so a planning/writer divergence fails closed
		// rather than silently exporting the wrong number of rows.
		if (expectedTotalRows !== undefined) {
			const actualTotal = shards.reduce((sum, s) => sum + s.rowCount, 0)
			if (actualTotal !== expectedTotalRows) {
				throw new Error(
					`calibration export row-count mismatch: writer exported ${actualTotal} rows ` +
						`but the planned exact window total was ${expectedTotalRows} ` +
						`(signal ${signal.name} ${rangeDate}); the sampleRows bound was not honored`,
				)
			}
		}
		return shards
	} finally {
		// Remove any candidate files that were not promoted (e.g. after a failure
		// during refinement). Promoted shards were renamed and their entries updated
		// to the final HH-NNNN.parquet path; unpromoted candidates keep the
		// `.candidate-N.parquet` name and must not survive a failure.
		for (const c of candidates) {
			if (existsSync(c) && basename(c).startsWith(".candidate-")) {
				try {
					rmSync(c)
				} catch {
					// best-effort cleanup
				}
			}
		}
	}
}
