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
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { SquareTerminalIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { SERIES_COLORS } from "./chart-colors"

interface AlertSignalChartProps {
	/** Warehouse signal buckets from `useAlertRuleChart` (`{ bucket, <series> }`). */
	data?: Record<string, unknown>[]
	/** The alert engine's recorded evaluations — drives the rail (and the chart for raw SQL). */
	checks: ReadonlyArray<AlertCheckDocument>
	/** Incidents for this rule — shaded as firing windows across the chart. */
	incidents: ReadonlyArray<AlertIncidentDocument>
	threshold: number
	thresholdUpper?: number | null
	comparator: AlertComparator
	signalType: AlertSignalType
	/** Page time window in epoch ms — the shared domain for the axis, bands, and rail. */
	window: { min: number; max: number }
	loading?: boolean
	/** Preview-query failure; non-fatal when recorded checks can still draw the chart. */
	chartError?: string | null
	className?: string
}

const SINGLE_KEY = "value"
const CHART_HEIGHT = 240

type ChartPoint = { t: number } & Record<string, number | null>
type SignalSource = "warehouse" | "checks" | "none"
const Y_AXIS_WIDTH = 62
const PLOT_RIGHT = 8
const RAIL_CELLS = 60

type RailStatus = "breached" | "skipped" | "healthy" | "empty"

const RAIL_COLOR: Record<RailStatus, string> = {
	breached: "bg-destructive",
	skipped: "bg-muted-foreground/30",
	healthy: "bg-chart-apdex/70",
	empty: "bg-muted/50",
}

function num(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function toMs(value: unknown): number {
	if (typeof value !== "string") return Number.NaN
	return new Date(normalizeTimestampInput(value)).getTime()
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value
}

export function AlertSignalChart({
	data,
	checks,
	incidents,
	threshold,
	thresholdUpper,
	comparator,
	signalType,
	window: domain,
	loading,
	chartError,
	className,
}: AlertSignalChartProps) {
	const isRaw = signalType === "raw_query"

	// The warehouse signal is the preferred source; when it's empty (raw SQL, or a
	// failed/empty preview) the recorded checks become the series instead, so even
	// raw-SQL rules get a chart. `source` lets us caption the fallback.
	const { chartData, seriesKeys, isMultiSeries, source } = React.useMemo((): {
		chartData: ChartPoint[]
		seriesKeys: string[]
		isMultiSeries: boolean
		source: SignalSource
	} => {
		if (Array.isArray(data) && data.length > 0) {
			const keySet = new Set<string>()
			for (const row of data) {
				for (const key of Object.keys(row)) if (key !== "bucket") keySet.add(key)
			}
			const allKeys = Array.from(keySet)
			if (allKeys.length === 1) {
				const label = allKeys[0]!
				const rows: ChartPoint[] = data
					.map((row) => ({ t: toMs(row.bucket), [SINGLE_KEY]: num(row[label]) }))
					.filter((row) => Number.isFinite(row.t))
					.sort((a, b) => a.t - b.t)
				return { chartData: rows, seriesKeys: [SINGLE_KEY], isMultiSeries: false, source: "warehouse" }
			}
			if (allKeys.length > 1) {
				const rows: ChartPoint[] = data
					.map((row) => {
						const point: ChartPoint = { t: toMs(row.bucket) }
						for (const key of allKeys) point[key] = num(row[key])
						return point
					})
					.filter((row) => Number.isFinite(row.t))
					.sort((a, b) => a.t - b.t)
				return { chartData: rows, seriesKeys: allKeys, isMultiSeries: true, source: "warehouse" }
			}
		}

		if (checks.length > 0) {
			const rows: ChartPoint[] = checks
				.map((check) => ({
					t: new Date(normalizeTimestampInput(check.timestamp)).getTime(),
					[SINGLE_KEY]: check.observedValue,
				}))
				.filter((row) => Number.isFinite(row.t))
				.sort((a, b) => a.t - b.t)
			return { chartData: rows, seriesKeys: [SINGLE_KEY], isMultiSeries: false, source: "checks" }
		}

		return { chartData: [], seriesKeys: [SINGLE_KEY], isMultiSeries: false, source: "none" }
	}, [data, checks])

	const hasSignal = chartData.length > 0

	// Adaptive time-axis labels reuse the warehouse formatter via an ISO round-trip.
	// `rangeMs` follows the drawn axis domain (not the data span) so the include-date
	// decision matches the width the ticks actually cover; `bucketSeconds` stays
	// data-derived for tick granularity.
	const axisContext = React.useMemo(() => {
		const rangeMs = domain.max - domain.min
		if (chartData.length < 2) return { rangeMs, bucketSeconds: undefined }
		return { rangeMs, bucketSeconds: (chartData[1]!.t - chartData[0]!.t) / 1000 }
	}, [chartData, domain])

	const formatTime = React.useCallback(
		(value: number, mode: "tick" | "tooltip") =>
			formatBucketLabel(new Date(value).toISOString(), axisContext, mode),
		[axisContext],
	)

	const chartConfig: ChartConfig = React.useMemo(() => {
		const config: ChartConfig = {}
		seriesKeys.forEach((key, i) => {
			config[key] = {
				label: isMultiSeries ? key : "Observed",
				color: SERIES_COLORS[i % SERIES_COLORS.length]!,
			}
		})
		return config
	}, [seriesKeys, isMultiSeries])

	const yDomain = React.useMemo<[number, number]>(() => {
		let maxVal = threshold
		if (thresholdUpper != null) maxVal = Math.max(maxVal, thresholdUpper)
		for (const point of chartData) {
			for (const key of seriesKeys) maxVal = Math.max(maxVal, num(point[key]))
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

	const railCells = React.useMemo(() => {
		const range = Math.max(1, domain.max - domain.min)
		const buckets = Array.from({ length: RAIL_CELLS }, () => ({
			breached: 0,
			healthy: 0,
			skipped: 0,
			opened: false,
		}))
		for (const check of checks) {
			const t = new Date(normalizeTimestampInput(check.timestamp)).getTime()
			if (!Number.isFinite(t)) continue
			const idx = Math.floor(((t - domain.min) / range) * RAIL_CELLS)
			if (idx < 0 || idx >= RAIL_CELLS) continue
			const bucket = buckets[idx]!
			if (check.status === "breached") bucket.breached += 1
			else if (check.status === "healthy") bucket.healthy += 1
			else bucket.skipped += 1
			if (check.incidentTransition === "opened") bucket.opened = true
		}
		return buckets.map((bucket, i) => {
			const total = bucket.breached + bucket.healthy + bucket.skipped
			const status: RailStatus =
				total === 0
					? "empty"
					: bucket.breached > 0
						? "breached"
						: bucket.healthy > 0
							? "healthy"
							: "skipped"
			const start = domain.min + (i / RAIL_CELLS) * range
			const end = domain.min + ((i + 1) / RAIL_CELLS) * range
			const counts = [
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
					: `${window} · ${counts}${bucket.opened ? " · incident opened" : ""}`
			return { status, opened: bucket.opened, title }
		})
	}, [checks, domain, formatTime])

	const chartArea = hasSignal ? (
		<ChartContainer config={chartConfig} className="aspect-auto w-full" style={{ height: CHART_HEIGHT }}>
			<ComposedChart data={chartData} accessibilityLayer margin={{ top: 8, right: PLOT_RIGHT, bottom: 0, left: 0 }}>
				<defs>
					<linearGradient id="alert-signal-fill" x1="0" y1="0" x2="0" y2="1">
						{breachAbove ? (
							<>
								<stop offset={0} stopColor="var(--destructive)" stopOpacity={0.32} />
								<stop offset={splitOffset} stopColor="var(--destructive)" stopOpacity={0.08} />
								<stop offset={splitOffset} stopColor={SERIES_COLORS[0]} stopOpacity={0.12} />
								<stop offset={1} stopColor={SERIES_COLORS[0]} stopOpacity={0.02} />
							</>
						) : breachBelow ? (
							<>
								<stop offset={0} stopColor={SERIES_COLORS[0]} stopOpacity={0.12} />
								<stop offset={splitOffset} stopColor={SERIES_COLORS[0]} stopOpacity={0.05} />
								<stop offset={splitOffset} stopColor="var(--destructive)" stopOpacity={0.08} />
								<stop offset={1} stopColor="var(--destructive)" stopOpacity={0.3} />
							</>
						) : (
							<>
								<stop offset={0.05} stopColor={SERIES_COLORS[0]} stopOpacity={0.45} />
								<stop offset={0.95} stopColor={SERIES_COLORS[0]} stopOpacity={0.04} />
							</>
						)}
					</linearGradient>
				</defs>
				<CartesianGrid vertical={false} />

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
								return typeof t === "number" ? formatTime(t, "tooltip") : ""
							}}
							formatter={(value, name) => (
								<span className="flex items-center gap-2">
									<span
										className="size-2.5 shrink-0 rounded-[2px]"
										style={{ backgroundColor: chartConfig[name as string]?.color ?? "var(--chart-1)" }}
									/>
									<span className="text-muted-foreground">
										{chartConfig[name as string]?.label ?? name}
									</span>
									<span className="font-mono font-medium">
										{typeof value === "number" ? formatSignalValue(signalType, value) : "—"}
									</span>
								</span>
							)}
						/>
					}
				/>

				{isMultiSeries && (
					<Legend
						verticalAlign="top"
						height={28}
						iconType="circle"
						iconSize={8}
						wrapperStyle={{ overflowX: "auto", overflowY: "hidden", whiteSpace: "nowrap" }}
						formatter={(value: string) => <span className="text-xs text-muted-foreground">{value}</span>}
					/>
				)}

				<ReferenceLine
					y={threshold}
					stroke="var(--destructive)"
					strokeDasharray="6 4"
					strokeWidth={1.5}
					label={{
						value: `Threshold ${formatSignalValue(signalType, threshold)}`,
						position: "insideTopRight",
						fill: "var(--destructive)",
						fontSize: 11,
					}}
				/>
				{thresholdUpper != null && (
					<ReferenceLine
						y={thresholdUpper}
						stroke="var(--destructive)"
						strokeDasharray="6 4"
						strokeWidth={1.5}
						label={{
							value: `Upper ${formatSignalValue(signalType, thresholdUpper)}`,
							position: "insideBottomRight",
							fill: "var(--destructive)",
							fontSize: 11,
						}}
					/>
				)}

				{isMultiSeries ? (
					seriesKeys.map((key, i) => (
						<Line
							key={key}
							type="monotone"
							dataKey={key}
							stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
							strokeWidth={1.5}
							dot={false}
							connectNulls
							isAnimationActive={false}
						/>
					))
				) : (
					<Area
						type="monotone"
						dataKey={SINGLE_KEY}
						stroke={SERIES_COLORS[0]}
						strokeWidth={2}
						fill="url(#alert-signal-fill)"
						connectNulls
						isAnimationActive={false}
					/>
				)}
			</ComposedChart>
		</ChartContainer>
	) : loading ? (
		<Skeleton className="w-full" style={{ height: CHART_HEIGHT }} />
	) : isRaw ? (
		<Placeholder icon>
			<p className="font-medium text-sm">Chart builds from recorded checks</p>
			<p className="text-muted-foreground text-xs">
				Raw SQL has no live preview. Once the scheduler records evaluations they'll plot here.
			</p>
		</Placeholder>
	) : chartError != null ? (
		<Placeholder tone="destructive">
			<p className="font-medium text-destructive text-sm">Preview query failed</p>
			<p className="line-clamp-3 text-muted-foreground text-xs">{chartError}</p>
		</Placeholder>
	) : (
		<Placeholder>
			<p className="text-muted-foreground text-sm">No data in this window. Try widening the range.</p>
		</Placeholder>
	)

	return (
		<div className={cn("space-y-2", className)}>
			{chartArea}

			{hasSignal && chartError != null && source === "checks" && (
				<p className="text-[11px] text-muted-foreground">
					Live signal preview unavailable — showing recorded checks.
				</p>
			)}

			{checks.length > 0 && (
				<div className="space-y-1" style={{ paddingLeft: Y_AXIS_WIDTH, paddingRight: PLOT_RIGHT }}>
					<div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
						<span className="font-medium uppercase tracking-wider">Evaluations</span>
						<RailLegend hasIncidents={incidentBands.length > 0} />
					</div>
					<div className="flex h-2.5 gap-px">
						{railCells.map((cell, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional rail
								key={i}
								title={cell.title}
								className={cn(
									"h-full flex-1 rounded-[1px]",
									RAIL_COLOR[cell.status],
									cell.opened && "ring-1 ring-inset ring-destructive",
								)}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	)
}

function Placeholder({
	children,
	tone,
	icon,
}: {
	children: React.ReactNode
	tone?: "destructive"
	icon?: boolean
}) {
	return (
		<div
			className={cn(
				"flex w-full items-center justify-center rounded-md border border-dashed px-6 text-center",
				tone === "destructive" ? "border-destructive/40 bg-destructive/5" : "border-border/60 bg-muted/20",
			)}
			style={{ height: CHART_HEIGHT }}
		>
			<div className="max-w-sm space-y-2">
				{icon && (
					<div className="mx-auto flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
						<SquareTerminalIcon size={16} />
					</div>
				)}
				{children}
			</div>
		</div>
	)
}

function RailLegend({ hasIncidents }: { hasIncidents: boolean }) {
	return (
		<div className="flex items-center gap-3">
			<LegendChip className="bg-destructive">Breached</LegendChip>
			<LegendChip className="bg-chart-apdex/70">Healthy</LegendChip>
			<LegendChip className="bg-muted-foreground/30">Skipped</LegendChip>
			{hasIncidents && (
				<LegendChip className="bg-destructive/15 ring-1 ring-inset ring-destructive/40">Incident</LegendChip>
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
