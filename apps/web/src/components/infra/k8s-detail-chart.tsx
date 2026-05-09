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

import {
	podInfraTimeseriesResultAtom,
	nodeInfraTimeseriesResultAtom,
	workloadInfraTimeseriesResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import type { PodInfraMetric, NodeInfraMetric, WorkloadInfraMetric, WorkloadKind } from "@/api/tinybird/infra"
import { formatPercent } from "./format"
import { formatBackendError } from "@/lib/error-messages"

const CHART_HEIGHT = 280

const COLOR_PALETTE = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
	"var(--chart-p50)",
]

function isoToLabel(iso: string): string {
	const d = new Date(iso)
	return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
}

interface TransformedPoint extends Record<string, string | number> {
	bucket: string
	time: string
}

function transformRows(rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>): {
	data: TransformedPoint[]
	series: string[]
} {
	const seriesSet = new Set<string>()
	const byBucket = new Map<string, TransformedPoint>()
	for (const row of rows) {
		const series = row.attributeValue || "value"
		seriesSet.add(series)
		const existing =
			byBucket.get(row.bucket) ??
			({
				bucket: row.bucket,
				time: isoToLabel(row.bucket),
			} as TransformedPoint)
		existing[series] = row.value
		byBucket.set(row.bucket, existing)
	}
	const data = Array.from(byBucket.values()).toSorted((a, b) => String(a.bucket).localeCompare(String(b.bucket)))
	return { data, series: [...seriesSet] }
}

