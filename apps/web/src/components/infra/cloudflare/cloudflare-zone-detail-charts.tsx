import { useId, useMemo, type ReactNode } from "react"
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { cn } from "@maple/ui/lib/utils"

import type {
	CloudflareZoneCacheBucket,
	CloudflareZoneLatencyBucket,
	CloudflareZoneStatusBucket,
} from "@/api/warehouse/cloudflare-infra"
import { formatLatency, formatNumber } from "@/lib/format"
import { CHART_EMPTY_MESSAGE, CHART_GRID_DASH, makeBucketLabeler, transformRows } from "../chart-utils"
import {
	CACHE_STATUS_COLORS,
	CACHE_STATUS_ORDER,
	STATUS_CLASS_COLORS,
	STATUS_CLASS_ORDER,
} from "./constants"

const CHART_HEIGHT = 200

const FALLBACK_SERIES_COLOR = "var(--chart-5)"

/** Card frame shared by every detail chart: title on the left, legend on the right. */
export function ChartCard({
	title,
	legend,
	children,
	className,
}: {
	title: string
	legend: ReactNode
	children: ReactNode
	className?: string
}) {
	return (
		<div className={cn("rounded-md border bg-card", className)}>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2.5">
				<span className="text-[11px] font-medium text-muted-foreground">{title}</span>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">{legend}</div>
			</div>
			{children}
		</div>
	)
}

export interface StackedBreakdownChartProps {
	title: string
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	colors: Record<string, string>
	/** Fixed legend/stack order; unlisted series append after, alphabetically. */
	order: ReadonlyArray<string>
	syncId?: string
}

export function StackedBreakdownChart({ title, rows, colors, order, syncId }: StackedBreakdownChartProps) {
	const gradientPrefix = useId().replace(/:/g, "")
	const { data, series } = useMemo(() => {
		const transformed = transformRows(rows, makeBucketLabeler(rows.map((r) => r.bucket)))
		const rank = new Map(order.map((name, idx) => [name, idx]))
		const sorted = [...transformed.series].sort(
			(a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length) || a.localeCompare(b),
		)
		return { data: transformed.data, series: sorted }
	}, [rows, order])

	const seriesColor = (name: string) => colors[name] ?? FALLBACK_SERIES_COLOR

	const config = useMemo<ChartConfig>(
		() =>
			Object.fromEntries(
				series.map((name) => [name, { label: name, color: colors[name] ?? FALLBACK_SERIES_COLOR }]),
			),
		[series, colors],
	)

	return (
		<ChartCard
			title={title}
			legend={series.map((s) => (
				<span key={s} className="inline-flex items-center gap-1.5">
					<span
						aria-hidden
						className="size-1.5 rounded-full"
						style={{ background: seriesColor(s) }}
					/>
					<span className="text-[11px] text-muted-foreground">{s}</span>
				</span>
			))}
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
						<CartesianGrid strokeDasharray={CHART_GRID_DASH} stroke="var(--border)" vertical={false} />
						<XAxis
							dataKey="time"
							tickLine={false}
							axisLine={false}
							tickMargin={8}
							fontSize={10}
							stroke="var(--muted-foreground)"
						/>
						<YAxis
							tickLine={false}
							axisLine={false}
							tickMargin={8}
							fontSize={10}
							width={52}
							stroke="var(--muted-foreground)"
							tickFormatter={(v: number) => formatNumber(v)}
						/>
						<ChartTooltip
							cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
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
												<span className="text-muted-foreground">{String(name)}</span>
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
}: {
	buckets: ReadonlyArray<CloudflareZoneStatusBucket>
	syncId?: string
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
		/>
	)
}

export function CloudflareZoneCacheChart({
	buckets,
	syncId,
}: {
	buckets: ReadonlyArray<CloudflareZoneCacheBucket>
	syncId?: string
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
}: {
	buckets: ReadonlyArray<CloudflareZoneLatencyBucket>
	syncId?: string
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
					No timing quantiles for this window — Cloudflare only exposes zone latency percentiles
					on some plans.
				</p>
			</ChartCard>
		)
	}

	return (
		<ChartCard
			title="Latency percentiles"
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
					<CartesianGrid strokeDasharray={CHART_GRID_DASH} stroke="var(--border)" vertical={false} />
					<XAxis
						dataKey="time"
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						fontSize={10}
						stroke="var(--muted-foreground)"
					/>
					<YAxis
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						fontSize={10}
						width={52}
						stroke="var(--muted-foreground)"
						tickFormatter={(v: number) => formatLatency(v)}
					/>
					<ChartTooltip
						cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
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
