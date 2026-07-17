import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useHotkeys } from "@tanstack/react-hotkeys"

import { cn } from "@maple/ui/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { type Log } from "@/api/warehouse/logs"
import { LogDetailSheet } from "./log-detail-sheet"
import { LogRowExpanded } from "./log-row-expanded"
import { LogsTableToolbar } from "./logs-table-toolbar"
import type { LogsSearchParams } from "@/routes/logs"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { useLogsViewPreferences, type LogsDensity } from "@/hooks/use-logs-view-preferences"
import { formatCompactTimeInTimezone } from "@/lib/timezone-format"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { isDialogOpen } from "@/lib/keyboard"
import { useInfiniteLogs, FETCH_THRESHOLD } from "@/hooks/use-infinite-logs"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { pickImportantAttributes } from "@/lib/log-attributes"
import { LogAttributeChip } from "./log-attribute-chip"
import { ChevronRightIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"

const ROW_HEIGHT = 36
const ROW_HEIGHT_COMFORTABLE = 48
const PINNED_COL_WIDTH = "150px"
/** Fixed message-column width in the default (horizontally scrollable) layout. */
const BODY_WIDTH = 480

const EMPTY_COLUMNS: string[] = []

interface LogsTableViewProps {
	allData: Log[]
	isFetchingNextPage: boolean
	hasNextPage: boolean
	fetchNextPage: () => void
	waiting: boolean
	wrap: boolean
	density: LogsDensity
	pinnedColumns: string[]
	onLogClick?: (log: Log) => void
	embedded?: boolean
}

interface LogsTableProps {
	filters?: LogsSearchParams
	/** Hide the /logs route toolbar — required when rendering off the /logs route
	 *  (LogsTableToolbar reads that route's search params and throws elsewhere). */
	embedded?: boolean
}

function LoadingState() {
	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<div className="rounded-md border overflow-hidden flex-1 min-h-0">
				{Array.from({ length: 40 }).map((_, i) => (
					<div key={i} className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
						<Skeleton className="size-1.5 rounded-full shrink-0" />
						<Skeleton className="h-3 w-16 shrink-0" />
						<Skeleton className="h-3 w-[72px] shrink-0" />
						<Skeleton className="h-3 flex-1" />
					</div>
				))}
			</div>
		</div>
	)
}

interface LogRowProps {
	log: Log
	index: number
	top: number
	timeZone: string
	isSelected: boolean
	isFocused: boolean
	isExpanded: boolean
	wrap: boolean
	density: LogsDensity
	pinnedColumns: string[]
	/** Shared width (px) measured from the widest row, so every row's separator
	 *  reaches the same end. `null` until measured (rows size to their content). */
	contentWidth: number | null
	measureRef: (node: Element | null) => void
	onClick: (log: Log) => void
	onToggleExpand: (index: number) => void
}

