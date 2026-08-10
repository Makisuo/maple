// ---------------------------------------------------------------------------
// The metric vocabulary shared by the KPI strip and the traffic chart.
//
// One descriptor per tile, holding everything both surfaces need: the headline
// number, the per-bucket series behind it, how to format either, and which
// direction of change is the good one. The strip renders the descriptors, the
// chart renders the selected one's series — so a tile and the chart it drives
// can never disagree about what they are showing.
// ---------------------------------------------------------------------------

import { formatNumber, formatPercent } from "@maple/ui/lib/format"

import type {
	WebAnalyticsPageviewsPoint,
	WebAnalyticsSummary,
	WebAnalyticsTimeseriesPoint,
} from "@/api/warehouse/web-analytics"

export type AnalyticsMetricKey =
	| "visitors"
	| "sessions"
	| "pageViews"
	| "pagesPerSession"
	| "bounceRate"
	| "avgDuration"
	| "newVisitors"
	| "returning"

/** One point of a metric's series. `value` is already in the metric's own unit. */
export interface AnalyticsMetricPoint {
	readonly bucket: string
	readonly value: number
}

/**
 * Everything a descriptor reads, for one time window.
 *
 * The same shape serves the current window and the comparison window, which is
 * what lets a single `value()` implementation produce both halves of a delta.
 */
export interface AnalyticsMetricSource {
	readonly summary: WebAnalyticsSummary
	readonly timeseries: ReadonlyArray<WebAnalyticsTimeseriesPoint>
	readonly pageviews: ReadonlyArray<WebAnalyticsPageviewsPoint>
}

export interface AnalyticsMetricDescriptor {
	readonly key: AnalyticsMetricKey
	readonly label: string
	/** Formats the headline, the y-axis ticks and the tooltip alike. */
	readonly format: (value: number) => string
	/**
	 * True when a *fall* is the improvement, so the delta colours the other way
	 * round. Bounce rate is the clear case; session duration is deliberately
	 * not marked (a longer session is good on a docs site and bad on a checkout,
	 * and the page cannot know which this is).
	 */
	readonly invertDelta?: boolean
	/**
	 * True when the metric is only measurable over sessions carrying the
	 * migration-0011 analytics block. Those tiles read `—` rather than `0` when
	 * nothing in the window reports it — a confident zero beside a populated page
	 * views tile is the misreading this flag exists to prevent.
	 */
	readonly visitorLevel?: boolean
	/**
	 * A metric worth drawing on the *same axes* as this one, plotted alongside it
	 * whenever this one is selected.
	 *
	 * Only ever a same-unit pairing — two counts share an axis, a count and a rate
	 * do not — which is why this is a per-metric opt-in rather than something the
	 * chart infers. Reciprocal by convention: if A names B, B names A, so the pair
	 * looks the same whichever half you click.
	 */
	readonly companion?: AnalyticsMetricKey
	/** The headline. `null` means "not measurable here", never zero. */
	readonly value: (source: AnalyticsMetricSource) => number | null
	/** The sparkline and, when selected, the chart. */
	readonly series: (source: AnalyticsMetricSource) => ReadonlyArray<AnalyticsMetricPoint>
	/**
	 * The line under the value — what this number counts, or what it is measured
	 * over. Deliberately not the time window: the header's range picker already
	 * says that, and repeating it eight times is eight lines of nothing.
	 */
	readonly subline: (source: AnalyticsMetricSource) => string | undefined
}

/**
 * Session duration in words. Coarser than `@maple/ui`'s `formatDuration`, which
 * is built for span latencies and would render a 4-minute session as "4.2min";
 * a session is read in minutes and seconds.
 */
