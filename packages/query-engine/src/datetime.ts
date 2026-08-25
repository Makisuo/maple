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

import { Schema, SchemaGetter } from "effect"

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

// Warehouse time as a schema
//
// Everything above is string plumbing any caller may skip. What follows makes
// a *validated* warehouse timestamp its own type, so the plumbing can't be
// skipped by accident: a `WarehouseDateTime` exists only because something
// decoded it, and the places that build SQL ask for that type by name.

/**
 * The accepted input grammar for an agent- or client-supplied timestamp:
 * `YYYY-MM-DD[ T]HH:MM:SS` with an optional fractional part and an optional
 * `Z`/±HH:MM offset, or a bare `YYYY-MM-DD` date.
 *
 * Deliberately narrower than `Date.parse`, which is the whole point. `Date.parse`
 * accepts `"2026"`, `"Aug 25"` and other partials, so a NaN check alone lets a
 * sheared timestamp through as a confidently-wrong window rather than an error.
 */
const TIME_INPUT_PATTERN =
	/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?$/

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/**
 * Structure is not enough: `2026-13-01` and `2026-02-30` both match the grammar
 * and are both nonsense.
 *
 * The fields are checked as written rather than by parsing, because V8 does not
 * reject day overflow — `Date.parse("2026-02-30T00:00:00Z")` silently rolls over
 * to 2 March. Left to the parser, a typo becomes a confidently wrong window
 * instead of an error. Timezone offsets legitimately shift the day, so the
 * as-written fields are the only stable thing to validate.
 */
const hasRealCalendarFields = (value: string): boolean => {
	const [, y, mo, d, h, mi, s] =
		/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(value) ?? []
	if (y === undefined || mo === undefined || d === undefined) return false

	const month = Number(mo)
	if (month < 1 || month > 12) return false

	const maxDay = month === 2 && isLeapYear(Number(y)) ? 29 : (DAYS_IN_MONTH[month - 1] as number)
	const day = Number(d)
	if (day < 1 || day > maxDay) return false

	// Absent for a bare date, in which case midnight is implied.
	if (h === undefined || mi === undefined || s === undefined) return true
	return Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59
}

/**
 * Grammar and calendar validity in one check, so one message can cover both.
 *
 * The message matters as much as the verdict: these failures are read by models
 * mid-tool-call and are their only chance to self-correct. The default rendering
 * for a pattern check is the raw regex source, which tells a caller nothing about
 * what to send instead — so the offending value and the accepted shapes are
 * spelled out here.
 */
const isWarehouseTimeInput = Schema.makeFilter(
	(value: string) => {
		if (!TIME_INPUT_PATTERN.test(value)) {
			return `\`${value}\` is not a timestamp — expected \`YYYY-MM-DD HH:mm:ss\` (UTC) or an ISO-8601 timestamp`
		}
		if (!hasRealCalendarFields(value) || Number.isNaN(parseWarehouseDateTime(value))) {
			return `\`${value}\` is not a real date and time`
		}
		return undefined
	},
	{ title: "warehouseTimeInput" },
)

/**
 * A warehouse `DateTime` literal: canonical `YYYY-MM-DD HH:mm:ss`, UTC, no
 * fractional part. Safe to interpolate into a `DateTime` comparison or wrap in
 * `toDateTime()`.
 *
 * Branded so it cannot be produced by string manipulation — only by decoding
 * through {@link WarehouseTimeInput} or by {@link warehouseDateTime}.
 */
export const WarehouseDateTime = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/), isWarehouseTimeInput),
	Schema.brand("@maple/WarehouseDateTime"),
).annotate({
	title: "WarehouseDateTime",
	description: "UTC warehouse DateTime literal, `YYYY-MM-DD HH:mm:ss` (e.g. `2026-08-25 08:47:52`).",
})
export type WarehouseDateTime = Schema.Schema.Type<typeof WarehouseDateTime>

/**
 * Decodes any accepted timestamp input — ISO-8601 with `Z` or an offset, the
 * warehouse shape with or without fractional seconds, a bare date — into a
 * canonical {@link WarehouseDateTime}.
 *
 * Rejecting here rather than at the warehouse is the point: an unparseable bound
 * used to reach ClickHouse verbatim and fail as `Cannot parse string … as
 * DateTime`, an error the caller could neither predict nor act on.
 */
