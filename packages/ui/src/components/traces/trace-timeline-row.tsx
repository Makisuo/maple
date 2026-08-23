import * as React from "react"

import { ChevronDownIcon, ChevronRightIcon, LayersIcon } from "../icons"
import { cn } from "../../lib/utils"
import { getServiceColor } from "../../lib/colors"
import { formatDuration } from "../../lib/format"
import { describeSpan } from "../../lib/span-category"
import type { TimelineBar } from "./trace-timeline-types"
import { DEPTH_INDENT, ROW_HEIGHT } from "./trace-timeline-types"

interface TraceTimelineRowProps {
	bar: TimelineBar
	/** y offset from the virtualizer (px). */
	top: number
	selected: boolean
	focused: boolean
	hovered: boolean
	/** Search active and this row is not a match → dim it. */
	dimmed: boolean
	/** Search active and this row matches → ring it. */
	matched: boolean
	onSelect: (spanId: string) => void
	/** `wholeSubtree` comes from an Alt/Option-click. */
	onToggleCollapse: (spanId: string, wholeSubtree: boolean) => void
	onZoomSpan: (spanId: string) => void
	onHover: (spanId: string | null, pos: { x: number; y: number } | null) => void
}

/**
 * Position of the bar inside the timeline cell, entirely in CSS.
 *
 * `--b0`/`--b1` are this span's start/end in trace-relative ms and never change with the
 * viewport; `--vp0`/`--vpk` come from the nearest time surface (see `writeTimeSurface`) and are
 * rewritten by the viewport controller on every gesture frame. So a pan or zoom repositions
 * every bar through the style engine, without React rendering anything.
 *
 * `clamp()` replaces what used to be a JS `Math.max(left, -50)`: zoomed in hard, a trace-long
 * span would otherwise resolve to a multi-million-percent box. The cell clips at its own edges,
 * so bounding the rect is visually identical and keeps the layout box sane.
 */
const BAR_LEFT = "clamp(-50%, calc((var(--b0) - var(--vp0)) * var(--vpk) * 1%), 150%)"
const BAR_RIGHT = "calc(100% - clamp(-50%, calc((var(--b1) - var(--vp0)) * var(--vpk) * 1%), 150%))"

function TraceTimelineRowImpl({
	bar,
	top,
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
	const { category, cacheInfo } = describeSpan(bar.span)
	const CategoryIcon = category.Icon
	const durationLabel = formatDuration(bar.span.durationMs)

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
			{/* Label cell. Sticky so it survives any horizontal scroll of the timeline column,
			    and sized from `--sidebar-w` so a resize drag doesn't re-render a single row. */}
			<div
				className="sticky left-0 z-10 relative flex items-center gap-1 shrink-0 border-r border-border bg-inherit pr-2 text-[11px]"
				style={{ width: "var(--sidebar-w)", paddingLeft: bar.depth * DEPTH_INDENT + 4 }}
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
						title={`${bar.isCollapsed ? "Expand" : "Collapse"} — ⌥ for the whole subtree`}
						className="flex items-center justify-center size-4 shrink-0 text-muted-foreground hover:text-foreground"
						onClick={(e) => {
							e.stopPropagation()
							onToggleCollapse(spanId, e.altKey)
						}}
					>
						{bar.isCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
					</button>
				) : (
					<span className="inline-block size-4 shrink-0" />
				)}
				{/* Category glyph. The timeline row has no room to spell the category out, so the
				    title carries it; `describeSpan` already ran here for `cacheInfo`. */}
				<span className="flex shrink-0 items-center" title={category.label}>
					<CategoryIcon
						size={11}
						className={bar.isError ? "text-destructive" : category.accent.text}
					/>
				</span>
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
					<span
						className="flex items-center gap-0.5 shrink-0 text-[9px] text-muted-foreground/70"
						title={`${bar.childCount} hidden ${bar.childCount === 1 ? "span" : "spans"}`}
					>
						<LayersIcon size={9} />
						{bar.childCount}
					</span>
				)}
				<span className="ml-auto shrink-0 pl-1 font-mono text-[10px] tabular-nums text-muted-foreground">
					{durationLabel}
				</span>
			</div>

			{/* Timeline cell */}
			<div className="group/cell relative flex-1 min-w-0 overflow-hidden">
				<div
					data-span-bar=""
					className={cn(
						"@container/bar absolute top-1/2 -translate-y-1/2 flex items-center",
						// Not overflow-hidden: the outside label is a child and has to escape the box.
						"whitespace-nowrap font-mono text-[11px]",
					)}
					style={{
						left: BAR_LEFT,
						right: BAR_RIGHT,
						minWidth: 2,
						height: ROW_HEIGHT - 8,
						backgroundColor: bar.fill,
						borderLeft: `3px solid ${bar.borderColor}`,
						// Read back by the row-decoration pass; also what the CSS above interpolates.
						["--b0" as string]: bar.offsetStartMs,
						["--b1" as string]: bar.offsetEndMs,
					}}
				>
					{/* Inside labels. Container queries replace what used to be a JS px measurement
					    per bar per frame: the name appears once the bar itself is ≥56px wide, the
					    duration at ≥140px. The style engine re-evaluates them on zoom for free. */}
					<div className="flex min-w-0 flex-1 items-center overflow-hidden">
						<span className="hidden truncate px-1.5 text-foreground/90 @min-[56px]/bar:inline">
							{bar.span.spanName}
						</span>
						<span className="ml-auto hidden shrink-0 px-1.5 text-foreground/50 tabular-nums @min-[140px]/bar:inline">
							{durationLabel}
						</span>
					</div>

					{/* Outside label for bars too narrow to hold one. Sits on the right by default;
					    the decoration pass flips it left near the right edge of the column. */}
					<span
						data-outside-label=""
						className={cn(
							"pointer-events-none absolute top-1/2 hidden -translate-y-1/2 whitespace-nowrap",
							"font-mono text-[10px] text-muted-foreground/80 @max-[56px]/bar:block",
							"left-full ml-[5px] data-[side=left]:left-auto data-[side=left]:right-full",
							"data-[side=left]:ml-0 data-[side=left]:mr-[5px]",
						)}
					>
						{bar.span.spanName} · {durationLabel}
					</span>
				</div>

				{/* Clipping chevrons, pinned to the cell edges (Jaeger). Toggled by the decoration
				    pass — CSS can't tell whether the clamp above actually bit. */}
				<span
					data-clip-left=""
					className="pointer-events-none absolute left-0.5 top-1/2 hidden -translate-y-1/2 font-mono text-[9px] leading-none"
					style={{ color: bar.borderColor }}
					aria-hidden
				>
					‹
				</span>
				<span
					data-clip-right=""
					className="pointer-events-none absolute right-0.5 top-1/2 hidden -translate-y-1/2 font-mono text-[9px] leading-none"
					style={{ color: bar.borderColor }}
					aria-hidden
				>
					›
				</span>
			</div>
		</div>
	)
}

export const TraceTimelineRow = React.memo(TraceTimelineRowImpl)
