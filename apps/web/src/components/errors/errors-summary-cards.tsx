import { Result, useAtomRefresh } from "@/lib/effect-atom"
import { CircleWarningIcon, CirclePercentageIcon, ServerIcon, PulseIcon } from "@/components/icons"
import { ErrorState } from "@/components/common/error-state"

import { Card, CardContent, CardHeader, CardTitle } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type GetErrorsSummaryInput } from "@/api/warehouse/errors"
import { getErrorsSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"

function formatNumber(num: number): string {
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(1)}M`
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`
	}
	return num.toLocaleString()
}

function formatPercentage(rate: number): string {
	const pct = rate * 100
	if (pct < 0.01) {
		return "0%"
	}
	if (pct < 1) {
		return `${pct.toFixed(2)}%`
	}
	return `${pct.toFixed(1)}%`
}

interface ErrorsSummaryCardsProps {
	filters: GetErrorsSummaryInput
}

export function ErrorsSummaryCards({ filters }: ErrorsSummaryCardsProps) {
	const summaryAtom = getErrorsSummaryResultAtom({ data: filters })
	const summaryResult = useRefreshableAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

	return Result.builder(summaryResult)
		.onInitial(() => (
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
				{Array.from({ length: 4 }).map((_, index) => (
					<Card key={index}>
						<CardHeader className="flex flex-row items-center justify-between gap-y-0 pb-2">
							<Skeleton className="h-4 w-24" />
							<Skeleton className="size-4" />
						</CardHeader>
						<CardContent>
							<Skeleton className="h-8 w-20" />
							<Skeleton className="h-3 w-32 mt-2" />
						</CardContent>
					</Card>
				))}
			</div>
		))
		.onError((error) => (
			<ErrorState
				error={error}
				title="Couldn't load error metrics"
				onRetry={refreshSummary}
				variant="row"
			/>
		))
		.onSuccess((response, result) => {
			const summary = response.data
			const cardConfig = [
				{
					title: "Total Errors",
					value: summary?.totalErrors ?? 0,
					format: formatNumber,
					icon: CircleWarningIcon,
					description: "Error spans in time range",
				},
				{
					title: "Error Rate",
					value: summary?.errorRate ?? 0,
					format: formatPercentage,
					icon: CirclePercentageIcon,
					description: "Errors / total spans",
				},
				{
					title: "Affected Services",
					value: summary?.affectedServicesCount ?? 0,
					format: formatNumber,
					icon: ServerIcon,
					description: "Services with errors",
				},
				{
					title: "Affected Traces",
					value: summary?.affectedTracesCount ?? 0,
					format: formatNumber,
					icon: PulseIcon,
					description: "Traces containing errors",
				},
			]

			return (
				<div
					className={`grid gap-4 md:grid-cols-2 lg:grid-cols-4 content-enter ${result.waiting ? "opacity-60" : ""}`}
				>
					{cardConfig.map((card) => (
						<Card key={card.title}>
							<CardHeader className="flex flex-row items-center justify-between gap-y-0 pb-2">
								<CardTitle className="text-sm font-medium">{card.title}</CardTitle>
								<card.icon size={16} className="text-muted-foreground" />
							</CardHeader>
							<CardContent>
								<div className="text-2xl font-bold">{card.format(card.value)}</div>
								<p className="text-xs text-muted-foreground">{card.description}</p>
							</CardContent>
						</Card>
					))}
				</div>
			)
		})
		.render()
}