export const WarehouseTimeInput = Schema.String.pipe(
	Schema.check(isWarehouseTimeInput),
	Schema.decodeTo(WarehouseDateTime, {
		// Total by construction: the checks above already proved this parses.
		decode: SchemaGetter.transform((value: string) => warehouseDateTime(parseWarehouseDateTime(value))),
		encode: SchemaGetter.passthrough(),
	}),
).annotate({
	title: "WarehouseTimeInput",
	// `examples` is typed against the decoded (branded) type while the published
	// schema shows the encoded form, so the samples live in the description —
	// which is the part a model reads anyway.
	description:
		"`YYYY-MM-DD HH:mm:ss` (UTC) or an ISO-8601 timestamp, e.g. `2026-08-25 08:47:52` or `2026-08-25T08:47:52Z`.",
})

/**
 * Format epoch milliseconds as a {@link WarehouseDateTime}.
 *
 * The one sanctioned way to mint the brand without decoding, for values that are
 * already numbers — `Date.now()`, a window offset — and so cannot be malformed.
 */
export function warehouseDateTime(epochMs: number): WarehouseDateTime {
	return WarehouseDateTime.make(formatWarehouseDateTime(epochMs))
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
// date-fns' `subMonths`/`startOfDay`. Day and week windows additionally snap
// their start to local midnight and count today as day one, so "7d" is seven
// calendar days rather than a rolling 168 hours. In the browser that is the viewer's
// calendar (unchanged behaviour); on a Worker, local is UTC, which is the only
// sensible reading server-side. One implementation serves both.

const RELATIVE_RANGE_PATTERN = /^(\d+)(mo|m|h|d|w)$/

const MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
} satisfies Record<string, number>

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

	// Day-or-wider windows are counted in whole local calendar days, inclusive
	// of today: "7d" is the last seven days *on the calendar* — midnight six
	// days ago through now — not a rolling 168-hour window that starts mid-
	// afternoon. Counting today as one of the N keeps the span at or under the
	// nominal duration, so the range-width ceilings (`isTimeRangeWithin`, the
	// exact 365-day limit the service and alert endpoints enforce) still pass.
	if (unit === "d" || unit === "w") {
		const days = unit === "w" ? amount * 7 : amount
		return { startMs: startOfLocalDay(new Date(nowMs - (days - 1) * MS.d)).getTime(), endMs: nowMs }
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

/**
 * The structural shape of `TimeRange` (`@maple/query-model`). Structural rather
 * than the branded schema type so every host — the stored dashboard document,
 * an MCP tool's decoded input, the share page's decoded document — can hand its
 * own time range in without a cast.
 */
export type TimeRangeInput =
	| { readonly type: "relative"; readonly value: string }
	| { readonly type: "absolute"; readonly startTime: string; readonly endTime: string }

export interface ResolveTimeRangeWindowOptions {
	/**
	 * Floor the endpoint to the cache-key grid (`snapRangeForCache`). Default
	 * `true`; pass `false` on an explicit reload so the window actually advances
	 * to "now".
	 */
	readonly snap?: boolean
	/** Injectable clock for tests. */
	readonly nowMs?: number
}

/**
 * A stored dashboard / widget `TimeRange` rendered into the warehouse window a
 * query runs over.
 *
 * The one resolver for every host that reads a persisted time range — the
 * signed-in dashboard, the share page, the share API resolving a pinned tile,
 * and the MCP dashboard tools. Each used to carry its own copy of "relative →
 * absolute, then snap", and the copies disagreed about snapping and about how
 * to parse a tz-less absolute bound; a shared board then ran over a different
 * window than the board it was sharing.
 *
 * Absolute bounds go through `parseWarehouseDateTime`, never `Date.parse`: a
 * stored bound may be the tz-less `YYYY-MM-DD HH:MM:SS` shape, which
 * `Date.parse` reads as local time and silently shifts by the runtime's UTC
 * offset. Returns `null` for an unknown relative shorthand or an unparseable
 * absolute bound so the caller decides the fallback.
 */
export function resolveTimeRangeWindow(
	timeRange: TimeRangeInput,
	options?: ResolveTimeRangeWindowOptions,
): { startTime: string; endTime: string } | null {
	if (timeRange.type === "absolute") {
		const startMs = parseWarehouseDateTime(timeRange.startTime)
		const endMs = parseWarehouseDateTime(timeRange.endTime)
		if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
		return {
			startTime: formatWarehouseDateTime(startMs),
			endTime: formatWarehouseDateTime(endMs),
		}
	}

	const resolved = resolveRelativeRangeToWarehouse(timeRange.value, options?.nowMs ?? Date.now())
	if (resolved === null) return null
	return options?.snap === false ? resolved : snapRangeForCache(resolved)
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
	/**
	 * Drop every ladder rung below this before picking. Default 60 (the whole
	 * ladder).
	 *
	 * This is what a caller with a coarser floor needs: raw-SQL `$__interval_s`
	 * wants 300, because a sub-5-minute bucket there produces a scan the
	 * granularity was chosen to avoid. Expressed as a ladder filter rather than a
	 * post-hoc `Math.max` on purpose — clamping after the fact would round 120 up
	 * to 300 while leaving the "nearest rung" choice computed against rungs the
	 * caller cannot use.
	 */
	minBucketSeconds?: number
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
	const minBucketSeconds = options?.minBucketSeconds ?? 0
	const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)
	const raw = Math.max(Math.ceil(rangeSeconds / targetPoints), 1)

	const ladder = AUTO_BUCKET_LADDER.filter((candidate) => candidate >= minBucketSeconds)
	const rungs = ladder.length > 0 ? ladder : [AUTO_BUCKET_LADDER[AUTO_BUCKET_LADDER.length - 1]]

	let bucket: number = rungs.reduce<number>(
		(best, candidate) => (Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best),
		rungs[0],
	)

	// Never coarser than what keeps at least `minBuckets` buckets over the range.
	const maxBucketForMin = Math.floor(rangeSeconds / minBuckets)
	if (bucket > maxBucketForMin) {
		const finer = rungs.filter((candidate) => candidate <= maxBucketForMin)
		// `rungs[0]` rather than the raw ladder's floor: `minBuckets` must not be
		// allowed to step below the caller's `minBucketSeconds`.
		bucket = finer.length > 0 ? finer[finer.length - 1] : rungs[0]
	}

	return bucket
}

