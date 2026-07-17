import { useState } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"

import { Button } from "@maple/ui/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Badge } from "@maple/ui/components/ui/badge"
import { MetricTypeBadge } from "./metric-type-badge"
import { type Metric, type ListMetricsInput } from "@/api/warehouse/metrics"
import { listMetricsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { QueryErrorState } from "@/components/common/query-error-state"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { ServiceDot } from "@maple/ui/components/service-dot"

function formatNumber(num: number): string {
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(1)}M`
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`
	}
	return num.toLocaleString()
}

function formatTimeAgo(timestamp: string): string {
	const date = new Date(normalizeTimestampInput(timestamp))
	const now = new Date()
	const diffMs = now.getTime() - date.getTime()
	const diffSec = Math.floor(diffMs / 1000)
	const diffMin = Math.floor(diffSec / 60)
	const diffHour = Math.floor(diffMin / 60)
	const diffDay = Math.floor(diffHour / 24)

	if (diffSec < 60) return `${diffSec}s ago`
	if (diffMin < 60) return `${diffMin}m ago`
	if (diffHour < 24) return `${diffHour}h ago`
	return `${diffDay}d ago`
}

interface MetricsTableProps {
	search: string
	metricType: ListMetricsInput["metricType"] | null
	onOpenMetric: (metric: Metric) => void
	startTime?: string
	endTime?: string
}

function LoadingState() {
	return (
		<div className="rounded-md border overflow-auto">
			<Table className="table-fixed">
				<TableHeader>
					<TableRow>
						<TableHead className="w-[40%]">Metric Name</TableHead>
						<TableHead className="hidden md:table-cell w-[100px]">Type</TableHead>
						<TableHead className="hidden md:table-cell w-[120px]">Service</TableHead>
						<TableHead className="hidden md:table-cell w-[100px]">Points</TableHead>
						<TableHead className="hidden md:table-cell w-[100px]">Last Seen</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{Array.from({ length: 10 }).map((_, i) => (
						<TableRow key={i}>
							<TableCell>
								<Skeleton className="h-4 w-48" />
							</TableCell>
							<TableCell className="hidden md:table-cell">
								<Skeleton className="h-4 w-16" />
							</TableCell>
							<TableCell className="hidden md:table-cell">
								<Skeleton className="h-4 w-20" />
							</TableCell>
							<TableCell className="hidden md:table-cell">
								<Skeleton className="h-4 w-12" />
							</TableCell>
							<TableCell className="hidden md:table-cell">
								<Skeleton className="h-4 w-16" />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	)
}

const PAGE_SIZE = 100
// Backend rejects limit > 1000 (ListMetricsInputSchema); we request limit + 1
// to detect more pages, so the displayed cap is 999.
const MAX_LIMIT = 1000

export function MetricsTable({ search, metricType, onOpenMetric, startTime, endTime }: MetricsTableProps) {
	const [limit, setLimit] = useState(PAGE_SIZE)
	const requestLimit = Math.min(limit + 1, MAX_LIMIT)

	const metricsResult = useAtomValue(
		listMetricsResultAtom({
			data: {
				search: search || undefined,
				metricType: metricType || undefined,
				limit: requestLimit,
				startTime,
				endTime,
			},
		}),
	)

	// Each Load more swaps to a new atom (the limit is part of the query key),
	// which starts in its initial state. Keep the last successful page so the
	// table stays rendered (dimmed) while the next page loads.
	const [view, setView] = useState<{
		source: { data: Metric[] }
		metrics: Metric[]
		hasMore: boolean
	} | null>(null)
	if (Result.isSuccess(metricsResult) && view?.source !== metricsResult.value) {
		setView({
			source: metricsResult.value,
			metrics: metricsResult.value.data.slice(0, limit),
			hasMore: metricsResult.value.data.length > limit,
		})
	}

	if (Result.isFailure(metricsResult) || view === null) {
		return Result.builder(metricsResult)
			.onError((error) => <QueryErrorState error={error} />)
			.orElse(() => <LoadingState />)
	}

	const { metrics, hasMore } = view
	const waiting = !Result.isSuccess(metricsResult) || metricsResult.waiting

	return metrics.length === 0 ? (
		<Empty>
			<EmptyHeader>
				<EmptyTitle>No metrics found</EmptyTitle>
				<EmptyDescription>
					No metrics matched your filters in the selected time range.
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	) : (
		<div className={`content-enter space-y-4 ${waiting ? "opacity-60" : ""}`}>
			<div className="rounded-md border overflow-auto">
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead className="w-[40%]">Metric Name</TableHead>
							<TableHead className="w-[100px]">Type</TableHead>
							<TableHead className="w-[120px]">Service</TableHead>
							<TableHead className="w-[100px]">Points</TableHead>
							<TableHead className="w-[100px]">Last Seen</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{metrics.map((metric) => {
							return (
								<TableRow
									key={`${metric.metricName}-${metric.metricType}-${metric.serviceName}`}
									className="cursor-pointer hover:bg-muted/50"
									onClick={() => onOpenMetric(metric)}
								>
									<TableCell>
										<div className="flex min-w-0 flex-col gap-0.5">
											<span
												className="truncate font-mono text-xs"
												title={metric.metricName}
											>
												{metric.metricName}
											</span>
											{metric.metricDescription && (
												<span className="text-[10px] text-muted-foreground line-clamp-1">
													{metric.metricDescription}
												</span>
											)}
										</div>
									</TableCell>
									<TableCell className="hidden md:table-cell">
										<MetricTypeBadge type={metric.metricType} />
									</TableCell>
									<TableCell className="hidden md:table-cell">
										{metric.serviceName ? (
											<Badge variant="outline" className="font-mono text-[10px]">
												<ServiceDot serviceName={metric.serviceName} className="size-1.5" />
												{metric.serviceName}
											</Badge>
										) : (
											<span className="text-xs text-muted-foreground">-</span>
										)}
									</TableCell>
									<TableCell className="hidden md:table-cell font-mono text-xs">
										{formatNumber(metric.dataPointCount)}
									</TableCell>
									<TableCell className="hidden md:table-cell text-xs text-muted-foreground">
										{formatTimeAgo(metric.lastSeen)}
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</div>

			<div className="flex items-center gap-3 text-sm text-muted-foreground">
				<span>
					Showing {metrics.length} metrics
					{hasMore ? " — more available" : ""}
				</span>
				{hasMore && (
					<Button
						variant="outline"
						size="sm"
						disabled={waiting}
						onClick={() => setLimit((current) => current + PAGE_SIZE)}
					>
						{waiting ? "Loading…" : "Load more"}
					</Button>
				)}
			</div>
		</div>
	)
}
