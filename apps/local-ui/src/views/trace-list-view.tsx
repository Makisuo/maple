import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { NetworkNodesIcon } from "@maple/ui/components/icons"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { Separator } from "@maple/ui/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { formatDuration } from "@maple/ui/format"
import { cn } from "@maple/ui/utils"
import { useLocalTraces, type TraceFilters } from "../hooks/use-local-traces"
import { useLocalTraceFacets } from "../hooks/use-local-trace-facets"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { DurationRangeFilter } from "@maple/ui/components/filters/duration-range-filter"
import { FilterSection, SearchableFilterSection, SingleCheckboxFilter } from "@maple/ui/components/filters/filter-section"
import { FilterSidebarBody, FilterSidebarFrame, FilterSidebarHeader } from "@maple/ui/components/filters/filter-sidebar"
import { PageShell } from "../components/page-shell"
import { parseAttributes } from "@maple/ui/lib/span-tree"
import { Toolbar, ToolbarSearch, ToolbarStat, TimeRangeSelect, RefreshButton } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

interface TraceListViewProps {
	onSelectTrace: (traceId: string) => void
}

/** Parse a URL param as a non-negative integer; anything else means "unset". */
function parseNonNegativeInt(raw: string | null): number | undefined {
	if (!raw) return undefined
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined
}

export function TraceListView({ onSelectTrace }: TraceListViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const search = query.get("q") || undefined

	const filters: TraceFilters = {
		range,
		search,
		service: query.get("service") || undefined,
		span: query.get("span") || undefined,
		errorsOnly: query.get("errors") === "1",
		method: query.get("method") || undefined,
		status: query.get("status") || undefined,
		env: query.get("env") || undefined,
		ns: query.get("ns") || undefined,
		minDurationMs: parseNonNegativeInt(query.get("minDur")),
		maxDurationMs: parseNonNegativeInt(query.get("maxDur")),
	}

	const facets = useLocalTraceFacets(filters)
	const { data, isPending, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useLocalTraces(filters)
	const rows = data?.pages.flat() ?? []

	const hasActiveFilters =
		!!filters.service ||
		!!filters.span ||
		!!filters.method ||
		!!filters.status ||
		!!filters.env ||
		!!filters.ns ||
		filters.minDurationMs != null ||
		filters.maxDurationMs != null ||
		filters.errorsOnly === true

	// Single-select facet adapter: the list query takes one value per dimension.
	const facetSelect = (key: string) => (vals: string[]) => setParams({ [key]: vals.at(-1) ?? null })

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={facets.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() =>
					setParams({
						service: null,
						span: null,
						errors: null,
						method: null,
						status: null,
						env: null,
						ns: null,
						minDur: null,
						maxDur: null,
					})
				}
			/>
			<FilterSidebarBody>
				<SingleCheckboxFilter
					title="Errors only"
					checked={filters.errorsOnly === true}
					onChange={(checked) => setParams({ errors: checked ? "1" : null })}
					count={facets.data?.errorCount}
				/>
				<Separator className="my-2" />
				<FilterSection
					title="Environment"
					options={facets.data?.deploymentEnvs ?? []}
					selected={filters.env ? [filters.env] : []}
					onChange={facetSelect("env")}
				/>
				<SearchableFilterSection
					title="Namespace"
					options={facets.data?.namespaces ?? []}
					selected={filters.ns ? [filters.ns] : []}
					onChange={facetSelect("ns")}
				/>
				<SearchableFilterSection
					title="Service"
					options={facets.data?.services ?? []}
					selected={filters.service ? [filters.service] : []}
					onChange={facetSelect("service")}
				/>
				<SearchableFilterSection
					title="Root Span"
					options={facets.data?.spanNames ?? []}
					selected={filters.span ? [filters.span] : []}
					onChange={facetSelect("span")}
				/>
				<DurationRangeFilter
					minValue={filters.minDurationMs}
					maxValue={filters.maxDurationMs}
					onRangeChange={(min, max) =>
						setParams({
							minDur: min != null ? String(Math.round(min)) : null,
							maxDur: max != null ? String(Math.round(max)) : null,
						})
					}
					durationStats={facets.data?.durationStats}
					debounceMs={300}
				/>
				<FilterSection
					title="HTTP Method"
					options={facets.data?.httpMethods ?? []}
					selected={filters.method ? [filters.method] : []}
					onChange={facetSelect("method")}
				/>
				<FilterSection
					title="Status Code"
					options={facets.data?.httpStatusCodes ?? []}
					selected={filters.status ? [filters.status] : []}
					onChange={facetSelect("status")}
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
					placeholder="Filter by span name…"
				/>
			}
			stats={
				<>
					<ToolbarStat value={rows.length} label={hasNextPage ? "traces+" : "traces"} />
					<RefreshButton />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</>
			}
		/>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{isPending ? (
				<ListSkeleton variant="table" />
			) : isError ? (
				<ErrorState label="traces" error={error} onRetry={() => refetch()} />
			) : rows.length === 0 ? (
				<EmptyState
					icon={<NetworkNodesIcon />}
					title={hasActiveFilters || search ? "No matching traces" : "No traces yet"}
					hint={
						hasActiveFilters || search
							? "Try widening the time range or clearing filters."
							: "Send OTLP spans to the local ingest endpoint to get started."
					}
				/>
			) : (
				<>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[40%]">Trace</TableHead>
								<TableHead>Service</TableHead>
								<TableHead className="text-right">Duration</TableHead>
								<TableHead className="text-right">Spans</TableHead>
								<TableHead>Time</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TableRow
									key={row.traceId}
									className={cn("cursor-pointer", row.hasError && "bg-destructive/5")}
									onClick={() => onSelectTrace(row.traceId)}
								>
									<TableCell className="min-w-0">
										<div className="flex items-center gap-2">
											{row.hasError ? (
												<span className="size-1.5 shrink-0 rounded-full bg-destructive" />
											) : null}
											<HttpSpanLabel
												spanName={row.rootSpanName}
												spanKind={row.rootSpanKind}
												spanAttributes={parseAttributes(row.rootSpanAttributes)}
												className="min-w-0"
											/>
										</div>
									</TableCell>
									<TableCell className="text-muted-foreground">
										<div className="flex flex-wrap gap-1">
											{row.services.slice(0, 3).map((svc) => (
												<Badge
													key={svc}
													variant="secondary"
													className="font-mono text-[10px]"
												>
													{svc}
												</Badge>
											))}
											{row.services.length > 3 ? (
												<Badge variant="secondary" className="font-mono text-[10px]">
													+{row.services.length - 3}
												</Badge>
											) : null}
										</div>
									</TableCell>
									<TableCell className="text-right font-mono tabular-nums">
										{formatDuration(row.durationMicros / 1000)}
									</TableCell>
									<TableCell className="text-right font-mono tabular-nums text-muted-foreground">
										{row.spanCount}
									</TableCell>
									<TableCell className="font-mono text-xs text-muted-foreground">
										{row.startTime}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>

					{hasNextPage ? (
						<div className="flex justify-center p-4">
							<Button
								variant="outline"
								size="sm"
								onClick={() => fetchNextPage()}
								disabled={isFetchingNextPage}
							>
								{isFetchingNextPage ? <Spinner className="size-4" /> : "Load more"}
							</Button>
						</div>
					) : null}
				</>
			)}
		</PageShell>
	)
}