/**
 * The bucket-sizing policies, one per surface that asks for an auto granularity.
 *
 * These numbers are NOT interchangeable and must not be collapsed into one
 * default — that is the whole reason they are named here rather than passed as
 * literals at each call site:
 *
 *   - `chart` targets 100 points because a dashboard or explore chart is read by
 *     a human looking for spikes, and 30 points averages them away.
 *   - `alert` targets 30 because bucket width changes per-bucket values, and
 *     therefore changes `minimumSampleCount` behaviour, for every auto-sized
 *     rule. Making rules denser would silently re-tune every one of them.
 *   - `rawSql` backs `$__interval_s` and carries a 300s floor: a sub-5-minute
 *     bucket there produces exactly the scan the granularity was chosen to
 *     avoid.
 *
 * `fallbackSeconds` is what a caller gets for an unparseable or inverted range —
 * see {@link computeBucketSecondsForRange}.
 */
export const BUCKET_POLICIES = {
	chart: { targetPoints: 100, fallbackSeconds: 300 },
	alert: { targetPoints: 30, fallbackSeconds: 300 },
	rawSql: { targetPoints: 30, minBucketSeconds: 300, fallbackSeconds: 300 },
} as const satisfies Record<string, ComputeBucketSecondsOptions & { fallbackSeconds: number }>

export type BucketPolicyName = keyof typeof BUCKET_POLICIES

/**
 * {@link computeBucketSeconds} for callers holding warehouse DateTime *strings*
 * rather than epoch milliseconds, which is most of them.
 *
 * Exists because the string parse plus the "unparseable range falls back to a
 * fixed width" rule were open-coded twice — once in the web app's
 * `timeseries-utils`, once as `computeAutoBucketSeconds` in the raw-SQL route —
 * with the same two behaviours and no shared home. `targetPoints` overrides the
 * policy's own target for the few callers that want a denser histogram.
 */
