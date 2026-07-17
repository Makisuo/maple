// ---------------------------------------------------------------------------
// Warehouse DateTime normalization
//
// ClickHouse / Tinybird return `DateTime` columns as strings like
// "2026-05-24 14:30:00" — UTC, but with NO timezone marker and a space
// separator. Passing that shape to `new Date(str)` / `Date.parse(str)` makes
// V8 parse it as LOCAL time, shifting the value by the runtime's UTC offset.
//
// These helpers are the single source of truth for turning a warehouse
// DateTime string into an unambiguous UTC value. Already-zoned strings (with a
// `Z` or numeric offset) and non-matching shapes are passed through untouched.
// ---------------------------------------------------------------------------

const WAREHOUSE_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/

/**
 * Normalize a warehouse (ClickHouse/Tinybird) DateTime string to an ISO-8601
 * UTC string with an explicit `Z`. Strings that don't match the tz-less
 * `YYYY-MM-DD HH:MM:SS[.fff]` shape (e.g. already carry a `Z`/offset, or aren't
 * timestamps) are returned trimmed but otherwise unchanged.
 */
export function warehouseDateTimeToIso(value: string): string {
	const trimmed = value.trim()
	const match = WAREHOUSE_DATETIME_PATTERN.exec(trimmed)
	if (!match) {
		return trimmed
	}

	const [, date, time, fractional] = match
	if (!fractional) {
		return `${date}T${time}Z`
	}

	const milliseconds = `${fractional}000`.slice(0, 3)
	return `${date}T${time}.${milliseconds}Z`
}

/**
 * Parse a warehouse DateTime string into epoch milliseconds, treating tz-less
 * values as UTC. Returns `NaN` for unparseable input (matching `Date.parse`).
 */
export function parseWarehouseDateTime(value: string): number {
	return Date.parse(warehouseDateTimeToIso(value))
}

/**
 * Format epoch milliseconds as the tz-less second-precision
 * `YYYY-MM-DD HH:MM:SS` shape ClickHouse/Tinybird DateTime params expect
 * (UTC wall clock, space separator, no fractional part).
 */
export function formatWarehouseDateTime(epochMs: number): string {
	return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)
}

// ---------------------------------------------------------------------------
// Time-series bucketing — single source of truth
//
// Both the web app and the query engine pick an auto bucket size and build
// bucket timelines. Keeping one pure implementation here (no driver / no
// `Date.now()`) prevents the two from drifting and producing different
// granularities for the same window.
// ---------------------------------------------------------------------------

/**
 * Bucket-size ladder (seconds) for auto time-series granularity. The sub-5-minute
 * rungs (60s/120s) keep short windows (e.g. "last 1 hour") usefully dense instead
 * of collapsing to a handful of coarse points.
 */
const AUTO_BUCKET_LADDER = [60, 120, 300, 900, 1800, 3600, 14400, 86400] as const

export interface ComputeBucketSecondsOptions {
	/** Aim for roughly this many points across the window. Default 30. */
	targetPoints?: number
	/**
	 * Never pick a bucket so coarse the window yields fewer than this many
	 * buckets — steps down the ladder if needed. Default 6. Guards against
	 * near-empty charts on short windows.
	 */
	minBuckets?: number
}

/**
 * Pick an auto bucket size (seconds) for the window `[startMs, endMs]`, snapping
 * to the nearest ladder rung that targets ~`targetPoints` points, then clamping
 * so the window keeps at least `minBuckets` buckets. Pure — safe to import from
 * the web/cli bundles via the package root barrel.
 */
export function computeBucketSeconds(
	startMs: number,
	endMs: number,
	options?: ComputeBucketSecondsOptions,
): number {
	const targetPoints = options?.targetPoints ?? 30
	const minBuckets = options?.minBuckets ?? 6
	const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
	const raw = Math.max(Math.ceil(rangeSeconds / targetPoints), 1)

	let bucket: number = AUTO_BUCKET_LADDER.reduce<number>(
		(best, candidate) => (Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best),
		AUTO_BUCKET_LADDER[0],
	)

	// Never coarser than what keeps at least `minBuckets` buckets over the range.
	const maxBucketForMin = Math.floor(rangeSeconds / minBuckets)
	if (bucket > maxBucketForMin) {
		const finer = AUTO_BUCKET_LADDER.filter((candidate) => candidate <= maxBucketForMin)
		bucket = finer.length > 0 ? finer[finer.length - 1] : AUTO_BUCKET_LADDER[0]
	}

	return bucket
}

const floorToBucketMs = (epochMs: number, bucketSeconds: number): number => {
	const bucketMs = bucketSeconds * 1000
	return Math.floor(epochMs / bucketMs) * bucketMs
}

const ceilToBucketMs = (epochMs: number, bucketSeconds: number): number => {
	const bucketMs = bucketSeconds * 1000
	return Math.ceil(epochMs / bucketMs) * bucketMs
}

/**
 * Build the list of ISO bucket timestamps spanning `[startMs, endMs]` for the
 * given bucket size. The leading bucket is the first one fully on-or-after
 * `startMs` (ceil — drops the partial leading bucket the query returns for
 * `Timestamp >= startTime`); the trailing bucket is the last one starting
 * on-or-before `endMs` (floor — keeps the in-progress trailing bucket).
 *
 * Guarantees at least one bucket for any valid range: when the window is
 * narrower than a single bucket (so `ceil(start) > floor(end)`), anchors a
 * single bucket at the window start instead of returning `[]`.
 */
export function bucketTimeline(startMs: number, endMs: number, bucketSeconds: number): string[] {
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || bucketSeconds <= 0) {
		return []
	}

	const bucketMs = bucketSeconds * 1000
	const firstBucketMs = ceilToBucketMs(startMs, bucketSeconds)
	const lastBucketMs = floorToBucketMs(endMs, bucketSeconds)

	if (firstBucketMs > lastBucketMs) {
		return [new Date(floorToBucketMs(startMs, bucketSeconds)).toISOString()]
	}

	const buckets: string[] = []
	for (let cursor = firstBucketMs; cursor <= lastBucketMs; cursor += bucketMs) {
		buckets.push(new Date(cursor).toISOString())
	}
	return buckets
}
