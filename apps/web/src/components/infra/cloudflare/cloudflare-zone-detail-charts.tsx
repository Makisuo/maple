import { useMemo, type ReactNode } from "react"
import { areaY, d3Curve, defineChart, lineY, stack } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { curveMonotoneX } from "d3-shape"

import {
	PlotFrame,
	PlotTooltipBody,
	createTooltipFocusStore,
	cursorTooltip,
	dashedGridY,
	focusCrosshair,
	focusDot,
	linearYDomain,
	niceLinearDomain,
	roundCapDasharray,
	useChartId,
	usePlotChromeColors,
	useResolvedSeriesColors,
	verticalGradient,
	type PlotTooltipSeries,
} from "@maple/ui/components/plot"
import { linkedCursorChartProps } from "@/hooks/use-linked-cursor"

import type {
	CloudflareZoneCacheBucket,
	CloudflareZoneLatencyBucket,
	CloudflareZoneStatusBucket,
} from "@/api/warehouse/cloudflare-infra"
import { formatLatency, formatNumber } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { CHART_EMPTY_MESSAGE, makeBucketLabeler, transformRows } from "../chart-utils"
import { CHART_HEIGHT, ChartCard, ChartCardMessage } from "../primitives/chart-card"
import {
	BREAKDOWN_OTHER_KEY,
	BREAKDOWN_OTHER_LABEL,
	CACHE_STATUS_COLORS,
	CACHE_STATUS_ORDER,
	OTHER_ZONES_COLOR,
	STATUS_CLASS_COLORS,
	STATUS_CLASS_ORDER,
} from "./constants"

/**
 * Series ceiling for a dimension with no fixed vocabulary. The API already folds the tail into
 * `BREAKDOWN_OTHER_KEY`, so this only catches a response that predates that fold (a cached one, or
 * a caller that passes rows straight through) — without it, one stale payload puts thousands of
 * `<Area>` elements back on the page.
 */
const MAX_SERIES = 6

/** Legend chips beyond this collapse into a `+N`, so the legend can never reflow the card header. */
const MAX_LEGEND_CHIPS = 8

/** The pooled-tail sentinel is a wire value, never a label. */
const seriesLabel = (name: string) => (name === BREAKDOWN_OTHER_KEY ? BREAKDOWN_OTHER_LABEL : name)

export interface StackedBreakdownChartProps {
	title: string
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	colors: Record<string, string>
	/** Fixed legend/stack order; unlisted series append after, alphabetically. */
	order: ReadonlyArray<string>
	syncId?: string
	scope?: ReactNode
}

/**
 * Cap the series count for dimensions with no fixed vocabulary, pooling the rest into one `Other`.
 * Dimensions that pass an `order` (status class, cache status) have a small closed vocabulary and
 * are left alone — folding those would hide a status class the operator is looking for.
 */
function foldTail(rows: StackedBreakdownChartProps["rows"]): StackedBreakdownChartProps["rows"] {
	const totals = new Map<string, number>()
	for (const row of rows) {
		totals.set(row.attributeValue, (totals.get(row.attributeValue) ?? 0) + row.value)
	}
	if (totals.size <= MAX_SERIES + 1) return rows
	const keep = new Set(
		[...totals.entries()]
			.toSorted((a, b) => b[1] - a[1])
			.slice(0, MAX_SERIES)
			.map(([name]) => name),
	)
	// Re-sum per bucket so the pooled series is one point per bucket, not N overlapping ones.
	const pooled = new Map<string, number>()
	const kept: Array<{ bucket: string; attributeValue: string; value: number }> = []
	for (const row of rows) {
		if (keep.has(row.attributeValue)) kept.push(row)
		else pooled.set(row.bucket, (pooled.get(row.bucket) ?? 0) + row.value)
	}
	for (const [bucket, value] of pooled) {
		kept.push({ bucket, attributeValue: BREAKDOWN_OTHER_KEY, value })
	}
	return kept
}

/** One band segment: a bucket row, the series it belongs to, and its value. */
interface BreakdownCell {
	row: Record<string, unknown>
	time: string
	name: string
	value: number
}

/**
 * A key absent from a bucket row is a zero count (the API only writes keys it
 * saw), and `stack()` starts a new segment at a null — so the band would tear
 * wherever one status class went quiet for a bucket.
 */
const cellValue = (value: unknown): number => (typeof value === "number" ? value : 0)