export function computeBucketSecondsForRange(
	startTime: string | undefined,
	endTime: string | undefined,
	policyName: BucketPolicyName = "chart",
	targetPoints?: number,
): number {
	const policy = BUCKET_POLICIES[policyName]
	if (!startTime || !endTime) return policy.fallbackSeconds

	const startMs = parseWarehouseDateTime(startTime)
	const endMs = parseWarehouseDateTime(endTime)
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
		return policy.fallbackSeconds
	}

	return computeBucketSeconds(startMs, endMs, {
		...policy,
		...(!(targetPoints === undefined) ? { targetPoints } : undefined),
	})
}

/**
 * Rounding thresholds for the width-based bucket model — one rung per row,
 * `[upperBoundExclusiveSeconds, bucketSeconds]`. A raw `range / maxDataPoints`
 * below the bound rounds to that rung. Grafana's `roundInterval` ladder from
 * 1m upward; the sub-minute rungs are deliberately absent because the
 * warehouse rollup tiers are minute- and hour-grain, and a 30s bucket would
 * push every widget onto raw-span scans.
 */
const WIDTH_INTERVAL_LADDER: ReadonlyArray<readonly [upperBoundSeconds: number, bucketSeconds: number]> = [
	[90, 60],
	[210, 120],
	[450, 300],
	[750, 600],
	[1050, 900],
	[1500, 1200],
	[2700, 1800],
	[5400, 3600],
	[9000, 7200],
	[16200, 10800],
	[32400, 21600],
	[86400, 43200],
	[604800, 86400],
]
const WIDTH_INTERVAL_MAX_SECONDS = 604800

/**
 * Round a raw per-point width up or down to the nearest "nice" bucket the way
 * Grafana's `roundInterval` does. Pure; exported for the tests and the
 * "Auto (2m)" placeholder in the widget editor.
 */
export function roundIntervalSeconds(rawSeconds: number): number {
	for (const [upperBound, bucketSeconds] of WIDTH_INTERVAL_LADDER) {
		if (rawSeconds < upperBound) return bucketSeconds
	}
	return WIDTH_INTERVAL_MAX_SECONDS
}

/**
 * Hard ceiling on points from the width model. Below `MAX_TIMESERIES_POINTS`
 * (1500) so the server's point-budget guard can never reject a bucket this
 * function chose, and because a series denser than one point per pixel is not
 * visible anyway.
 */
export const MAX_AUTO_DATA_POINTS = 1000
const MIN_AUTO_DATA_POINTS = 30

export interface ComputeBucketSecondsForWidthOptions {
	/**
	 * How many points the caller can display — for a chart, its rendered pixel
	 * width (a narrow tile gets coarser buckets, a wide editor preview finer
	 * ones). Clamped to `[30, MAX_AUTO_DATA_POINTS]`.
	 */
	maxDataPoints: number
	/** Same meaning as {@link ComputeBucketSecondsOptions.minBuckets}. Default 6. */
	minBuckets?: number
}

/**
 * Width-based auto bucket: `roundIntervalSeconds(range / maxDataPoints)`, then
 * stepped coarser while the window would still exceed `MAX_AUTO_DATA_POINTS`
 * points and finer while it would yield fewer than `minBuckets`.
 *
 * This is the Grafana model (`$__interval` = range / panel width) and it is used
 * ONLY by dashboard widgets, which know their tile width. Every other caller
 * keeps the fixed-target {@link computeBucketSeconds}: moving them would change
 * granularity and cache keys across the app for no visible gain.
 */
