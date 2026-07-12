import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { usePlotArea, useXAxisScale, ZIndexLayer } from "recharts"

import { useSuppressChartTooltip } from "@maple/ui/components/ui/chart"
import { cn } from "@maple/ui/utils"

import { CommitDetailBody, CommitListBody } from "../commit-sha-hover-card"
import {
	type CommitMarker,
	type LabelGroup,
	type MarkerCommit,
	type PositionedMarker,
	layoutMarkerLabels,
} from "./marker-layout"

// Hovering a dash for this long opens its card; the label is quicker because its
// hitbox is small and deliberate, while a dash hitbox spans the whole plot height
// so a cursor merely crossing it shouldn't pop the card.
const LINE_OPEN_DELAY = 1500
const LABEL_OPEN_DELAY = 400
// Grace period so moving between a group's dash, label and card doesn't close it.
// Kept short so a genuine exit to empty space feels immediate, not laggy — it only
// needs to survive the few-frame hop across the small gaps between dash/label/card.
const CLOSE_GRACE = 60
// Above every recharts layer (the highest default zIndex is the label at 2000).
const MARKER_Z = 3000
const LABEL_HEIGHT = 18
// Distance between the chip's lower edge and the top of the plot. The chip sits ABOVE
// the plot — it overflows out of the chart's top edge into the card's header/padding
// gap (the recharts surface is un-clipped by ChartContainer) rather than reserving an
// inner margin, so the series keeps its full height. Each dash rises through this gap
// to meet the chip's underside.
const LABEL_GAP = 4
// How far the chip row rises above the plot top. The overlay's foreignObject is
// extended upward by this much so the chips fall inside its hit-test region —
// foreignObject only dispatches pointer events within its own box, so a chip drawn
// above y=0 would render (overflow visible) but be unhoverable without this.
const LABEL_OVERHANG = LABEL_HEIGHT + LABEL_GAP
// Hitbox half-width around a dash (so a thin line is still easy to hover).
const DASH_HIT = 5

// Freeze the chart cursor while the pointer is over a marker (dash/label) or the
// overlay is swallowing events: stop the move/press/click from reaching recharts'
// wrapper handlers, which listen on an ancestor and so receive the synthetic event
// as it bubbles up the React tree unless we halt it here.
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation()
// Spreadable handler set for the dash/label hitboxes (their propagation is always
// stopped; the root's is conditional so it stays inline there).
const stopHandlers = {
	onMouseMove: stopPropagation,
	onMouseDown: stopPropagation,
	onClick: stopPropagation,
}

export interface CommitMarkersLayerProps {
	/** Deploy markers, pre-snapped to chart buckets (see `buildCommitMarkers`). */
	markers: CommitMarker[]
}

/**
 * Renders commit deploy markers (dashed verticals + labels + hover cards) over a
 * time-series chart. Mounted as a child of the recharts chart so it can read the
 * x-scale and plot rect; one instance per chart, each owning its own hover state.
 */
