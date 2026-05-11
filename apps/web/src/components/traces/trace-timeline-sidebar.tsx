import * as React from "react"

import { ChevronDownIcon, ChevronRightIcon } from "@/components/icons"
import { cn } from "@maple/ui/utils"
import { formatDuration } from "@/lib/format"
import { getCacheInfo } from "@/lib/cache"
import type { TimelineBar } from "./trace-timeline-types"
import { DEPTH_INDENT, OVERSCAN, ROW_GAP, ROW_HEIGHT } from "./trace-timeline-types"

interface TraceTimelineSidebarProps {
	bars: TimelineBar[]
	totalRows: number
	scrollTop: number
	containerHeight: number
	selectedSpanId?: string
	focusedIndex: number | null
	searchMatches: Set<string>
	isSearchActive: boolean
	hoveredSpanId: string | null
	width: number
	onBarClick: (spanId: string) => void
	onBarDoubleClick: (spanId: string) => void
	onCollapseToggle: (spanId: string) => void
	onHoverSpan?: (spanId: string | null) => void
}

const rowSize = ROW_HEIGHT + ROW_GAP

export function TraceTimelineSidebar({
	bars,
	totalRows,
	scrollTop,
	containerHeight,
	selectedSpanId,
	focusedIndex,
	searchMatches,
	isSearchActive,
	hoveredSpanId,
	width,
	onBarClick,
	onBarDoubleClick,
	onCollapseToggle,
	onHoverSpan,
}: TraceTimelineSidebarProps) {
	const firstVisible = Math.max(0, Math.floor(scrollTop / rowSize) - OVERSCAN)
	const lastVisible = Math.min(
		totalRows - 1,
		Math.ceil((scrollTop + containerHeight) / rowSize) + OVERSCAN,
	)
	const visibleBars = React.useMemo(
		() => bars.filter((bar) => bar.row >= firstVisible && bar.row <= lastVisible),
		[bars, firstVisible, lastVisible],
	)

	const handleClick = React.useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			const target = e.target as HTMLElement
			const collapseBtn = target.closest("[data-collapse-toggle]") as HTMLElement | null
			if (collapseBtn) {
				const spanId = collapseBtn.getAttribute("data-collapse-toggle")
				if (spanId) {
					e.stopPropagation()
					onCollapseToggle(spanId)
				}
				return
			}
			const row = target.closest("[data-row-id]") as HTMLElement | null
			if (row) {
				const spanId = row.getAttribute("data-row-id")
				if (spanId) onBarClick(spanId)
			}
		},
		[onBarClick, onCollapseToggle],
	)

	const handleDoubleClick = React.useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			const target = e.target as HTMLElement
			const row = target.closest("[data-row-id]") as HTMLElement | null
			if (row) {
				const spanId = row.getAttribute("data-row-id")
				if (spanId) onBarDoubleClick(spanId)
			}
		},
		[onBarDoubleClick],
	)

	const handleMouseMove = React.useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			if (!onHoverSpan) return
			const target = e.target as HTMLElement
			const row = target.closest("[data-row-id]") as HTMLElement | null
			onHoverSpan(row?.getAttribute("data-row-id") ?? null)
		},
		[onHoverSpan],
	)

	const handleMouseLeave = React.useCallback(() => {
		onHoverSpan?.(null)
	}, [onHoverSpan])

	const totalHeight = totalRows * rowSize

	return (
		<div
			className="relative shrink-0 border-r border-border bg-background"
			style={{ width }}
		>
			<div
				className="relative"
				style={{ height: totalHeight }}
				onClick={handleClick}
				onDoubleClick={handleDoubleClick}
				onMouseMove={handleMouseMove}
				onMouseLeave={handleMouseLeave}
			>
				{/* Tree indent guides */}
				<TreeIndentLines bars={visibleBars} />

				{visibleBars.map((bar) => {
					const isSelected = selectedSpanId === bar.span.spanId
					const isFocused = focusedIndex !== null && bar.row === focusedIndex
					const isMatch = isSearchActive && searchMatches.has(bar.span.spanId)
					const isDimmed = isSearchActive && !isMatch
					const isHovered = hoveredSpanId === bar.span.spanId
					const cacheInfo = getCacheInfo(bar.span.spanAttributes)
					return (
						<div
							key={bar.span.spanId}
							data-row-id={bar.span.spanId}
							className={cn(
								"absolute left-0 right-0 flex items-center gap-1 pr-2 text-[11px] cursor-pointer select-none",
								"hover:bg-muted/40",
								isHovered && "bg-muted/40",
								isSelected && "bg-primary/10",
								isFocused && "ring-1 ring-inset ring-primary/60",
								isDimmed && "opacity-40",
								bar.span.isMissing && "italic text-muted-foreground",
							)}
							style={{
								transform: `translateY(${bar.row * rowSize}px)`,
								height: ROW_HEIGHT,
								paddingLeft: bar.depth * DEPTH_INDENT + 4,
							}}
						>
							{/* Service color stripe */}
							<span
								className="shrink-0"
								style={{
									width: 3,
									height: ROW_HEIGHT - 8,
									backgroundColor: bar.borderColor,
								}}
							/>
							{bar.hasChildren ? (
								<button
									type="button"
									data-collapse-toggle={bar.span.spanId}
									tabIndex={-1}
									className="flex items-center justify-center size-4 shrink-0 text-muted-foreground hover:text-foreground"
								>
									{bar.isCollapsed ? (
										<ChevronRightIcon size={12} />
									) : (
										<ChevronDownIcon size={12} />
									)}
								</button>
							) : (
								<span className="inline-block size-4 shrink-0" />
							)}
							<span
								className={cn(
									"truncate font-mono font-medium text-foreground/90",
									bar.isError && "text-destructive",
								)}
							>
								{bar.span.spanName}
							</span>
							<span className="truncate text-[10px] text-muted-foreground shrink-0">
								{bar.span.serviceName}
							</span>
							{cacheInfo?.result && (
								<span
									className={cn(
										"text-[9px] font-semibold px-1 shrink-0 uppercase",
										cacheInfo.result === "hit" ? "text-primary" : "text-chart-p50",
									)}
								>
									{cacheInfo.result}
								</span>
							)}
							{bar.isCollapsed && bar.childCount > 0 && (
								<span className="text-[9px] text-muted-foreground/70 shrink-0">
									+{bar.childCount}
								</span>
							)}
							<span className="ml-auto shrink-0 pl-1 font-mono text-[10px] tabular-nums text-muted-foreground">
								{formatDuration(bar.span.durationMs)}
							</span>
						</div>
					)
				})}
			</div>
		</div>
	)
}

