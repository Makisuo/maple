/**
 * Fixtures for the line, area and stacked-bar arms of `/lab/charts`.
 *
 * Two anchors, one predicate. Every series is generated from its bucket INDEX —
 * sine sums, no `Math.random()` — so the shape is byte-identical run to run and
 * the perf numbers stay comparable. What differs between the plain and the
 * trailing-partial fixtures is only where the last bucket sits on the clock:
 *
 * - plain fixtures end at a FIXED instant a month in the past, so nothing is ever
 *   in flight and both arms draw one unbroken solid line;
 * - partial fixtures are anchored to WALL-CLOCK now, because the production
 *   charts have to infer partiality themselves.
 *
 * That second anchor is not a lapse in the determinism rule, it is forced.
 * `QueryBuilderLineChart` rebuilds its rows as `{bucket, s1..sN}` before calling
 * `useIncompleteSegments` (query-builder-line-chart.tsx:85-95), so a `partial`
 * flag we set never reaches `markIncompleteSegments` — it is dropped one step
 * earlier, and passing it through would instead register `partial` as a fourth
 * SERIES. The production arm therefore falls back to the spacing + wall-clock
 * heuristic (`incomplete-buckets.ts:38-56`), and a fixed 2026 timestamp exercises
 * nothing at all. `widget-lab/scenarios.ts:546-596` anchors to `now` for exactly
 * this reason.
 *
 * `isPartial` below is that heuristic's predicate, evaluated against the same
 * captured `NOW_MS`. Both arms therefore classify the same buckets, so the dashed
 * tail starts at the same bucket in Recharts and in TanStack — which is the whole
 * point of putting them side by side.
 */

/** 5 minutes. Wide enough that a render crossing a bucket boundary is rare. */
const BUCKET_MS = 5 * 60 * 1000

/**
 * Captured once, at module load. Read repeatedly, `Date.now()` would let two
 * fixtures built in the same session disagree about which bucket is in flight.
 */
const NOW_MS = Date.now()

/** The most recent bucket boundary that has already passed. */
const ALIGNED_NOW_MS = Math.floor(NOW_MS / BUCKET_MS) * BUCKET_MS

/**
 * The same fixed instant `bench-data.ts` uses — deliberately in the past, so the
 * wall-clock heuristic finds nothing in flight and the plain arms stay solid.
 */
const FIXED_PAST_END_MS = Date.UTC(2026, 6, 17, 18, 30)

/**
 * Five buckets beyond the current one. The in-flight bucket alone is 1/59th of
 * the plot width and reads as a rendering glitch rather than a feature; running
 * the series out past `now` makes the dashed tail a tenth of the chart, and is
 * also the honest shape for a projection (`spend-chart.tsx` draws the rest of the
 * billing month the same way).
 */
const FUTURE_BUCKETS = 5

/** A bucket is incomplete once its END is still ahead of now — the heuristic's test. */
function isPartial(bucketStartMs: number): boolean {
	return bucketStartMs + BUCKET_MS > NOW_MS
}

/** Bucket starts, oldest first, with `lastStartMs` as the newest. */
function bucketStarts(count: number, lastStartMs: number): number[] {
	const starts: number[] = []
	for (let index = 0; index < count; index++) {
		starts.push(lastStartMs - (count - 1 - index) * BUCKET_MS)
	}
	return starts
}

/**
 * One timeseries point.
 *
 * No index signature, deliberately — the same constraint every other spike in
 * this directory carries: an `Omit`/`keyof` walk over a type with one collapses
 * `keyof` to `string | number` and drops the named fields. It is also what keeps
 * every channel an accessor rather than a `"field"` string.
 */