export function CommitMarkersLayer({ markers }: CommitMarkersLayerProps) {
	const xScale = useXAxisScale()
	const plotArea = usePlotArea()
	const setSuppressed = useSuppressChartTooltip()

	const [hoverKey, setHoverKey] = useState<string | null>(null)
	const [openKey, setOpenKey] = useState<string | null>(null)
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	// Only once a card is OPEN do we hide the chart's own data tooltip (they never
	// co-show). Merely hovering a marker — before the open delay elapses — leaves the
	// chart tooltip live, so a quick pass over a dash doesn't blink it away.
	useEffect(() => {
		setSuppressed(openKey !== null)
	}, [openKey, setSuppressed])

	useEffect(
		() => () => {
			if (openTimer.current) clearTimeout(openTimer.current)
			if (closeTimer.current) clearTimeout(closeTimer.current)
			setSuppressed(false)
		},
		[setSuppressed],
	)

	// Arm a group: become the hovered group now, open its card after `delay`.
	const arm = useCallback((key: string, delay: number) => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current)
			closeTimer.current = null
		}
		setHoverKey(key)
		// Keep this group's own card open; drop a *sibling* group's card immediately.
		// (Re-arming an already-open group still schedules a `setOpenKey(key)` below,
		// but it's a no-op when it fires — same behavior as the old early return.)
		setOpenKey((prev) => (prev === key ? prev : null))
		if (openTimer.current) clearTimeout(openTimer.current)
		openTimer.current = setTimeout(() => setOpenKey(key), delay)
	}, [])

	const scheduleClose = useCallback(() => {
		if (openTimer.current) {
			clearTimeout(openTimer.current)
			openTimer.current = null
		}
		if (closeTimer.current) clearTimeout(closeTimer.current)
		closeTimer.current = setTimeout(() => {
			setHoverKey(null)
			setOpenKey(null)
		}, CLOSE_GRACE)
	}, [])

	const groups = useMemo(() => {
		if (!xScale || !plotArea || markers.length === 0) return []
		const positioned: PositionedMarker[] = []
		for (const marker of markers) {
			const x = xScale(marker.bucket)
			if (typeof x === "number" && Number.isFinite(x)) {
				positioned.push({ marker, x })
			}
		}
		positioned.sort((a, b) => a.x - b.x)
		return layoutMarkerLabels(positioned, plotArea.x, plotArea.x + plotArea.width)
	}, [markers, xScale, plotArea])

	if (!plotArea || groups.length === 0) return null

	// Once a card is OPEN, the overlay swallows pointer events over the whole plot so
	// they never reach the chart underneath — no ghost cursor or data tooltip fighting
	// the commit card. While merely hovering (before the card opens) or idle it stays
	// transparent so the plot area still drives the chart's own tooltip.
	const blockChart = openKey !== null

	return (
		<ZIndexLayer zIndex={MARKER_Z}>
			{/* Extended upward by LABEL_OVERHANG so the chip row (drawn above the plot,
			    overflowing into the card's header gap) is inside the hit-test box and stays
			    hoverable; the inner div is pushed back down by the same amount so every
			    child's `top` still reads in plot coordinates (origin at the plot's SVG y=0). */}
			<foreignObject
				x={0}
				y={-LABEL_OVERHANG}
				width={plotArea.x + plotArea.width}
				height={plotArea.y + plotArea.height + LABEL_OVERHANG}
				style={{ pointerEvents: "none", overflow: "visible" }}
			>
				{/* Idle: events pass through to the chart. Active: the root captures them
				    so nothing reaches the series; the dashes/labels/card still handle their
				    own hover on top. */}
				<div
					onMouseMove={blockChart ? stopPropagation : undefined}
					onMouseDown={blockChart ? stopPropagation : undefined}
					onClick={blockChart ? stopPropagation : undefined}
					style={{
						position: "relative",
						top: LABEL_OVERHANG,
						width: "100%",
						height: "100%",
						pointerEvents: blockChart ? "auto" : "none",
					}}
				>
					{groups.map((group) => (
						<MarkerGroup
							key={group.key}
							group={group}
							plotTop={plotArea.y}
							plotHeight={plotArea.height}
							active={hoverKey === group.key || openKey === group.key}
							open={openKey === group.key}
							onArmLine={() => arm(group.key, LINE_OPEN_DELAY)}
							onArmLabel={() => arm(group.key, LABEL_OPEN_DELAY)}
							onLeave={scheduleClose}
						/>
					))}
				</div>
			</foreignObject>
		</ZIndexLayer>
	)
}

interface MarkerGroupProps {
	group: LabelGroup
	plotTop: number
	plotHeight: number
	active: boolean
	open: boolean
	onArmLine: () => void
	onArmLabel: () => void
	onLeave: () => void
}

