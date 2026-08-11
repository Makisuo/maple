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
 *
 * This is the canonical formatter. It previously existed as ~50 local copies
 * named `fmt`, `fmtUTC`, `tinybirdDateTime`, `toTinybirdDateTime`,
 * `fmtWarehouseTime`, `msToWarehouseDateTime`, `warehouseDate`,
 * `formatForTinybird`, and `toWarehouseDateTime` — all identical.
 */
export function formatWarehouseDateTime(epochMs: number): string {
	return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)
}

/**
 * Millisecond-precision variant: `YYYY-MM-DD HH:MM:SS.mmm`.
 *
 * A minority of callers deliberately keep the fractional part (DateTime64
 * columns, replay fixtures whose ordering is sub-second). Distinct from
 * `formatWarehouseDateTime` because truncating those to whole seconds
 * collapses events that must stay ordered.
 */
export function formatWarehouseDateTimeMs(epochMs: number): string {
	return new Date(epochMs).toISOString().replace("T", " ").replace(/Z$/, "")
}

// Relative range shorthand — single source of truth
//
// The time picker persists relative ranges as shorthand ("15m", "7d", "3mo",
// "today"). This grammar used to exist three times over — in the web app (on
// date-fns), in the MCP dashboard resolver (on Effect DateTime, approximating a
// month as 30 days), and in the query engine's own limits module — which is how
// `mo` came to mean different spans depending on which one you asked.
//
// Month and day arithmetic is done on **local** calendar components, matching
// date-fns' `subMonths`/`startOfDay`. In the browser that is the viewer's
// calendar (unchanged behaviour); on a Worker, local is UTC, which is the only
// sensible reading server-side. One implementation serves both.

const RELATIVE_RANGE_PATTERN = /^(\d+)(mo|m|h|d|w)$/

const MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
}

/**
 * Shift `date` by whole calendar months, clamping the day-of-month to the
 * target month's length (31 Mar − 1mo → 28 Feb, never 3 Mar). Mirrors
 * date-fns' `subMonths` so the web app's behaviour is preserved exactly.
 */
function addCalendarMonths(date: Date, months: number): Date {
	const shifted = new Date(date.getTime())
	const day = shifted.getDate()
	// Park on the 1st before changing month, so the month set can't overflow.
	shifted.setDate(1)
	shifted.setMonth(shifted.getMonth() + months)
	const daysInTargetMonth = new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0).getDate()
	shifted.setDate(Math.min(day, daysInTargetMonth))
	return shifted
}

/** Local midnight for the day containing `date`. Mirrors date-fns' `startOfDay`. */
function startOfLocalDay(date: Date): Date {
	const start = new Date(date.getTime())
	start.setHours(0, 0, 0, 0)
	return start
}

/**
 * Duration in seconds for a relative shorthand, or `null` when the string isn't
 * valid shorthand.
 *
 * Approximate by construction — a month is counted as 30 days and `"today"` as
 * its 24-hour worst case — because this exists to compare a shorthand against a
 * fixed ceiling, where a deterministic answer matters more than a calendar-exact
 * one. Use `resolveRelativeRange` to build actual query bounds.
 */
export function relativeRangeSeconds(shorthand: string): number | null {
	const trimmed = shorthand.trim().toLowerCase()
	if (trimmed === "today") return 86_400

	const match = RELATIVE_RANGE_PATTERN.exec(trimmed)
	if (!match) return null

	const amount = Number.parseInt(match[1], 10)
	if (!Number.isFinite(amount) || amount <= 0) return null

	const unit = match[2]
	const unitMs = unit === "mo" ? 30 * 86_400_000 : MS[unit]
	if (unitMs === undefined) return null

	return (amount * unitMs) / 1000
}

/**
 * Resolve a relative shorthand to an absolute epoch-ms window ending at `nowMs`.
 * Returns `null` for anything the grammar doesn't accept, so callers can fall
 * back or report an error rather than silently querying a default window.
 */
export function resolveRelativeRange(
	shorthand: string,
	nowMs: number = Date.now(),
): { startMs: number; endMs: number } | null {
	const trimmed = shorthand.trim().toLowerCase()
	const now = new Date(nowMs)

	if (trimmed === "today") {
		return { startMs: startOfLocalDay(now).getTime(), endMs: nowMs }
	}

	const match = RELATIVE_RANGE_PATTERN.exec(trimmed)
	if (!match) return null

	const amount = Number.parseInt(match[1], 10)
	if (!Number.isFinite(amount) || amount <= 0) return null

	const unit = match[2]
	if (unit === "mo") {
		return { startMs: addCalendarMonths(now, -amount).getTime(), endMs: nowMs }
	}

	const unitMs = MS[unit]
	if (unitMs === undefined) return null
	return { startMs: nowMs - amount * unitMs, endMs: nowMs }
}

/**
 * `resolveRelativeRange` rendered straight into warehouse DateTime strings —
 * the shape every query path actually wants.
 */
