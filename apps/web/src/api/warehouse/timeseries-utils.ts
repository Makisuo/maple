import { bucketTimeline, computeBucketSecondsForRange } from "@maple/query-engine"

const TINYBIRD_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/

function toEpochMs(value: string): number {
	return new Date(value.replace(" ", "T") + "Z").getTime()
}

function ceilToBucketMs(epochMs: number, bucketSeconds: number): number {
	const bucketMs = bucketSeconds * 1000
	return Math.ceil(epochMs / bucketMs) * bucketMs
}

/**
 * ISO timestamp of the first bucket that's fully on-or-after `startTime`.
 *
 * Mirrors the leading-bucket invariant in `buildBucketTimeline`: callers that
 * don't use the timeline (e.g. `getCustomChartTimeSeries`, which streams the
 * query response directly) can use this to drop the partial leading bucket
 * the query returned for `Timestamp >= startTime`.
 */
export function firstFullBucketIso(startTime: string | undefined, bucketSeconds: number): string | null {
	if (!startTime) return null
	const startMs = toEpochMs(startTime)
	if (Number.isNaN(startMs)) return null
	return new Date(ceilToBucketMs(startMs, bucketSeconds)).toISOString()
}

/**
 * Drop leading buckets whose value is a tiny fraction of the next bucket's
 * value. Catches two visually-broken-looking-but-data-accurate scenarios:
 *
 *  1. **Zero-filled gaps** — the query returned no rows for the first bucket
 *     and `fillServiceDetailPoints` synthesized a `throughput: 0` entry.
 *  2. **Ingestion ramp-up** — the leading bucket falls during a startup
 *     window where only a handful of stray events landed before normal
 *     volume kicked in. The chart correctly plots, e.g., 0.1/s next to a
 *     neighbor of 2,300/s, but on a 0-2.8K scale the leading point sits
 *     visually on the zero line and reads as a bug.
 *
 * The threshold compares each leading bucket to its **next** neighbor, not to
 * the mean/median, so legitimate diurnal dips (a 3-AM bucket at ~30% of peak)
 * stay on the chart — they're nowhere near `nextRatio` of the next bucket.
 *
 * Default `nextRatio = 0.01` (1%) is wide of any real cycle but narrow enough
 * to remove the leading-0 ramp every time it appears.
 */
export function trimSparseLeadingBuckets<T>(
	rows: ReadonlyArray<T>,
	getValue: (row: T) => number,
	nextRatio = 0.01,
): T[] {
	if (rows.length < 2) return Array.from(rows)
	let cutoff = 0
	while (cutoff < rows.length - 1) {
		const v = getValue(rows[cutoff])
		const next = getValue(rows[cutoff + 1])
		if (next <= 0) break
		if (v >= next * nextRatio) break
		cutoff++
	}
	return rows.slice(cutoff)
}

export function toIsoBucket(value: string | Date): string {
	if (value instanceof Date) {
		return value.toISOString()
	}

	const raw = String(value).trim()
	const tinybirdDateTimeMatch = raw.match(TINYBIRD_DATETIME_RE)
	const normalized = tinybirdDateTimeMatch
		? `${tinybirdDateTimeMatch[1]}T${tinybirdDateTimeMatch[2]}${tinybirdDateTimeMatch[3] ?? ""}Z`
		: raw

	const parsed = new Date(normalized).getTime()
	if (Number.isNaN(parsed)) {
		return raw
	}

	return new Date(parsed).toISOString()
}

/**
 * Chart-policy bucket width, from warehouse DateTime strings.
 *
 * A thin alias over the shared `computeBucketSecondsForRange` — kept as a local
 * export because ~15 call sites import it from here, not because it does
 * anything of its own.
 */
export function computeBucketSeconds(startTime?: string, endTime?: string, targetPoints?: number): number {
	return computeBucketSecondsForRange(startTime, endTime, "chart", targetPoints)
}

/**
 * Round a bucket width up to a whole minute.
 *
 * The service-overview rollup tiers are minute- and hour-grain, so a bucket that
 * is not a minute multiple has no tier that can place a row inside it and the
 * query falls back to scanning raw spans. Callers that can tolerate a slightly
 * coarser bucket use this to stay on the rollup.
 *
 * Rounds UP, never below 60: rounding down would produce more points than the
 * caller asked for, and 0 is not a bucket.
 */
export function quantizeToMinute(bucketSeconds: number): number {
	if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 60) return 60
	return Math.ceil(bucketSeconds / 60) * 60
}

export function buildBucketTimeline(
	startTime: string | undefined,
	endTime: string | undefined,
	bucketSeconds: number,
): string[] {
	if (!startTime || !endTime) {
		return []
	}

	const startMs = toEpochMs(startTime)
	const endMs = toEpochMs(endTime)
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
		return []
	}

	return bucketTimeline(startMs, endMs, bucketSeconds)
}
