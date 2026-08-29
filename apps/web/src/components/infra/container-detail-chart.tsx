import { Result, useAtomValue } from "@/lib/effect-atom"

import { ChartError, ChartLoading } from "@maple/ui/components/charts"

import { containerInfraTimeseriesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import type { ContainerInfraMetric } from "@/api/warehouse/infra"
import { K8sMetricChartView } from "./k8s-detail-chart"
import { displayError } from "@/lib/error-messages"

const CHART_HEIGHT = 280

export const CONTAINER_METRIC_LABELS: Record<ContainerInfraMetric, string> = {
	cpu: "CPU",
	memory_percent: "Memory / limit",
	memory_bytes: "Memory usage",
	network: "Network I/O",
	disk_io: "Block I/O",
	uptime: "Uptime",
} satisfies Record<ContainerInfraMetric, string>

interface ContainerDetailChartProps {
	containerName: string
	hostName?: string
	metric: ContainerInfraMetric
	startTime: string
	endTime: string
	bucketSeconds?: number
	syncId?: string
}

export function ContainerDetailChart({
	containerName,
	hostName,
	metric,
	startTime,
	endTime,
	bucketSeconds,
	syncId,
}: ContainerDetailChartProps) {
	const result = useAtomValue(
		containerInfraTimeseriesResultAtom({
			data: { containerName, hostName, metric, startTime, endTime, bucketSeconds },
		}),
	)

	return Result.builder(result)
		.onInitial(() => <ChartLoading variant="area" height={CHART_HEIGHT} />)
		.onError((err) => <ChartError height={CHART_HEIGHT}>{displayError(err).message}</ChartError>)
		.onSuccess((response, holder) => (
			<K8sMetricChartView
				rows={response.data}
				unit={response.unit}
				seriesLabel={CONTAINER_METRIC_LABELS[metric]}
				showThreshold={metric === "cpu" || metric === "memory_percent"}
				waiting={Boolean(holder.waiting)}
				syncId={syncId}
				chartId={`container-${metric}`}
			/>
		))
		.render()
}
