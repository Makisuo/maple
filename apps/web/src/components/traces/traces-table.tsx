import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"

import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type Trace } from "@/api/tinybird/traces"
import type { TracesSearchParams } from "@/routes/traces"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { QueryErrorState } from "@/components/common/query-error-state"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import { formatRelativeTime } from "@/lib/format"
import { HttpSpanLabel } from "./http-span-label"
import { useInfiniteTraces, FETCH_THRESHOLD } from "@/hooks/use-infinite-traces"

export interface TracesTableViewProps {
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

interface TracesTableProps {
	filters?: TracesSearchParams
}

function LoadingState() {
	return (
		<div className="flex-1 min-h-0 flex flex-col gap-4">
			<div className="rounded-md border">
				<table className="w-full caption-bottom text-sm">
					<thead className="[&_tr]:border-b">
						<tr className="border-b transition-colors hover:bg-muted/50">
							<th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[100px]">
								Trace ID
							</th>
							<th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground">
								Root Span
							</th>
							<th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[160px]">
								Services
							</th>
							<th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[100px]">
								Duration
							</th>
							<th className="h-10 px-2 text-left align-middle font-medium text-muted-foreground w-[80px]">
								Status
							</th>
						</tr>
					</thead>
					<tbody className="[&_tr:last-child]:border-0">
						{Array.from({ length: 10 }).map((_, i) => (
							<tr key={i} className="border-b transition-colors">
								<td className="p-2 align-middle">
									<Skeleton className="h-4 w-16" />
								</td>
								<td className="p-2 align-middle">
									<Skeleton className="h-4 w-40" />
								</td>
								<td className="p-2 align-middle">
									<Skeleton className="h-4 w-24" />
								</td>
								<td className="p-2 align-middle">
									<Skeleton className="h-4 w-16" />
								</td>
								<td className="p-2 align-middle">
									<Skeleton className="h-4 w-12" />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}

export function TracesTableView({
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
							textClassName="text-xs"
						/>
						<span className="text-[10px] text-muted-foreground">
							{formatTimestampInTimezone(row.original.startTime, {
								timeZone: effectiveTimezone,
							})}{" "}
							<span className="text-muted-foreground/60">
								({formatRelativeTime(row.original.startTime)})
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
					<div className="flex flex-wrap gap-1">
						{row.original.services.slice(0, 3).map((service: string) => (
							<Badge key={service} variant="outline" className="font-mono text-[10px]">
								{service}
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

	if (allData.length === 0) {
		return (
			<div className="flex-1 min-h-0 flex flex-col gap-4">
				<div className="rounded-md border">
					<table className="w-full caption-bottom text-sm">
						<thead className="[&_tr]:border-b">
							<tr className="border-b transition-colors hover:bg-muted/50">
								<th
									className="h-10 px-2 text-left align-middle font-medium text-muted-foreground"
									colSpan={5}
								>
									<span className="sr-only">Trace columns</span>
								</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td colSpan={5} className="h-24 text-center">
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
				<table className="w-full caption-bottom text-sm" aria-label="Traces">
					<thead className="[&_tr]:border-b sticky top-0 z-10 bg-background">
						{table.getHeaderGroups().map((headerGroup) => (
							<tr key={headerGroup.id} className="border-b transition-colors hover:bg-muted/50">
								{headerGroup.headers.map((header) => (
									<th
										key={header.id}
										className={`h-10 px-2 text-left align-middle font-medium text-muted-foreground ${
											header.id === "services" ? "hidden md:table-cell" : ""
										}`}
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
									className="border-b transition-colors hover:bg-muted/50 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
									tabIndex={0}
									onClick={() => onTraceClick(row.original.traceId, row.original.startTime)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											onTraceClick(row.original.traceId, row.original.startTime)
										}
									}}
								>
									{row.getVisibleCells().map((cell) => (
										<td
											key={cell.id}
											className={`p-2 align-middle [&:has([role=checkbox])]:pr-0 ${
												cell.column.id === "services" ? "hidden md:table-cell" : ""
											}${cell.column.id === "rootSpan" ? " max-w-0" : ""}`}
										>
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</td>
									))}
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
								<td colSpan={5} className="p-2 text-center text-sm text-muted-foreground">
									Loading more traces...
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
