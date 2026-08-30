import { formatDuration } from "@maple/ui/lib/format"
import { TableSkeleton } from "@maple/ui/components/ui/table-skeleton"
import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { Link, useNavigate } from "@tanstack/react-router"
import { ExcludedEmptyHint } from "@maple/ui/components/filters/excluded-empty-hint"
import { traceFilterChips } from "@/lib/traces/trace-filter-chips"
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Badge } from "@maple/ui/components/ui/badge"
import { ArrowUpDownIcon } from "@/components/icons"
import { type Trace } from "@/api/warehouse/traces"
import type { TracesSearchParams } from "@/routes/traces"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { QueryErrorState } from "@/components/common/query-error-state"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { useInfiniteTraces, FETCH_THRESHOLD } from "@/hooks/use-infinite-traces"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { ServiceDot } from "@maple/ui/components/service-dot"

type TraceSortKey = NonNullable<TracesSearchParams["sortBy"]>
type TraceSortDir = NonNullable<TracesSearchParams["sortDir"]>

interface TracesTableViewProps {
	allData: Trace[]
	isFetchingNextPage: boolean
	hasNextPage: boolean
	isCapped: boolean
	hiddenCount: number
	fetchNextPage: () => void
	waiting: boolean
	onTraceClick: (trace: Trace) => void
	onShowNoise: () => void
	sortBy: TraceSortKey
	sortDir: TraceSortDir
	onSortChange: (key: TraceSortKey) => void
	/** Flattened active exclusions, for the empty state's hint. */
	excludedValues: ReadonlyArray<string>
	clearExclusions: () => void
}

/**
 * The span to pre-select on the detail page. With `rootOnly` off the list shows
 * individual child spans, and clicking one should land on that span rather than
 * on the trace with nothing selected. Root-span rows stay undefined so the
 * default trace view opens unchanged.
 */
function deepLinkSpanId(trace: Trace): string | undefined {
	return trace.isRootSpan ? undefined : trace.spanId
}

function truncateId(id: string, length = 8): string {
	if (id.length <= length) return id
	return id.slice(0, length)
}

function StatusBadge({ hasError }: { hasError: boolean }) {
	if (hasError) {
		return (
			<Badge variant="secondary" className="bg-severity-error/15 text-severity-error">
				Error
			</Badge>
		)
	}
	return (
		<Badge variant="secondary" className="bg-severity-info/15 text-severity-info">
			OK
		</Badge>
	)
}

function HttpStatusBadge({ statusCode }: { statusCode: number }) {
	return (
		<Badge
			variant="secondary"
			className={
				statusCode >= 500
					? "bg-severity-error/15 text-severity-error"
					: statusCode >= 400
						? "bg-severity-warn/15 text-severity-warn"
						: statusCode >= 300
							? "bg-chart-p50/15 text-chart-p50"
							: "bg-severity-info/15 text-severity-info"
			}
		>
			{statusCode}
		</Badge>
	)
}

/**
 * Clickable column header. Sorting is server-side — the list is paged, so
 * reordering the rows already fetched would only sort the current window.
 */
function SortableHeader({
	label,
	sortKey,
	activeKey,
	dir,
	onSort,
}: {
	label: string
	sortKey: TraceSortKey
	activeKey: TraceSortKey
	dir: TraceSortDir
	onSort: (key: TraceSortKey) => void
}) {
	const active = activeKey === sortKey
	return (
		<button
			type="button"
			onClick={() => onSort(sortKey)}
			className={`inline-flex items-center gap-1 transition-colors ${
				active ? "text-foreground" : "hover:text-foreground"
			}`}
		>
			{label}
			<ArrowUpDownIcon
				size={10}
				className={`transition-opacity ${active ? "opacity-100" : "opacity-40"} ${
					active && dir === "asc" ? "rotate-180" : ""
				}`}
			/>
		</button>
	)
}

const ROW_HEIGHT = 44

const HEADER_CELL_CLASS = "h-10 px-2 text-left align-middle font-medium text-muted-foreground"

