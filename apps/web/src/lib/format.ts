import { normalizeTimestampInput } from "@/lib/timezone-format"

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
	return formatCount(num)
}

const countFormatterCache = new Map<number, Intl.NumberFormat>()

/**
 * Format a full-precision, grouped number (e.g. "1,234,567"). Unlike
 * {@link formatNumber} this never abbreviates — use it for exact counts,
 * totals, and sample counts in tables and tooltips.
 *
 * Byte-identical to the locale-default number formatting it replaces: with no
 * cap it matches default grouping; with a cap it applies `maximumFractionDigits`.
 * Formatters are cached per fraction-digit setting.
 */
export function formatCount(num: number, maximumFractionDigits?: number): string {
	const key = maximumFractionDigits ?? -1
	let formatter = countFormatterCache.get(key)
	if (!formatter) {
		formatter =
			maximumFractionDigits === undefined
				? new Intl.NumberFormat()
				: new Intl.NumberFormat(undefined, { maximumFractionDigits })
		countFormatterCache.set(key, formatter)
	}
	return formatter.format(num)
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
 * Format an error rate (0–1 ratio) as a percentage string.
 */
export function formatErrorRate(rate: number): string {
	const pct = rate * 100
	if (pct < 0.01) {
		return "0%"
	}
	if (pct < 1) {
		return `${pct.toFixed(2)}%`
	}
	return `${pct.toFixed(1)}%`
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
function parseBucketMs(value: unknown): number | null {
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
 * Format an ISO timestamp as a relative time string (e.g. "5m ago", "2h ago").
 */
export function formatRelativeTime(iso: string): string {
	const diff = Date.now() - new Date(normalizeTimestampInput(iso)).getTime()
	if (diff < 0) return "just now"
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}