export function StackedBreakdownChart({
	title,
	rows,
	colors,
	order,
	syncId,
	scope,
}: StackedBreakdownChartProps) {
	const gradientPrefix = useChartId("breakdown")
	const { data, series } = useMemo(() => {
		const bounded = order.length > 0 ? rows : foldTail(rows)
		const transformed = transformRows(bounded, makeBucketLabeler(bounded.map((r) => r.bucket)))
		const rank = new Map(order.map((name, idx) => [name, idx]))
		// The pooled tail always sorts last — it is the leftovers, not a peer of the named series.
		const rankOf = (name: string) =>
			name === BREAKDOWN_OTHER_KEY ? Number.MAX_SAFE_INTEGER : (rank.get(name) ?? order.length)
		const sorted = [...transformed.series].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))
		return { data: transformed.data, series: sorted }
	}, [rows, order])

	// Fixed vocabularies (status class, cache status) map a color to a meaning. Everything else
	// hashes its name into the shared identity palette, so a path/country/host keeps its color
	// across windows and stays distinguishable instead of collapsing into one fallback hue.
	const paletteByName = useMemo(() => {
		const identities = series.filter((name) => colors[name] == null && name !== BREAKDOWN_OTHER_KEY)
		const identityColors = resolveSeriesColors(identities)
		const map = new Map<string, string>()
		for (const name of series) {
			map.set(
				name,
				colors[name] ??
					(name === BREAKDOWN_OTHER_KEY
						? OTHER_ZONES_COLOR
						: (identityColors.get(name) ?? OTHER_ZONES_COLOR)),
			)
		}
		return map
	}, [series, colors])

	const seriesColor = (name: string) => paletteByName.get(name) ?? OTHER_ZONES_COLOR

	// Resolved to literals: canvas cannot read `var(--chart-3)`.
	const chromeColors = usePlotChromeColors()
	const resolvedColors = useResolvedSeriesColors(paletteByName, OTHER_ZONES_COLOR)
	const colorOf = (name: string) => resolvedColors.get(name) ?? OTHER_ZONES_COLOR
	const focusStore = useMemo(() => createTooltipFocusStore(), [])

	const yDomain = useMemo<[number, number]>(
		() => niceLinearDomain(linearYDomain({ rows: data, keys: series, stacked: true })),
		[data, series],
	)

	const tooltipSeries = useMemo<PlotTooltipSeries<BreakdownCell>[]>(
		() =>
			series.map((name) => ({
				label: seriesLabel(name),
				color: colorOf(name),
				// Off the bucket ROW, so hovering one band still prints every series.
				value: (cell: BreakdownCell) => {
					const value = cell.row[name]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatNumber(value),
			})),
		[series, resolvedColors],
	)

	const definition = useMemo(() => {
		const cells: BreakdownCell[] = data.flatMap((row) =>
			series.map((name) => ({
				row,
				time: String(row.time),
				name,
				value: cellValue(row[name]),
			})),
		)

		return defineChart({
			gradients: series.map((name) =>
				verticalGradient(`${gradientPrefix}-${name.replace(/\W+/g, "_")}`, colorOf(name), 0.4, 0.05),
			),
			marks: [
				dashedGridY(),
				areaY(cells, {
					x: (cell: BreakdownCell) => cell.time,
					y: (cell: BreakdownCell) => cell.value,
					z: (cell: BreakdownCell) => cell.name,
					fill: (cell: BreakdownCell) =>
						`url(#${gradientPrefix}-${cell.name.replace(/\W+/g, "_")})`,
					stroke: (cell: BreakdownCell) => colorOf(cell.name),
					strokeWidth: 1.25,
					curve: d3Curve(curveMonotoneX),
					layout: stack({ order: [...series] }),
				}),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: {
					scale: scalePoint,
					axis: {
						line: false,
						ticks: { size: 0, padding: 8 },
						tickLabels: { thin: { minGap: 12 } },
					},
				},
				y: {
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: { size: 0, padding: 8, format: (v: number) => formatNumber(v) },
					},
				},
			},
			// `bottom` unset on purpose: a set side is a hard lock, and only a measured
			// side reserves the x tick labels' height.
			margin: { top: 12, right: 12, left: 60 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [data, series, resolvedColors, chromeColors, gradientPrefix, yDomain, focusStore])

	const legendChips = series.slice(0, MAX_LEGEND_CHIPS)
	const legendOverflow = series.length - legendChips.length

	return (
		<ChartCard
			title={title}
			scope={scope}
			legend={
				<>
					{legendChips.map((s) => (
						<span key={s} className="inline-flex min-w-0 items-center gap-1.5">
							<span
								aria-hidden
								className="size-1.5 shrink-0 rounded-full"
								style={{ background: seriesColor(s) }}
							/>
							<span
								className="max-w-[24ch] truncate text-[11px] text-muted-foreground"
								title={seriesLabel(s)}
							>
								{seriesLabel(s)}
							</span>
						</span>
					))}
					{legendOverflow > 0 ? (
						<span className="text-[11px] text-muted-foreground/70">+{legendOverflow}</span>
					) : null}
				</>
			}
		>
			{data.length === 0 ? (
				<ChartCardMessage>{CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<div
					className="w-full"
					style={{ height: CHART_HEIGHT }}
					{...linkedCursorChartProps(syncId != null ? `cf-breakdown-${title}` : undefined)}
				>
					<PlotFrame
						definition={definition}
						ariaLabel={title}
						className="h-full w-full"
						renderTooltipBody={({ points }) => (
							<PlotTooltipBody
								points={points}
								series={tooltipSeries}
								focusStore={focusStore}
								heading={(cell: BreakdownCell) => cell.time}
							/>
						)}
					/>
				</div>
			)}
		</ChartCard>
	)
}

export function CloudflareZoneStatusChart({
	buckets,
	syncId,
	scope,
}: {
	buckets: ReadonlyArray<CloudflareZoneStatusBucket>
	syncId?: string
	scope?: ReactNode
}) {
	const rows = useMemo(
		() => buckets.map((b) => ({ bucket: b.bucket, attributeValue: b.statusClass, value: b.requests })),
		[buckets],
	)
	return (
		<StackedBreakdownChart
			title="Requests by status class"
			rows={rows}
			colors={STATUS_CLASS_COLORS}
			order={STATUS_CLASS_ORDER}
			syncId={syncId}
			scope={scope}
		/>
	)
}

export function CloudflareZoneCacheChart({
	buckets,
	syncId,
	scope,
}: {
	buckets: ReadonlyArray<CloudflareZoneCacheBucket>
	syncId?: string
	scope?: ReactNode
}) {
	const rows = useMemo(
		() => buckets.map((b) => ({ bucket: b.bucket, attributeValue: b.cacheStatus, value: b.requests })),
		[buckets],
	)
	return (
		<StackedBreakdownChart
			title="Requests by cache status"
			rows={rows}
			colors={CACHE_STATUS_COLORS}
			order={CACHE_STATUS_ORDER}
			syncId={syncId}
			scope={scope}
		/>
	)
}

// Edge TTFB solid, origin duration dashed — the dash pattern is the visual cue
// that origin lines describe the slower upstream leg of the same request.
const LATENCY_SERIES: ReadonlyArray<{
	key: keyof Omit<CloudflareZoneLatencyBucket, "bucket">
	label: string
	color: string
	dashed?: boolean
}> = [
	{ key: "ttfbP50Ms", label: "TTFB p50", color: "var(--chart-p50)" },
	{ key: "ttfbP95Ms", label: "TTFB p95", color: "var(--chart-2)" },
	{ key: "ttfbP99Ms", label: "TTFB p99", color: "var(--chart-1)" },
	{ key: "originP50Ms", label: "Origin p50", color: "var(--chart-p50)", dashed: true },
	{ key: "originP95Ms", label: "Origin p95", color: "var(--chart-2)", dashed: true },
	{ key: "originP99Ms", label: "Origin p99", color: "var(--chart-1)", dashed: true },
]

function LatencyLegendSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
	if (dashed) {
		return <span aria-hidden className="w-3 border-t border-dashed" style={{ borderColor: color }} />
	}
	return <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: color }} />
}

/** One bucket of latency percentiles, keyed by series. */
type LatencyPoint = { bucket: string; time: string } & Record<string, string | number>

export function CloudflareZoneLatencyChart({
	buckets,
	syncId,
	scope,
}: {
	buckets: ReadonlyArray<CloudflareZoneLatencyBucket>
	syncId?: string
	scope?: ReactNode
}) {
	const { data, activeSeries } = useMemo(() => {
		const labeler = makeBucketLabeler(buckets.map((b) => b.bucket))
		const points = buckets.map((b) => ({
			bucket: b.bucket,
			time: labeler(b.bucket),
			...Object.fromEntries(LATENCY_SERIES.map((s) => [s.key, b[s.key]])),
		}))
		// Zones without plan-level quantiles (or without origin traffic) leave
		// whole series at 0 — drop those lines instead of plotting a floor.
		const active = LATENCY_SERIES.filter((s) => buckets.some((b) => b[s.key] > 0))
		return { data: points, activeSeries: active }
	}, [buckets])

	const chromeColors = usePlotChromeColors()
	const focusStore = useMemo(() => createTooltipFocusStore(), [])

	// The percentile tokens resolved to literals — canvas cannot read `var()`.
	const colorTokens = useMemo(() => new Map(LATENCY_SERIES.map((entry) => [entry.key, entry.color])), [])
	const colors = useResolvedSeriesColors(colorTokens, chromeColors.border)

	const yDomain = useMemo<[number, number]>(
		() => niceLinearDomain(linearYDomain({ rows: data, keys: activeSeries.map((e) => e.key) })),
		[data, activeSeries],
	)

	const tooltipSeries = useMemo<PlotTooltipSeries<LatencyPoint>[]>(
		() =>
			activeSeries.map((entry) => ({
				label: entry.label,
				color: colors.get(entry.key) ?? chromeColors.border,
				dashed: entry.dashed,
				value: (point: LatencyPoint) => {
					const value = point[entry.key]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatLatency(value),
			})),
		[activeSeries, colors, chromeColors.border],
	)

	const definition = useMemo(() => {
		const at = (point: LatencyPoint) => point.time
		const valueOf = (key: string) => (point: LatencyPoint) => {
			const value = point[key]
			return typeof value === "number" ? value : null
		}
		const colorOf = (key: string) => colors.get(key) ?? chromeColors.border
		const curve = d3Curve(curveMonotoneX)

		return defineChart({
			marks: [
				dashedGridY(),
				...activeSeries.map((entry) =>
					lineY(data, {
						id: entry.key,
						x: at,
						y: valueOf(entry.key),
						stroke: colorOf(entry.key),
						strokeWidth: 1.5,
						// The origin series is drawn dashed, matching its legend swatch.
						strokeDasharray: entry.dashed ? roundCapDasharray(4, 4, 1.5) : undefined,
						curve,
					}),
				),
				...activeSeries.map((entry) =>
					focusDot(data, at, valueOf(entry.key), colorOf(entry.key), chromeColors),
				),
				focusCrosshair(chromeColors),
			],
			scales: {
				x: {
					scale: scalePoint,
					axis: {
						line: false,
						ticks: { size: 0, padding: 8 },
						tickLabels: { thin: { minGap: 12 } },
					},
				},
				y: {
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: { size: 0, padding: 8, format: (v: number) => formatLatency(v) },
					},
				},
			},
			// `bottom` unset on purpose: a set side is a hard lock, and only a measured
			// side reserves the x tick labels' height.
			margin: { top: 12, right: 12, left: 60 },
			focus: "group-x",
			focusRing: false,
			tooltip: cursorTooltip(focusStore.anchor),
		})
	}, [data, activeSeries, colors, chromeColors, yDomain, focusStore])

	// Latency quantiles are plan-gated on Cloudflare's side — say so instead of
	// silently omitting the panel (the operator shouldn't wonder where it went).
	if (activeSeries.length === 0) {
		return (
			<ChartCard title="Latency percentiles" legend={null}>
				<p className="px-3 pb-3 pt-1.5 font-mono text-[11px] text-muted-foreground">
					No timing quantiles for this window — Cloudflare only exposes zone latency percentiles on
					some plans.
				</p>
			</ChartCard>
		)
	}

	return (
		<ChartCard
			title="Latency percentiles"
			scope={scope}
			legend={activeSeries.map((s) => (
				<span key={s.key} className="inline-flex items-center gap-1.5">
					<LatencyLegendSwatch color={s.color} dashed={s.dashed} />
					<span className="text-[11px] text-muted-foreground">{s.label}</span>
				</span>
			))}
		>
			<div
				className="w-full"
				style={{ height: CHART_HEIGHT }}
				{...linkedCursorChartProps(syncId != null ? "cf-zone-latency" : undefined)}
			>
				<PlotFrame
					definition={definition}
					ariaLabel="Latency percentiles"
					className="h-full w-full"
					renderTooltipBody={({ points }) => (
						<PlotTooltipBody
							points={points}
							series={tooltipSeries}
							focusStore={focusStore}
							heading={(point: LatencyPoint) => point.time}
						/>
					)}
				/>
			</div>
		</ChartCard>
	)
}
