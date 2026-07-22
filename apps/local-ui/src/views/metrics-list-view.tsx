import { useMemo } from "react"
import { PulseIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { StatSparkline } from "@maple/ui/components/charts/sparkline/stat-sparkline"
import {
	METRIC_TYPE_COLORS,
	MetricTypeBadge,
} from "@maple/ui/components/metrics/metric-type-badge"
import {
	FilterSection,
	SearchableFilterSection,
	type FilterOption,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import {
	useLocalMetricsList,
	useLocalMetricsSparklines,
	useLocalMetricsSummary,
	type MetricEntry,
	type SparklinePoint,
} from "../hooks/use-local-metrics"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { PageShell } from "../components/page-shell"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarSearch, ToolbarStat } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

interface MetricsListViewProps {
	onSelectMetric: (metricName: string) => void
}

export function MetricsListView({ onSelectMetric }: MetricsListViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const service = query.get("service") || undefined
	const type = query.get("type") || undefined
	const search = query.get("q") || undefined

	const list = useLocalMetricsList({ service, type, search, range })
	const summary = useLocalMetricsSummary({ service, range })
	const entries = list.data?.entries ?? []
	const sparklines = useLocalMetricsSparklines(entries, range)

	const totalDataPoints = (summary.data ?? []).reduce((sum, row) => sum + row.dataPointCount, 0)
	const typeFacets: FilterOption[] = (summary.data ?? [])
		.map((row) => ({ name: row.metricType, count: row.metricCount }))
		.sort((a, b) => b.count - a.count)

	const hasActiveFilters = !!service || !!type

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={list.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ service: null, type: null })}
			/>
			<FilterSidebarBody>
				<FilterSection
					title="Type"
					options={typeFacets}
					selected={type ? [type] : []}
					onChange={(vals) => setParams({ type: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Service"
					options={list.data?.serviceFacets ?? []}
					selected={service ? [service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const toolbar = (
		<Toolbar
			search={
				<ToolbarSearch
					query={search ?? ""}
					onSearch={(value) => setParams({ q: value ?? null })}
					placeholder="Filter by metric name…"
				/>
			}
			stats={
				<>
					<ToolbarStat value={entries.length} label="metrics" />
					<ToolbarStat value={totalDataPoints} label="datapoints" />
					<RefreshButton />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</>
			}
		/>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{list.isPending ? (
				<ListSkeleton variant="card" rows={6} />
			) : list.isError ? (
				<ErrorState label="metrics" error={list.error} onRetry={() => list.refetch()} />
			) : entries.length === 0 ? (
				<EmptyState
					icon={<PulseIcon />}
					title={hasActiveFilters || search ? "No matching metrics" : "No metrics received yet"}
					hint={
						hasActiveFilters || search ? (
							"Try widening the time range or clearing filters."
						) : (
							<>
								Point an OTLP exporter at{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
									/v1/metrics
								</code>{" "}
								to start collecting metrics.
							</>
						)
					}
				/>
			) : (
				<div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
					{entries.map((entry) => (
						<MetricPreviewCard
							key={`${entry.metricName} ${entry.metricType}`}
							entry={entry}
							points={sparklines.data?.get(entry.metricName)}
							loading={sparklines.isPending}
							onOpen={() => onSelectMetric(entry.metricName)}
						/>
					))}
				</div>
			)}
		</PageShell>
	)
}

/**
 * Cheap type-aware preview — mirrors the web app's browse cards: gauges and
 * histograms plot the average value; counters plot datapoints per interval
 * (true rate needs the window-function CTE, which must not run one-per-card;
 * the detail page shows real rate).
 */
function MetricPreviewCard({
	entry,
	points,
	loading,
	onOpen,
}: {
	entry: MetricEntry
	points: ReadonlyArray<SparklinePoint> | undefined
	loading: boolean
	onOpen: () => void
}) {
	const rows = useMemo(
		() =>
			(points ?? []).map((point) => ({
				bucket: point.bucket,
				v: entry.metricType === "sum" ? point.dataPointCount : point.avgValue,
			})),
		[entry.metricType, points],
	)

	return (
		<button
			type="button"
			onClick={onOpen}
			className="group flex flex-col gap-2 rounded-md border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
		>
			<div className="flex w-full items-start justify-between gap-2">
				<span className="min-w-0 truncate font-mono text-xs font-medium" title={entry.metricName}>
					{entry.metricName}
				</span>
				<MetricTypeBadge type={entry.metricType} />
			</div>

			<div className="h-12 w-full">
				{rows.length >= 2 ? (
					<StatSparkline
						data={rows}
						color={METRIC_TYPE_COLORS[entry.metricType] ?? "var(--chart-1)"}
						className="h-full w-full"
					/>
				) : (
					<div className="flex h-full items-center text-[10px] text-muted-foreground">
						{loading ? "Loading…" : "Not enough datapoints for a preview"}
					</div>
				)}
			</div>

			<div className="flex w-full items-center justify-between gap-2 text-[10px] text-muted-foreground">
				<span className="truncate">
					{entry.serviceNames.length === 1
						? entry.serviceNames[0]
						: `${entry.serviceNames.length} services`}
				</span>
				<span className="flex shrink-0 items-center gap-1.5">
					{entry.metricUnit && (
						<Badge variant="outline" className="px-1 py-0 font-mono text-[9px]">
							{entry.metricUnit}
						</Badge>
					)}
					{entry.metricType === "sum" ? "datapoints/interval" : "avg"}
				</span>
			</div>
		</button>
	)
}
