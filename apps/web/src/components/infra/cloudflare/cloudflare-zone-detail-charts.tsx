import { useId, useMemo } from "react"
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
import { CHART_EMPTY_MESSAGE, CHART_GRID_DASH, transformRows } from "../chart-utils"

const CHART_HEIGHT = 200

// Status classes carry severity; cache statuses shade from "answered at the
// edge" (primary) to "went to origin" (muted). Both are fixed, meaningful
// mappings — not palette-by-index.
const STATUS_CLASS_COLORS: Record<string, string> = {
	"2xx": "var(--severity-info)",
	"3xx": "var(--chart-2)",
	"4xx": "var(--severity-warn)",
	"5xx": "var(--severity-error)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
}

const CACHE_STATUS_COLORS: Record<string, string> = {
	hit: "var(--primary)",
	stale: "color-mix(in oklab, var(--primary) 70%, transparent)",
	revalidated: "color-mix(in oklab, var(--primary) 50%, transparent)",
	updating: "color-mix(in oklab, var(--primary) 35%, transparent)",
	miss: "var(--chart-3)",
	expired: "var(--chart-4)",
	dynamic: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
	none: "color-mix(in oklab, var(--muted-foreground) 35%, transparent)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 25%, transparent)",
}

const FALLBACK_SERIES_COLOR = "var(--chart-5)"

interface StackedBreakdownChartProps {
	title: string
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	colors: Record<string, string>
	/** Fixed legend/stack order; unlisted series append after, alphabetically. */
	order: ReadonlyArray<string>
	waiting?: boolean
	syncId?: string
}

function StackedBreakdownChart({ title, rows, colors, order, waiting, syncId }: StackedBreakdownChartProps) {
	const gradientPrefix = useId().replace(/:/g, "")
	const { data, series } = useMemo(() => {
		const transformed = transformRows(rows)
		const rank = new Map(order.map((name, idx) => [name, idx]))
		const sorted = [...transformed.series].sort(
			(a, b) => (rank.get(a) ?? order.length) - (rank.get(b) ?? order.length) || a.localeCompare(b),
		)
		return { data: transformed.data, series: sorted }
	}, [rows, order])

	const seriesColor = (name: string) => colors[name] ?? FALLBACK_SERIES_COLOR

	const config = useMemo<ChartConfig>(
		() => Object.fromEntries(series.map((name) => [name, { label: name, color: seriesColor(name) }])),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[series],
	)

	return (
		<div className={cn("rounded-md border bg-card", waiting && "opacity-60 transition-opacity")}>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2.5">
				<span className="text-[11px] font-medium text-muted-foreground">{title}</span>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					{series.map((s) => (
						<span key={s} className="inline-flex items-center gap-1.5">
							<span
								aria-hidden
								className="size-1.5 rounded-full"
								style={{ background: seriesColor(s) }}
							/>
							<span className="text-[11px] text-muted-foreground">{s}</span>
						</span>
					))}
				</div>
			</div>
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
		</div>
	)
}

const STATUS_ORDER = ["2xx", "3xx", "4xx", "5xx", "unknown"]
const CACHE_ORDER = [
	"hit",
	"stale",
	"revalidated",
	"updating",
	"miss",
	"expired",
	"dynamic",
	"none",
	"unknown",
]

export function CloudflareZoneStatusChart({
	buckets,
	waiting,
	syncId,
}: {
	buckets: ReadonlyArray<CloudflareZoneStatusBucket>
	waiting?: boolean
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
			order={STATUS_ORDER}
			waiting={waiting}
			syncId={syncId}
		/>
	)
}

export function CloudflareZoneCacheChart({
	buckets,
	waiting,
	syncId,
}: {
	buckets: ReadonlyArray<CloudflareZoneCacheBucket>
	waiting?: boolean
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
			order={CACHE_ORDER}
			waiting={waiting}
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

export function CloudflareZoneLatencyChart({
	buckets,
	waiting,
	syncId,
}: {
	buckets: ReadonlyArray<CloudflareZoneLatencyBucket>
	waiting?: boolean
	syncId?: string
}) {
	const { data, activeSeries } = useMemo(() => {
		const points = buckets.map((b) => ({
			bucket: b.bucket,
			time: new Date(b.bucket).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
			...Object.fromEntries(LATENCY_SERIES.map((s) => [s.key, b[s.key]])),
		}))
		// Zones without plan-level quantiles (or without origin traffic) leave
		// whole series at 0 — drop those lines instead of plotting a floor.
		const active = LATENCY_SERIES.filter((s) => buckets.some((b) => b[s.key] > 0))
		return { data: points, activeSeries: active }
	}, [buckets])

	if (activeSeries.length === 0) return null

	const config = Object.fromEntries(
		activeSeries.map((s) => [s.key, { label: s.label, color: s.color }]),
	) satisfies ChartConfig

	return (
		<div className={cn("rounded-md border bg-card", waiting && "opacity-60 transition-opacity")}>
			<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 pt-2.5">
				<span className="text-[11px] font-medium text-muted-foreground">Latency percentiles</span>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					{activeSeries.map((s) => (
						<span key={s.key} className="inline-flex items-center gap-1.5">
							<span
								aria-hidden
								className={cn("h-0.5 w-3", s.dashed && "border-t border-dashed")}
								style={
									s.dashed
										? { borderColor: s.color, height: 0 }
										: { background: s.color }
								}
							/>
							<span className="text-[11px] text-muted-foreground">{s.label}</span>
						</span>
					))}
				</div>
			</div>
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
		</div>
	)
}
