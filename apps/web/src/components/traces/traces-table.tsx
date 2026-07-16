import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type Trace } from "@/api/warehouse/traces"
import type { TracesSearchParams } from "@/routes/traces"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { QueryErrorState } from "@/components/common/query-error-state"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { formatRelativeTime } from "@/lib/format"
import { HttpSpanLabel } from "@maple/ui/components/traces/http-span-label"
import { useInfiniteTraces, FETCH_THRESHOLD } from "@/hooks/use-infinite-traces"
import { useListNavigation } from "@/hooks/use-list-navigation"

interface TracesTableViewProps {
	allData: Trace[]
	isFetchingNextPage: boolean
	hasNextPage: boolean
	fetchNextPage: () => void
	waiting: boolean
	onTraceClick: (traceId: string, startTime: string) => void
}

function formatDuration(ms: number): string {
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)}μs`
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)}ms`
	}
	return `${(ms / 1000).toFixed(2)}s`
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
 * Duration (100) joins at 480 and Services (160) at 680, each keeping Root Span at ≥200px.
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
			<div className="rounded-md border">
				<table className="w-full table-fixed caption-bottom text-sm">
					<thead className="[&_tr]:border-b">
						<tr className="border-b transition-colors hover:bg-muted/50">
							{TRACE_COLUMNS.map((column) => (
								<th
									key={column.id}
									className={`${HEADER_CELL_CLASS} ${column.responsive ?? ""}`}
									style={{ width: column.width }}
								>
									{column.header}
								</th>
							))}
						</tr>
					</thead>
					<tbody className="[&_tr:last-child]:border-0">
						{Array.from({ length: 10 }).map((_, i) => (
							<tr key={i} className="border-b transition-colors">
								{TRACE_COLUMNS.map((column) => (
									<td
										key={column.id}
										className={`p-2 align-middle ${column.responsive ?? ""}`}
									>
										<Skeleton className={`h-4 ${column.skeleton}`} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}

function TracesTableView({
	allData,
	isFetchingNextPage,
	hasNextPage,
	fetchNextPage,
	waiting,
	onTraceClick,
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
						search={(prev: Record<string, unknown>) => ({ ...prev, t: row.original.startTime })}
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
				cell: ({ row }) => (
					<div className="flex flex-col min-w-0">
						<HttpSpanLabel
							spanName={row.original.rootSpan.name || row.original.rootSpanName || "Unknown"}
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
				),
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
				accessorKey: "durationMs",
				header: "Duration",
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
		[effectiveTimezone],
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
			if (trace) onTraceClick(trace.traceId, trace.startTime)
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
								<td colSpan={TRACE_COLUMNS.length} className="h-24 text-center">
									No traces found
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
									onClick={() => onTraceClick(row.original.traceId, row.original.startTime)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											onTraceClick(row.original.traceId, row.original.startTime)
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
				Showing {allData.length} traces
				{!hasNextPage && allData.length > 0 && " (all loaded)"}
			</div>
		</div>
	)
}

export function TracesTable({ filters }: TracesTableProps) {
	const navigate = useNavigate()
	const { firstPageResult, allData, isFetchingNextPage, hasNextPage, fetchNextPage } =
		useInfiniteTraces(filters)

	const onTraceClick = React.useCallback(
		(traceId: string, startTime: string) => {
			navigate({
				to: "/traces/$traceId",
				params: { traceId },
				search: (prev: Record<string, unknown>) => ({ ...prev, t: startTime }),
			})
		},
		[navigate],
	)

	return Result.builder(firstPageResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <QueryErrorState error={error} />)
		.onSuccess((_response, result) => (
			<TracesTableView
				allData={allData}
				isFetchingNextPage={isFetchingNextPage}
				hasNextPage={hasNextPage}
				fetchNextPage={fetchNextPage}
				waiting={result.waiting ?? false}
				onTraceClick={onTraceClick}
			/>
		))
		.render()
}
