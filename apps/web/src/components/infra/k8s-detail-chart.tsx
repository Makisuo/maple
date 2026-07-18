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
} from "@/lib/services/atoms/warehouse-query-atoms"
import type {
	PodInfraMetric,
	NodeInfraMetric,
	WorkloadInfraMetric,
	WorkloadKind,
} from "@/api/warehouse/infra"
import {
	CHART_EMPTY_MESSAGE,
	CHART_GRID_DASH,
	COLOR_PALETTE,
	formatSeconds,
	formatValueWithUnit,
	transformRows,
	UNNAMED_SERIES_KEY,
} from "./chart-utils"
import { InfraTooltipItem } from "./chart-tooltip"
import { formatBackendError } from "@/lib/error-messages"
import { LinkedCursorOverlay, linkedCursorChartProps } from "@/hooks/use-linked-cursor"

const CHART_HEIGHT = 280

type Unit = "percent" | "cores" | "seconds"

// Human label for each metric, used as the tooltip/legend "type" for the single
// unnamed series (gauges with no group-by attribute, e.g. a pod's CPU usage).
const POD_METRIC_LABELS: Record<PodInfraMetric, string> = {
	cpu_usage: "CPU usage",
	cpu_limit: "CPU / limit",
	cpu_request: "CPU / request",
	memory_limit: "Memory / limit",
	memory_request: "Memory / request",
}

const NODE_METRIC_LABELS: Record<NodeInfraMetric, string> = {
	cpu_usage: "CPU usage",
	uptime: "Uptime",
}

const WORKLOAD_METRIC_LABELS: Record<WorkloadInfraMetric, string> = {
	cpu_usage: "CPU usage",
	cpu_limit: "CPU / limit",
	memory_limit: "Memory / limit",
}

interface K8sMetricChartViewProps {
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	unit: Unit
	// Label for the unnamed default series so the tooltip shows the metric type
	// instead of a bare "value".
	seriesLabel?: string
	isStacked?: boolean
	showThreshold?: boolean
	waiting: boolean
	/**
	 * Groups this chart with its siblings for the linked hover cursor (see
	 * `useLinkedCursor`; the container rendering the group must spread
	 * `containerProps`). Only sent to Recharts when `syncMode="recharts"`.
	 */
	syncId?: string
	/**
	 * `cursor` (default) drives the shared linked cursor; `recharts` hands the
	 * syncId to Recharts' event bus instead (render storms on hover — kept only
	 * for the perf bench baseline).
	 */
	syncMode?: "recharts" | "cursor"
	/** Distinguishes sibling charts in the linked-cursor DOM markers. */
	chartId?: string
}

// Exported for the /infra-bench synthetic perf harness.
export function K8sMetricChartView({
	rows,
	unit,
	seriesLabel,
	isStacked,
	showThreshold,
	waiting,
	syncId,
	syncMode = "cursor",
	chartId,
}: K8sMetricChartViewProps) {
	const gradientPrefix = useId().replace(/:/g, "")
	const { data, series } = useMemo(() => transformRows(rows), [rows])

	// Series names can contain dots/slashes (container names, pod names),
	// which are invalid in a raw `var(--color-…)` reference — colour series
	// directly instead of via the ChartContainer CSS variables.
	const seriesColor = useMemo(
		() => new Map(series.map((name, idx) => [name, COLOR_PALETTE[idx % COLOR_PALETTE.length] ?? ""])),
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
			<div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
				{CHART_EMPTY_MESSAGE}
			</div>
		)
	}

	const tickFormatter = (v: number) => {
		if (unit === "percent") return `${Math.round(v * 100)}%`
		if (unit === "seconds") return formatSeconds(v)
		return v.toLocaleString(undefined, { maximumFractionDigits: 3 })
	}

	const margin = { top: 12, right: 12, left: 0, bottom: 0 }
	const linkedCursor = syncMode === "cursor" && syncId != null
	const linkedChartId = chartId ?? seriesLabel ?? "k8s-metric"
	const rechartsSyncId = syncMode === "recharts" ? syncId : undefined

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
								style={{ background: seriesColor.get(s) }}
							/>
							<span className="font-medium text-foreground/80">{config[s]?.label ?? s}</span>
							{value !== undefined && (
								<span className="font-mono tabular-nums text-muted-foreground">
									{formatValueWithUnit(value, unit)}
								</span>
							)}
						</div>
					)
				})}
			</div>
			<div className="relative" {...linkedCursorChartProps(linkedCursor ? linkedChartId : undefined)}>
				<ChartContainer config={config} className="w-full" style={{ height: CHART_HEIGHT }}>
					{isStacked ? (
						<AreaChart data={data} margin={margin} syncId={rechartsSyncId} syncMethod="value">
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
												stopOpacity={0.05}
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
										strokeWidth={1.6}
										fill={`url(#${id})`}
										fillOpacity={1}
									/>
								)
							})}
						</AreaChart>
					) : (
						<LineChart data={data} margin={margin} syncId={rechartsSyncId} syncMethod="value">
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
								width={70}
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
									strokeWidth={1.8}
									dot={false}
									activeDot={{ r: 3, strokeWidth: 0 }}
								/>
							))}
						</LineChart>
					)}
				</ChartContainer>
				{linkedCursor && <LinkedCursorOverlay chartId={linkedChartId} />}
			</div>
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
			<K8sMetricChartView
				rows={response.data}
				unit={response.unit}
				seriesLabel={POD_METRIC_LABELS[metric]}
				showThreshold={metric.startsWith("cpu_") || metric.startsWith("memory_")}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
				chartId={`pod-${metric}`}
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
			<K8sMetricChartView
				rows={response.data}
				unit={response.unit}
				seriesLabel={NODE_METRIC_LABELS[metric]}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
				chartId={`node-${metric}`}
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
			<K8sMetricChartView
				rows={response.data}
				unit={response.unit}
				seriesLabel={WORKLOAD_METRIC_LABELS[metric]}
				showThreshold={metric === "cpu_limit" || metric === "memory_limit"}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
				chartId={`workload-${metric}`}
			/>
		))
		.render()
}