export interface TimeseriesSpikeRow {
	bucket: string
	/**
	 * The same instant as `bucket`, pre-parsed. The TanStack arms feed a d3 time
	 * scale, whose temporal inference REQUIRES `Date` channel values —
	 * `inferScaleDomain` throws "A temporal scale factory requires Date channel
	 * values" on numbers (`@tanstack/charts/dist/scale-input.js`) — and parsing in
	 * the accessor would allocate a Date per datum per mark per render. `bucket`
	 * stays: the production Recharts arms consume it via `toLatencyProductionRows`
	 * / `toThroughputProductionRows`, and `formatBucketLabel` only accepts strings.
	 */
	date: Date
	throughput: number
	/** A FRACTION, not a percentage — 0.02 is 2%. */
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	partial: boolean
}

function makeTimeseriesRows(lastStartMs: number): TimeseriesSpikeRow[] {
	const count = 60
	return bucketStarts(count, lastStartMs).map((startMs, index) => {
		const phase = (index / (count - 1)) * Math.PI * 6
		const base = 0.55 + 0.35 * Math.sin(phase)
		const date = new Date(startMs)
		return {
			bucket: date.toISOString(),
			date,
			throughput: Math.round(4000 * base + 400 * Math.sin(phase * 3.1)),
			errorRate: Math.max(0, 0.02 + 0.018 * Math.sin(phase * 1.7 + 0.9)),
			p50LatencyMs: 40 + 18 * base,
			p95LatencyMs: 180 + 90 * base + 20 * Math.sin(phase * 2.3),
			p99LatencyMs: 420 + 260 * base + 60 * Math.sin(phase * 2.9),
			partial: isPartial(startMs),
		}
	})
}

/** 60 complete buckets. Nothing in flight. */
export const TIMESERIES_SPIKE_ROWS: readonly TimeseriesSpikeRow[] = makeTimeseriesRows(FIXED_PAST_END_MS)

/** The same 60 buckets, run out past `now` so the last six are still filling. */
export const TIMESERIES_PARTIAL_ROWS: readonly TimeseriesSpikeRow[] = makeTimeseriesRows(
	ALIGNED_NOW_MS + FUTURE_BUCKETS * BUCKET_MS,
)

/** What `formatBucketLabel` needs to pick a tick format. */
export function timeseriesAxisContext(rows: readonly TimeseriesSpikeRow[]): {
	rangeMs: number
	bucketSeconds: number
} {
	return { rangeMs: (rows.length - 1) * BUCKET_MS, bucketSeconds: BUCKET_MS / 1000 }
}

/**
 * The solid run and the dashed run, as SLICES of one array.
 *
 * This is where TanStack is structurally simpler than Recharts, not just
 * differently shaped. `markIncompleteSegments` has to rewrite every row into
 * `key`/`key_incomplete` column pairs, because a Recharts `<Line dataKey>` is a
 * string and the only way to give one series two dash styles is to make it two
 * series. TanStack marks take accessors, so the same picture is two marks over
 * two slices — no row is copied, no column is invented, and the shared row at
 * `first - 1` IS the bridge point that `incomplete-buckets.ts:106-110` builds by
 * duplicating a value into a second column.
 */
export function splitAtFirstPartial<T extends { partial: boolean }>(
	rows: readonly T[],
): { solid: readonly T[]; dashed: readonly T[] } {
	const first = rows.findIndex((row) => row.partial)
	if (first === -1) return { solid: rows, dashed: [] }
	// Nothing complete to bridge from: the whole series is in flight.
	if (first === 0) return { solid: [], dashed: rows }
	return { solid: rows.slice(0, first), dashed: rows.slice(first - 1) }
}

/**
 * The latency series widened for `QueryBuilderLineChart`'s loose row prop.
 *
 * An interface has no implicit index signature, so `TimeseriesSpikeRow[]` is not
 * assignable to `Record<string, unknown>[]` — but a fresh object literal is.
 * Rebuilding is the cast-free way across that boundary, and it keeps both arms
 * provably on identical numbers (the same move as `histogramProductionRows` in
 * `charts-lab.tsx`).
 *
 * `partial` is deliberately NOT carried over: the production chart treats every
 * non-`bucket` key as a series, so it would draw a fourth line pinned at zero.
 */
