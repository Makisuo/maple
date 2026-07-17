import * as React from "react"

import { ChevronDownIcon, ChevronRightIcon } from "../icons"
import { cn } from "../../lib/utils"
import { getServiceColor } from "../../lib/colors"
import { formatDuration } from "../../lib/format"
import { getCacheInfo } from "../../lib/cache"
import type { TimelineBar, ViewportState } from "./trace-timeline-types"
import { DEPTH_INDENT, ROW_HEIGHT } from "./trace-timeline-types"

interface TraceTimelineRowProps {
	bar: TimelineBar
	/** y offset from the virtualizer (px). */
	top: number
	sidebarWidth: number
	/** Measured px width of the timeline column — decides which in-bar labels fit. */
	timelineWidthPx: number
	viewport: ViewportState
	selected: boolean
	focused: boolean
	hovered: boolean
	/** Search active and this row is not a match → dim it. */
	dimmed: boolean
	/** Search active and this row matches → ring it. */
	matched: boolean
	onSelect: (spanId: string) => void
	onToggleCollapse: (spanId: string) => void
	onZoomSpan: (spanId: string) => void
	onHover: (spanId: string | null, pos: { x: number; y: number } | null) => void
}

function TraceTimelineRowImpl({
	bar,
	top,
	sidebarWidth,
	timelineWidthPx,
	viewport,
	selected,
	focused,
	hovered,
	dimmed,
	matched,
	onSelect,
	onToggleCollapse,
	onZoomSpan,
	onHover,
}: TraceTimelineRowProps) {
	const spanId = bar.span.spanId
	const cacheInfo = getCacheInfo(bar.span.spanAttributes)

	return (
		<div
			data-row-id={spanId}
			className={cn(
				"absolute left-0 right-0 flex items-stretch cursor-pointer select-none",
				"hover:bg-muted/30",
				hovered && "bg-muted/30",
				selected && "bg-primary/10",
				focused && "ring-1 ring-inset ring-primary/60",
				matched && "ring-1 ring-inset ring-primary/40",
				dimmed && "opacity-40",
			)}
			style={{ transform: `translateY(${top}px)`, height: ROW_HEIGHT }}
			onClick={() => onSelect(spanId)}
			onDoubleClick={() => onZoomSpan(spanId)}
			onMouseMove={(e) => onHover(spanId, { x: e.clientX, y: e.clientY })}
			onMouseLeave={() => onHover(null, null)}
		>
			{/* Sidebar cell */}
			<div
				className="relative flex items-center gap-1 shrink-0 border-r border-border pr-2 text-[11px]"
				style={{ width: sidebarWidth, paddingLeft: bar.depth * DEPTH_INDENT + 4 }}
			>
				{/* Ancestor indent guides */}
				{bar.depth > 0 &&
					Array.from({ length: bar.depth }).map((_, level) => (
						<span
							key={level}
							aria-hidden
							className="absolute top-0 bottom-0 border-l border-foreground/[0.06]"
							style={{ left: level * DEPTH_INDENT + 8 }}
						/>
					))}
				<span
					className="shrink-0"
					style={{ width: 3, height: ROW_HEIGHT - 8, backgroundColor: bar.borderColor }}
				/>
				{bar.hasChildren ? (
					<button
						type="button"
						tabIndex={-1}
						aria-label={bar.isCollapsed ? "Expand" : "Collapse"}
						className="flex items-center justify-center size-4 shrink-0 text-muted-foreground hover:text-foreground"
						onClick={(e) => {
							e.stopPropagation()
							onToggleCollapse(spanId)
						}}
					>
						{bar.isCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
					</button>
				) : (
					<span className="inline-block size-4 shrink-0" />
				)}
				<span
					className={cn(
						"truncate font-mono font-medium text-foreground/90",
						bar.isError && "text-destructive",
						bar.span.isMissing && "italic text-muted-foreground",
					)}
				>
					{bar.span.spanName}
				</span>
				<span
					className="truncate text-[10px] shrink-0"
					style={{ color: getServiceColor(bar.span.serviceName) }}
				>
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
					<span className="text-[9px] text-muted-foreground/70 shrink-0">+{bar.childCount}</span>
				)}
				<span className="ml-auto shrink-0 pl-1 font-mono text-[10px] tabular-nums text-muted-foreground">
					{formatDuration(bar.span.durationMs)}
				</span>
			</div>

			{/* Timeline cell */}
			<div className="relative flex-1 min-w-0 overflow-hidden">
				<SpanBar bar={bar} viewport={viewport} timelineWidthPx={timelineWidthPx} />
			</div>
		</div>
	)
}

function SpanBar({
	bar,
	viewport,
	timelineWidthPx,
}: {
	bar: TimelineBar
	viewport: ViewportState
	timelineWidthPx: number
}) {
	const visible = viewport.endMs - viewport.startMs
	if (visible <= 0) return null
	const leftPct = ((bar.startMs - viewport.startMs) / visible) * 100
	const rawWidthPct = (Math.max(bar.endMs - bar.startMs, 0) / visible) * 100
	// Off-screen → don't render (overflow-hidden also clips, this skips the node entirely).
	if (leftPct > 100 || leftPct + rawWidthPct < 0) return null

	// Clamp the rendered rect to a bounded range around the visible column. When zoomed in
	// hard, a span spanning the whole trace would otherwise resolve to a multi-million-percent
	// (gigapixel) node; overflow-hidden clips anything past the column, so this is visually
	// identical while keeping the DOM node a sane size.
	const left = Math.max(leftPct, -50)
	const right = Math.min(leftPct + rawWidthPct, 150)
	const widthPct = Math.max(0, right - left)

	const barPx = (widthPct / 100) * timelineWidthPx
	const showName = barPx > 56
	const showDuration = barPx > 140

	return (
		<div
			className="absolute top-1/2 -translate-y-1/2 flex items-center overflow-hidden whitespace-nowrap font-mono text-[11px]"
			style={{
				left: `${left}%`,
				width: `max(2px, ${widthPct}%)`,
				height: ROW_HEIGHT - 8,
				backgroundColor: bar.fill,
				borderLeft: `3px solid ${bar.borderColor}`,
			}}
		>
			{showName && <span className="truncate px-1.5 text-foreground/90">{bar.span.spanName}</span>}
			{showDuration && (
				<span className="ml-auto shrink-0 px-1.5 text-foreground/50 tabular-nums">
					{formatDuration(bar.span.durationMs)}
				</span>
			)}
		</div>
	)
}

export const TraceTimelineRow = React.memo(TraceTimelineRowImpl)