/**
 * Column layout, shared by the real table, the loading skeleton and the empty state so the three
 * can't drift apart.
 *
 * `responsive` drops a column when the table gets too narrow to hold it, protecting Root Span — the
 * only column that identifies the row, and the only one that flexes. Thresholds are *container*
 * queries against `@container/page` (declared by PageLayout.Content), not viewport media queries:
 * two sidebars can take 512px, so viewport width says little about what the table actually gets.
 * At a 768px viewport the table has ~480px, which a `md:` media query would wrongly call roomy.
 *
 * Budget: Trace ID (100) + Status (80) are always on, leaving `container - 180` for Root Span.
 * Duration (100) joins at 480, Spans (70) at 560 and Services (160) at 680, each keeping Root
 * Span at ≥200px.
 */
interface TraceColumnLayout {
	readonly id: string
	readonly header: string
	readonly skeleton: string
	readonly width?: number
	/** Applied to both the th and the td — keep it a literal so Tailwind's scanner sees it. */
	readonly responsive?: string
	readonly cellClass?: string
}

const TRACE_COLUMNS: readonly TraceColumnLayout[] = [
	{ id: "traceId", header: "Trace ID", width: 100, skeleton: "w-16" },
	// No width: under table-fixed the unsized column absorbs whatever the sized ones leave.
	{ id: "rootSpan", header: "Root Span", skeleton: "w-40" },
	{
		id: "services",
		header: "Services",
		width: 160,
		skeleton: "w-24",
		responsive: "hidden @min-[680px]/page:table-cell",
	},
	{
		id: "spanCount",
		header: "Spans",
		width: 70,
		skeleton: "w-8",
		responsive: "hidden @min-[560px]/page:table-cell",
	},
	{
		id: "durationMs",
		header: "Duration",
		width: 100,
		skeleton: "w-16",
		responsive: "hidden @min-[480px]/page:table-cell",
	},
	{ id: "status", header: "Status", width: 80, skeleton: "w-12" },
]

const COLUMN_LAYOUT: ReadonlyMap<string, TraceColumnLayout> = new Map(
	TRACE_COLUMNS.map((column) => [column.id, column]),
)

function columnClasses(columnId: string): { responsive?: string; cellClass?: string } {
	const layout = COLUMN_LAYOUT.get(columnId)
	return { responsive: layout?.responsive, cellClass: layout?.cellClass }
}

interface TracesTableProps {
	filters?: TracesSearchParams
}

function LoadingState() {
	return (
		<div className="flex-1 min-h-0 flex flex-col gap-4">
			<TableSkeleton
				rows={10}
				tableClassName="w-full table-fixed"
				columns={TRACE_COLUMNS.map((column) => ({
					header: column.header,
					headClassName: column.responsive,
					cellClassName: column.responsive,
					skeleton: column.skeleton,
					width: column.width,
				}))}
			/>
		</div>
	)
}

