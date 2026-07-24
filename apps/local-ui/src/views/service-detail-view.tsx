import { useMemo } from "react"
import { ArrowLeftIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ServiceDot } from "@maple/ui/components/service-dot"
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
import { formatDuration, formatNumber } from "@maple/ui/format"
import { cn } from "@maple/ui/utils"
import {
	useLocalServiceOperations,
	useLocalServiceOperationsTimeseries,
	useLocalServiceOverview,
} from "../hooks/use-local-service-detail"
import { navigate, useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { RefreshButton, TimeRangeSelect } from "../components/toolbar"
import { EmptyState, ErrorState } from "../components/view-states"

const CHART_SERIES_LIMIT = 8

interface ServiceDetailViewProps {
	serviceName: string
	onBack: () => void
}

export function ServiceDetailView({ serviceName, onBack }: ServiceDetailViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE

	const overview = useLocalServiceOverview(serviceName, range)
	const operations = useLocalServiceOperations(serviceName, range)
	const topSpanNames = useMemo(
		() => (operations.data ?? []).slice(0, CHART_SERIES_LIMIT).map((op) => op.spanName),
		[operations.data],
	)
	const timeseries = useLocalServiceOperationsTimeseries(serviceName, topSpanNames, range)

	const chartData = useMemo(() => {
		const byBucket = new Map<string, Record<string, unknown>>()
		for (const row of timeseries.data ?? []) {
			let bucketRow = byBucket.get(row.bucket)
			if (!bucketRow) byBucket.set(row.bucket, (bucketRow = { bucket: row.bucket }))
			bucketRow[row.spanName] = row.count
		}
		return [...byBucket.values()]
	}, [timeseries.data])

	const openTraces = (spanName?: string) => {
		const params = new URLSearchParams()
		params.set("service", serviceName)
		if (range !== DEFAULT_RANGE) params.set("range", range)
		if (spanName) params.set("span", spanName)
		navigate("/traces", params)
	}

	const stats = overview.data

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
					<ArrowLeftIcon size={14} />
					Services
				</Button>
				<span className="flex min-w-0 items-center gap-2">
					<ServiceDot serviceName={serviceName} />
					<span className="truncate text-sm font-medium">{serviceName}</span>
				</span>
				{stats?.environments.map((environment) => (
					<Badge key={environment} variant="outline" className="px-1.5 py-0 text-[10px]">
						{environment}
					</Badge>
				))}
				<div className="ml-auto flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => openTraces()}>
						View traces
					</Button>
					<RefreshButton />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{overview.isPending ? (
					<div className="flex h-full items-center justify-center">
						<Spinner />
					</div>
				) : overview.isError ? (
					<ErrorState
						label="service"
						error={overview.error}
						onRetry={() => overview.refetch()}
					/>
				) : !stats ? (
					<EmptyState
						title="No spans in this range"
						hint="Widen the time range, or send some traffic to this service."
					/>
				) : (
					<div className="space-y-6 p-4">
						<section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
							<StatCard label="Spans" value={formatNumber(stats.spanCount)} />
							<StatCard
								label="Errors"
								value={formatNumber(stats.errorCount)}
								danger={stats.errorCount > 0}
							/>
							<StatCard
								label="Error rate"
								value={`${(stats.errorRate * 100).toFixed(1)}%`}
								danger={stats.errorRate > 0.05}
							/>
							<StatCard label="p50" value={formatDuration(stats.p50LatencyMs)} />
							<StatCard label="p95" value={formatDuration(stats.p95LatencyMs)} />
							<StatCard label="p99" value={formatDuration(stats.p99LatencyMs)} />
						</section>

						<section className="space-y-2">
							<h3 className="text-sm font-medium">Throughput by operation</h3>
							{timeseries.isPending && topSpanNames.length > 0 ? (
								<div className="flex h-56 items-center justify-center rounded-md border">
									<Spinner />
								</div>
							) : chartData.length < 2 ? (
								<div className="flex h-56 items-center justify-center rounded-md border text-sm text-muted-foreground">
									Not enough datapoints to chart this range.
								</div>
							) : (
								<div className="rounded-md border p-3">
									<QueryBuilderLineChart
										data={chartData}
										className="h-56 w-full"
										legend="visible"
										curveType="monotone"
									/>
								</div>
							)}
						</section>

						<section className="space-y-2">
							<h3 className="text-sm font-medium">Top operations</h3>
							{operations.isPending ? (
								<div className="flex h-24 items-center justify-center rounded-md border">
									<Spinner />
								</div>
							) : operations.isError ? (
								<ErrorState
									label="operations"
									error={operations.error}
									onRetry={() => operations.refetch()}
								/>
							) : (operations.data ?? []).length === 0 ? (
								<div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
									No operations recorded in this range.
								</div>
							) : (
								<div className="rounded-md border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Operation</TableHead>
												<TableHead className="text-right">Spans</TableHead>
												<TableHead className="text-right">Errors</TableHead>
												<TableHead className="text-right">Error rate</TableHead>
												<TableHead className="text-right">Avg</TableHead>
												<TableHead className="text-right">p50</TableHead>
												<TableHead className="text-right">p95</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{(operations.data ?? []).map((op) => (
												<TableRow
													key={op.spanName}
													onClick={() => openTraces(op.spanName)}
													className="cursor-pointer"
												>
													<TableCell className="max-w-96 truncate font-mono text-xs">
														{op.spanName}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatNumber(op.estimatedSpanCount || op.spanCount)}
													</TableCell>
													<TableCell
														className={cn(
															"text-right tabular-nums",
															op.errorCount > 0 && "text-destructive",
														)}
													>
														{formatNumber(op.estimatedErrorCount || op.errorCount)}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{(op.errorRate * 100).toFixed(1)}%
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatDuration(op.avgDurationMs)}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatDuration(op.p50DurationMs)}
													</TableCell>
													<TableCell className="text-right tabular-nums">
														{formatDuration(op.p95DurationMs)}
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

function StatCard({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
	return (
		<div className="rounded-md border bg-card px-3 py-2">
			<div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
			<div className={cn("text-lg font-semibold tabular-nums", danger && "text-destructive")}>
				{value}
			</div>
		</div>
	)
}
