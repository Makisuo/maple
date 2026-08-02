import * as React from "react"
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Legend,
	Line,
	ReferenceArea,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts"

import type {
	AlertCheckDocument,
	AlertComparator,
	AlertIncidentDocument,
	AlertRulePreviewResponse,
	AlertSignalType,
} from "@maple/domain/http"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@maple/ui/components/ui/chart"
import { formatBucketLabel } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/utils"

/** The single-series signal line and its area fill — one fixed accent, never hashed. */
const SIGNAL_COLOR = "var(--chart-1)"

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

const SINGLE_KEY = "value"
/** The unselected source, drawn dashed behind the selected one for comparison. */
const GHOST_KEY = "__ghost"
const CHART_HEIGHT = 300

type ChartPoint = { t: number } & Record<string, number | null>
export type SignalSource = "preview" | "checks"
type ResolvedSource = SignalSource | "none"

export const SIGNAL_SOURCE_LABEL: Record<SignalSource, string> = {
	preview: "Query",
	checks: "Evaluated",
}

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
}

function num(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value
}

const NO_CHECKS: ReadonlyArray<AlertCheckDocument> = []
const NO_INCIDENTS: ReadonlyArray<AlertIncidentDocument> = []
const EMPTY_BANDS: Array<{ x1: number; x2: number }> = []

// Recharts reconciliation cost is linear in plotted points, and beyond ~1
// point per 2 horizontal pixels extra points are invisible at our widths.
// Tooltip/rail/band data stays computed from the full series.
const MAX_PLOTTED_POINTS = 720

function downsample(rows: ChartPoint[]): ChartPoint[] {
	if (rows.length <= MAX_PLOTTED_POINTS) return rows
	const stride = Math.ceil(rows.length / MAX_PLOTTED_POINTS)
	const out: ChartPoint[] = []
	for (let i = 0; i < rows.length; i += stride) out.push(rows[i]!)
	const last = rows[rows.length - 1]!
	if (out[out.length - 1] !== last) out.push(last)
	return out
}