export function resolveRelativeRangeToWarehouse(
	shorthand: string,
	nowMs: number = Date.now(),
): { startTime: string; endTime: string } | null {
	const resolved = resolveRelativeRange(shorthand, nowMs)
	if (!resolved) return null
	return {
		startTime: formatWarehouseDateTime(resolved.startMs),
		endTime: formatWarehouseDateTime(resolved.endMs),
	}
}

// Cache-key snap grid — single source of truth
//
// A relative preset ("12h") has no absolute endpoint in the URL, so every fresh
// mount re-resolves it against `Date.now()` and produces a slightly different
// range. Cache keys are built from that range, so the key rolls over as fast as
// the clock moves — and a client-side idle TTL of 30s never gets to fire,
// because the key it was keeping alive no longer exists. Navigating away and
// back re-fetches from cold.
//
// The fix is to floor the endpoint to a grid coarse enough that the key holds
// still between navigations, and fine enough that the data is still current.
// A flat grid can't do both: 15s is right for "last 1 hour" and pointless for
// "last 7 days". So the grid scales with the window.
//
// Drift is worst just above a rung boundary, where the wider grid has kicked in
// but the window has not yet grown to match; the peak is 1h+ε on the 1m rung,
// at 1.7% of the window. In absolute terms it is never more than a minute on a
// window of 6h or less, 5 minutes on a day, 15 on a week, 30 beyond that.
// Explicit refresh and auto-refresh re-resolve against the real clock, so this
// bounds staleness while idle, not staleness overall.
//
// This is a *cache-key* concern, not a display one. Callers that materialize a
// preset into an absolute range the user will see (the time-range picker
// writing to the URL) should record the true instant and skip this.

const CACHE_SNAP_LADDER: ReadonlyArray<readonly [maxRangeMs: number, snapSeconds: number]> = [
	[60 * 60 * 1000, 15], // <= 1h  → 15s
	[6 * 60 * 60 * 1000, 60], // <= 6h  → 1m
	[24 * 60 * 60 * 1000, 300], // <= 24h → 5m
	[7 * 24 * 60 * 60 * 1000, 900], // <= 7d  → 15m
] as const

const CACHE_SNAP_FALLBACK_SECONDS = 1800 // > 7d → 30m

/**
 * Cache-key snap grid (seconds) for a window of the given width. Wider windows
 * tolerate a coarser grid because the same absolute drift is a smaller share of
 * the range. Non-finite or non-positive widths fall back to the finest rung.
 */
export function cacheSnapSecondsForRange(rangeMs: number): number {
	if (!Number.isFinite(rangeMs) || rangeMs <= 0) return CACHE_SNAP_LADDER[0][1]
	for (const [maxRangeMs, snapSeconds] of CACHE_SNAP_LADDER) {
		if (rangeMs <= maxRangeMs) return snapSeconds
	}
	return CACHE_SNAP_FALLBACK_SECONDS
}

/**
 * Floor a resolved range's endpoint to the grid from `cacheSnapSecondsForRange`,
 * holding the window width exactly constant.
 *
 * Width is preserved by deriving the start from the snapped end rather than
 * flooring both independently — independent floors make the width oscillate by
 * one grid step as `now` crosses a boundary, which changes the bucket count and
 * defeats the point of snapping.
 *
 * Unparseable input is returned untouched, so a malformed timestamp degrades to
 * the previous (unsnapped) behaviour instead of throwing on the cache-key path.
 */
export function snapRangeForCache(range: { readonly startTime: string; readonly endTime: string }): {
	startTime: string
	endTime: string
} {
	const startMs = parseWarehouseDateTime(range.startTime)
	const endMs = parseWarehouseDateTime(range.endTime)
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return range

	const gridMs = cacheSnapSecondsForRange(endMs - startMs) * 1000
	const snappedEndMs = Math.floor(endMs / gridMs) * gridMs

	return {
		startTime: formatWarehouseDateTime(snappedEndMs - (endMs - startMs)),
		endTime: formatWarehouseDateTime(snappedEndMs),
	}
}

// Time-series bucketing — single source of truth
//
// Both the web app and the query engine pick an auto bucket size and build
// bucket timelines. Keeping one pure implementation here (no driver / no
// `Date.now()`) prevents the two from drifting and producing different
// granularities for the same window.

/**
 * Bucket-size ladder (seconds) for auto time-series granularity. The sub-5-minute
 * rungs (60s/120s) keep short windows (e.g. "last 1 hour") usefully dense instead
 * of collapsing to a handful of coarse points.
 */
const AUTO_BUCKET_LADDER = [60, 120, 300, 900, 1800, 3600, 14400, 86400] as const

export interface ComputeBucketSecondsOptions {
	/**
	 * Aim for roughly this many points across the window. Default 100 — dense
	 * enough for manual investigation (spikes stay visible instead of averaging
	 * into a 30-point line). Alert evaluation pins `targetPoints: 30` explicitly
	 * so observation windows keep their historical granularity.
	 */
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
	const targetPoints = options?.targetPoints ?? 100
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
