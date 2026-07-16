import { Result, useAtomValue, useAtomRefresh } from "@/lib/effect-atom"
import { PlusIcon, ChartLineIcon, ChartBarIcon, ChartBarTrendUpIcon } from "@/components/icons"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { ErrorState } from "@/components/common/error-state"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type ListMetricsInput } from "@/api/warehouse/metrics"
import { getMetricsSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

export type MetricType = ListMetricsInput["metricType"]

function formatNumber(num: number): string {
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(1)}M`
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`
	}
	return num.toLocaleString()
}

const cardConfig = [
	{
		title: "Sum Metrics",
		key: "sum" as const,
		icon: PlusIcon,
	},
	{
		title: "Gauge Metrics",
		key: "gauge" as const,
		icon: ChartLineIcon,
	},
	{
		title: "Histogram",
		key: "histogram" as const,
		icon: ChartBarIcon,
	},
	{
		title: "Exp Histogram",
		key: "exponential_histogram" as const,
		icon: ChartBarTrendUpIcon,
	},
]

interface MetricsSummaryCardsProps {
	selectedType: MetricType | null
	onSelectType: (type: MetricType | null) => void
	startTime?: string
	endTime?: string
}

export function MetricsSummaryCards({
	selectedType,
	onSelectType,
	startTime,
	endTime,
}: MetricsSummaryCardsProps) {
	const summaryAtom = getMetricsSummaryResultAtom({ data: { startTime, endTime } })
	const summaryResult = useAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

	return Result.builder(summaryResult)
		.onInitial(() => (
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
				{cardConfig.map((card) => (
					<Card key={card.title}>
						<CardHeader className="flex flex-row items-center justify-between gap-y-0 pb-2">
							<Skeleton className="h-4 w-24" />
							<Skeleton className="size-4" />
						</CardHeader>
						<CardContent>
							<Skeleton className="h-8 w-20" />
						</CardContent>
					</Card>
				))}
			</div>
		))
		.onError((error) => (
			<ErrorState
				variant="inline"
				error={error}
				title="Failed to load metrics summary"
				onRetry={refreshSummary}
			/>
		))
		.onSuccess((response, result) => {
			const summaryByType = response.data.reduce(
				(acc, item) => {
					acc[item.metricType] = {
						metricCount: item.metricCount,
						dataPointCount: item.dataPointCount,
					}
					return acc
				},
				{} as Record<string, { metricCount: number; dataPointCount: number }>,
			)

			return (
				<div
					className={`content-enter grid gap-4 md:grid-cols-2 lg:grid-cols-4 ${result.waiting ? "opacity-60" : ""}`}
				>
					{cardConfig.map((card) => {
						const data = summaryByType[card.key]
						const isSelected = selectedType === card.key

						return (
							<Card
								key={card.title}
								className={`cursor-pointer transition-colors ${
									isSelected ? "ring-2 ring-primary" : "hover:bg-muted/50"
								}`}
								onClick={() => onSelectType(isSelected ? null : card.key)}
							>
								<CardHeader className="flex flex-row items-center justify-between gap-y-0 pb-2">
									<CardTitle className="text-sm font-medium">{card.title}</CardTitle>
									<card.icon size={16} className="text-muted-foreground" />
								</CardHeader>
								<CardContent>
									<div className="text-2xl font-bold">
										{formatNumber(data?.dataPointCount ?? 0)}
									</div>
									<p className="text-xs text-muted-foreground">
										{data?.metricCount ?? 0} unique metrics
									</p>
								</CardContent>
							</Card>
						)
					})}
				</div>
			)
		})
		.render()
}
