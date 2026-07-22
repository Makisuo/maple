import { DatabaseIcon } from "@maple/ui/components/icons"
import { ServiceDot } from "@maple/ui/components/service-dot"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@maple/ui/components/ui/table"
import { formatDuration, formatNumber } from "@maple/ui/format"
import { cn } from "@maple/ui/utils"
import { SearchableFilterSection } from "@maple/ui/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@maple/ui/components/filters/filter-sidebar"
import { useLocalServiceCatalog, type ServiceCatalogEntry } from "../hooks/use-local-service-catalog"
import { useQueryParams } from "../lib/router"
import { DEFAULT_RANGE } from "../lib/time"
import { PageShell } from "../components/page-shell"
import { RefreshButton, TimeRangeSelect, Toolbar, ToolbarSearch, ToolbarStat } from "../components/toolbar"
import { EmptyState, ErrorState, ListSkeleton } from "../components/view-states"

interface ServicesListViewProps {
	onSelectService: (serviceName: string) => void
}

export function ServicesListView({ onSelectService }: ServicesListViewProps) {
	const [query, setParams] = useQueryParams()
	const range = query.get("range") || DEFAULT_RANGE
	const env = query.get("env") || undefined
	const ns = query.get("ns") || undefined
	const search = query.get("q") || undefined

	const catalog = useLocalServiceCatalog({ env, ns, search, range })
	const entries = catalog.data?.entries ?? []
	const hasActiveFilters = !!env || !!ns

	const sidebar = (
		<FilterSidebarFrame className="w-56 shrink-0 px-4" waiting={catalog.isFetching}>
			<FilterSidebarHeader
				canClear={hasActiveFilters}
				onClear={() => setParams({ env: null, ns: null })}
			/>
			<FilterSidebarBody>
				<SearchableFilterSection
					title="Environment"
					options={catalog.data?.envFacets ?? []}
					selected={env ? [env] : []}
					onChange={(vals) => setParams({ env: vals.at(-1) ?? null })}
				/>
				<SearchableFilterSection
					title="Namespace"
					options={catalog.data?.nsFacets ?? []}
					selected={ns ? [ns] : []}
					onChange={(vals) => setParams({ ns: vals.at(-1) ?? null })}
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
					placeholder="Filter by service name…"
				/>
			}
			stats={
				<>
					<ToolbarStat value={entries.length} label="services" />
					<ToolbarStat
						value={Math.round(catalog.data?.totalErrorCount ?? 0)}
						label="errors"
						danger
					/>
					<RefreshButton />
					<TimeRangeSelect value={range} onChange={(next) => setParams({ range: next })} />
				</>
			}
		/>
	)

	return (
		<PageShell sidebar={sidebar} toolbar={toolbar}>
			{catalog.isPending ? (
				<ListSkeleton rows={8} />
			) : catalog.isError ? (
				<ErrorState label="services" error={catalog.error} onRetry={() => catalog.refetch()} />
			) : entries.length === 0 ? (
				<EmptyState
					icon={<DatabaseIcon />}
					title={hasActiveFilters || search ? "No matching services" : "No services seen yet"}
					hint={
						hasActiveFilters || search
							? "Try widening the time range or clearing filters."
							: "Services appear as soon as their traces arrive."
					}
				/>
			) : (
				<div className="p-4">
					<div className="rounded-md border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Service</TableHead>
									<TableHead className="text-right">Spans</TableHead>
									<TableHead className="text-right">Errors</TableHead>
									<TableHead className="text-right">Error rate</TableHead>
									<TableHead className="text-right">p50</TableHead>
									<TableHead className="text-right">p95</TableHead>
									<TableHead className="text-right">Logs</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{entries.map((entry) => (
									<ServiceRow
										key={entry.serviceName}
										entry={entry}
										onSelect={() => onSelectService(entry.serviceName)}
									/>
								))}
							</TableBody>
						</Table>
					</div>
				</div>
			)}
		</PageShell>
	)
}

function ServiceRow({ entry, onSelect }: { entry: ServiceCatalogEntry; onSelect: () => void }) {
	return (
		<TableRow onClick={onSelect} className="cursor-pointer">
			<TableCell>
				<span className="flex items-center gap-2">
					<ServiceDot serviceName={entry.serviceName} />
					<span className="font-medium">{entry.serviceName}</span>
					{entry.serviceNamespaces.length > 0 ? (
						<span className="truncate text-xs text-muted-foreground">
							{entry.serviceNamespaces.join(", ")}
						</span>
					) : null}
				</span>
			</TableCell>
			<TableCell className="text-right tabular-nums">{formatNumber(entry.spanCount)}</TableCell>
			<TableCell
				className={cn("text-right tabular-nums", entry.errorCount > 0 && "text-destructive")}
			>
				{formatNumber(entry.errorCount)}
			</TableCell>
			<TableCell
				className={cn("text-right tabular-nums", entry.errorRate > 0.05 && "text-destructive")}
			>
				{(entry.errorRate * 100).toFixed(1)}%
			</TableCell>
			<TableCell className="text-right tabular-nums">{formatDuration(entry.p50LatencyMs)}</TableCell>
			<TableCell className="text-right tabular-nums">{formatDuration(entry.p95LatencyMs)}</TableCell>
			<TableCell className="text-right tabular-nums">{formatNumber(entry.logCount)}</TableCell>
		</TableRow>
	)
}