function MarkerGroup({
	group,
	plotTop,
	plotHeight,
	active,
	open,
	onArmLine,
	onArmLabel,
	onLeave,
}: MarkerGroupProps) {
	// Anchor the card to the representative dash so it opens centered on the line,
	// not on the (possibly wide) label box.
	const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
	const labelTop = plotTop - LABEL_HEIGHT - LABEL_GAP
	// Each dash rises from the label's lower edge (plotTop - LABEL_GAP) straight down
	// through the plot, so it connects directly to the underside of the box — which the
	// layout has centered over (and widened to span) the whole cluster. No tie line.
	const dashTop = plotTop - LABEL_GAP
	const dashHeight = Math.max(plotHeight + LABEL_GAP, 0)
	const badge = group.commits.length - 1
	// The card anchors under the centre of the label box (the cluster's visual centre),
	// not on any one dash, since a merged group has several.
	const anchorX = group.boxLeft + group.boxWidth / 2

	const dashColor = active ? "var(--foreground)" : "var(--muted-foreground)"

	return (
		<>
			{group.dashXs.map((x, i) => (
				<div
					key={`${group.key}-dash-${i}`}
					onMouseEnter={onArmLine}
					onMouseLeave={onLeave}
					{...stopHandlers}
					style={{
						position: "absolute",
						left: x - DASH_HIT,
						top: dashTop,
						width: DASH_HIT * 2,
						height: dashHeight,
						display: "flex",
						justifyContent: "center",
						pointerEvents: "auto",
					}}
				>
					<div
						style={{
							width: 0,
							height: "100%",
							borderLeft: `1px dashed ${dashColor}`,
							opacity: active ? 0.85 : 0.4,
							transition: "opacity 120ms ease, border-color 120ms ease",
						}}
					/>
				</div>
			))}

			{/* Card anchor: a zero-size point under the centre of the label box. */}
			<span
				ref={setAnchorEl}
				style={{ position: "absolute", top: plotTop, left: anchorX, width: 0, height: 0 }}
			/>

			<div
				onMouseEnter={onArmLabel}
				onMouseLeave={onLeave}
				{...stopHandlers}
				style={{
					position: "absolute",
					left: group.boxLeft,
					top: labelTop,
					// Render at exactly the laid-out width (NOT w-fit) so the pill matches the
					// box the placement math reserved — every owned dash sits under it and its
					// vertical connects. Text is centered and truncates within.
					width: group.boxWidth,
					height: LABEL_HEIGHT,
					pointerEvents: "auto",
				}}
				className={cn(
					"flex cursor-pointer items-center justify-center gap-1 rounded-[5px] border px-1.5 font-mono text-[11px] leading-none backdrop-blur-sm transition-colors",
					active
						? "border-border bg-popover text-popover-foreground shadow-sm"
						: "border-border/60 bg-popover/85 text-muted-foreground hover:text-popover-foreground",
				)}
			>
				<span className="min-w-0 truncate" title={group.label}>
					{group.label}
				</span>
				{badge > 0 ? (
					<span
						className={cn(
							"shrink-0 rounded-[3px] px-1 text-[10px] tabular-nums",
							active ? "bg-muted text-foreground" : "bg-muted/70 text-muted-foreground",
						)}
					>
						{/* Cap the displayed count so a bucket with 100+ commits can't overflow the
						    badge's reserved width (BADGE_PX). */}
						+{Math.min(badge, 99)}
					</span>
				) : null}
			</div>

			<MarkerCard
				open={open}
				anchor={anchorEl}
				commits={group.commits}
				onKeep={onArmLabel}
				onLeave={onLeave}
			/>
		</>
	)
}

function MarkerCard({
	open,
	anchor,
	commits,
	onKeep,
	onLeave,
}: {
	open: boolean
	anchor: HTMLElement | null
	commits: MarkerCommit[]
	onKeep: () => void
	onLeave: () => void
}) {
	if (!anchor) return null
	return (
		<TooltipPrimitive.Root open={open}>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Positioner
					anchor={anchor}
					side="bottom"
					align="center"
					sideOffset={8}
					className="z-[60]"
				>
					<TooltipPrimitive.Popup
						onMouseEnter={onKeep}
						onMouseLeave={onLeave}
						className="border-border/60 bg-popover text-popover-foreground max-h-80 w-80 overflow-y-auto rounded-xl border text-xs shadow-xl"
					>
						{/* One commit ⇒ the rich card. Several ⇒ a compact one-row-per-commit
						    list that stays tidy and scrolls cleanly however many there are. */}
						{commits.length === 1 ? (
							<CommitDetailBody sha={commits[0].sha} compact />
						) : (
							<CommitListBody commits={commits} />
						)}
					</TooltipPrimitive.Popup>
				</TooltipPrimitive.Positioner>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	)
}
