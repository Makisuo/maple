import * as React from "react"
import { Result } from "@/lib/effect-atom"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useHotkeys } from "@tanstack/react-hotkeys"

import { cn } from "@maple/ui/lib/utils"
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
import { isDialogOpen } from "@maple/ui/lib/keyboard"
import { useInfiniteLogs, FETCH_THRESHOLD } from "@/hooks/use-infinite-logs"
import { useListNavigation } from "@/hooks/use-list-navigation"
import { pickImportantAttributes } from "@/lib/log-attributes"
import { LogAttributeChip } from "./log-attribute-chip"
import { ChevronRightIcon } from "@/components/icons"
import { QueryErrorState } from "@/components/common/query-error-state"
import { usePageScrolledReporter } from "@maple/ui/components/ui/page-layout"

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
	isCapped: boolean
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
	measureRef?: (node: Element | null) => void
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
				// The track owns the horizontal size (see `trackStyle`). A row that
				// needs more than the track still overflows via the inner `w-max`,
				// which is what grows the track on the next frame.
				width: "100%",
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
	trackStyle,
}: {
	pinnedColumns: string[]
	wrap: boolean
	trackStyle: React.CSSProperties
}) {
	return (
		<div
			// `top-0` only: a `left-0` sticky header stays glued to the viewport
			// while the rows scroll sideways underneath it, so the labels drift off
			// the columns they name. It shares the rows' track width instead.
			style={trackStyle}
			className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-background border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground/70 select-none"
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

export function LogsTableView({
	allData,
	isFetchingNextPage,
	hasNextPage,
	isCapped,
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
	const { effectiveTimezone } = useTimezonePreference()
	const scrollContainerRef = React.useRef<HTMLDivElement>(null)
	// This pane owns its scroller (the route mounts it under `DashboardLayout.Fill`,
	// not `.Scroll`), so it has to raise the sticky area's shadow itself.
	const reportScrolled = usePageScrolledReporter()

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

	const handleSheetOpenChange = React.useCallback((open: boolean) => {
		setSheetOpen(open)
		if (!open) setSelectedLog(null)
	}, [])

	// Measured row heights, feeding an adaptive estimate. The constants below are
	// only a cold start: a compact row actually lands near 31px (an 18px chip
	// between two 6px paddings plus the border), so every measurement used to
	// shrink `getTotalSize()` and drag the scrollbar out from under the cursor.
	// Expanded rows are excluded — they are not representative of the rest.
	const sizeStatsRef = React.useRef({ sum: 0, byIndex: new Map<number, number>() })
	const expandedRowsRef = React.useRef(expandedRows)
	React.useLayoutEffect(() => {
		expandedRowsRef.current = expandedRows
	}, [expandedRows])

	const estimateSize = React.useCallback(() => {
		const stats = sizeStatsRef.current
		if (stats.byIndex.size >= 8) return Math.round(stats.sum / stats.byIndex.size)
		if (wrap) return density === "comfortable" ? 88 : 72
		return density === "comfortable" ? ROW_HEIGHT_COMFORTABLE : ROW_HEIGHT
	}, [wrap, density])

	const virtualizer = useVirtualizer({
		count: allData.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize,
		// 4 rows of buffer is ~140px at compact density — a flick outruns it and
		// leaves blank bands, which reads as the list stuttering.
		overscan: wrap ? 6 : 12,
	})

	// Every row is measured, not just the wrapped/expanded ones: an unmeasured
	// row keeps its estimate, and a list of wrong estimates is exactly the drift
	// above. Recording the height here (rather than reading the virtualizer's
	// cache) keeps the mean deduped by index.
	const measureElement = React.useCallback(
		(node: Element | null) => {
			virtualizer.measureElement(node)
			if (!(node instanceof HTMLElement)) return
			const index = Number(node.dataset.index)
			if (!Number.isInteger(index) || expandedRowsRef.current.has(index)) return
			const height = node.offsetHeight
			if (height <= 0) return
			const stats = sizeStatsRef.current
			const previous = stats.byIndex.get(index)
			if (previous === height) return
			stats.sum += height - (previous ?? 0)
			stats.byIndex.set(index, height)
		},
		[virtualizer],
	)

	// A global wrap/density change resizes every row at once. Clear the
	// measurement cache so off-screen rows re-measure from the corrected
	// estimate instead of jumping on the stale one. Per-row expand/collapse
	// re-measures automatically via the row's ResizeObserver.
	React.useLayoutEffect(() => {
		sizeStatsRef.current = { sum: 0, byIndex: new Map() }
		virtualizer.measure()
	}, [wrap, density, virtualizer])

	const virtualItems = virtualizer.getVirtualItems()

	// A virtualized list's horizontal scroll width is the width of whichever rows
	// happen to be mounted, and in the default layout a row sizes to its content
	// — so scrolling vertically swung `scrollWidth` by hundreds of px and the
	// browser yanked `scrollLeft` along with it. The track is sized to the widest
	// row seen so far and only ever grows, which keeps the horizontal range
	// still while you scroll. It resets when the layout or the query changes.
	const [trackWidth, setTrackWidth] = React.useState(0)
	// Mirrored in a ref so the effect can decide *not* to call `setTrackWidth` at
	// all: a `setState` in a layout effect costs a second commit even when the
	// updater returns the current value, and this effect runs on every scroll
	// frame — which doubled the list's commits per frame.
	const trackWidthRef = React.useRef(0)
	const trackResetKey = `${wrap}|${density}|${pinnedColumns.join("\u0000")}`
	const trackStateRef = React.useRef({ key: trackResetKey, count: allData.length })

	React.useLayoutEffect(() => {
		const element = scrollContainerRef.current
		if (!element) return
		const previous = trackStateRef.current
		const reset = previous.key !== trackResetKey || allData.length < previous.count
		trackStateRef.current = { key: trackResetKey, count: allData.length }
		if (reset) {
			if (trackWidthRef.current === 0) return
			trackWidthRef.current = 0
			setTrackWidth(0)
			return
		}
		// Wrap mode fills the container and never scrolls sideways.
		if (wrap) return
		const measured = element.scrollWidth
		if (measured <= trackWidthRef.current) return
		trackWidthRef.current = measured
		setTrackWidth(measured)
	}, [virtualItems, trackResetKey, allData.length, wrap])

	const trackStyle = React.useMemo<React.CSSProperties>(
		() => ({ width: trackWidth > 0 ? trackWidth : "100%", minWidth: "100%" }),
		[trackWidth],
	)

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
			<div className={`flex-1 min-h-0 flex flex-col transition-opacity ${waiting ? "opacity-60" : ""}`}>
				{!onLogClick && !embedded && <LogsTableToolbar />}
				<div className="flex-1 min-h-0 relative">
					<div
						ref={scrollContainerRef}
						onScroll={(e) => reportScrolled(e.currentTarget.scrollTop > 0)}
						className="absolute inset-0 overflow-auto overscroll-contain rounded-md border"
					>
						{pinnedColumns.length > 0 && (
							<PinnedHeader pinnedColumns={pinnedColumns} wrap={wrap} trackStyle={trackStyle} />
						)}
						<div
							style={{
								...trackStyle,
								height: virtualizer.getTotalSize(),
								position: "relative",
							}}
							role="log"
						>
							{virtualItems.map((virtualRow) => {
								const log = allData[virtualRow.index]
								const isSelected = selectedLog === log
								const isExpanded = expandedRows.has(virtualRow.index)
								return (
									<LogRow
										key={virtualRow.index}
										log={log}
										index={virtualRow.index}
										top={virtualRow.start}
										timeZone={effectiveTimezone}
										isSelected={isSelected}
										isFocused={virtualRow.index === focusedIndex}
										isExpanded={isExpanded}
										wrap={wrap}
										density={density}
										pinnedColumns={pinnedColumns}
										measureRef={measureElement}
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
					{isCapped
						? `Showing first ${allData.length.toLocaleString()} logs — narrow filters to continue`
						: `Showing ${allData.length.toLocaleString()} logs${!hasNextPage ? " (all loaded)" : ""}`}
				</div>
			</div>

			<LogDetailSheet log={selectedLog} open={sheetOpen} onOpenChange={handleSheetOpenChange} />
		</>
	)
}

export function LogsTable({ filters, embedded }: LogsTableProps) {
	const { firstPageResult, allData, isFetchingNextPage, hasNextPage, isCapped, fetchNextPage } =
		useInfiniteLogs(filters)
	const { wrap, density } = useLogsViewPreferences()

	const columnsKey = (filters?.columns ?? EMPTY_COLUMNS).join("\x00")
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
				isCapped={isCapped}
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
