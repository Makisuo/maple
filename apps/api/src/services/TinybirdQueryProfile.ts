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
  return { ...(base ?? {}), ...(options.settings ?? {}) }
}

const QUOTA_ERROR_PATTERNS: ReadonlyArray<{
  pattern: RegExp
  setting: "max_execution_time" | "max_memory_usage" | "max_threads"
}> = [
  {
    pattern: /TIMEOUT[_ ]EXCEEDED|Timeout exceeded|max_execution_time|estimated query execution time/i,
    setting: "max_execution_time",
  },
  {
    pattern: /MEMORY[_ ]LIMIT[_ ]EXCEEDED|Memory limit \(for query\) exceeded/i,
    setting: "max_memory_usage",
  },
]

export const detectQuotaSetting = (
  message: string | undefined,
): "max_execution_time" | "max_memory_usage" | "max_threads" | undefined => {
  if (!message) return undefined
  for (const { pattern, setting } of QUOTA_ERROR_PATTERNS) {
    if (pattern.test(message)) return setting
  }
  return undefined
}
