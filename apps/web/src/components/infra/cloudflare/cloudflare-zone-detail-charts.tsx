import { useId, useMemo, type ReactNode } from "react"
import { Area, AreaChart, Line, LineChart } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
	ChartGrid,
	ChartXAxis,
	ChartYAxis,
} from "@maple/ui/components/ui/chart"

import type {
	CloudflareZoneCacheBucket,
	CloudflareZoneLatencyBucket,
	CloudflareZoneStatusBucket,
} from "@/api/warehouse/cloudflare-infra"
import { formatLatency, formatNumber } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { CHART_EMPTY_MESSAGE, makeBucketLabeler, transformRows } from "../chart-utils"
import { CHART_HEIGHT, ChartCard } from "../primitives/chart-card"
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

export function StackedBreakdownChart({
	title,
	rows,
	colors,
	order,
	syncId,
	scope,
}: StackedBreakdownChartProps) {
	const gradientPrefix = useId().replace(/:/g, "")
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

	const config = useMemo<ChartConfig>(
		() =>
			Object.fromEntries(
				series.map((name) => [
					name,
					{ label: seriesLabel(name), color: paletteByName.get(name) ?? OTHER_ZONES_COLOR },
				]),
			),
		[series, paletteByName],
	)

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
				<div
					className="flex items-center justify-center font-mono text-[11px] text-muted-foreground"
					style={{ height: CHART_HEIGHT }}
				>
					{CHART_EMPTY_MESSAGE}
				</div>
			) : (
				<ChartContainer config={config} className="w-full" style={{ height: CHART_HEIGHT }}>
					<AreaChart
						data={data}
						margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
						syncId={syncId}
						syncMethod="value"
					>
						<defs>
							{series.map((s, idx) => (
								<linearGradient
									key={s}
									id={`${gradientPrefix}-${idx}`}
									x1="0"
									y1="0"
									x2="0"
									y2="1"
								>
									<stop offset="5%" stopColor={seriesColor(s)} stopOpacity={0.4} />
									<stop offset="95%" stopColor={seriesColor(s)} stopOpacity={0.05} />
								</linearGradient>
							))}
						</defs>
						<ChartGrid />
						<ChartXAxis dataKey="time" />
						<ChartYAxis
							tickMargin={8}
							width={52}
							tickFormatter={(v: number) => formatNumber(v)}
						/>
						<ChartTooltip
							content={
								<ChartTooltipContent
									indicator="dot"
									formatter={(value, name) => (
										<>
											<div
												className="size-2.5 shrink-0 rounded-[2px]"
												style={{ background: seriesColor(String(name)) }}
											/>
											<div className="flex flex-1 items-center justify-between gap-3 leading-none">
												<span className="max-w-[28ch] truncate text-muted-foreground">
													{seriesLabel(String(name))}
												</span>
												<span className="font-mono font-medium tabular-nums text-foreground">
													{formatNumber(Number(value))}
												</span>
											</div>
										</>
									)}
								/>
							}
						/>
						{series.map((s, idx) => (
							<Area
								key={s}
								type="monotone"
								dataKey={s}
								stackId="stack"
								stroke={seriesColor(s)}
								fill={`url(#${gradientPrefix}-${idx})`}
								strokeWidth={1.25}
								isAnimationActive={false}
							/>
						))}
					</AreaChart>
				</ChartContainer>
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

	const config = useMemo<ChartConfig>(
		() => Object.fromEntries(activeSeries.map((s) => [s.key, { label: s.label, color: s.color }])),
		[activeSeries],
	)

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
			<ChartContainer config={config} className="w-full" style={{ height: CHART_HEIGHT }}>
				<LineChart
					data={data}
					margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
					syncId={syncId}
					syncMethod="value"
				>
					<ChartGrid />
					<ChartXAxis dataKey="time" />
					<ChartYAxis tickMargin={8} width={52} tickFormatter={(v: number) => formatLatency(v)} />
					<ChartTooltip
						content={
							<ChartTooltipContent
								indicator="dot"
								formatter={(value, name) => {
									const series = LATENCY_SERIES.find((s) => s.key === name)
									return (
										<>
											<div
												className="size-2.5 shrink-0 rounded-[2px]"
												style={{ background: series?.color }}
											/>
											<div className="flex flex-1 items-center justify-between gap-3 leading-none">
												<span className="text-muted-foreground">
													{series?.label ?? String(name)}
												</span>
												<span className="font-mono font-medium tabular-nums text-foreground">
													{formatLatency(Number(value))}
												</span>
											</div>
										</>
									)
								}}
							/>
						}
					/>
					{activeSeries.map((s) => (
						<Line
							key={s.key}
							type="monotone"
							dataKey={s.key}
							stroke={s.color}
							strokeWidth={1.5}
							strokeDasharray={s.dashed ? "4 3" : undefined}
							dot={false}
							isAnimationActive={false}
						/>
					))}
				</LineChart>
			</ChartContainer>
		</ChartCard>
	)
}