export function toLatencyProductionRows(rows: readonly TimeseriesSpikeRow[]): Record<string, unknown>[] {
	return rows.map((row) => ({
		bucket: row.bucket,
		p50LatencyMs: row.p50LatencyMs,
		p95LatencyMs: row.p95LatencyMs,
		p99LatencyMs: row.p99LatencyMs,
	}))
}

/** Throughput and error throughput, widened the same way for the area arm. */
export function toThroughputProductionRows(rows: readonly TimeseriesSpikeRow[]): Record<string, unknown>[] {
	return rows.map((row) => ({
		bucket: row.bucket,
		throughput: row.throughput,
		errors: errorThroughput(row),
	}))
}

/** Errors per bucket. `errorRate` is a fraction, so this is a plain product. */
export function errorThroughput(row: TimeseriesSpikeRow): number {
	return row.throughput * row.errorRate
}

/**
 * One service's contribution to one bucket — LONG form, one row per cell.
 *
 * That is TanStack's native shape for a stacked bar: `barY` groups through the
 * `z` channel, so the series live in the data rather than in the column names.
 * Recharts needs the wide form instead, which `toStackedBarProductionRows` builds.
 */
export interface StackedBarSpikeRow {
	bucket: string
	service: string
	spans: number
	partial: boolean
}

/**
 * Five, not more: `bucketTimeseries` collapses everything past `MAX_BAR_SERIES`
 * into an "Other" bucket, and only `--chart-1..5` exist as tokens.
 */
export const STACKED_BAR_SERVICES: readonly string[] = ["api", "web", "ingest", "worker", "db"]

function makeStackedBarRows(lastStartMs: number): StackedBarSpikeRow[] {
	const count = 24
	const rows: StackedBarSpikeRow[] = []
	for (const [index, startMs] of bucketStarts(count, lastStartMs).entries()) {
		const bucket = new Date(startMs).toISOString()
		const partial = isPartial(startMs)
		const phase = (index / (count - 1)) * Math.PI * 4
		for (const [serviceIndex, service] of STACKED_BAR_SERVICES.entries()) {
			const weight = 1 - serviceIndex * 0.16
			const wobble = Math.sin(phase * (1 + serviceIndex * 0.35) + serviceIndex)
			rows.push({
				bucket,
				service,
				spans: Math.round(2400 * weight * (0.7 + 0.3 * wobble)),
				partial,
			})
		}
	}
	return rows
}

/** 24 complete buckets × 5 services. */
export const STACKED_BAR_SPIKE_ROWS: readonly StackedBarSpikeRow[] = makeStackedBarRows(FIXED_PAST_END_MS)

/** The same grid, run out past `now` so the trailing bars are still filling. */
export const STACKED_BAR_PARTIAL_ROWS: readonly StackedBarSpikeRow[] = makeStackedBarRows(
	ALIGNED_NOW_MS + FUTURE_BUCKETS * BUCKET_MS,
)

/** What `formatBucketLabel` needs for the stacked-bar axis. */
export function stackedBarAxisContext(rows: readonly StackedBarSpikeRow[]): {
	rangeMs: number
	bucketSeconds: number
} {
	const buckets = new Set(rows.map((row) => row.bucket))
	return { rangeMs: (buckets.size - 1) * BUCKET_MS, bucketSeconds: BUCKET_MS / 1000 }
}

/** Long form pivoted to wide form for `QueryBuilderBarChart`. */
export function toStackedBarProductionRows(rows: readonly StackedBarSpikeRow[]): Record<string, unknown>[] {
	const byBucket = new Map<string, Record<string, unknown>>()
	for (const row of rows) {
		let wide = byBucket.get(row.bucket)
		if (!wide) {
			wide = { bucket: row.bucket }
			byBucket.set(row.bucket, wide)
		}
		wide[row.service] = row.spans
	}
	return [...byBucket.values()]
}
