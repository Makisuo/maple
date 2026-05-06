/**
 * ClickHouse query settings forwarded to Tinybird via inline `SETTINGS` clause.
 *
 * Only settings Tinybird allows on `/v0/sql` are exposed:
 * - `maxExecutionTime` (seconds)
 * - `maxMemoryUsage` (bytes)
 * - `maxThreads`
 *
 * Tinybird restricts row/byte caps (`max_rows_to_read`, `max_result_rows`,
 * `max_bytes_to_read`) — they error with "restricted" if used.
 */
export type TinybirdQuerySettings = {
	maxExecutionTime?: number
	maxMemoryUsage?: number
	maxThreads?: number
}

export type QueryProfileName = "discovery" | "list" | "aggregation" | "explain" | "unbounded"

/**
 * Named cost profiles. Pick one at the call site (not at the query
 * definition) since the same query can be cheap as a one-off and
 * expensive as a dropdown populator.
 *
 * `unbounded` is the explicit opt-out for known-cheap queries
 * (MV-backed scalars, alert evaluation that pre-validates range).
 */
export const QueryProfile: Record<QueryProfileName, TinybirdQuerySettings> = {
	discovery: { maxExecutionTime: 5, maxMemoryUsage: 512_000_000 },
	list: { maxExecutionTime: 15, maxMemoryUsage: 1_500_000_000 },
	aggregation: { maxExecutionTime: 30, maxMemoryUsage: 4_000_000_000 },
	explain: { maxExecutionTime: 2, maxMemoryUsage: 128_000_000 },
	unbounded: {},
}

const settingToCh: Record<keyof TinybirdQuerySettings, string> = {
	maxExecutionTime: "max_execution_time",
	maxMemoryUsage: "max_memory_usage",
	maxThreads: "max_threads",
}

/**
 * Append a ClickHouse `SETTINGS` clause to a SQL string. Returns the
 * input unchanged when no settings are provided.
 *
 * Caller must guarantee the SQL doesn't already contain a SETTINGS
 * clause — none of maple's DSL queries do today.
 */
export const appendSettings = (sql: string, settings: TinybirdQuerySettings | undefined): string => {
	if (!settings) return sql
	const parts: string[] = []
	for (const key of Object.keys(settings) as Array<keyof TinybirdQuerySettings>) {
		const value = settings[key]
		if (typeof value === "number" && Number.isFinite(value)) {
			parts.push(`${settingToCh[key]}=${value}`)
		}
	}
	if (parts.length === 0) return sql
	return `${sql.replace(/;\s*$/, "")} SETTINGS ${parts.join(", ")}`
}

/**
 * Resolve effective settings: profile defaults overridden by explicit settings.
 */
export const resolveSettings = (options?: {
	profile?: QueryProfileName
	settings?: TinybirdQuerySettings
}): TinybirdQuerySettings | undefined => {
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
