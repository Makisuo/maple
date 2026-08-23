import * as React from "react"
import { areaY, d3Curve, defineChart, lineY, rect, ruleY } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scaleTime } from "d3-scale"
import { curveMonotoneX } from "d3-shape"

import type {
	AlertCheckDocument,
	AlertComparator,
	AlertIncidentDocument,
	AlertRulePreviewResponse,
	AlertSignalType,
} from "@maple/domain/http"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import {
	clipToDomain,
	GHOST_KEY,
	mergeGhost,
	projectChecks,
	projectPreview,
	resolveChartDomain,
	resolveSource,
	SIGNAL_SOURCE_LABEL,
	SINGLE_KEY,
	type Band,
	type SignalSource,
} from "@/lib/alerts/chart-series"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	resolvePlotColor,
	roundCapDasharray,
	useChartId,
	usePlotChromeColors,
	useResolvedSeriesColors,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { useTheme } from "@maple/ui/hooks/use-theme"

/** A `ChartConfig` in all but name — kept local now that the Recharts kit is gone. */
type ChartConfig = Record<string, { label: string; color?: string }>
import { formatBucketLabel } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

/** The single-series signal line and its area fill — one fixed accent, never hashed. */
const SIGNAL_TOKEN = "--chart-1"
const SIGNAL_FALLBACK = "#6366f1"

/**
 * THE alert rule chart — shared by the create form's live hero and the rule
 * detail page, so what you see while building a rule is exactly what you see
 * while tracking it. The series comes from the `previewRule` endpoint (the
 * evaluator's own query at the evaluator's own bucketing: one point per
 * evaluation window). The detail page additionally overlays real incidents and
 * the recorded-checks rail; the create form overlays the simulated
 * "would have fired" spans instead.
 */
interface AlertRuleChartProps {
	/** Evaluator-faithful series + would-fire spans from `previewRule`. */
	preview: AlertRulePreviewResponse | null
	/** The alert engine's recorded evaluations — drives the rail and the fallback series. */
	checks?: ReadonlyArray<AlertCheckDocument>
	/** Incidents for this rule — shaded as firing windows across the chart. */
	incidents?: ReadonlyArray<AlertIncidentDocument>
	/** Shade `preview.wouldFire` spans (create form — incidents don't exist yet). */
	showWouldFire?: boolean
	threshold: number
	thresholdUpper?: number | null
	comparator: AlertComparator
	signalType: AlertSignalType
	/** Page time window in epoch ms — the shared domain for the axis, bands, and rail. */
	window: { min: number; max: number }
	/**
	 * Which series to plot: the rule's query replayed now (`preview`) or the
	 * values the evaluator actually recorded (`checks`). When the requested
	 * source has no points the other one is drawn instead — and the swap is
	 * stated in the caption rather than happening silently, which is what the
	 * old auto-pick did.
	 */
	source?: SignalSource
	/** Sentence describing what the rail spans, e.g. "60 buckets · full 24h window". */
	railCoverage?: string
	/** Index of the highlighted rail bucket; clicking a cell calls back with it. */
	selectedBucket?: number | null
	onSelectBucket?: (index: number | null, bucket: { start: number; end: number }) => void
	loading?: boolean
	/** Preview-query failure; non-fatal when recorded checks can still draw the chart. */
	error?: string | null
	className?: string
}

const CHART_HEIGHT = 300

const Y_AXIS_WIDTH = 72
const PLOT_RIGHT = 12
const RAIL_CELLS = 60

type RailStatus = "breached" | "error" | "skipped" | "healthy" | "empty"

const RAIL_COLOR: Record<RailStatus, string> = {
	breached: "bg-destructive",
	error: "bg-warning",
	skipped: "bg-muted-foreground/30",
	healthy: "bg-chart-apdex/70",
	empty: "bg-muted/50",
} satisfies Record<RailStatus, string>

function num(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value
}