/**
 * Static tree-indent guides drawn in CSS — one vertical hairline per depth level for visible bars.
 * Lightweight: we render N≈visible rows × depth lines using absolutely-positioned divs.
 */
function TreeIndentLines({ bars }: { bars: TimelineBar[] }) {
	if (bars.length === 0) return null
	return (
		<div className="absolute inset-0 pointer-events-none">
			{bars.map((bar) =>
				bar.depth > 0 ? (
					<div
						key={`indent-${bar.span.spanId}`}
						className="absolute border-l border-foreground/[0.06]"
						style={{
							left: (bar.depth - 1) * DEPTH_INDENT + 8,
							top: bar.row * rowSize,
							height: ROW_HEIGHT,
						}}
					/>
				) : null,
			)}
		</div>
	)
}

interface SidebarResizeHandleProps {
	onResize: (delta: number) => void
}

export function SidebarResizeHandle({ onResize }: SidebarResizeHandleProps) {
	const startX = React.useRef<number | null>(null)
	const startWidth = React.useRef<number>(0)

	const handleMouseDown = React.useCallback(
		(e: React.MouseEvent) => {
			startX.current = e.clientX
			startWidth.current = 0
			e.preventDefault()

			const handleMove = (ev: MouseEvent) => {
				if (startX.current == null) return
				const delta = ev.clientX - startX.current
				startX.current = ev.clientX
				onResize(delta)
			}
			const handleUp = () => {
				startX.current = null
				window.removeEventListener("mousemove", handleMove)
				window.removeEventListener("mouseup", handleUp)
			}
			window.addEventListener("mousemove", handleMove)
			window.addEventListener("mouseup", handleUp)
		},
		[onResize],
	)

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			className="absolute top-0 bottom-0 z-30 w-1 -ml-0.5 cursor-col-resize bg-transparent hover:bg-primary/30 transition-colors"
			onMouseDown={handleMouseDown}
		/>
	)
}
