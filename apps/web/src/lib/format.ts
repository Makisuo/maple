/**
 * Format a duration in milliseconds to a human-readable string.
 * - < 1ms: displays in microseconds (μs)
 * - 1ms - 1000ms: displays in milliseconds (ms)
 * - >= 1000ms: displays in seconds (s)
 */
export function formatDuration(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`
  }
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * Format a number with compact notation.
 * - >= 1M: displays as e.g. "1.2M"
 * - >= 1K: displays as e.g. "3.4K"
 * - < 1K: displays with locale formatting
 */
export function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`
  }
  return num.toLocaleString()
}

/**
 * Format a latency value in milliseconds to a human-readable string.
 */
export function formatLatency(ms: number): string {
  if (ms == null || Number.isNaN(ms)) {
    return "-"
  }
  if (ms < 1) {
    return `${(ms * 1000).toFixed(0)}μs`
  }
  if (ms < 1000) {
    return `${ms.toFixed(1)}ms`
  }
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * Format an error rate percentage.
 */
export function formatErrorRate(rate: number): string {
  if (rate < 0.01) {
    return "0%"
  }
  if (rate < 1) {
    return `${rate.toFixed(2)}%`
  }
  return `${rate.toFixed(1)}%`
}

/**
 * Infer the bucket interval in seconds from consecutive data points.
 * Expects data with a `bucket` string timestamp field.
 */
export function inferBucketSeconds(data: Array<{ bucket: string }>): number | undefined {
  if (data.length < 2) return undefined
  const t0 = new Date(data[0].bucket).getTime()
  const t1 = new Date(data[1].bucket).getTime()
  const diffMs = t1 - t0
  if (diffMs <= 0 || Number.isNaN(diffMs)) return undefined
  return diffMs / 1000
}

/**
 * Parse a bucket value to a millisecond timestamp.
 */
export function parseBucketMs(value: unknown): number | null {
  if (typeof value !== "string") return null
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Infer the total time range in milliseconds from an array of data points with a `bucket` key.
 */
export function inferRangeMs(data: Array<Record<string, unknown>>): number {
  const bucketTimes = data
    .map((row) => parseBucketMs(row.bucket))
    .filter((value): value is number => value != null)

  if (bucketTimes.length < 2) return 0
  return Math.max(...bucketTimes) - Math.min(...bucketTimes)
}

/**
 * Format a bucket timestamp label that adapts based on the overall time range:
 * - >= 24h with daily buckets: "Feb 14"
 * - >= 24h with sub-day buckets: "Feb 14, 02:00 PM"
 * - 30min - 24h: "02:00 PM"
 * - <= 30min: "02:00:30 PM"
 */
export function formatBucketLabel(
  value: unknown,
  context: { rangeMs: number; bucketSeconds: number | undefined },
  mode: "tick" | "tooltip",
): string {
  if (typeof value !== "string") return ""

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const includeDate = context.rangeMs >= 24 * 60 * 60 * 1000 || (context.bucketSeconds ?? 0) >= 24 * 60 * 60
  const includeSeconds = context.rangeMs <= 30 * 60 * 1000 && !includeDate

  if (mode === "tooltip") {
    return date.toLocaleString(undefined, {
      year: includeDate ? "numeric" : undefined,
      month: includeDate ? "short" : undefined,
      day: includeDate ? "numeric" : undefined,
      hour: "2-digit",
      minute: "2-digit",
      second: includeSeconds ? "2-digit" : undefined,
    })
  }

  if (includeDate) {
    if ((context.bucketSeconds ?? 0) >= 24 * 60 * 60) {
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    }
    return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  }

  return date
    .toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: includeSeconds ? "2-digit" : undefined,
    })
    .replace(/^24:/, "00:")
}

const bucketLabelMap: Record<number, string> = {
  60: "/min",
  300: "/5min",
  900: "/15min",
  3600: "/h",
  14400: "/4h",
  86400: "/d",
}

/**
 * Map bucket interval seconds to a human-readable rate suffix.
 */
export function bucketIntervalLabel(seconds: number | undefined): string {
  if (seconds == null) return ""
  return bucketLabelMap[seconds] ?? ""
}

/**
 * Format a throughput value with a rate suffix for chart axes.
 */
export function formatThroughput(value: number, suffix: string): string {
  return `${formatNumber(value)}${suffix}`
}
