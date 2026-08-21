import { Result, useAtomValue } from "@/lib/effect-atom"

import { ChartError, ChartLoading, ChartPlotArea } from "@maple/ui/components/charts"

import { hostInfraTimeseriesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { HostInfraMetric } from "@/api/warehouse/infra"
import { formatValueWithUnit } from "./chart-utils"
import {
	InfraMetricChart,
	INFRA_METRIC_CHART_HEIGHT,
	type InfraSeriesInfo,
} from "./primitives/infra-metric-chart"
import { displayError } from "@/lib/error-messages"

interface HostDetailChartProps {
	hostName: string
	metric: HostInfraMetric
	startTime: string
	endTime: string
	bucketSeconds?: number
	/**
	 * Groups this chart with its siblings for the linked hover cursor. The id is
	 * not sent to Recharts (see `useLinkedCursor`) unless `syncMode="recharts"`;
	 * the container rendering the group must spread `useLinkedCursor(...)`'s
	 * `containerProps`.
	 */
	syncId?: string
}

// Human label for each host metric, shown as the tooltip/legend "type" for the
// single unnamed series.
const HOST_METRIC_LABELS: Record<HostInfraMetric, string> = {
	cpu: "CPU",
	memory: "Memory",
	filesystem: "Disk",
	network: "Network",
	load15: "Load (15m)",
} satisfies Record<HostInfraMetric, string>

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

	return (
		<ChartPlotArea height={INFRA_METRIC_CHART_HEIGHT}>
			{Result.builder(result)
				.onInitial(() => <ChartLoading variant="area" />)
				.onError((err) => <ChartError>{displayError(err).message}</ChartError>)
				.onSuccess((response, holder) => (
					<HostMetricChartView
						rows={response.data}
						unit={response.unit}
						metric={metric}
						seriesLabel={HOST_METRIC_LABELS[metric]}
						waiting={Boolean(holder.waiting)}
						syncId={syncId}
					/>
				))
				.render()}
		</ChartPlotArea>
	)
}

interface HostMetricChartViewProps {
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	unit: "percent" | "load" | "bytes_per_second"
	metric: HostInfraMetric
	// Label for the unnamed default series so the tooltip shows the metric type
	// instead of a bare "value".
	seriesLabel?: string
	waiting: boolean
	/**
	 * Groups this chart with its siblings for the linked hover cursor. The
	 * container rendering the group must spread `useLinkedCursor(...)`'s
	 * `containerProps`.
	 */
	syncId?: string
}

/**
 * The host page's right-aligned last-value strip.
 *
 * The Kubernetes page draws bordered chips instead, which is why the summary is
 * the caller's rather than the shared chart's.
 */
function HostSeriesSummary({ series, colors, lastValues, labelFor, unit }: InfraSeriesInfo) {
	return (
		<div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-3 py-2">
			{series.map((name) => {
				const value = lastValues[name]
				return (
					<div key={name} className="inline-flex items-baseline gap-1.5">
						<span
							aria-hidden
							className="size-1.5 translate-y-[-1px] rounded-full"
							style={{ background: colors.get(name) }}
						/>
						<span className="text-[11px] text-muted-foreground">{labelFor(name)}</span>
						{value !== undefined && (
							<span className="font-mono text-[11px] text-foreground/85 tabular-nums">
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
export function HostMetricChartView({
	rows,
	unit,
	metric,
	seriesLabel,
	waiting,
	syncId,
}: HostMetricChartViewProps) {
	// CPU and memory are a whole split into parts, so they stack and carry the
	// 80% warning rule; the rest are independent lines.
	const stacked = metric === "cpu" || metric === "memory"

	return (
		<InfraMetricChart
			rows={rows}
			unit={unit}
			seriesLabel={seriesLabel}
			stacked={stacked}
			showThreshold={stacked}
			waiting={waiting}
			linkedChartId={syncId != null ? `host-${metric}` : undefined}
			header={HostSeriesSummary}
		/>
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