function formatSeconds(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "—"
	if (seconds < 60) return `${Math.round(seconds)}s`
	const m = Math.floor(seconds / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ${m % 60}m`
	const d = Math.floor(h / 24)
	return `${d}d ${h % 24}h`
}

type Unit = "percent" | "cores" | "seconds"

interface ChartViewProps {
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	unit: Unit
	isStacked?: boolean
	showThreshold?: boolean
	waiting: boolean
	syncId?: string
}

function ChartView({ rows, unit, isStacked, showThreshold, waiting, syncId }: ChartViewProps) {
	const gradientPrefix = useId().replace(/:/g, "")
	const { data, series } = useMemo(() => transformRows(rows), [rows])

	const config = useMemo<ChartConfig>(
		() =>
			Object.fromEntries(
				series.map((name, idx) => [
					name,
					{
						label: name || "value",
						color: COLOR_PALETTE[idx % COLOR_PALETTE.length],
					},
				]),
			),
		[series],
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
			<div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
				No data for this metric in the selected window.
			</div>
		)
	}

	const tickFormatter = (v: number) => {
		if (unit === "percent") return `${Math.round(v * 100)}%`
		if (unit === "seconds") return formatSeconds(v)
		return v.toLocaleString(undefined, { maximumFractionDigits: 3 })
	}

	const tooltipFormatter = (val: unknown): string => {
		const num = typeof val === "number" ? val : Number(val)
		if (!Number.isFinite(num)) return "—"
		if (unit === "percent") return formatPercent(num)
		if (unit === "seconds") return formatSeconds(num)
		return num.toLocaleString(undefined, { maximumFractionDigits: 3 })
	}

	const margin = { top: 12, right: 12, left: 0, bottom: 0 }

	return (
		<div className={cn("rounded-lg border bg-card p-4 transition-opacity", waiting && "opacity-60")}>
			<div className="mb-3 flex flex-wrap items-center gap-2">
				{series.map((s) => {
					const value = lastValues[s]
					return (
						<div
							key={s}
							className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-[11px]"
						>
							<span
								className="size-2 rounded-full"
								style={{ background: `var(--color-${s})` }}
							/>
							<span className="font-medium text-foreground/80">{config[s]?.label ?? s}</span>
							{value !== undefined && (
								<span className="font-mono tabular-nums text-muted-foreground">
									{tooltipFormatter(value)}
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
											stopColor={`var(--color-${s})`}
											stopOpacity={0.45}
										/>
										<stop
											offset="95%"
											stopColor={`var(--color-${s})`}
											stopOpacity={0.05}
										/>
									</linearGradient>
								)
							})}
						</defs>
						<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
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
							width={56}
							stroke="var(--muted-foreground)"
							tickFormatter={tickFormatter}
						/>
						{showThreshold && unit === "percent" && (
							<ReferenceLine
								y={0.8}
								stroke="var(--severity-warn)"
								strokeDasharray="4 4"
								strokeOpacity={0.7}
								label={{
									value: "80%",
									position: "right",
									fill: "var(--severity-warn)",
									fontSize: 10,
								}}
							/>
						)}
						<ChartTooltip
							cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
							content={
								<ChartTooltipContent indicator="dot" formatter={(v) => tooltipFormatter(v)} />
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
									stroke={`var(--color-${s})`}
									strokeWidth={1.6}
									fill={`url(#${id})`}
									fillOpacity={1}
								/>
							)
						})}
					</AreaChart>
				) : (
					<LineChart data={data} margin={margin} syncId={syncId} syncMethod="value">
						<CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
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
							width={70}
							stroke="var(--muted-foreground)"
							tickFormatter={tickFormatter}
						/>
						<ChartTooltip
							cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
							content={
								<ChartTooltipContent
									indicator="line"
									formatter={(v) => tooltipFormatter(v)}
								/>
							}
						/>
						{series.map((s) => (
							<Line
								key={s}
								dataKey={s}
								type="monotone"
								stroke={`var(--color-${s})`}
								strokeWidth={1.8}
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

interface PodDetailChartProps {
	podName: string
	namespace?: string
	metric: PodInfraMetric
	startTime: string
	endTime: string
	bucketSeconds?: number
	syncId?: string
}

export function PodDetailChart({
	podName,
	namespace,
	metric,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
}: PodDetailChartProps) {
	const result = useAtomValue(
		podInfraTimeseriesResultAtom({
			data: { podName, namespace, metric, startTime, endTime, bucketSeconds },
		}),
	)

	return Result.builder(result)
		.onInitial(() => <Skeleton className="h-[280px] w-full rounded-lg" />)
		.onError((err) => (
			<div className="flex h-[280px] items-center justify-center rounded-lg border border-destructive/40 bg-destructive/5 text-xs text-destructive">
				{formatBackendError(err).description}
			</div>
		))
		.onSuccess((response, holder) => (
			<ChartView
				rows={response.data}
				unit={response.unit}
				showThreshold={metric.startsWith("cpu_") || metric.startsWith("memory_")}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
			/>
		))
		.render()
}

interface NodeDetailChartProps {
	nodeName: string
	metric: NodeInfraMetric
	startTime: string
	endTime: string
	bucketSeconds?: number
	syncId?: string
}

export function NodeDetailChart({
	nodeName,
	metric,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
}: NodeDetailChartProps) {
	const result = useAtomValue(
		nodeInfraTimeseriesResultAtom({
			data: { nodeName, metric, startTime, endTime, bucketSeconds },
		}),
	)

	return Result.builder(result)
		.onInitial(() => <Skeleton className="h-[280px] w-full rounded-lg" />)
		.onError((err) => (
			<div className="flex h-[280px] items-center justify-center rounded-lg border border-destructive/40 bg-destructive/5 text-xs text-destructive">
				{formatBackendError(err).description}
			</div>
		))
		.onSuccess((response, holder) => (
			<ChartView
				rows={response.data}
				unit={response.unit}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
			/>
		))
		.render()
}

interface WorkloadDetailChartProps {
	kind: WorkloadKind
	workloadName: string
	namespace?: string
	metric: WorkloadInfraMetric
	groupByPod?: boolean
	startTime: string
	endTime: string
	bucketSeconds?: number
	syncId?: string
}

export function WorkloadDetailChart({
	kind,
	workloadName,
	namespace,
	metric,
	groupByPod,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
}: WorkloadDetailChartProps) {
	const result = useAtomValue(
		workloadInfraTimeseriesResultAtom({
			data: {
				kind,
				workloadName,
				namespace,
				metric,
				groupByPod,
				startTime,
				endTime,
				bucketSeconds,
			},
		}),
	)

	return Result.builder(result)
		.onInitial(() => <Skeleton className="h-[280px] w-full rounded-lg" />)
		.onError((err) => (
			<div className="flex h-[280px] items-center justify-center rounded-lg border border-destructive/40 bg-destructive/5 text-xs text-destructive">
				{formatBackendError(err).description}
			</div>
		))
		.onSuccess((response, holder) => (
			<ChartView
				rows={response.data}
				unit={response.unit}
				showThreshold={metric === "cpu_limit" || metric === "memory_limit"}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
			/>
		))
		.render()
}
