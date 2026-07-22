import { useMemo } from "react"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@maple/ui/components/ui/table"
import { QueryBuilderLineChart } from "@maple/ui/components/charts/line/query-builder-line-chart"
import { MetricTypeBadge } from "@maple/ui/components/metrics/metric-type-badge"
import { formatNumber } from "@maple/ui/format"
import {
	useLocalMetricBreakdown,
	useLocalMetricEntry,
	useLocalMetricTimeseries,
} from "../hooks/use-local-metric-detail"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE, formatRelativeTime } from "../lib/time"
import { RefreshButton, TimeRangeSelect } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"

interface MetricDetailViewProps {
	metricName: string
	onBack: () => void
}

export function MetricDetailView({ metricName, onBack }: MetricDetailViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE

	const entryQuery = useLocalMetricEntry(metricName, range)
	const entry = entryQuery.data
	const timeseries = useLocalMetricTimeseries(entry, range)
	const breakdown = useLocalMetricBreakdown(entry, range)

	// Pivot (bucket, groupName, value) rows into the wide shape the shared
	// line chart plots: one column per series (service).
	const chartData = useMemo(() => {
		const rows = timeseries.data ?? []
		const byBucket = new Map<string, Record<string, unknown>>()
		for (const row of rows) {
			let bucketRow = byBucket.get(row.bucket)
			if (!bucketRow) byBucket.set(row.bucket, (bucketRow = { bucket: row.bucket }))
			bucketRow[row.groupName || "value"] = row.value
		}
		return [...byBucket.values()]
	}, [timeseries.data])

	const isRate = entry?.metricType === "sum" && entry.isMonotonic

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					Metrics
				</Button>
				<span className="truncate font-mono text-xs" title={metricName}>
					{metricName}
				</span>
				{entry ? <MetricTypeBadge type={entry.metricType} /> : null}
				{entry?.metricUnit ? (
					<Badge variant="outline" className="px-1 py-0 font-mono text-[10px]">
						{entry.metricUnit}
					</Badge>
				) : null}
				<div className="ml-auto flex items-center gap-2">
					<RefreshButton />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{entryQuery.isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : entryQuery.isError ? (
					<ErrorState
						label="metric"
						error={entryQuery.error}
						onRetry={() => entryQuery.refetch()}
					/>
				) : !entry ? (
					<EmptyState
						title="Metric not found"
						hint="No catalog entry for this metric in the selected time range."
					/>
				) : (
					<div className="space-y-6 p-4">
						{entry.metricDescription ? (
							<p className="text-sm text-muted-foreground">{entry.metricDescription}</p>
						) : null}

						<section className="space-y-2">
							<div className="flex items-baseline justify-between">
								<h3 className="text-sm font-medium">
									{isRate ? "Rate (per second)" : "Average value"} by service
								</h3>
								<span className="text-xs text-muted-foreground">
									{entry.serviceNames.length.toLocaleString()} services ·{" "}
									{formatNumber(entry.dataPointCount)} datapoints · last seen{" "}
									{formatRelativeTime(entry.lastSeen)}
								</span>
							</div>
							{timeseries.isPending ? (
								<div className="flex h-64 items-center justify-center rounded-md border">
									<Spinner />
								</div>
							) : timeseries.isError ? (
								<ErrorState
									label="timeseries"
									error={timeseries.error}
									onRetry={() => timeseries.refetch()}
								/>
							) : chartData.length < 2 ? (
								<div className="flex h-64 items-center justify-center rounded-md border text-sm text-muted-foreground">
									Not enough datapoints to chart this range.
								</div>
							) : (
								<div className="rounded-md border p-3">
									<QueryBuilderLineChart
										data={chartData}
										className="h-64 w-full"
										legend="visible"
										curveType="monotone"
										unit={isRate ? undefined : entry.metricUnit || undefined}
										fitYAxisToData={!isRate}
									/>
								</div>
							)}
						</section>

						<section className="space-y-2">
							<h3 className="text-sm font-medium">Breakdown by service</h3>
							{breakdown.isPending ? (
								<div className="flex h-24 items-center justify-center rounded-md border">
									<Spinner />
								</div>
							) : breakdown.isError ? (
								<ErrorState
									label="breakdown"
									error={breakdown.error}
									onRetry={() => breakdown.refetch()}
								/>
							) : (
								<div className="rounded-md border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Service</TableHead>
												<TableHead className="text-right">Avg</TableHead>
												<TableHead className="text-right">Sum</TableHead>
												<TableHead className="text-right">Datapoints</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{(breakdown.data ?? []).map((row) => (
												<TableRow key={row.name}>
													<TableCell className="font-mono text-xs">
														{row.name || "—"}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatNumber(row.avgValue)}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatNumber(row.sumValue)}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{row.count.toLocaleString()}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							)}
						</section>
					</div>
				)}
			</div>
		</div>
	)
}