const NO_CHECKS: ReadonlyArray<AlertCheckDocument> = []
const NO_INCIDENTS: ReadonlyArray<AlertIncidentDocument> = []
const EMPTY_BANDS: Band[] = []

export const AlertRuleChart = React.memo(function AlertRuleChart({
	preview,
	checks = NO_CHECKS,
	incidents = NO_INCIDENTS,
	showWouldFire = false,
	threshold,
	thresholdUpper,
	comparator,
	signalType,
	window: requestedDomain,
	source: requestedSource,
	railCoverage,
	selectedBucket = null,
	onSelectBucket,
	loading,
	error,
	className,
}: AlertRuleChartProps) {
	const { domain, clampedToPreview } = React.useMemo(
		() =>
			resolveChartDomain(requestedDomain, preview?.truncatedToStart, {
				// The rail and the incident lane share this domain and are not capped
				// by the preview's window budget.
				hasOverlays: checks.length > 0 || incidents.length > 0,
			}),
		[requestedDomain, preview?.truncatedToStart, checks.length, incidents.length],
	)

	// The two sources are projected independently so the toggle can switch
	// between them, and so the unselected one can be drawn as a comparison ghost.
	const previewChart = React.useMemo(() => projectPreview(preview, domain.max), [preview, domain.max])
	const checksChart = React.useMemo(() => projectChecks(checks), [checks])

	const { source, fellBack, bothAvailable } = resolveSource(requestedSource, {
		preview: previewChart.hasPoints,
		checks: checksChart.hasPoints,
	})

	const bucketMeta = previewChart.meta
	// Memoised because `[SINGLE_KEY]` is a fresh array otherwise, and this feeds
	// the chart *definition* — an unstable identity here rebuilt the entire plot
	// spec on every render.
	const seriesKeys = React.useMemo(
		() => (source === "preview" ? previewChart.seriesKeys : [SINGLE_KEY]),
		[source, previewChart.seriesKeys],
	)
	const isMultiSeries = source === "preview" && previewChart.isMultiSeries
	const noDataBands = React.useMemo(
		() => (source === "preview" ? clipToDomain(previewChart.noDataBands, domain) : EMPTY_BANDS),
		[source, previewChart.noDataBands, domain],
	)

	// Grouped rules skip the ghost — N series plus N ghosts is unreadable.
	const { chartData, divergence } = React.useMemo(() => {
		const primary = source === "preview" ? previewChart.rows : checksChart.rows
		if (source === "none" || isMultiSeries || !bothAvailable) {
			return { chartData: primary, divergence: null as number | null }
		}
		const ghostRows = source === "preview" ? checksChart.rows : previewChart.rows
		const merged = mergeGhost(primary, ghostRows, (domain.max - domain.min) / RAIL_CELLS)
		return { chartData: merged.rows, divergence: merged.divergence }
	}, [source, isMultiSeries, bothAvailable, previewChart, checksChart, domain])

	const hasSignal = chartData.length > 0

	// Adaptive time-axis labels reuse the warehouse formatter via an ISO round-trip.
	const axisContext = React.useMemo(() => {
		const rangeMs = domain.max - domain.min
		const bucketSeconds =
			preview != null
				? preview.bucketSeconds
				: chartData.length >= 2
					? (chartData[1]!.t - chartData[0]!.t) / 1000
					: undefined
		return { rangeMs, bucketSeconds }
	}, [chartData, domain, preview])

	const formatTime = React.useCallback(
		(value: number, mode: "tick" | "tooltip") =>
			formatBucketLabel(new Date(value).toISOString(), axisContext, mode),
		[axisContext],
	)

	// Keyed by group name, so a group keeps its color when a wider time range
	// (or a different sort) changes which other groups are on screen — and it
	// matches that service's ServiceDot everywhere else in the product.
	const seriesColors = React.useMemo(() => resolveSeriesColors(seriesKeys), [seriesKeys])

	const otherSource: SignalSource = source === "preview" ? "checks" : "preview"
	const hasGhost = source !== "none" && !isMultiSeries && bothAvailable

	const chartConfig: ChartConfig = React.useMemo(() => {
		const config: ChartConfig = {}
		for (const key of seriesKeys) {
			config[key] = {
				label: isMultiSeries ? key : source === "none" ? "Observed" : SIGNAL_SOURCE_LABEL[source],
				color: seriesColors.get(key),
			}
		}
		if (hasGhost) {
			config[GHOST_KEY] = {
				label: SIGNAL_SOURCE_LABEL[otherSource],
				color: "var(--muted-foreground)",
			}
		}
		return config
	}, [seriesKeys, isMultiSeries, seriesColors, source, hasGhost, otherSource])

	const yDomain = React.useMemo<[number, number]>(() => {
		let maxVal = threshold
		if (thresholdUpper != null) maxVal = Math.max(maxVal, thresholdUpper)
		for (const point of chartData) {
			for (const key of seriesKeys) maxVal = Math.max(maxVal, num(point[key]))
			// The ghost shares the axis — clipping it would misrepresent the gap.
			if (point[GHOST_KEY] != null) maxVal = Math.max(maxVal, num(point[GHOST_KEY]))
		}
		const upper = Math.max(maxVal * 1.15, threshold * 1.3)
		return [0, upper > 0 ? upper : 1]
	}, [chartData, seriesKeys, threshold, thresholdUpper])

	// The breach region — the part of the fill that turns red — is the side of the
	// threshold the comparator flags. Range comparators have two bounds, so they
	// skip the split and keep a neutral fill plus both reference lines.
	const breachAbove = comparator === "gt" || comparator === "gte"
	const breachBelow = comparator === "lt" || comparator === "lte"
	const splitOffset = clamp01((yDomain[1] - threshold) / (yDomain[1] - yDomain[0] || 1))

	const incidentBands = React.useMemo(
		() =>
			clipToDomain(
				incidents.map((incident) => ({
					x1: new Date(incident.firstTriggeredAt).getTime(),
					x2: incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : domain.max,
					open: incident.status === "open",
				})),
				domain,
			),
		[incidents, domain],
	)

	const wouldFireBands = React.useMemo(() => {
		if (!showWouldFire || preview == null) return EMPTY_BANDS
		return clipToDomain(
			preview.wouldFire.map((span) => ({
				x1: Date.parse(span.start),
				x2: Date.parse(span.end),
				groupKey: span.groupKey,
			})),
			domain,
		)
	}, [showWouldFire, preview, domain])

	const railCells = React.useMemo(() => {
		const range = Math.max(1, domain.max - domain.min)
		const buckets = Array.from({ length: RAIL_CELLS }, () => ({
			breached: 0,
			healthy: 0,
			skipped: 0,
			errored: 0,
			opened: false,
			errorMessage: null as string | null,
		}))
		for (const check of checks) {
			const t = new Date(normalizeTimestampInput(check.timestamp)).getTime()
			if (!Number.isFinite(t)) continue
			const idx = Math.floor(((t - domain.min) / range) * RAIL_CELLS)
			if (idx < 0 || idx >= RAIL_CELLS) continue
			const bucket = buckets[idx]!
			if (check.status === "breached") bucket.breached += 1
			else if (check.status === "healthy") bucket.healthy += 1
			else if (check.status === "error") {
				bucket.errored += 1
				if (bucket.errorMessage == null && check.errorMessage != null) {
					bucket.errorMessage = check.errorMessage
				}
			} else bucket.skipped += 1
			if (check.incidentTransition === "opened") bucket.opened = true
		}
		return buckets.map((bucket, i) => {
			const total = bucket.breached + bucket.healthy + bucket.skipped + bucket.errored
			// Errors outrank breaches: a failing query is the more urgent signal.
			const status: RailStatus =
				total === 0
					? "empty"
					: bucket.errored > 0
						? "error"
						: bucket.breached > 0
							? "breached"
							: bucket.healthy > 0
								? "healthy"
								: "skipped"
			const start = domain.min + (i / RAIL_CELLS) * range
			const end = domain.min + ((i + 1) / RAIL_CELLS) * range
			const counts = [
				bucket.errored > 0 ? `${bucket.errored} failed` : null,
				bucket.breached > 0 ? `${bucket.breached} breached` : null,
				bucket.healthy > 0 ? `${bucket.healthy} healthy` : null,
				bucket.skipped > 0 ? `${bucket.skipped} skipped` : null,
			]
				.filter(Boolean)
				.join(", ")
			const window = `${formatTime(start, "tick")} – ${formatTime(end, "tick")}`
			const title =
				total === 0
					? `${window} · no checks`
					: `${window} · ${counts}${bucket.opened ? " · incident opened" : ""}${bucket.errorMessage != null ? ` · ${bucket.errorMessage}` : ""}`
			return { status, opened: bucket.opened, title, start, end }
		})
	}, [checks, domain, formatTime])

	/** Window-wide status counts — the rail legend doubles as the tally. */
	const railTotals = React.useMemo(() => {
		let breached = 0
		let healthy = 0
		let skipped = 0
		let errored = 0
		for (const check of checks) {
			if (check.status === "breached") breached += 1
			else if (check.status === "healthy") healthy += 1
			else if (check.status === "error") errored += 1
			else skipped += 1
		}
		return { breached, healthy, skipped, errored }
	}, [checks])

	// Incident spans as percentages of the domain, so the lane under the rail
	// lines up with the bands painted on the plot above it.
	const incidentSpans = React.useMemo(() => {
		const range = Math.max(1, domain.max - domain.min)
		return incidentBands.map((band) => ({
			left: (clamp01((band.x1 - domain.min) / range) * 100).toFixed(4),
			width: (clamp01((Math.max(band.x2, band.x1) - band.x1) / range) * 100).toFixed(4),
			open: band.open,
		}))
	}, [incidentBands, domain])

	const chromeColors = usePlotChromeColors()
	const focusStore = React.useMemo(() => createTooltipFocusStore(), [])
	const signalGradientId = useChartId("alert-signal")
	const { theme } = useTheme()

	const palette = React.useMemo(
		() => ({
			signal: resolvePlotColor(SIGNAL_TOKEN, SIGNAL_FALLBACK),
			destructive: resolvePlotColor("--destructive", "#ef4444"),
			muted: resolvePlotColor("--muted-foreground", "#71717a"),
		}),
		[theme],
	)

	const resolvedSeriesColors = useResolvedSeriesColors(seriesColors, palette.signal)

	/**
	 * One plotted bucket: the row's series values, plus its instant as a `Date`.
	 *
	 * Precomputed rather than derived in the x accessor — the time scale would
	 * otherwise allocate a `Date` per datum on every scale pass.
	 */
	type SignalPoint = Record<string, unknown> & { t: number; at: Date }

	const points = React.useMemo<SignalPoint[]>(
		() => chartData.map((row) => ({ ...row, t: num(row.t), at: new Date(num(row.t)) })),
		[chartData],
	)

	const tooltipSeries = React.useMemo<PlotTooltipSeries<SignalPoint>[]>(() => {
		const keys = isMultiSeries ? seriesKeys : [SINGLE_KEY]
		const rows: PlotTooltipSeries<SignalPoint>[] = keys.map((key) => ({
			label: chartConfig[key]?.label ?? key,
			color: isMultiSeries ? (resolvedSeriesColors.get(key) ?? palette.signal) : palette.signal,
			value: (point: SignalPoint) => {
				const value = point[key]
				return typeof value === "number" ? value : null
			},
			format: (value: number) => formatSignalValue(signalType, value),
		}))
		if (hasGhost) {
			rows.push({
				label: chartConfig[GHOST_KEY]?.label ?? "Other source",
				color: palette.muted,
				dashed: true,
				value: (point: SignalPoint) => {
					const value = point[GHOST_KEY]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatSignalValue(signalType, value),
			})
		}
		return rows
	}, [isMultiSeries, seriesKeys, chartConfig, resolvedSeriesColors, palette, signalType, hasGhost])

	const definition = React.useMemo(() => {
		const at = (point: SignalPoint) => point.at
		const valueOf = (key: string) => (point: SignalPoint) => {
			const value = point[key]
			return typeof value === "number" ? value : null
		}
		const curve = d3Curve(curveMonotoneX)

		/**
		 * The fill under the single-series signal, split at the threshold.
		 *
		 * Four stops with two sharing `splitOffset` is a hard colour break, not a
		 * blend: below the line the area reads as the signal's own accent, above it
		 * as the breach colour. `verticalGradient` only builds the two-stop form,
		 * so this is spelled out.
		 */
		const signalGradient = {
			id: signalGradientId,
			x1: 0,
			y1: 0,
			x2: 0,
			y2: 1,
			stops: breachAbove
				? [
						{ offset: 0, color: palette.destructive, opacity: 0.32 },
						{ offset: splitOffset, color: palette.destructive, opacity: 0.08 },
						{ offset: splitOffset, color: palette.signal, opacity: 0.12 },
						{ offset: 1, color: palette.signal, opacity: 0.02 },
					]
				: breachBelow
					? [
							{ offset: 0, color: palette.signal, opacity: 0.12 },
							{ offset: splitOffset, color: palette.signal, opacity: 0.05 },
							{ offset: splitOffset, color: palette.destructive, opacity: 0.08 },
							{ offset: 1, color: palette.destructive, opacity: 0.3 },
						]
					: [
							{ offset: 0.05, color: palette.signal, opacity: 0.45 },
							{ offset: 0.95, color: palette.signal, opacity: 0.04 },
						],
		}

		/** A band spanning the full y domain — `rect` has no "fill the plot" mode. */
		const band = (bands: ReadonlyArray<Band>, fill: string, fillOpacity: number, id: string) =>
			bands.length === 0
				? []
				: [
						decorative(
							rect(bands, {
								id,
								// Already clipped to the domain by `clipToDomain`.
								x1: (b: Band) => new Date(b.x1),
								x2: (b: Band) => new Date(b.x2),
								y1: () => yDomain[0],
								y2: () => yDomain[1],
								fill,
								fillOpacity,
								stroke: "none",
							}),
						),
					]

		return defineChart({
			gradients: [signalGradient],
			marks: [
				dashedGridY(),
				// No-data windows. The Recharts original hatched these with an SVG
				// `<pattern>`; the chart spec carries gradients but not patterns, so
				// this is a flat muted wash at the hatch's own weight. It still reads
				// as "nothing was measured here" against the plot background.
				...band(noDataBands, palette.muted, 0.1, "no-data"),
				...band(
					incidentBands.filter((b) => b.open),
					palette.destructive,
					0.12,
					"incident-open",
				),
				...band(
					incidentBands.filter((b) => !b.open),
					palette.destructive,
					0.06,
					"incident-closed",
				),
				...band(wouldFireBands, palette.destructive, 0.08, "would-fire"),
				// Threshold rules. The labels deliberately live in the caption below
				// the plot, so they cannot clip at the right edge.
				ruleY(
					thresholdUpper != null
						? [{ value: threshold }, { value: thresholdUpper }]
						: [{ value: threshold }],
					{
						y: (entry: { value: number }) => entry.value,
						stroke: palette.destructive,
						strokeOpacity: 1,
						strokeWidth: 1.5,
						strokeDasharray: "6 4",
					},
				),
				// The unselected source, behind the primary: same shape, dashed and
				// muted, so "the query says one thing, the evaluator recorded another"
				// is visible instead of inferred.
				...(hasGhost
					? [
							lineY(points, {
								id: GHOST_KEY,
								x: at,
								y: valueOf(GHOST_KEY),
								stroke: palette.muted,
								strokeWidth: 1.5,
								strokeDasharray: roundCapDasharray(5, 3, 1.5),
								curve,
							}),
						]
					: []),
				...(isMultiSeries
					? seriesKeys.map((key) =>
							lineY(points, {
								id: key,
								x: at,
								y: valueOf(key),
								stroke: resolvedSeriesColors.get(key) ?? palette.signal,
								strokeWidth: 1.5,
								curve,
							}),
						)
					: [
							areaY(points, {
								id: `${SINGLE_KEY}-band`,
								x: at,
								y: valueOf(SINGLE_KEY),
								y1: () => yDomain[0],
								fill: `url(#${signalGradientId})`,
								stroke: "none",
								curve,
							}),
							lineY(points, {
								id: SINGLE_KEY,
								x: at,
								y: valueOf(SINGLE_KEY),
								stroke: palette.signal,
								strokeWidth: 2,
								curve,
							}),
						]),
				focusCrosshair(chromeColors),
			],
			x: {
				// A real time scale over the bucket instants, which is what Recharts'
				// `type="number" scale="time"` was.
				scale: scaleTime().domain([new Date(domain.min), new Date(domain.max)]),
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						format: (value: Date) => formatTime(value.getTime(), "tick"),
					},
					tickLabels: { thin: { minGap: 12 } },
				},
			},
			y: {
				scale: scaleLinear().domain(yDomain),
				axis: {
					line: false,
					ticks: {
						size: 0,
						padding: 8,
						format: (value: number) => formatSignalValue(signalType, value),
					},
				},
			},
			// `bottom` is left unset: an authored side is a hard lock, and `bottom: 0`
			// (carried over from Recharts, which sized the axis separately) clipped
			// the x tick labels out and halved the y axis's "0". Unset, the frame
			// measures the labels and reserves their height.
			margin: { top: 8, right: PLOT_RIGHT, left: Y_AXIS_WIDTH },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [
		points,
		domain,
		yDomain,
		noDataBands,
		incidentBands,
		wouldFireBands,
		threshold,
		thresholdUpper,
		hasGhost,
		isMultiSeries,
		seriesKeys,
		resolvedSeriesColors,
		palette,
		splitOffset,
		breachAbove,
		breachBelow,
		signalGradientId,
		chromeColors,
		formatTime,
		signalType,
		focusStore,
	])

	const chartArea = hasSignal ? (
		<div className="w-full">
			{/*
			 * The series key, only when there is more than one series to tell apart.
			 * Recharts drew this with `<Legend verticalAlign="top" height={32}>`; the
			 * plot layer keeps legends in the DOM, so it is a sibling above the plot
			 * rather than a reserved band inside it.
			 */}
			{isMultiSeries ? (
				<div className="flex h-8 items-center gap-3 overflow-x-auto whitespace-nowrap">
					{seriesKeys.map((key) => (
						<span key={key} className="inline-flex items-center gap-1.5">
							<span
								aria-hidden
								className="size-2 shrink-0 rounded-full"
								style={{ background: resolvedSeriesColors.get(key) ?? palette.signal }}
							/>
							<span className="text-xs text-muted-foreground">
								{chartConfig[key]?.label ?? key}
							</span>
						</span>
					))}
				</div>
			) : null}
			<div style={{ height: CHART_HEIGHT }}>
				<PlotFrame
					definition={definition}
					ariaLabel="Alert signal"
					className="h-full w-full"
					renderTooltipBody={({ points: focused }) => (
						<PlotTooltipBody
							points={focused}
							series={tooltipSeries}
							focusStore={focusStore}
							heading={(point: SignalPoint) => {
								const t = num(point.t)
								const label = formatTime(t, "tooltip")
								const meta = bucketMeta.get(t)
								const extras = [
									meta != null ? `${meta.sampleCount} samples` : null,
									meta?.status === "skipped" ? "skipped" : null,
									meta?.provisional === true ? "in progress" : null,
								].filter(Boolean)
								return extras.length > 0 ? `${label} · ${extras.join(" · ")}` : label
							}}
						/>
					)}
				/>
			</div>
		</div>
	) : loading ? (
		<Skeleton className="w-full" style={{ height: CHART_HEIGHT }} />
	) : error != null ? (
		<Placeholder tone="destructive">
			<p className="font-medium text-destructive text-sm">Preview query failed</p>
			<p className="line-clamp-3 text-muted-foreground text-xs">{error}</p>
		</Placeholder>
	) : (
		<Placeholder>
			<p className="text-muted-foreground text-sm">No data in this window. Try widening the range.</p>
		</Placeholder>
	)

	return (
		<div className={cn("space-y-2", className)}>
			{chartArea}

			{hasSignal && (
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
					<span
						aria-hidden
						className="inline-block h-0 w-4 shrink-0 border-t-[1.5px] border-dashed border-destructive"
					/>
					<span>
						{thresholdUpper != null
							? "Threshold range "
							: breachBelow
								? "Breach below "
								: "Breach above "}
						<span className="font-mono font-medium text-foreground">
							{formatSignalValue(signalType, threshold)}
							{thresholdUpper != null
								? ` – ${formatSignalValue(signalType, thresholdUpper)}`
								: ""}
						</span>
					</span>
				</div>
			)}

			{/* Always rendered when the source swapped — the old caption was gated
			    on `error`, so an empty-but-successful preview silently changed
			    what the chart meant. */}
			{hasSignal && fellBack && (
				<div className="flex items-start gap-2.5 border-l-2 border-warning py-0.5 pl-2.5">
					<div className="space-y-0.5">
						<p className="text-foreground text-xs">
							Showing{" "}
							<span className="font-medium">{SIGNAL_SOURCE_LABEL[source as SignalSource]}</span>{" "}
							— {SIGNAL_SOURCE_LABEL[otherSource].toLowerCase()} has no points in this window.
						</p>
						{error != null && (
							<p className="line-clamp-2 text-[11px] text-muted-foreground">{error}</p>
						)}
					</div>
				</div>
			)}

			{hasSignal && hasGhost && (
				<div className="flex items-center gap-3 text-[11px] text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<span
							aria-hidden
							className="inline-block h-0 w-4 shrink-0 border-t-[1.5px] border-dashed border-muted-foreground"
						/>
						{SIGNAL_SOURCE_LABEL[otherSource]}
					</span>
					{divergence != null && divergence > Math.abs(threshold) * 0.05 && (
						<span className="rounded border border-warning/50 px-1.5 py-px text-warning">
							Sources differ by up to {formatSignalValue(signalType, divergence)}
						</span>
					)}
				</div>
			)}

			{showWouldFire && wouldFireBands.length > 0 && (
				<p className="text-[11px] text-muted-foreground">
					Shaded: rule would have fired (approximate — the live scheduler evaluates every minute).
				</p>
			)}
			{hasSignal && source === "preview" && noDataBands.length > 0 && (
				<p className="text-[11px] text-muted-foreground">
					Hatched: no data received in these windows.
				</p>
			)}
			{preview?.truncatedToStart != null && (
				<p className="text-[11px] text-muted-foreground">
					{clampedToPreview ? "Axis starts at " : "Query series starts at "}
					{formatTime(Date.parse(preview.truncatedToStart), "tooltip")} — the selected range needs
					more evaluation windows than one preview replays. Widen the rule's window or shorten the
					range for full coverage.
				</p>
			)}

			{/* One rail, two lanes. Evaluations are discrete cells; incidents are a
			    continuous bar — different *shapes*, so the lanes can't be mistaken
			    for each other the way the old duplicate strips were. */}
			{checks.length > 0 && (
				<div className="space-y-1.5 pt-1" style={{ paddingRight: PLOT_RIGHT }}>
					<div className="flex items-center">
						<RailGutter>Eval</RailGutter>
						<div className="flex h-3.5 flex-1 gap-px">
							{railCells.map((cell, i) => {
								const selected = selectedBucket === i
								return (
									<button
										// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional rail
										key={i}
										type="button"
										title={cell.title}
										aria-label={cell.title}
										aria-pressed={selected}
										disabled={onSelectBucket == null}
										onClick={() =>
											onSelectBucket?.(selected ? null : i, {
												start: cell.start,
												end: cell.end,
											})
										}
										className={cn(
											"h-full flex-1 rounded-[1px] p-0",
											RAIL_COLOR[cell.status],
											onSelectBucket != null && "cursor-pointer",
											cell.opened && "ring-1 ring-inset ring-destructive",
											selected && "ring-2 ring-foreground ring-offset-0",
										)}
									/>
								)
							})}
						</div>
					</div>
					<div className="flex items-center">
						<RailGutter>Incident</RailGutter>
						<div className="relative h-1 flex-1 rounded-[1px] bg-muted/60">
							{incidentSpans.map((span, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: positional overlay
									key={i}
									className={cn(
										"absolute inset-y-0 rounded-[1px] bg-destructive",
										!span.open && "opacity-60",
									)}
									style={{ left: `${span.left}%`, width: `${span.width}%` }}
								/>
							))}
						</div>
					</div>
					<div
						className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-0.5 text-[11px] text-muted-foreground"
						style={{ paddingLeft: Y_AXIS_WIDTH }}
					>
						<RailLegend totals={railTotals} />
						{railCoverage != null && <span>{railCoverage}</span>}
					</div>
				</div>
			)}
		</div>
	)
})

function Placeholder({ children, tone }: { children: React.ReactNode; tone?: "destructive" }) {
	return (
		<div
			className={cn(
				"flex w-full items-center justify-center rounded-md border border-dashed px-6 text-center",
				tone === "destructive"
					? "border-destructive/40 bg-destructive/5"
					: "border-border/60 bg-muted/20",
			)}
			style={{ height: CHART_HEIGHT }}
		>
			<div className="max-w-sm space-y-2">{children}</div>
		</div>
	)
}

/** Fixed-width label column that keeps both lanes aligned to the plot area. */
function RailGutter({ children }: { children: React.ReactNode }) {
	return (
		<span
			className="shrink-0 pr-3 text-right text-[10px] text-muted-foreground uppercase tracking-wider"
			style={{ width: Y_AXIS_WIDTH }}
		>
			{children}
		</span>
	)
}

/** Doubles as the window-wide tally, so the rail states its own totals. */
function RailLegend({
	totals,
}: {
	totals: { breached: number; healthy: number; skipped: number; errored: number }
}) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			<LegendChip className="bg-chart-apdex/70">Healthy {totals.healthy}</LegendChip>
			<LegendChip className="bg-destructive">Breached {totals.breached}</LegendChip>
			{totals.errored > 0 && <LegendChip className="bg-warning">Failed {totals.errored}</LegendChip>}
			{totals.skipped > 0 && (
				<LegendChip className="bg-muted-foreground/30">Skipped {totals.skipped}</LegendChip>
			)}
		</div>
	)
}

function LegendChip({ className, children }: { className?: string; children: React.ReactNode }) {
	return (
		<span className="flex items-center gap-1.5">
			<span className={cn("size-2 rounded-[1px]", className)} />
			{children}
		</span>
	)
}
