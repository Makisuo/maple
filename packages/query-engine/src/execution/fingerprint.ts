import { splitTerminalClauses } from "@maple-dev/clickhouse-builder/sql"

/**
 * Cap traced SQL at 16 KB. OTel's default attribute size limit is 32 KB, and
 * 16 KB covers the overwhelming majority of compiled DSL queries while leaving
 * headroom for other span attributes. Logs use a tighter cap.
 */
export const SQL_TRACE_MAX = 16_384
export const SQL_LOG_MAX = 1_000

export const truncateSql = (s: string, maxLen: number) =>
	s.length > maxLen ? s.slice(0, maxLen) + "...[truncated]" : s

/**
 * Stable 32-bit FNV-1a hash over SQL with literals and numbers normalized. Lets
 * the same query with different params group together in trace search.
 */
export const fingerprintSql = (s: string): string => {
	const normalized = s.replace(/'[^']*'/g, "'?'").replace(/\b\d+\b/g, "?")
	let h = 0x811c9dc5
	for (let i = 0; i < normalized.length; i++) {
		h ^= normalized.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * The SQL verb and primary table of a statement, plus the OTEL
 * `db.query.summary` composed from them.
 */
export interface SqlSummary {
	/** `db.operation.name` — the uppercased leading verb ("SELECT"), or `""`. */
	readonly operation: string
	/** `db.collection.name` — the first table named after from/into/update/join/table, or `""`. */
	readonly collection: string
	/** `db.query.summary` — `"{operation} {collection}"`, either part omitted when empty. */
	readonly summary: string
}

/**
 * Leading verb. Mirrors the RE2 `extract(stmt, '^\\s*(\\w+)')` on the read side —
 * `\w` is `[0-9A-Za-z_]` in both engines. Exported so the parity test can assert
 * this exact pattern still appears in the ClickHouse fragment.
 */
export const SQL_VERB_RE = /^\s*(\w+)/

/**
 * First table named by a from/into/update/join/table clause. The optional `\W`
 * skips one quote/bracket so `from "alert_rules"` yields `alert_rules`. The `i`
 * flag stands in for RE2's inline `(?i)`. Exported for the parity test.
 */
export const SQL_TABLE_RE = /(?:from|into|update|join|table)\s+\W?([\w.]+)/i

/**
 * Derive `db.operation.name` / `db.collection.name` / `db.query.summary` from raw
 * statement text, for instrumentation that only learns the SQL after the fact
 * (the drizzle `logger` fires while the DB span is already open).
 *
 * MUST stay behaviourally identical to `derivedStatementSummarySql` in
 * `@maple/domain/tinybird/db-query-shape-sql` — that fragment is what the
 * warehouse derives a shape label with when `db.query.summary` is ABSENT, and
 * the emitted summary takes precedence over it. If the two disagree, every
 * existing shape in `service_map_db_query_shapes_hourly` forks into a duplicate
 * at the moment we start emitting. `summarize-sql.test.ts` pins the parity.
 */
export const summarizeSql = (sql: string): SqlSummary => {
	if (sql === "") return { operation: "", collection: "", summary: "" }
	const operation = (SQL_VERB_RE.exec(sql)?.[1] ?? "").toUpperCase()
	const collection = SQL_TABLE_RE.exec(sql)?.[1] ?? ""
	const summary = `${operation}${collection === "" ? "" : ` ${collection}`}`.trim()
	return { operation, collection, summary }
}

/**
 * The official ClickHouse client sets the wire format itself, so it rejects a
 * statement that carries its own `FORMAT` clause (any format, not just the
 * `FORMAT JSON` the DSL emits) and a trailing `;`. Strip both before handing the
 * SQL to the CH driver, keeping any `SETTINGS` clause. Tinybird's `/v0/sql`
 * keeps the SQL as-is.
 */
export const normalizeSqlForClickHouseClient = (sql: string): string => {
	const terminal = splitTerminalClauses(sql)
	return terminal.settings === undefined ? terminal.body : `${terminal.body}\n${terminal.settings}`
}
