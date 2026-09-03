import { Result, useAtomValue } from "@/lib/effect-atom"

import { ChartError, ChartLoading } from "@maple/ui/components/charts"

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
import { formatValueWithUnit } from "./chart-utils"
import { InfraMetricChart, type InfraSeriesInfo } from "./primitives/infra-metric-chart"
import { displayError } from "@/lib/error-messages"

/**
 * k8s detail charts plot taller than the shared infra default: a pod/node page
 * shows one metric at a time, so it can afford the height. Declared once and
 * passed to every branch — the plot and its loading/error stand-ins.
 */
const CHART_HEIGHT = 280

type Unit = "percent" | "cores" | "seconds" | "bytes"

// Human label for each metric, used as the tooltip/legend "type" for the single
// unnamed series (gauges with no group-by attribute, e.g. a pod's CPU usage).
const POD_METRIC_LABELS: Record<PodInfraMetric, string> = {
	cpu_usage: "CPU usage",
	cpu_limit: "CPU / limit",
	cpu_request: "CPU / request",
	memory_limit: "Memory / limit",
	memory_request: "Memory / request",
} satisfies Record<PodInfraMetric, string>

const NODE_METRIC_LABELS: Record<NodeInfraMetric, string> = {
	cpu_usage: "CPU usage",
	uptime: "Uptime",
} satisfies Record<NodeInfraMetric, string>

const WORKLOAD_METRIC_LABELS: Record<WorkloadInfraMetric, string> = {
	cpu_usage: "CPU usage",
	cpu_limit: "CPU / limit",
	memory_limit: "Memory / limit",
} satisfies Record<WorkloadInfraMetric, string>

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
	 * `containerProps`).
	 */
	syncId?: string
	/** Distinguishes sibling charts in the linked-cursor DOM markers. */
	chartId?: string
	/** Plot height. The detail pages take the tall default; the peek sheet stacks five and goes shorter. */
	height?: number
}

/**
 * The Kubernetes page's chip-style last-value summary.
 *
 * The host page draws a plain right-aligned strip instead, which is why the
 * summary belongs to the caller rather than to `InfraMetricChart`.
 */
function K8sSeriesSummary({ series, colors, lastValues, labelFor, unit }: InfraSeriesInfo) {
	return (
		<div className="mb-3 flex flex-wrap items-center gap-2">
			{series.map((name) => {
				const value = lastValues[name]
				return (
					<div
						key={name}
						className="inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-[11px]"
					>
						<span className="size-2 rounded-full" style={{ background: colors.get(name) }} />
						<span className="font-medium text-foreground/80">{labelFor(name)}</span>
						{value !== undefined && (
							<span className="font-mono text-muted-foreground tabular-nums">
								{formatValueWithUnit(value, unit)}
							</span>
						)}
					</div>
				)
			})}
		</div>
	)
}

// Exported for the /lab/bench/infra synthetic perf harness.
export function K8sMetricChartView({
	rows,
	unit,
	seriesLabel,
	isStacked,
	showThreshold,
	waiting,
	syncId,
	chartId,
	height = CHART_HEIGHT,
}: K8sMetricChartViewProps) {
	return (
		<div className="rounded-lg border bg-card p-4">
			<InfraMetricChart
				rows={rows}
				unit={unit}
				seriesLabel={seriesLabel}
				stacked={isStacked}
				showThreshold={showThreshold}
				waiting={waiting}
				height={height}
				linkedChartId={syncId != null ? (chartId ?? seriesLabel ?? "k8s-metric") : undefined}
				header={K8sSeriesSummary}
			/>
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
	height?: number
}

export function PodDetailChart({
	podName,
	namespace,
	metric,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
	height = CHART_HEIGHT,
}: PodDetailChartProps) {
	const result = useAtomValue(
		podInfraTimeseriesResultAtom({
			data: { podName, namespace, metric, startTime, endTime, bucketSeconds },
		}),
	)

	return Result.builder(result)
		.onInitial(() => <ChartLoading variant="area" height={height} />)
		.onError((err) => <ChartError height={height}>{displayError(err).message}</ChartError>)
		.onSuccess((response, holder) => (
			<K8sMetricChartView
				rows={response.data}
				unit={response.unit}
				seriesLabel={POD_METRIC_LABELS[metric]}
				showThreshold={metric.startsWith("cpu_") || metric.startsWith("memory_")}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
				chartId={`pod-${metric}`}
				height={height}
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
		.onInitial(() => <ChartLoading variant="area" height={CHART_HEIGHT} />)
		.onError((err) => <ChartError height={CHART_HEIGHT}>{displayError(err).message}</ChartError>)
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
		.onInitial(() => <ChartLoading variant="area" height={CHART_HEIGHT} />)
		.onError((err) => <ChartError height={CHART_HEIGHT}>{displayError(err).message}</ChartError>)
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
