import { qualifyStatementForDatabase } from "./qualify"

/**
 * Structured backfill statements.
 *
 * A backfill is a chunkable `INSERT INTO <target> SELECT <select> FROM <from>
 * [WHERE <where>]`. Unlike a raw DDL string, the apply engine can split it into
 * time windows on `tsColumn` so each chunk completes well within a Cloudflare
 * Worker subrequest budget (~100s) — a single `INSERT…SELECT` over billions of
 * source rows otherwise runs for minutes and can never complete from the Worker.
 *
 * Migrations express heavy backfills as `BackfillSpec` (instead of a raw string)
 * so both apply paths can either run the full statement (`renderBackfillFull`,
 * byte-equivalent to the old raw SQL) or window it (`compileBackfillChunk`).
 */
export interface BackfillSpec {
	readonly kind: "backfill"
	/** Destination table (Maple-managed, unqualified). */
	readonly target: string
	/** Explicit destination column list, in INSERT order. */
	readonly columns: ReadonlyArray<string>
	/** Source table the SELECT reads from (must have a known time column). */
	readonly from: string
	/** Time column on `from` used to window chunks (the raw source column). */
	readonly tsColumn: string
	/** SELECT projection list — everything between `SELECT` and `FROM`. */
	readonly select: string
	/** Optional row filter, WITHOUT any time-window predicate. */
	readonly where?: string
	/**
	 * Optional GROUP BY list (for aggregate backfills). Safe to chunk as long as
	 * `tsColumn` windows are aligned coarser-than-or-equal to the aggregation
	 * grain (e.g. day windows for an hourly rollup) so no group straddles a chunk.
	 */
	readonly groupBy?: string
}

export const isBackfill = (stmt: unknown): stmt is BackfillSpec =>
	typeof stmt === "object" && stmt !== null && (stmt as { readonly kind?: unknown }).kind === "backfill"

/**
 * Reliable time column per source table backfills read from. Used to window
 * chunks. Keep in sync with `CLICKHOUSE_MV_SOURCE_TABLES` in `qualify.ts`.
 */
export const SOURCE_TIME_COLUMNS: Readonly<Record<string, string>> = {
	traces: "Timestamp",
	logs: "TimestampTime",
	metrics_sum: "TimeUnix",
	metrics_gauge: "TimeUnix",
	metrics_histogram: "TimeUnix",
	metrics_exponential_histogram: "TimeUnix",
	service_overview_spans: "Timestamp",
	service_operations_minutely: "Minute",
	session_events: "Timestamp",
}

const ident = (db: string, name: string): string => `\`${db}\`.\`${name}\``

const buildInsert = (spec: BackfillSpec, db: string, timePredicate?: string): string => {
	const cols = spec.columns.join(", ")
	const whereParts: string[] = []
	if (spec.where && spec.where.trim().length > 0) whereParts.push(`(${spec.where})`)
	if (timePredicate) whereParts.push(timePredicate)
	const whereClause = whereParts.length > 0 ? `\nWHERE ${whereParts.join(" AND ")}` : ""
	const groupByClause = spec.groupBy && spec.groupBy.trim().length > 0 ? `\nGROUP BY ${spec.groupBy}` : ""
	// `prefer_column_name_to_alias = 1` only when we add the time predicate: the
	// projection aliases a column to its own name (e.g. `toDateTime(Timestamp) AS
	// Timestamp` on traces), so an unqualified `Timestamp` in WHERE would
	// otherwise bind to the alias and lose partition/index pruning. Forcing the
	// raw source column keeps each chunk pruned to its window.
	const settings = timePredicate ? `\nSETTINGS prefer_column_name_to_alias = 1` : ""
	return `INSERT INTO ${ident(db, spec.target)} (${cols})\nSELECT ${spec.select}\nFROM ${ident(db, spec.from)}${whereClause}${groupByClause}${settings}`
}

/**
 * Full backfill statement (no time window) — qualified with the database.
 * Byte-for-byte the SQL the old raw-string statement produced after
 * `qualifyStatementForDatabase`, so non-chunking callers keep their behavior.
 */
export const renderBackfillFull = (spec: BackfillSpec, database: string): string =>
	buildInsert(spec, database)

/**
 * One time-windowed chunk of a backfill: `[fromTs, toTs)` on `tsColumn`.
 * `fromTs`/`toTs` are ClickHouse datetime literals (`YYYY-MM-DD HH:MM:SS`).
 */
export const compileBackfillChunk = (
	spec: BackfillSpec,
	database: string,
	fromTs: string,
	toTs: string,
): string =>
	buildInsert(
		spec,
		database,
		`${spec.tsColumn} >= toDateTime('${fromTs}') AND ${spec.tsColumn} < toDateTime('${toTs}')`,
	)

/**
 * Render any migration statement to a single executable SQL string (no
 * chunking): raw strings are qualified with the database, backfill specs render
 * to their full `INSERT…SELECT`. Use this on the non-chunking apply paths so
 * they behave exactly as before the structured-backfill format landed.
 */
export const renderStatementFull = (stmt: string | BackfillSpec, database: string): string =>
	isBackfill(stmt) ? renderBackfillFull(stmt, database) : qualifyStatementForDatabase(stmt, database)
