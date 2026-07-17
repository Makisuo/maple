import { useId, useMemo } from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"

import {
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
	type ChartConfig,
} from "@maple/ui/components/ui/chart"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { hostInfraTimeseriesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { HostInfraMetric } from "@/api/warehouse/infra"
import { formatBytesPerSecond } from "./format"
import {
	CHART_EMPTY_MESSAGE,
	CHART_GRID_DASH,
	COLOR_PALETTE,
	formatValueWithUnit,
	transformRows,
	UNNAMED_SERIES_KEY,
} from "./chart-utils"
import { InfraTooltipItem } from "./chart-tooltip"
import { formatBackendError } from "@/lib/error-messages"

interface HostDetailChartProps {
	hostName: string
	metric: HostInfraMetric
	startTime: string
	endTime: string
	bucketSeconds?: number
	syncId?: string
}

const CHART_HEIGHT = 220

// Human label for each host metric, shown as the tooltip/legend "type" for the
// single unnamed series.
const HOST_METRIC_LABELS: Record<HostInfraMetric, string> = {
	cpu: "CPU",
	memory: "Memory",
	filesystem: "Disk",
	network: "Network",
	load15: "Load (15m)",
}

export function HostDetailChart({
	hostName,
	metric,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
}: HostDetailChartProps) {
	const result = useAtomValue(
		hostInfraTimeseriesResultAtom({
			data: { hostName, metric, startTime, endTime, bucketSeconds },
		}),
	)

	return Result.builder(result)
		.onInitial(() => <Skeleton className="h-[220px] w-full rounded-none" />)
		.onError((err) => (
			<div className="flex h-[220px] items-center justify-center border border-destructive/40 bg-destructive/5 font-mono text-[11px] text-destructive">
				{formatBackendError(err).description}
			</div>
		))
		.onSuccess((response, holder) => (
			<ChartView
				rows={response.data}
				unit={response.unit}
				metric={metric}
				seriesLabel={HOST_METRIC_LABELS[metric]}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
			/>
		))
		.render()
}

interface ChartViewProps {
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	unit: "percent" | "load" | "bytes_per_second"
	metric: HostInfraMetric
	// Label for the unnamed default series so the tooltip shows the metric type
	// instead of a bare "value".
	seriesLabel?: string
	waiting: boolean
	syncId?: string
}

function ChartView({ rows, unit, metric, seriesLabel, waiting, syncId }: ChartViewProps) {
	const gradientPrefix = useId().replace(/:/g, "")

	const { data, series } = useMemo(() => transformRows(rows), [rows])

	// Series names can contain dots/slashes (container names, mount points),
	// which are invalid in a raw `var(--color-…)` reference — colour series
	// directly instead of via the ChartContainer CSS variables.
	const seriesColor = useMemo(
		() =>
			new Map(series.map((name, idx) => [name, COLOR_PALETTE[idx % COLOR_PALETTE.length] ?? ""])),
		[series],
	)

	const config = useMemo<ChartConfig>(
		() =>
			Object.fromEntries(
				series.map((name) => [
					name,
					{
						// Swap the unnamed-series placeholder for the metric label.
						label: name === UNNAMED_SERIES_KEY ? (seriesLabel ?? name) : name,
						color: seriesColor.get(name),
					},
				]),
			),
		[series, seriesLabel, seriesColor],
	)

	const lastValues = useMemo(() => {
		const out: Record<string, number> = {}
		const latest = data[data.length - 1]
		if (!latest) return out
		for (const s of series) {
			const v = latest[s]
			if (typeof v === "number") out[s] = v
		}
		return out
	}, [data, series])

	if (data.length === 0) {
		return (
			<div className="flex h-[220px] items-center justify-center border border-dashed border-border/60 font-mono text-[11px] text-muted-foreground">
				{CHART_EMPTY_MESSAGE}
			</div>
		)
	}

	const tickFormatter = (v: number) => {
		if (unit === "percent") return `${Math.round(v * 100)}%`
		if (unit === "bytes_per_second") return formatBytesPerSecond(v)
		return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
	}

	const isStacked = metric === "cpu" || metric === "memory"
	const showThreshold = metric === "cpu" || metric === "memory"
	const margin = { top: 12, right: 12, left: 0, bottom: 0 }

	return (
		<div className={cn("content-enter", waiting && "opacity-60")}>
			<div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-3 py-2">
				{series.map((s) => {
					const value = lastValues[s]
					return (
						<div key={s} className="inline-flex items-baseline gap-1.5">
							<span
								aria-hidden
								className="size-1.5 rounded-full translate-y-[-1px]"
								style={{ background: seriesColor.get(s) }}
							/>
							<span className="text-[11px] text-muted-foreground">{config[s]?.label ?? s}</span>
							{value !== undefined && (
								<span className="font-mono text-[11px] tabular-nums text-foreground/85">
									{formatValueWithUnit(value, unit)}
								</span>
							)}
						</div>
					)
				})}
			</div>
			<ChartContainer config={config} className="w-full" style={{ height: CHART_HEIGHT }}>
				{isStacked ? (
					<AreaChart data={data} margin={margin} syncId={syncId} syncMethod="value">
						<defs>
							{series.map((s) => {
								const id = `${gradientPrefix}-${s.replace(/\W+/g, "_")}`
								return (
									<linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
										<stop
											offset="5%"
											stopColor={seriesColor.get(s)}
											stopOpacity={0.45}
										/>
										<stop
											offset="95%"
											stopColor={seriesColor.get(s)}
											stopOpacity={0.04}
										/>
									</linearGradient>
								)
							})}
						</defs>
						<CartesianGrid
							strokeDasharray={CHART_GRID_DASH}
							stroke="var(--border)"
							vertical={false}
						/>
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
							tickFormatter={tickFormatter}
						/>
						{showThreshold && (
							<ReferenceLine
								y={0.8}
								stroke="var(--severity-warn)"
								strokeOpacity={0.7}
								className="infra-ref-line"
								label={{
									value: "80%",
									position: "right",
									fill: "var(--severity-warn)",
									fontSize: 9,
								}}
							/>
						)}
						<ChartTooltip
							cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
							content={
								<ChartTooltipContent
									indicator="dot"
									formatter={(value, name) => (
										<InfraTooltipItem
											color={seriesColor.get(String(name)) ?? ""}
											label={config[String(name)]?.label ?? String(name)}
											value={Number(value)}
											unit={unit}
										/>
									)}
								/>
							}
						/>
						{series.map((s) => {
							const id = `${gradientPrefix}-${s.replace(/\W+/g, "_")}`
							return (
								<Area
									key={s}
									dataKey={s}
									type="monotone"
									stackId="a"
									stroke={seriesColor.get(s)}
									strokeWidth={1.4}
									fill={`url(#${id})`}
									fillOpacity={1}
								/>
							)
						})}
					</AreaChart>
				) : (
					<LineChart data={data} margin={margin} syncId={syncId} syncMethod="value">
						<CartesianGrid
							strokeDasharray={CHART_GRID_DASH}
							stroke="var(--border)"
							vertical={false}
						/>
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
							width={64}
							stroke="var(--muted-foreground)"
							tickFormatter={tickFormatter}
						/>
						<ChartTooltip
							cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
							content={
								<ChartTooltipContent
									indicator="line"
									formatter={(value, name) => (
										<InfraTooltipItem
											color={seriesColor.get(String(name)) ?? ""}
											label={config[String(name)]?.label ?? String(name)}
											value={Number(value)}
											unit={unit}
										/>
									)}
								/>
							}
						/>
						{series.map((s) => (
							<Line
								key={s}
								dataKey={s}
								type="monotone"
								stroke={seriesColor.get(s)}
								strokeWidth={1.6}
								dot={false}
								activeDot={{ r: 3, strokeWidth: 0 }}
							/>
						))}
					</LineChart>
				)}
			</ChartContainer>
		</div>
	)
}

interface MetricStripProps {
	label: string
	caption?: string
	hostName: string
	metric: HostInfraMetric
	startTime: string
	endTime: string
	bucketSeconds?: number
	syncId?: string
}

export function MetricStrip({
	label,
	caption,
	hostName,
	metric,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
}: MetricStripProps) {
	return (
		<section className="grid grid-cols-1 gap-0 border-t first:border-t-0 lg:grid-cols-[160px_1fr]">
			<div className="border-b px-1 py-3 lg:border-b-0 lg:border-r lg:py-5">
				<div className="text-[12px] font-medium text-foreground">{label}</div>
				{caption ? (
					<div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{caption}</div>
				) : null}
			</div>
			<div className="lg:pl-4">
				<HostDetailChart
					hostName={hostName}
					metric={metric}
					startTime={startTime}
					endTime={endTime}
					bucketSeconds={bucketSeconds}
					syncId={syncId}
				/>
			</div>
		</section>
	)
}
