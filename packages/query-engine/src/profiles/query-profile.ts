/**
 * ClickHouse query settings forwarded via inline `SETTINGS` clause.
 *
 * Tinybird allows only a subset on `/v0/sql`:
 * - `maxExecutionTime` (seconds)
 * - `maxMemoryUsage` (bytes)
 * - `maxThreads`
 *
 * Tinybird restricts row/byte caps (`max_rows_to_read`, `max_result_rows`,
 * `max_bytes_to_read`) — they error with "restricted" if used. `maxBlockSize`
 * is also Tinybird-restricted; the executor strips it on the managed Tinybird
 * backend — whether reached via the Tinybird SDK or its ClickHouse-compatible
 * gateway (`CLICKHOUSE_URL`) — and keeps it only for a genuine per-org BYO
 * ClickHouse (see `stripTinybirdRestrictedSettings` and the strip gate in the
 * executor, which keys on the config `source`, not its `_tag`).
 */
export type WarehouseQuerySettings = {
	maxExecutionTime?: number
	maxMemoryUsage?: number
	maxThreads?: number
	/**
	 * Rows per read block (`max_block_size`). The MergeTree reader merges
	 * granules up to this many rows into a single allocation per thread, so on
	 * tables with very wide string columns (a busy org's `logs.Body` averages
	 * ~100KB) the default 65536 produces ~256MB chunks × 9 read threads — an
	 * instant `max_memory_usage` breach for any query whose filter has to read
	 * the column (`Body ILIKE '%…%'`). Capping rows-per-block bounds peak
	 * memory while keeping full read parallelism: benchmarked on the maple
	 * cluster, `512` turned both OOMing log-search shapes into sub-2s queries
	 * at ~260-420MB peak. BYO-ClickHouse-only — stripped for the managed Tinybird
	 * backend (Tinybird SDK or its ClickHouse-compatible gateway).
	 */
	maxBlockSize?: number
}

/**
 * Per-query settings for log queries that filter on `Body` (full-text
 * search). See `WarehouseQuerySettings.maxBlockSize` for the rationale.
 */
export const LOGS_BODY_SEARCH_SETTINGS: WarehouseQuerySettings = { maxBlockSize: 512 }

export type QueryProfileName =
	| "discovery"
	| "list"
	| "aggregation"
	| "rawInteractive"
	| "rawAlert"
	| "explain"
	| "unbounded"

/**
 * The shared profile/settings selector carried by every warehouse query path
 * (the `WarehouseExecutor` interface, `WarehouseQueryService.sqlQuery`, and the
 * CLI executors). Profile defaults are overridden by explicit `settings`.
 */
export type WarehouseQueryOptions = {
	profile?: QueryProfileName
	settings?: WarehouseQuerySettings
}

/**
 * The single per-call option type shared by every warehouse query surface
 * (`WarehouseQueryServiceShape`, the `WarehouseExecutor` facade, the runtime
 * `QueryEngineWarehouse` port, and the CLI executors). It lives next to the
 * profiles because it is a pure type with no execution-layer dependency.
 */
export type SqlQueryOptions = WarehouseQueryOptions & {
	/**
	 * Semantic name for the query (e.g. "errorsByType", "spanHierarchy").
	 * Annotated on the executeSql span as `query.context` so traces can be
	 * filtered and grouped by call site without re-running the SQL.
	 */
	context?: string
	/**
	 * Route this query to the INGEST backend (managed Tinybird) instead of the
	 * per-org read config. Prefer declaring this at the query definition via
	 * `.routing("ingest")` (carried on `CompiledQuery.routing`); use this option
	 * only for hand-written SQL or when the pin depends on runtime state (e.g.
	 * reads of gateway-written data gated on write-readiness).
	 */
	route?: "ingest"
}

/**
 * Named cost profiles. Pick one at the call site (not at the query
 * definition) since the same query can be cheap as a one-off and
 * expensive as a dropdown populator.
 *
 * `unbounded` is the explicit opt-out for known-cheap queries
 * (MV-backed scalars, alert evaluation that pre-validates range).
 */
export const QueryProfile: Record<QueryProfileName, WarehouseQuerySettings> = {
	discovery: { maxExecutionTime: 5, maxMemoryUsage: 512_000_000 },
	list: { maxExecutionTime: 15, maxMemoryUsage: 1_500_000_000 },
	aggregation: { maxExecutionTime: 30, maxMemoryUsage: 4_000_000_000 },
	rawInteractive: { maxExecutionTime: 10, maxMemoryUsage: 512_000_000, maxThreads: 2 },
	rawAlert: { maxExecutionTime: 5, maxMemoryUsage: 256_000_000, maxThreads: 2 },
	explain: { maxExecutionTime: 2, maxMemoryUsage: 128_000_000 },
	unbounded: {},
}

const settingToCh: Record<keyof WarehouseQuerySettings, string> = {
	maxExecutionTime: "max_execution_time",
	maxMemoryUsage: "max_memory_usage",
	maxThreads: "max_threads",
	maxBlockSize: "max_block_size",
}