const LogRow = React.memo(function LogRow({
	log,
	index,
	top,
	timeZone,
	isSelected,
	isFocused,
	isExpanded,
	wrap,
	density,
	pinnedColumns,
	contentWidth,
	measureRef,
	onClick,
	onToggleExpand,
}: LogRowProps) {
	const all = React.useMemo(() => pickImportantAttributes(log, Number.POSITIVE_INFINITY), [log])
	// Every important (non-pinned) attribute is shown inline — the row scrolls
	// horizontally to reach them rather than clipping behind a "+N".
	const chips = React.useMemo(() => {
		const pinned = new Set(pinnedColumns)
		return all.filter((attr) => !pinned.has(attr.key))
	}, [all, pinnedColumns])
	const severityColor = getSeverityColor(log.severityText)
	// When `fill` the header line stretches to the container (no horizontal
	// scroll): wrap mode wraps the body, expanded keeps a one-line summary with
	// the full body in the panel below. Otherwise (the default), the row sizes to
	// its content (body + every chip) and the stream scrolls sideways.
	const fill = wrap || isExpanded

	return (
		<div
			ref={measureRef}
			data-index={index}
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: contentWidth != null ? contentWidth : fill ? "100%" : "max-content",
				minWidth: "100%",
				transform: `translateY(${top}px)`,
			}}
			className="border-b border-border"
		>
			<div
				data-selected={isSelected || undefined}
				data-focused={isFocused || undefined}
				tabIndex={0}
				role="listitem"
				onClick={() => onClick(log)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault()
						onClick(log)
					}
				}}
				className={cn(
					"flex gap-2 px-3 text-xs font-mono cursor-pointer hover:bg-muted/50 data-[selected]:bg-primary/5 data-[focused]:bg-muted/70 data-[focused]:ring-1 data-[focused]:ring-ring data-[focused]:ring-inset focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
					wrap ? "items-start" : "items-center",
					fill ? "w-full" : "w-max min-w-full",
					density === "comfortable" ? "py-2.5" : "py-1.5",
				)}
			>
				<button
					type="button"
					aria-label={isExpanded ? "Collapse log" : "Expand log"}
					aria-expanded={isExpanded}
					onClick={(e) => {
						e.stopPropagation()
						onToggleExpand(index)
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") e.stopPropagation()
					}}
					className="shrink-0 flex items-center justify-center size-4 text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer focus-visible:outline-none focus-visible:text-foreground"
				>
					<ChevronRightIcon
						size={12}
						className={cn("transition-transform", isExpanded && "rotate-90")}
					/>
				</button>
				{/* h-4 wrapper = the text line-box height, so the dot centers on the
				    first line even when the row is top-aligned in wrap mode. */}
				<span className="shrink-0 flex h-4 items-center" aria-hidden="true">
					<span className="size-1.5 rounded-full" style={{ backgroundColor: severityColor }} />
				</span>
				<span
					className="shrink-0 w-12 text-[10px] uppercase tabular-nums font-semibold hidden md:inline-block"
					style={{ color: severityColor }}
				>
					{log.severityText}
				</span>
				<span className="shrink-0 w-24 text-muted-foreground tabular-nums">
					{formatCompactTimeInTimezone(log.timestamp, { timeZone })}
				</span>
				<span className="shrink-0 w-[120px] truncate text-muted-foreground/60 hidden md:inline-block">
					{log.serviceName}
				</span>
				{pinnedColumns.map((key) => {
					const value = log.logAttributes[key] ?? log.resourceAttributes[key] ?? "—"
					const numeric = value !== "—" && value.trim() !== "" && !Number.isNaN(Number(value))
					return (
						<span
							key={key}
							title={`${key}=${value}`}
							style={{ width: PINNED_COL_WIDTH }}
							className={cn(
								"shrink-0 truncate text-foreground/80 hidden md:block",
								numeric && "tabular-nums",
							)}
						>
							{value}
						</span>
					)
				})}
				{fill ? (
					<span
						className={cn(
							"min-w-0 flex-1 text-foreground text-[12px]",
							wrap ? "whitespace-pre-wrap break-words" : "truncate",
						)}
					>
						{log.body}
					</span>
				) : (
					<span
						style={{ width: BODY_WIDTH }}
						className="shrink-0 truncate text-foreground text-[12px]"
					>
						{log.body}
					</span>
				)}
				{!fill && chips.length > 0 && (
					<div className="flex items-center gap-1 shrink-0">
						{chips.map((chip) => (
							<LogAttributeChip
								key={chip.key}
								attrKey={chip.key}
								value={chip.value}
								tone={chip.tone}
							/>
						))}
					</div>
				)}
				{/* Fills the row background to the container edge when content is
				    narrower than the viewport; collapses to 0 when the row overflows. */}
				{!fill && <span className="flex-1" aria-hidden="true" />}
			</div>
			{isExpanded && <LogRowExpanded log={log} onOpenDetail={() => onClick(log)} />}
		</div>
	)
})

/** Slim sticky header that labels the pinned-attribute columns. */
function PinnedHeader({
	pinnedColumns,
	wrap,
	contentWidth,
}: {
	pinnedColumns: string[]
	wrap: boolean
	contentWidth: number | null
}) {
	return (
		<div
			style={{ width: contentWidth != null ? contentWidth : undefined }}
			className={cn(
				"sticky top-0 left-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-background border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground/70 select-none",
				wrap ? "w-full" : "w-max min-w-full",
			)}
		>
			<span className="shrink-0 size-4" aria-hidden="true" />
			<span className="shrink-0 size-1.5" aria-hidden="true" />
			<span className="shrink-0 w-12 hidden md:inline-block" aria-hidden="true" />
			<span className="shrink-0 w-24">Time</span>
			<span className="shrink-0 w-[120px] hidden md:inline-block">Service</span>
			{pinnedColumns.map((key) => (
				<span
					key={key}
					title={key}
					style={{ width: PINNED_COL_WIDTH }}
					className="shrink-0 truncate text-foreground/60 hidden md:block"
				>
					{key}
				</span>
			))}
			{wrap ? (
				<span className="min-w-0 flex-1">Message</span>
			) : (
				<>
					<span style={{ width: BODY_WIDTH }} className="shrink-0">
						Message
					</span>
					<span className="flex-1" aria-hidden="true" />
				</>
			)}
		</div>
	)
}