export function computeBucketSecondsForWidth(
	startMs: number,
	endMs: number,
	options: ComputeBucketSecondsForWidthOptions,
): number {
	const minBuckets = options.minBuckets ?? 6
	const maxDataPoints = Math.min(
		MAX_AUTO_DATA_POINTS,
		Math.max(MIN_AUTO_DATA_POINTS, Math.floor(options.maxDataPoints)),
	)
	const rangeSeconds = Math.max((endMs - startMs) / 1000, 1)

	let bucket = roundIntervalSeconds(rangeSeconds / maxDataPoints)

	// The rounding can land below the raw width (e.g. 1400px over 7d → 432s → 5m
	// = 2016 points); walk up the ladder until the window fits the budget.
	while (Math.ceil(rangeSeconds / bucket) > MAX_AUTO_DATA_POINTS) {
		const next = WIDTH_INTERVAL_LADDER.find(([, seconds]) => seconds > bucket)?.[1]
		if (next === undefined) break
		bucket = next
	}

	// Never coarser than what keeps at least `minBuckets` buckets over the range.
	const maxBucketForMin = Math.floor(rangeSeconds / minBuckets)
	if (bucket > maxBucketForMin) {
		const finer = WIDTH_INTERVAL_LADDER.filter(([, seconds]) => seconds <= maxBucketForMin)
		bucket = finer.length > 0 ? finer[finer.length - 1][1] : WIDTH_INTERVAL_LADDER[0][1]
	}

	return bucket
}

/**
 * {@link computeBucketSecondsForWidth} for warehouse DateTime strings; an
 * unparseable or inverted range falls back to the chart policy's width.
 */
export function computeBucketSecondsForWidthRange(
	startTime: string | undefined,
	endTime: string | undefined,
	options: ComputeBucketSecondsForWidthOptions,
): number {
	if (!startTime || !endTime) return BUCKET_POLICIES.chart.fallbackSeconds
	const startMs = parseWarehouseDateTime(startTime)
	const endMs = parseWarehouseDateTime(endTime)
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
		return BUCKET_POLICIES.chart.fallbackSeconds
	}
	return computeBucketSecondsForWidth(startMs, endMs, options)
}

/**
 * Compact label for a bucket width — "30s", "2m", "1h", "1d", "1w" — the same
 * shorthand `parseBucketSeconds` accepts, so what the editor shows as the auto
 * value can be typed back verbatim to pin it.
 */
export function formatBucketSecondsShort(seconds: number): string {
	if (seconds % 604800 === 0) return `${seconds / 604800}w`
	if (seconds % 86400 === 0) return `${seconds / 86400}d`
	if (seconds % 3600 === 0) return `${seconds / 3600}h`
	if (seconds % 60 === 0) return `${seconds / 60}m`
	return `${seconds}s`
}

/**
 * Bucket width for an alert rule's evaluation window.
 *
 * A rule compares one value per window against a threshold, so the bucket IS the
 * window — not a fraction of it. Floored at 60s because sub-minute alert windows
 * are not offered and a zero-width bucket is not a bucket.
 *
 * Named rather than inlined because it was previously spelled out at two sites
 * (`compileRulePlan`, which bakes it into the stored spec, and
 * `prepareAlertEvaluation`'s raw-SQL branch), and a rule whose stored spec
 * disagreed with its evaluation-time bucket would silently evaluate a different
 * window than the one it was saved with.
 */
export const alertWindowBucketSeconds = (windowMinutes: number): number => Math.max(windowMinutes * 60, 60)

/** The scheduler tick period. Alert windows are snapped to it — see below. */
export const ALERT_TICK_SECONDS = 60

/**
 * Snap an alert evaluation window's end to the tick boundary.
 *
 * Two reasons, one of which is a correctness improvement rather than a cache
 * trick:
 *
 *  1. FRESHNESS — a window ending at `now` always includes the current,
 *     still-filling minute, so the final bucket reads low for reasons that have
 *     nothing to do with the signal. The error tick already excludes it
 *     (`ErrorsService`'s cutoff floors to the minute and subtracts one more).
 *  2. SHARING — every rule in a tick computed its own `now`, so rules over the
 *     identical query still produced distinct windows and distinct cache keys.
 *     Snapping makes a tick's rules agree, which is what lets the `qe-evaluate`
 *     entry be reused by, say, warn-at-100 and page-at-500 on one signal.
 *
 * Costs up to one tick of extra lag, which is bounded by the tick period the
 * scheduler already imposes.
 */
export const snapAlertWindowEndMs = (epochMs: number): number => floorToBucketMs(epochMs, ALERT_TICK_SECONDS)

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
