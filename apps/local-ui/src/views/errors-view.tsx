import { useState } from "react"
import { CircleWarningIcon, ChevronDownIcon } from "@maple/ui/components/icons"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { formatDuration, formatNumber } from "@maple/ui/format"
import { cn } from "@maple/ui/utils"
import {
	SearchableFilterSection,
	SingleCheckboxFilter,
	serviceColorMap,
} from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import type { CH } from "@maple/query-engine"
import {
	useLocalErrorTraces,
	useLocalErrorsByType,
	useLocalErrorsFacets,
	useLocalErrorsSummary,
	type ErrorsFilters,
} from "../hooks/use-local-errors"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE, formatRelativeTime } from "../lib/time"
import { PageShell } from "../components/page-shell"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarStat } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

interface ErrorsViewProps {
	onSelectTrace: (traceId: string) => void
}

export function ErrorsView({ onSelectTrace }: ErrorsViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const service = query.get("service") || undefined
	const env = query.get("env") || undefined
	const rootOnly = query.get("root") === "1"

	const filters: ErrorsFilters = { service, env, rootOnly, range }
	const summary = useLocalErrorsSummary(filters)
	const byType = useLocalErrorsByType(filters)
	const facets = useLocalErrorsFacets(filters)
	const hasActiveFilters = !!service || !!env || rootOnly

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ service: null, env: null, root: null })}
			/>
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Root spans only"
					checked={rootOnly}
					onChange={(checked) => setParams({ root: checked ? "1" : null })}
				/>
				<SearchableFilterSection
					title="Service"
					options={facets.data?.services ?? []}
					selected={service ? [service] : []}
					onChange={(vals) => setParams({ service: vals.at(-1) ?? null })}
					colorMap={serviceColorMap(facets.data?.services ?? [])}
				/>
				<SearchableFilterSection
					title="Environment"
					options={facets.data?.environments ?? []}
					selected={env ? [env] : []}
					onChange={(vals) => setParams({ env: vals.at(-1) ?? null })}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)

	const stats = summary.data
	const toolbar = (
		<Toolbar
			search={<div />}
			stats={
				<>
					<ToolbarStat value={Math.round(stats?.totalErrors ?? 0)} label="errors" danger />
					<ToolbarStat
						value={Math.round(stats?.affectedTracesCount ?? 0)}
						label="affected traces"
					/>
					<span className="text-sm text-muted-foreground">
						<span className="font-medium tabular-nums text-foreground">
							{((stats?.errorRate ?? 0) * 100).toFixed(2)}%
						</span>{" "}
						error rate
					</span>
					<RefreshButton />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</>
			}
		/>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{byType.isPending ? (
				<ListSkeleton variant="card" rows={6} />
			) : byType.isError ? (
				<ErrorState label="errors" error={byType.error} onRetry={() => byType.refetch()} />
			) : (byType.data ?? []).length === 0 ? (
				<EmptyState
					icon={<CircleWarningIcon />}
					title={hasActiveFilters ? "No matching errors" : "No errors recorded"}
					hint={
						hasActiveFilters
							? "Try widening the time range or clearing filters."
							: "Errors appear when spans arrive with an Error status."
					}
				/>
			) : (
				<div className="space-y-2 p-4">
					{(byType.data ?? []).map((row) => (
						<ErrorTypeCard
							key={row.fingerprintHash}
							row={row}
							filters={filters}
							onSelectTrace={onSelectTrace}
						/>
					))}
				</div>
			)}
		</PageShell>
	)
}

function ErrorTypeCard({
	row,
	filters,
	onSelectTrace,
}: {
	row: CH.ErrorsByTypeOutput
	filters: ErrorsFilters
	onSelectTrace: (traceId: string) => void
}) {
	const [expanded, setExpanded] = useState(false)
	const traces = useLocalErrorTraces(expanded ? row.fingerprintHash : undefined, filters)

	return (
		<div className="rounded-md border bg-card">
			<button
				type="button"
				onClick={() => setExpanded((prev) => !prev)}
				className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
			>
				<CircleWarningIcon className="size-4 shrink-0 text-destructive" />
				<span className="min-w-0 flex-1">
					<span className="flex items-baseline gap-2">
						<span className="truncate text-sm font-medium">{row.errorLabel || "Unknown Error"}</span>
						<span className="shrink-0 text-xs text-muted-foreground">
							{row.affectedServicesCount === 1
								? "1 service"
								: `${row.affectedServicesCount} services`}
						</span>
					</span>
					{row.sampleMessage ? (
						<span className="block truncate font-mono text-xs text-muted-foreground">
							{row.sampleMessage}
						</span>
					) : null}
				</span>
				<span className="shrink-0 text-right">
					<span className="block text-sm font-semibold tabular-nums text-destructive">
						{formatNumber(row.count)}
					</span>
					<span className="block text-[10px] text-muted-foreground">
						last seen {formatRelativeTime(row.lastSeen)}
					</span>
				</span>
				<ChevronDownIcon
					className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")}
				/>
			</button>

			{expanded ? (
				<div className="border-t px-4 py-2">
					{traces.isPending ? (
						<div className="flex h-16 items-center justify-center">
							<Spinner className="size-4" />
						</div>
					) : traces.isError ? (
						<p className="py-2 text-xs text-destructive">
							Couldn’t load traces: {String(traces.error)}
						</p>
					) : (traces.data ?? []).length === 0 ? (
						<p className="py-2 text-xs text-muted-foreground">
							No traces found for this error in the selected range.
						</p>
					) : (
						<ul className="divide-y">
							{(traces.data ?? []).map((trace) => (
								<li key={trace.traceId}>
									<button
										type="button"
										onClick={() => onSelectTrace(trace.traceId)}
										className="flex w-full items-center gap-3 py-2 text-left text-xs transition-colors hover:text-foreground text-muted-foreground"
									>
										<span className="min-w-0 flex-1 truncate font-mono">
											{trace.rootSpanName || trace.traceId}
										</span>
										<span className="shrink-0 tabular-nums">
											{trace.spanCount} spans
										</span>
										<span className="shrink-0 tabular-nums">
											{formatDuration(trace.durationMicros / 1000)}
										</span>
										<span className="shrink-0 tabular-nums">
											{formatRelativeTime(trace.startTime.slice(0, 19))}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	)
}