function LogsTableView({
	allData,
	isFetchingNextPage,
	hasNextPage,
	fetchNextPage,
	waiting,
	wrap,
	density,
	pinnedColumns,
	onLogClick,
	embedded,
}: LogsTableViewProps) {
	const [selectedLog, setSelectedLog] = React.useState<Log | null>(null)
	const [sheetOpen, setSheetOpen] = React.useState(false)
	const [expandedRows, setExpandedRows] = React.useState<ReadonlySet<number>>(() => new Set())
	const [contentWidth, setContentWidth] = React.useState<number | null>(null)
	const { effectiveTimezone } = useTimezonePreference()
	const scrollContainerRef = React.useRef<HTMLDivElement>(null)
	const pinnedKey = pinnedColumns.join(" ")

	const handleRowClick = React.useCallback(
		(log: Log) => {
			if (onLogClick) {
				onLogClick(log)
				return
			}
			setSelectedLog(log)
			setSheetOpen(true)
		},
		[onLogClick],
	)

	const toggleExpanded = React.useCallback((index: number) => {
		setExpandedRows((prev) => {
			const next = new Set(prev)
			if (next.has(index)) next.delete(index)
			else next.add(index)
			return next
		})
	}, [])

	React.useEffect(() => {
		if (!sheetOpen) setSelectedLog(null)
	}, [sheetOpen])

	const estimateSize = React.useCallback(() => {
		if (wrap) return density === "comfortable" ? 88 : 72
		return density === "comfortable" ? ROW_HEIGHT_COMFORTABLE : ROW_HEIGHT
	}, [wrap, density])

	const virtualizer = useVirtualizer({
		count: allData.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize,
		overscan: 10,
	})

	// A global wrap/density change resizes every row at once. Clear the
	// measurement cache so off-screen rows re-measure from the corrected
	// estimate instead of jumping on the stale one. Per-row expand/collapse
	// re-measures automatically via the row's ResizeObserver.
	React.useLayoutEffect(() => {
		virtualizer.measure()
	}, [wrap, density, virtualizer])

	const virtualItems = virtualizer.getVirtualItems()

	// Drop back to natural widths when the layout mode or pinned columns change so
	// the shared width can shrink (not only grow) for the new row shape.
	React.useLayoutEffect(() => {
		setContentWidth(null)
	}, [wrap, density, pinnedKey])

	// Measure the widest rendered row and give every row + the header that width,
	// so the row separators all reach the same end while the stream scrolls
	// sideways. Monotonic per shape (reset above); a wider row scrolling in grows
	// it, and `measureElement`'s observer handles heights independently.
	React.useLayoutEffect(() => {
		if (wrap) return
		const sc = scrollContainerRef.current
		if (!sc) return
		let max = 0
		for (const el of sc.querySelectorAll<HTMLElement>("[data-index]")) {
			if (el.scrollWidth > max) max = el.scrollWidth
		}
		if (max > 0) {
			setContentWidth((prev) => (prev === null || max > prev + 1 ? max : prev))
		}
	}, [virtualItems, wrap, density, pinnedKey, contentWidth])

	// Index-keyed nav ids: logs have no stable row id, and the list is
	// append-only for a given query, so indices stay stable while browsing.
	const rowIds = React.useMemo(() => allData.map((_, index) => String(index)), [allData])
	const { focusedId } = useListNavigation({
		ids: rowIds,
		enabled: allData.length > 0,
		onOpen: (id) => {
			const log = allData[Number(id)]
			if (log) handleRowClick(log)
		},
		scrollTo: (_id, index) => virtualizer.scrollToIndex(index, { align: "auto" }),
	})
	const focusedIndex = focusedId === null ? -1 : Number(focusedId)

	// →/← expand or collapse the focused row, complementing the chevron.
	useHotkeys(
		[
			{
				hotkey: "ArrowRight",
				callback: () => {
					if (isDialogOpen() || focusedIndex < 0) return
					setExpandedRows((prev) => {
						if (prev.has(focusedIndex)) return prev
						const next = new Set(prev)
						next.add(focusedIndex)
						return next
					})
				},
				options: { ignoreInputs: true },
			},
			{
				hotkey: "ArrowLeft",
				callback: () => {
					if (isDialogOpen() || focusedIndex < 0) return
					setExpandedRows((prev) => {
						if (!prev.has(focusedIndex)) return prev
						const next = new Set(prev)
						next.delete(focusedIndex)
						return next
					})
				},
				options: { ignoreInputs: true },
			},
		],
		{ enabled: allData.length > 0 },
	)

	React.useEffect(() => {
		const lastItem = virtualItems[virtualItems.length - 1]
		if (!lastItem) return

		if (lastItem.index >= allData.length - FETCH_THRESHOLD && hasNextPage && !isFetchingNextPage) {
			fetchNextPage()
		}
	}, [virtualItems, allData.length, hasNextPage, isFetchingNextPage, fetchNextPage])

	if (allData.length === 0) {
		return (
			<div className="flex-1 min-h-0 flex flex-col gap-4">
				{!onLogClick && !embedded && <LogsTableToolbar />}
				<div className="rounded-md border flex items-center justify-center h-48">
					<span className="text-sm text-muted-foreground">No logs found</span>
				</div>
			</div>
		)
	}

	return (
		<>
			<div className={`flex-1 min-h-0 flex flex-col content-enter ${waiting ? "opacity-60" : ""}`}>
				{!onLogClick && !embedded && <LogsTableToolbar />}
				<div className="flex-1 min-h-0 relative">
					<div
						ref={scrollContainerRef}
						className="absolute inset-0 overflow-auto rounded-md border"
					>
						{pinnedColumns.length > 0 && (
							<PinnedHeader
								pinnedColumns={pinnedColumns}
								wrap={wrap}
								contentWidth={wrap ? null : contentWidth}
							/>
						)}
						<div style={{ height: virtualizer.getTotalSize(), position: "relative" }} role="log">
							{virtualItems.map((virtualRow) => {
								const log = allData[virtualRow.index]
								const isSelected = selectedLog === log
								return (
									<LogRow
										key={virtualRow.index}
										log={log}
										index={virtualRow.index}
										top={virtualRow.start}
										timeZone={effectiveTimezone}
										isSelected={isSelected}
										isFocused={virtualRow.index === focusedIndex}
										isExpanded={expandedRows.has(virtualRow.index)}
										wrap={wrap}
										density={density}
										pinnedColumns={pinnedColumns}
										contentWidth={contentWidth}
										measureRef={virtualizer.measureElement}
										onClick={handleRowClick}
										onToggleExpand={toggleExpanded}
									/>
								)
							})}
						</div>
					</div>
					<div className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none rounded-b-md bg-gradient-to-t from-background to-transparent" />
				</div>

				<div className="text-sm text-muted-foreground shrink-0 mt-1.5">
					Showing {allData.length} logs
					{!hasNextPage && allData.length > 0 && " (all loaded)"}
				</div>
			</div>

			<LogDetailSheet log={selectedLog} open={sheetOpen} onOpenChange={setSheetOpen} />
		</>
	)
}

export function LogsTable({ filters, embedded }: LogsTableProps) {
	const { firstPageResult, allData, isFetchingNextPage, hasNextPage, fetchNextPage } =
		useInfiniteLogs(filters)
	const { wrap, density } = useLogsViewPreferences()

	const columnsKey = (filters?.columns ?? EMPTY_COLUMNS).join(" ")
	const pinnedColumns = React.useMemo(
		() => filters?.columns ?? EMPTY_COLUMNS,
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[columnsKey],
	)

	return Result.builder(firstPageResult)
		.onInitial(() => <LoadingState />)
		.onError((error) => <QueryErrorState error={error} />)
		.onSuccess((_response, result) => (
			<LogsTableView
				allData={allData}
				isFetchingNextPage={isFetchingNextPage}
				hasNextPage={hasNextPage}
				fetchNextPage={fetchNextPage}
				waiting={result.waiting ?? false}
				wrap={wrap}
				density={density}
				pinnedColumns={pinnedColumns}
				embedded={embedded}
			/>
		))
		.render()
}