/**
 * Settings Tinybird's `/v0/sql` rejects with "Usage of setting '…' is
 * restricted". The executor drops them for the managed Tinybird backend
 * (reached via the Tinybird SDK or its ClickHouse-compatible gateway) and keeps
 * them only for a genuine per-org BYO ClickHouse, so the same call site works
 * against both backends.
 */
const TINYBIRD_RESTRICTED_SETTINGS: ReadonlyArray<keyof WarehouseQuerySettings> = ["maxBlockSize"]

export const stripTinybirdRestrictedSettings = (
	settings: WarehouseQuerySettings | undefined,
): WarehouseQuerySettings | undefined => {
	if (!settings) return undefined
	if (!TINYBIRD_RESTRICTED_SETTINGS.some((key) => settings[key] !== undefined)) return settings
	const stripped = { ...settings }
	for (const key of TINYBIRD_RESTRICTED_SETTINGS) delete stripped[key]
	return stripped
}

/**
 * Matches a trailing `FORMAT <name>` clause (the DSL compiler terminates every
 * query with `FORMAT JSON`). `SETTINGS` must precede `FORMAT` — Tinybird's
 * ClickHouse rejects `FORMAT JSON SETTINGS …` with a syntax error.
 */
const trailingFormatRe = /\s+FORMAT\s+\w+\s*$/i

/**
 * Add a ClickHouse `SETTINGS` clause to a SQL string, inserting it before a
 * trailing `FORMAT <name>` clause when present. Returns the input unchanged
 * when no settings are provided.
 *
 * Caller must guarantee the SQL doesn't already contain a SETTINGS
 * clause — none of maple's DSL queries do today.
 */
export const appendSettings = (sql: string, settings: WarehouseQuerySettings | undefined): string => {
	if (!settings) return sql
	const parts: string[] = []
	for (const key of Object.keys(settings) as Array<keyof WarehouseQuerySettings>) {
		const value = settings[key]
		if (typeof value === "number" && Number.isFinite(value)) {
			parts.push(`${settingToCh[key]}=${value}`)
		}
	}
	if (parts.length === 0) return sql
	const clause = `SETTINGS ${parts.join(", ")}`
	const trimmed = sql.replace(/;\s*$/, "")
	const formatMatch = trimmed.match(trailingFormatRe)
	if (formatMatch) {
		const body = trimmed.slice(0, formatMatch.index)
		return `${body} ${clause}${formatMatch[0]}`
	}
	return `${trimmed} ${clause}`
}

/**
 * Resolve effective settings: profile defaults overridden by explicit settings.
 */
export const resolveSettings = (options?: WarehouseQueryOptions): WarehouseQuerySettings | undefined => {
	if (!options) return undefined
	const base = options.profile ? QueryProfile[options.profile] : undefined
	if (!base && !options.settings) return undefined
	return { ...base, ...options.settings }
}

type QuotaSetting = "max_execution_time" | "max_memory_usage" | "max_threads"

/**
 * ClickHouse error codes for the quota-class errors we care about.
 * Source: ClickHouse `src/Common/ErrorCodes.cpp`.
 */
const CODE_TO_SETTING: Record<string, QuotaSetting> = {
	"159": "max_execution_time", // TIMEOUT_EXCEEDED
	"241": "max_memory_usage", // MEMORY_LIMIT_EXCEEDED
}

const TYPE_TO_SETTING: Record<string, QuotaSetting> = {
	TIMEOUT_EXCEEDED: "max_execution_time",
	MEMORY_LIMIT_EXCEEDED: "max_memory_usage",
}

/**
 * Message-only fallback patterns. Deliberately tight: bare substrings like
 * `max_execution_time` or `max_memory_usage` would match the trailing
 * `SETTINGS max_execution_time = 30, max_memory_usage = ...` clause that
 * ClickHouse echoes inside *every* error message, falsely tagging
 * UNKNOWN_IDENTIFIER and similar errors as quota errors.
 *
 * Use these only when neither structured `code` nor `type` is available.
 */
const QUOTA_ERROR_PATTERNS: ReadonlyArray<{ pattern: RegExp; setting: QuotaSetting }> = [
	{
		pattern: /Code:\s*159\b|TIMEOUT_EXCEEDED|estimated query execution time exceeded|Timeout exceeded:/i,
		setting: "max_execution_time",
	},
	{
		pattern: /Code:\s*241\b|MEMORY_LIMIT_EXCEEDED|Memory limit \(for query\) exceeded/i,
		setting: "max_memory_usage",
	},
]

/**
 * Classify whether a ClickHouse error is a quota/limit breach (and which one).
 *
 * Prefers the structured `code` / `type` fields surfaced by the ClickHouse
 * client — they're unambiguous. Only falls back to message regex when both
 * are absent (e.g. errors that come back as a raw string), and even then
 * the patterns avoid the SQL-echo trap.
 */
export const detectQuotaSetting = (
	message: string | undefined,
	code?: string,
	type?: string,
): QuotaSetting | undefined => {
	if (code && CODE_TO_SETTING[code]) return CODE_TO_SETTING[code]
	if (type && TYPE_TO_SETTING[type]) return TYPE_TO_SETTING[type]
	if (code || type) return undefined
	if (!message) return undefined
	for (const { pattern, setting } of QUOTA_ERROR_PATTERNS) {
		if (pattern.test(message)) return setting
	}
	return undefined
}