export function formatSessionDuration(ms: number): string {
	if (ms <= 0) return "—"
	const seconds = Math.round(ms / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

const formatRatio = (value: number): string => (value > 0 ? value.toFixed(1) : "—")

const sum = <T>(rows: ReadonlyArray<T>, pick: (row: T) => number): number =>
	rows.reduce((total, row) => total + pick(row), 0)

const ratio = (numerator: number, denominator: number): number =>
	denominator > 0 ? numerator / denominator : 0

/** Sessions that are not first-ever for their visitor. */
const returningSessions = (summary: WebAnalyticsSummary): number =>
	Math.max(summary.identifiedSessions - summary.newSessions, 0)

const fromTimeseries = (
	source: AnalyticsMetricSource,
	pick: (point: WebAnalyticsTimeseriesPoint) => number,
): ReadonlyArray<AnalyticsMetricPoint> =>
	source.timeseries.map((point) => ({ bucket: point.bucket, value: pick(point) }))

const fromPageviews = (
	source: AnalyticsMetricSource,
	pick: (point: WebAnalyticsPageviewsPoint) => number,
): ReadonlyArray<AnalyticsMetricPoint> =>
	source.pageviews.map((point) => ({ bucket: point.bucket, value: pick(point) }))

/**
 * The eight tiles, in display order — two rows of four at the `lg` breakpoint.
 *
 * Order is not arbitrary: the reach metrics (visitors, sessions, page views,
 * pages per session) lead, and the engagement and composition metrics follow, so
 * the top row reads as "how much traffic" and the bottom as "what kind".
 */
export const ANALYTICS_METRICS: ReadonlyArray<AnalyticsMetricDescriptor> = [
	{
		key: "visitors",
		label: "Unique visitors",
		format: formatNumber,
		visitorLevel: true,
		// The pairing the page is really read for: how many people, against how much
		// they read. They come from different tables with different coverage, so the
		// chart draws them unstacked — visitors are a subset of page views, and
		// their sum means nothing.
		companion: "pageViews",
		value: (source) => source.summary.visitors,
		series: (source) => fromTimeseries(source, (point) => point.visitors),
		// Partial coverage is the caveat that belongs on the number itself, not in
		// a footnote somewhere else on the page.
		subline: (source) =>
			source.summary.coverage < 0.98
				? `${formatPercent(source.summary.coverage)} of sessions report one`
				: "Distinct browsers",
	},
	{
		key: "sessions",
		label: "Sessions",
		format: formatNumber,
		value: (source) => source.summary.sessions,
		series: (source) => fromTimeseries(source, (point) => point.sessions),
		subline: (source) =>
			source.summary.identifiedSessions > 0
				? `${formatNumber(source.summary.newSessions)} first-time`
				: undefined,
	},
	{
		key: "pageViews",
		label: "Page views",
		format: formatNumber,
		companion: "visitors",
		// Summed from the buckets rather than taken from the summary: page views
		// come from `session_events`, which the summary query deliberately does not
		// read (see its doc comment on why `sum(PageViews)` is the wrong source).
		value: (source) => sum(source.pageviews, (point) => point.pageViews),
		series: (source) => fromPageviews(source, (point) => point.pageViews),
		// The one headline with no coverage caveat, and worth saying so beside four
		// tiles that do have one.
		subline: () => "Across every session",
	},
	{
		key: "pagesPerSession",
		label: "Pages / session",
		format: formatRatio,
		// Both halves from `session_events`, so the ratio is over one population.
		// Dividing page views by the summary's session count would mix a
		// full-coverage numerator with a differently-scoped denominator.
		value: (source) =>
			ratio(
				sum(source.pageviews, (point) => point.pageViews),
				sum(source.pageviews, (point) => point.sessions),
			),
		series: (source) => fromPageviews(source, (point) => ratio(point.pageViews, point.sessions)),
		subline: () => "Views per session",
	},
	{
		key: "bounceRate",
		label: "Bounce rate",
		format: formatPercent,
		invertDelta: true,
		visitorLevel: true,
		value: (source) => source.summary.bounceRate,
		series: (source) =>
			fromTimeseries(source, (point) => ratio(point.bouncedSessions, point.identifiedSessions)),
		subline: (source) => `Of ${formatNumber(source.summary.identifiedSessions)} reporting sessions`,
	},
	{
		key: "avgDuration",
		label: "Avg. session",
		format: formatSessionDuration,
		value: (source) => source.summary.avgDurationMs,
		series: (source) => fromTimeseries(source, (point) => point.avgDurationMs),
		subline: () => "Sessions that ended",
	},
	{
		key: "newVisitors",
		label: "New visitors",
		format: formatNumber,
		visitorLevel: true,
		value: (source) => source.summary.newSessions,
		series: (source) => fromTimeseries(source, (point) => point.newSessions),
		subline: () => "First-ever session",
	},
	{
		key: "returning",
		label: "Returning",
		format: formatNumber,
		visitorLevel: true,
		// Over identified sessions only, so this and `newVisitors` sum to the
		// population that actually reports a visitor id rather than to all sessions.
		value: (source) => returningSessions(source.summary),
		series: (source) =>
			fromTimeseries(source, (point) => Math.max(point.identifiedSessions - point.newSessions, 0)),
		subline: () => "Seen before this window",
	},
]

export const findMetric = (key: AnalyticsMetricKey): AnalyticsMetricDescriptor =>
	ANALYTICS_METRICS.find((metric) => metric.key === key) ?? ANALYTICS_METRICS[0]!

/**
 * Whether a descriptor can be shown at all for this window.
 *
 * A visitor-level metric with no identified sessions is unknown, not zero — the
 * tile says so and refuses selection rather than driving the chart along the
 * axis.
 */
export const isMetricAvailable = (
	metric: AnalyticsMetricDescriptor,
	source: AnalyticsMetricSource,
): boolean => {
	if (metric.visitorLevel && source.summary.identifiedSessions === 0) return false
	return metric.value(source) !== null
}

/**
 * Fractional change against the comparison window, or `null` when there is
 * nothing to compare against.
 *
 * A zero previous value yields `null` rather than an infinite or 100% rise:
 * "first traffic in this window" is a different statement from "up 100%", and
 * only one of them is true.
 */
export const metricDelta = (
	metric: AnalyticsMetricDescriptor,
	current: AnalyticsMetricSource,
	previous: AnalyticsMetricSource | undefined,
): number | null => {
	if (!previous) return null
	const now = metric.value(current)
	const before = metric.value(previous)
	if (now === null || before === null || before === 0) return null
	return (now - before) / before
}