export const AlertRuleChart = React.memo(function AlertRuleChart({
	preview,
	checks = NO_CHECKS,
	incidents = NO_INCIDENTS,
	showWouldFire = false,
	threshold,
	thresholdUpper,
	comparator,
	signalType,
	window: domain,
	source: requestedSource,
	railCoverage,
	selectedBucket = null,
	onSelectBucket,
	loading,
	error,
	className,
}: AlertRuleChartProps) {
	// The two sources are built independently so the toggle can switch between
	// them, and so the unselected one can be drawn as a comparison ghost.
	const previewChart = React.useMemo((): {
		rows: ChartPoint[]
		seriesKeys: string[]
		isMultiSeries: boolean
		hasPoints: boolean
		/** t → total samples across groups (tooltip). */
		sampleCounts: Map<number, number>
		/** t → worst per-bucket status across groups (tooltip). */
		statuses: Map<number, string>
		/** Merged spans where NO group observed data — hatched on the chart. */
		noDataBands: Array<{ x1: number; x2: number }>
		/** x-coords of the trailing in-progress window (tooltip). */
		provisionalTs: Set<number>
	} => {
		const sampleCounts = new Map<number, number>()
		const statuses = new Map<number, string>()
		const provisionalTs = new Set<number>()
		const previewSeries = preview?.series ?? []
		// An entirely-valueless preview (every window no-data) charts nothing
		// useful — fall through to checks/placeholder instead of an empty grid.
		const hasPreviewPoints = previewSeries.some((s) => s.points.some((p) => p.value != null))

		if (!hasPreviewPoints) {
			return {
				rows: [],
				seriesKeys: [SINGLE_KEY],
				isMultiSeries: false,
				hasPoints: false,
				sampleCounts,
				statuses,
				noDataBands: [],
				provisionalTs,
			}
		}

		{
			const keys = previewSeries.map((s) => s.groupKey)
			const single = keys.length === 1
			const byT = new Map<number, ChartPoint>()
			const statusRank: Record<string, number> = { healthy: 0, skipped: 1, breached: 2 }
			// Points plot at the window CLOSE — the moment the evaluator observes
			// the window — matching check timestamps and reaching the axis edge.
			const stepMs = (preview?.bucketSeconds ?? 60) * 1000
			// t → window bounds + how many of the bucket's points carried data.
			const buckets = new Map<number, { x1: number; x2: number; points: number; withData: number }>()
			for (const series of previewSeries) {
				const key = single ? SINGLE_KEY : series.groupKey
				for (const point of series.points) {
					const open = Date.parse(point.bucket)
					if (!Number.isFinite(open)) continue
					// The provisional window is shorter than a full step — close it at
					// the domain edge instead of overshooting it.
					const t = point.provisional ? Math.min(open + stepMs, domain.max) : open + stepMs
					let row = byT.get(t)
					if (!row) {
						row = { t }
						byT.set(t, row)
					}
					row[key] = point.value
					sampleCounts.set(t, (sampleCounts.get(t) ?? 0) + point.sampleCount)
					const prev = statuses.get(t)
					if (prev == null || (statusRank[point.status] ?? 0) > (statusRank[prev] ?? 0)) {
						statuses.set(t, point.status)
					}
					if (point.provisional) provisionalTs.add(t)
					let bucket = buckets.get(t)
					if (!bucket) {
						bucket = { x1: open, x2: t, points: 0, withData: 0 }
						buckets.set(t, bucket)
					}
					bucket.points += 1
					if (point.value != null) bucket.withData += 1
				}
			}
			// Runs of windows where every group came back empty → merged hatched bands.
			const noDataBands: Array<{ x1: number; x2: number }> = []
			const emptyBuckets = Array.from(buckets.values())
				.filter((b) => b.points > 0 && b.withData === 0)
				.sort((a, b) => a.x1 - b.x1)
			for (const bucket of emptyBuckets) {
				const last = noDataBands[noDataBands.length - 1]
				if (last && bucket.x1 <= last.x2 + 1) last.x2 = bucket.x2
				else noDataBands.push({ x1: bucket.x1, x2: bucket.x2 })
			}
			const rows = downsample(Array.from(byT.values()).sort((a, b) => a.t - b.t))
			return {
				rows,
				seriesKeys: single ? [SINGLE_KEY] : keys,
				isMultiSeries: !single,
				hasPoints: true,
				sampleCounts,
				statuses,
				noDataBands,
				provisionalTs,
			}
		}
	}, [preview, domain.max])

	/** The values the evaluator actually recorded, one point per check. */
	const checksChart = React.useMemo((): { rows: ChartPoint[]; hasPoints: boolean } => {
		const rows: ChartPoint[] = checks
			.map((check) => ({
				t: new Date(normalizeTimestampInput(check.timestamp)).getTime(),
				[SINGLE_KEY]: check.observedValue,
			}))
			.filter((row) => Number.isFinite(row.t))
			.sort((a, b) => a.t - b.t)
		return { rows: downsample(rows), hasPoints: rows.some((r) => r[SINGLE_KEY] != null) }
	}, [checks])

	// The requested source wins when it has points; otherwise we fall back to the
	// other one. `fellBack` drives the caption, so the swap is never silent.
	const resolvedSource: ResolvedSource = previewChart.hasPoints
		? requestedSource === "checks" && checksChart.hasPoints
			? "checks"
			: "preview"
		: checksChart.hasPoints
			? "checks"
			: "none"
	const fellBack =
		requestedSource != null && resolvedSource !== "none" && resolvedSource !== requestedSource
	const bothSourcesAvailable = previewChart.hasPoints && checksChart.hasPoints

	const source = resolvedSource
	const { sampleCounts, statuses, provisionalTs } = previewChart
	const seriesKeys = source === "preview" ? previewChart.seriesKeys : [SINGLE_KEY]
	const isMultiSeries = source === "preview" && previewChart.isMultiSeries
	const noDataBands = source === "preview" ? previewChart.noDataBands : EMPTY_BANDS

	// The unselected source, aligned onto the selected series' own timestamps so
	// it can share the dataset without shredding the primary line with nulls.
	// Grouped rules skip the ghost — N series plus N ghosts is unreadable.
	const { chartData, divergence } = React.useMemo(() => {
		const primary = source === "preview" ? previewChart.rows : checksChart.rows
		if (source === "none" || isMultiSeries || !bothSourcesAvailable) {
			return { chartData: primary, divergence: null as number | null }
		}
		const ghostRows = source === "preview" ? checksChart.rows : previewChart.rows
		const ghostPoints = ghostRows
			.map((row) => ({ t: row.t, v: row[SINGLE_KEY] }))
			.filter((p): p is { t: number; v: number } => typeof p.v === "number")
		if (ghostPoints.length === 0) return { chartData: primary, divergence: null }
		// Half the primary spacing: close enough to be the same window, far enough
		// that a coarser summary bucket still lands on its neighbour.
		const spacing =
			primary.length >= 2
				? Math.abs(primary[1]!.t - primary[0]!.t)
				: (domain.max - domain.min) / RAIL_CELLS
		const tolerance = Math.max(spacing, 1)
		let cursor = 0
		let maxGap: number | null = null
		const merged = primary.map((row) => {
			while (
				cursor + 1 < ghostPoints.length &&
				Math.abs(ghostPoints[cursor + 1]!.t - row.t) <= Math.abs(ghostPoints[cursor]!.t - row.t)
			) {
				cursor += 1
			}
			const candidate = ghostPoints[cursor]!
			if (Math.abs(candidate.t - row.t) > tolerance) return row
			const own = row[SINGLE_KEY]
			if (typeof own === "number") {
				const gap = Math.abs(own - candidate.v)
				if (maxGap == null || gap > maxGap) maxGap = gap
			}
			return { ...row, [GHOST_KEY]: candidate.v }
		})
		return { chartData: merged, divergence: maxGap }
	}, [source, isMultiSeries, bothSourcesAvailable, previewChart, checksChart, domain])

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
	const hasGhost = source !== "none" && !isMultiSeries && bothSourcesAvailable

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
			incidents
				.map((incident) => {
					const x1 = new Date(incident.firstTriggeredAt).getTime()
					const x2 = incident.resolvedAt ? new Date(incident.resolvedAt).getTime() : domain.max
					return { x1, x2, open: incident.status === "open" }
				})
				.filter((band) => band.x2 >= domain.min && band.x1 <= domain.max)
				.map((band) => ({
					...band,
					x1: Math.max(band.x1, domain.min),
					x2: Math.min(band.x2, domain.max),
				})),
		[incidents, domain],
	)

	const wouldFireBands = React.useMemo(() => {
		if (!showWouldFire || preview == null) return []
		return preview.wouldFire
			.map((span) => ({
				x1: Date.parse(span.start),
				x2: Date.parse(span.end),
				groupKey: span.groupKey,
			}))
			.filter(
				(band) =>
					Number.isFinite(band.x1) &&
					Number.isFinite(band.x2) &&
					band.x2 >= domain.min &&
					band.x1 <= domain.max,
			)
			.map((band) => ({
				...band,
				x1: Math.max(band.x1, domain.min),
				x2: Math.min(band.x2, domain.max),
			}))
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

	const chartArea = hasSignal ? (
		<ChartContainer config={chartConfig} className="aspect-auto w-full" style={{ height: CHART_HEIGHT }}>
			<ComposedChart
				data={chartData}
				accessibilityLayer
				margin={{ top: 8, right: PLOT_RIGHT, bottom: 0, left: 0 }}
			>
				<defs>
					<linearGradient id="alert-signal-fill" x1="0" y1="0" x2="0" y2="1">
						{breachAbove ? (
							<>
								<stop offset={0} stopColor="var(--destructive)" stopOpacity={0.32} />
								<stop
									offset={splitOffset}
									stopColor="var(--destructive)"
									stopOpacity={0.08}
								/>
								<stop offset={splitOffset} stopColor={SIGNAL_COLOR} stopOpacity={0.12} />
								<stop offset={1} stopColor={SIGNAL_COLOR} stopOpacity={0.02} />
							</>
						) : breachBelow ? (
							<>
								<stop offset={0} stopColor={SIGNAL_COLOR} stopOpacity={0.12} />
								<stop offset={splitOffset} stopColor={SIGNAL_COLOR} stopOpacity={0.05} />
								<stop
									offset={splitOffset}
									stopColor="var(--destructive)"
									stopOpacity={0.08}
								/>
								<stop offset={1} stopColor="var(--destructive)" stopOpacity={0.3} />
							</>
						) : (
							<>
								<stop offset={0.05} stopColor={SIGNAL_COLOR} stopOpacity={0.45} />
								<stop offset={0.95} stopColor={SIGNAL_COLOR} stopOpacity={0.04} />
							</>
						)}
					</linearGradient>
					<pattern
						id="alert-nodata-hatch"
						patternUnits="userSpaceOnUse"
						width={6}
						height={6}
						patternTransform="rotate(45)"
					>
						<line
							x1={0}
							y1={0}
							x2={0}
							y2={6}
							stroke="var(--muted-foreground)"
							strokeOpacity={0.25}
							strokeWidth={1.5}
						/>
					</pattern>
				</defs>
				<CartesianGrid vertical={false} />

				{noDataBands.map((band, i) => (
					<ReferenceArea
						key={`no-data-${i}`}
						x1={Math.max(band.x1, domain.min)}
						x2={Math.min(band.x2, domain.max)}
						fill="url(#alert-nodata-hatch)"
						stroke="none"
						ifOverflow="hidden"
					/>
				))}

				{incidentBands.map((band, i) => (
					<ReferenceArea
						key={`incident-${i}`}
						x1={band.x1}
						x2={band.x2}
						fill="var(--destructive)"
						fillOpacity={band.open ? 0.12 : 0.06}
						stroke="none"
						ifOverflow="hidden"
					/>
				))}

				{wouldFireBands.map((band, i) => (
					<ReferenceArea
						key={`would-fire-${i}`}
						x1={band.x1}
						x2={band.x2}
						fill="var(--destructive)"
						fillOpacity={0.08}
						stroke="var(--destructive)"
						strokeOpacity={0.4}
						strokeDasharray="4 3"
						ifOverflow="hidden"
					/>
				))}

				<XAxis
					dataKey="t"
					type="number"
					scale="time"
					domain={[domain.min, domain.max]}
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					fontSize={11}
					tickFormatter={(value) => formatTime(value as number, "tick")}
				/>
				<YAxis
					tickLine={false}
					axisLine={false}
					tickMargin={8}
					width={Y_AXIS_WIDTH}
					fontSize={11}
					domain={yDomain}
					tickFormatter={(value) => formatSignalValue(signalType, num(value))}
				/>

				<ChartTooltip
					content={
						<ChartTooltipContent
							labelFormatter={(_, payload) => {
								const t = payload?.[0]?.payload?.t
								if (typeof t !== "number") return ""
								const label = formatTime(t, "tooltip")
								const samples = sampleCounts.get(t)
								const status = statuses.get(t)
								const extras = [
									samples != null ? `${samples} samples` : null,
									status === "skipped" ? "skipped" : null,
									provisionalTs.has(t) ? "in progress" : null,
								].filter(Boolean)
								return extras.length > 0 ? `${label} · ${extras.join(" · ")}` : label
							}}
							formatter={(value, name) => (
								<span className="flex items-center gap-2">
									<span
										className="size-2.5 shrink-0 rounded-[2px]"
										style={{
											backgroundColor:
												chartConfig[name as string]?.color ?? "var(--chart-1)",
										}}
									/>
									<span className="text-muted-foreground">
										{chartConfig[name as string]?.label ?? name}
									</span>
									<span className="font-mono font-medium">
										{typeof value === "number"
											? formatSignalValue(signalType, value)
											: "—"}
									</span>
								</span>
							)}
						/>
					}
				/>

				{isMultiSeries && (
					<Legend
						verticalAlign="top"
						height={32}
						iconType="circle"
						iconSize={8}
						wrapperStyle={{ overflowX: "auto", overflowY: "hidden", whiteSpace: "nowrap" }}
						formatter={(value: string) => (
							<span className="text-xs text-muted-foreground">{value}</span>
						)}
					/>
				)}

				{/* Dashed threshold line(s) only — the labels live in the caption below
				    the plot so they can't clip at the right edge or collide with the
				    legend/series. */}
				<ReferenceLine
					y={threshold}
					stroke="var(--destructive)"
					strokeDasharray="6 4"
					strokeWidth={1.5}
				/>
				{thresholdUpper != null && (
					<ReferenceLine
						y={thresholdUpper}
						stroke="var(--destructive)"
						strokeDasharray="6 4"
						strokeWidth={1.5}
					/>
				)}

				{/* The unselected source, behind the primary: same shape, dashed and
				    muted, so "the query says one thing, the evaluator recorded
				    another" is visible instead of inferred. */}
				{hasGhost && (
					<Line
						type="monotone"
						dataKey={GHOST_KEY}
						stroke="var(--muted-foreground)"
						strokeWidth={1.5}
						strokeDasharray="5 3"
						dot={false}
						connectNulls
						isAnimationActive={false}
					/>
				)}

				{isMultiSeries ? (
					seriesKeys.map((key) => (
						<Line
							key={key}
							type="monotone"
							dataKey={key}
							stroke={seriesColors.get(key)}
							strokeWidth={1.5}
							dot={false}
							// Skipped/no-data windows stay visible as gaps — connecting
							// across them would fabricate a signal the evaluator never saw.
							connectNulls={source !== "preview"}
							isAnimationActive={false}
						/>
					))
				) : (
					<Area
						type="monotone"
						dataKey={SINGLE_KEY}
						stroke={SIGNAL_COLOR}
						strokeWidth={2}
						fill="url(#alert-signal-fill)"
						connectNulls={source !== "preview"}
						isAnimationActive={false}
					/>
				)}
			</ComposedChart>
		</ChartContainer>
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
					Preview truncated to {formatTime(Date.parse(preview.truncatedToStart), "tooltip")} —
					shorten the window or the range for full coverage.
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