function TracesTableView({
	allData,
	isFetchingNextPage,
	hasNextPage,
	isCapped,
	hiddenCount,
	fetchNextPage,
	waiting,
	onTraceClick,
	onShowNoise,
	sortBy,
	sortDir,
	onSortChange,
	excludedValues,
	clearExclusions,
}: TracesTableViewProps) {
	const { effectiveTimezone } = useTimezonePreference()
	const scrollContainerRef = React.useRef<HTMLDivElement>(null)

	const columns = React.useMemo<ColumnDef<Trace>[]>(
		() => [
			{
				accessorKey: "traceId",
				header: "Trace ID",
				size: 100,
				cell: ({ row }) => (
					<Link
						to="/traces/$traceId"
						params={{ traceId: row.original.traceId }}
						search={(prev: Record<string, unknown>) => ({
							...prev,
							t: row.original.startTime,
							spanId: deepLinkSpanId(row.original),
						})}
						className="font-mono text-xs text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
						onClick={(e) => e.stopPropagation()}
					>
						{truncateId(row.original.traceId)}
					</Link>
				),
			},
			{
				id: "rootSpan",
				header: "Root Span",
				cell: ({ row }) => {
					const name = row.original.rootSpan.name || row.original.rootSpanName || "Unknown"
					// Mobile screen spans are all named `ui.screen`/`screen.load`; the
					// identity that distinguishes rows lives in `screen.name`.
					const screenName = row.original.rootSpan.attributes["screen.name"]
					const displayName =
						screenName && !name.includes(screenName) ? `${name} · ${screenName}` : name
					return (
						<div className="flex flex-col min-w-0">
							<HttpSpanLabel
								spanName={displayName}
								spanAttributes={row.original.rootSpan.attributes}
								spanKind={row.original.rootSpan.kind}
								textClassName="text-xs"
							/>
							{/*
							 * One slot, two sub-lines — switched at the same 480px the Duration column
							 * uses, so exactly one of them shows the duration. While Duration is hidden
							 * the absolute timestamp gives way to it (the more useful of the two at a
							 * glance); the full timestamp stays available on the tooltip.
							 */}
							<span
								className="truncate text-[10px] text-muted-foreground"
								title={formatTimestampInTimezone(row.original.startTime, {
									timeZone: effectiveTimezone,
								})}
							>
								<span className="hidden @min-[480px]/page:inline">
									{formatTimestampInTimezone(row.original.startTime, {
										timeZone: effectiveTimezone,
									})}{" "}
								</span>
								<span className="text-muted-foreground/60">
									({formatRelativeTime(row.original.startTime)})
								</span>
								<span className="@min-[480px]/page:hidden">
									{" · "}
									{formatDuration(row.original.durationMs)}
								</span>
							</span>
						</div>
					)
				},
			},
			{
				id: "services",
				header: "Services",
				size: 160,
				cell: ({ row }) => (
					<div className="flex min-w-0 flex-wrap gap-1">
						{row.original.services.slice(0, 3).map((service: string) => (
							<Badge
								key={service}
								variant="outline"
								className="max-w-full font-mono text-[10px]"
								title={service}
							>
								<ServiceDot serviceName={service} className="size-1.5" />
								<span className="truncate">{service}</span>
							</Badge>
						))}
						{row.original.services.length > 3 && (
							<Badge variant="outline" className="text-[10px]">
								+{row.original.services.length - 3}
							</Badge>
						)}
					</div>
				),
			},
			{
				accessorKey: "spanCount",
				header: "Spans",
				size: 70,
				cell: ({ row }) => (
					<span className="font-mono text-xs text-muted-foreground">
						{row.original.spanCount.toLocaleString()}
					</span>
				),
			},
			{
				accessorKey: "durationMs",
				header: () => (
					<SortableHeader
						label="Duration"
						sortKey="durationMs"
						activeKey={sortBy}
						dir={sortDir}
						onSort={onSortChange}
					/>
				),
				size: 100,
				cell: ({ row }) => (
					<span className="font-mono text-xs">{formatDuration(row.original.durationMs)}</span>
				),
			},
			{
				id: "status",
				header: "Status",
				size: 80,
				cell: ({ row }) =>
					row.original.rootSpan.http?.statusCode != null ? (
						<HttpStatusBadge statusCode={row.original.rootSpan.http.statusCode} />
					) : (
						<StatusBadge hasError={row.original.hasError} />
					),
			},
		],
		[effectiveTimezone, sortBy, sortDir, onSortChange],
	)

	const table = useReactTable({
		data: allData,
		columns,
		getCoreRowModel: getCoreRowModel(),
	})

	const { rows } = table.getRowModel()

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 10,
	})

	const virtualItems = virtualizer.getVirtualItems()

	React.useEffect(() => {
		const lastItem = virtualItems[virtualItems.length - 1]
		if (!lastItem) return

		if (lastItem.index >= rows.length - FETCH_THRESHOLD && hasNextPage && !isFetchingNextPage) {
			fetchNextPage()
		}
	}, [virtualItems, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

	// Index-keyed nav ids — the list is append-only for a given query.
	const rowIds = React.useMemo(() => allData.map((_, index) => String(index)), [allData])
	const { focusedId } = useListNavigation({
		ids: rowIds,
		enabled: allData.length > 0,
		onOpen: (id) => {
			const trace = allData[Number(id)]
			if (trace) onTraceClick(trace)
		},
		scrollTo: (_id, index) => virtualizer.scrollToIndex(index, { align: "auto" }),
	})
	const focusedIndex = focusedId === null ? -1 : Number(focusedId)

	if (allData.length === 0) {
		return (
			<div className="flex-1 min-h-0 flex flex-col gap-4">
				<div className="rounded-md border">
					<table className="w-full caption-bottom text-sm">
						<thead className="[&_tr]:border-b">
							<tr className="border-b transition-colors hover:bg-muted/50">
								<th className={HEADER_CELL_CLASS} colSpan={TRACE_COLUMNS.length}>
									<span className="sr-only">Trace columns</span>
								</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td colSpan={TRACE_COLUMNS.length} className="px-4 py-8 text-center">
									No traces found
									<ExcludedEmptyHint
										excluded={excludedValues}
										onClear={clearExclusions}
										className="mx-auto max-w-lg"
									/>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		)
	}

	return (
		<div
			className={`flex-1 min-h-0 flex flex-col gap-4 transition-opacity ${waiting ? "opacity-50" : ""}`}
		>
			<div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto rounded-md border">
				{/*
				 * table-fixed makes the declared column widths authoritative. Under auto layout a long
				 * service badge grew Services well past its 160px and starved Root Span down to ~50px;
				 * fixed layout pins the sized columns and hands the remainder to Root Span, which is the
				 * only column that should flex.
				 */}
				<table className="w-full table-fixed caption-bottom text-sm" aria-label="Traces">
					<thead className="[&_tr]:border-b sticky top-0 z-10 bg-background">
						{table.getHeaderGroups().map((headerGroup) => (
							<tr key={headerGroup.id} className="border-b transition-colors hover:bg-muted/50">
								{headerGroup.headers.map((header) => (
									<th
										key={header.id}
										aria-sort={
											header.id === sortBy
												? sortDir === "asc"
													? "ascending"
													: "descending"
												: undefined
										}
										className={`${HEADER_CELL_CLASS} ${columnClasses(header.id).responsive ?? ""}`}
										style={{
											width: header.getSize() !== 150 ? header.getSize() : undefined,
										}}
									>
										{header.isPlaceholder
											? null
											: flexRender(header.column.columnDef.header, header.getContext())}
									</th>
								))}
							</tr>
						))}
					</thead>
					<tbody className="[&_tr:last-child]:border-0">
						{virtualItems.length > 0 && (
							<tr style={{ height: virtualItems[0].start }} aria-hidden="true">
								<td />
							</tr>
						)}
						{virtualItems.map((virtualRow) => {
							const row = rows[virtualRow.index]
							return (
								<tr
									key={row.id}
									ref={virtualizer.measureElement}
									data-index={virtualRow.index}
									data-focused={virtualRow.index === focusedIndex || undefined}
									className="border-b transition-colors hover:bg-muted/50 data-[focused]:bg-muted/70 data-[focused]:ring-1 data-[focused]:ring-ring data-[focused]:ring-inset cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
									tabIndex={0}
									onClick={() => onTraceClick(row.original)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											onTraceClick(row.original)
										}
									}}
								>
									{row.getVisibleCells().map((cell) => {
										const { responsive, cellClass } = columnClasses(cell.column.id)
										return (
											<td
												key={cell.id}
												className={`p-2 align-middle [&:has([role=checkbox])]:pr-0 ${responsive ?? ""} ${cellClass ?? ""}`}
											>
												{flexRender(cell.column.columnDef.cell, cell.getContext())}
											</td>
										)
									})}
								</tr>
							)
						})}
						{virtualItems.length > 0 && (
							<tr
								style={{
									height:
										virtualizer.getTotalSize() -
										virtualItems[virtualItems.length - 1].end,
								}}
								aria-hidden="true"
							>
								<td />
							</tr>
						)}
						{isFetchingNextPage && (
							<tr className="border-b transition-colors">
								<td
									colSpan={TRACE_COLUMNS.length}
									className="p-2 text-center text-sm text-muted-foreground"
								>
									Loading more traces…
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			<div className="text-sm text-muted-foreground shrink-0">
				{isCapped
					? `Showing first ${allData.length.toLocaleString()} traces — narrow filters to continue`
					: `Showing ${allData.length.toLocaleString()} traces${!hasNextPage ? " (all loaded)" : ""}`}
				{/* Hidden rows are never silently dropped — say how many and offer the way back. */}
				{hiddenCount > 0 && (
					<>
						{" · "}
						{hiddenCount.toLocaleString()} single-span noise{" "}
						{hiddenCount === 1 ? "trace" : "traces"} hidden{" "}
						<button
							type="button"
							onClick={onShowNoise}
							className="text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
						>
							show
						</button>
					</>
				)}
			</div>
		</div>
	)
}

export function TracesTable({ filters }: TracesTableProps) {
	const navigate = useNavigate()
	// Bound to the traces route so the sort patch keeps the rest of the search
	// params typed and intact.
	const navigateTraces = useNavigate({ from: "/traces/" })
	const {
		firstPageResult,
		allData,
		isFetchingNextPage,
		hasNextPage,
		isCapped,
		hiddenCount,
		fetchNextPage,
	} = useInfiniteTraces(filters)

	// An empty list under an exclusion cannot explain itself — the filter is defined by what is
	// absent, so it reads exactly like telemetry that stopped arriving.
	const excludedChips = traceFilterChips(filters ?? {}).filter((chip) => chip.negated)
	const excludedValues = excludedChips.flatMap((chip) => chip.values)
	const clearExclusions = () =>
		navigateTraces({
			search: (prev) => ({
				...prev,
				...Object.fromEntries(excludedChips.map((chip) => [chip.param, undefined])),
			}),
		})

	const onShowNoise = React.useCallback(() => {
		navigateTraces({ search: (prev) => ({ ...prev, hideNoise: false }) })
	}, [navigateTraces])

	const onTraceClick = React.useCallback(
		(trace: Trace) => {
			navigate({
				to: "/traces/$traceId",
				params: { traceId: trace.traceId },
				search: (prev: Record<string, unknown>) => ({
					...prev,
					t: trace.startTime,
					spanId: deepLinkSpanId(trace),
				}),
			})
		},
		[navigate],
	)

	const sortBy = filters?.sortBy ?? "timestamp"
	const sortDir = filters?.sortDir ?? "desc"

	const onSortChange = React.useCallback(
		(key: TraceSortKey) => {
			// Same column toggles direction; a new column starts at desc
			// (slowest / newest first, the useful end of both).
			const nextDir: TraceSortDir = key === sortBy && sortDir === "desc" ? "asc" : "desc"
			navigateTraces({ search: (prev) => ({ ...prev, sortBy: key, sortDir: nextDir }) })
		},
		[navigateTraces, sortBy, sortDir],
	)

	return Result.builder(firstPageResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <QueryErrorState error={error} />)
		.onSuccess((_response, result) => (
			<TracesTableView
				allData={allData}
				isFetchingNextPage={isFetchingNextPage}
				hasNextPage={hasNextPage}
				isCapped={isCapped}
				hiddenCount={hiddenCount}
				fetchNextPage={fetchNextPage}
				waiting={result.waiting ?? false}
				onTraceClick={onTraceClick}
				onShowNoise={onShowNoise}
				sortBy={sortBy}
				sortDir={sortDir}
				onSortChange={onSortChange}
				excludedValues={excludedValues}
				clearExclusions={clearExclusions}
			/>
		))
		.render()
}
