import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import type { ResolvedScale } from "@tanstack/charts"

import { useSuppressChartTooltip } from "@maple/ui/components/plot/floating-tooltip"
import { usePlotRect, usePlotScales, type PlotRect } from "@maple/ui/components/plot/plot-frame"
import { parseBucketMs } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { CommitDetailBody, CommitListBody } from "../commit-sha-hover-card"
import {
	type CommitMarker,
	type LabelGroup,
	type MarkerCommit,
	type PositionedMarker,
	layoutMarkerLabels,
	shouldRenderLabels,
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
const LABEL_HEIGHT = 18
// Distance between the chip's lower edge and the top of the plot. The chip sits ABOVE
// the plot — it overflows out of the chart's top edge into the card's header/padding
// gap rather than reserving an inner margin, so the series keeps its full height. Each
// dash rises through this gap to meet the chip's underside.
//
// Overflowing upward used to cost something: under Recharts this layer lived in a
// `foreignObject`, which only dispatches pointer events inside its own box, so the box
// had to be grown upward by a matching `LABEL_OVERHANG` or a chip drawn above y=0 would
// paint but never hover. `PlotFrame`'s overlay slot is an ordinary DOM sibling with
// visible overflow, so the overhang is pure layout now and the workaround is gone.
const LABEL_GAP = 4
// Hitbox half-width around a dash (so a thin line is still easy to hover).
const DASH_HIT = 5

export interface CommitMarkersLayerProps {
	/** Deploy markers, pre-snapped to chart buckets (see `buildCommitMarkers`). */
	markers: CommitMarker[]
}

export interface CommitMarkersOverlayProps extends CommitMarkersLayerProps {
	/** The plot region, in the overlay's own coordinates. `null` until it resolves. */
	plotRect: PlotRect | null
	/** The chart's resolved x scale. `null` until it resolves. */
	xScale: ResolvedScale | null
}

/**
 * The x value to hand a resolved scale for a marker's bucket string.
 *
 * Recharts placed these charts on a CATEGORICAL x axis, where the bucket string was
 * itself the axis value. The TanStack timeseries plots on a real time scale over
 * `Date`s, so the same string has to be parsed first. Which shape a given chart wants
 * is read off the scale's own domain rather than its `type`: `type` is the opaque
 * `"configured"` for any scale a chart supplied itself, which says nothing about the
 * value shape, while the domain is always a sample of what the scale accepts.
 */
function scaleInputForBucket(bucket: string, scale: ResolvedScale): Date | number | string | null {
	const sample = scale.domain[0]
	// An empty domain means the chart resolved no data; there is nothing to align to.
	if (sample === undefined) return null
	if (typeof sample === "string") return bucket
	const ms = parseBucketMs(bucket)
	if (ms === null) return null
	return sample instanceof Date ? new Date(ms) : ms
}

/**
 * Renders commit deploy markers (dashed verticals + labels + hover cards) over a
 * time-series chart. Mounted through `PlotFrame`'s `overlay` slot; one instance per
 * chart, each owning its own hover state.
 *
 * The geometry arrives as PROPS rather than being read here, so the whole layout — the
 * one thing that actually broke in the port — can be exercised at known pixel values.
 * `CommitMarkersLayer` below is the connector that supplies them from the frame.
 */
export function CommitMarkersOverlay({ markers, plotRect, xScale }: CommitMarkersOverlayProps) {
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

	const { groups, labeled } = useMemo(() => {
		if (!xScale || !plotRect || markers.length === 0) return { groups: [] as LabelGroup[], labeled: true }
		const positioned: PositionedMarker[] = []
		for (const marker of markers) {
			const input = scaleInputForBucket(marker.bucket, xScale)
			if (input === null) continue
			const x = xScale.map(input)
			if (Number.isFinite(x)) {
				positioned.push({ marker, x })
			}
		}
		positioned.sort((a, b) => a.x - b.x)
		const plotLeft = plotRect.x
		const plotRight = plotRect.x + plotRect.width
		if (!shouldRenderLabels(positioned, plotLeft, plotRight)) {
			// Dashes-only mode: no label merging — every marker keeps its own dash and
			// hover card (a zero-width "box" makes the card anchor sit on the dash).
			return {
				groups: positioned.map(
					(p): LabelGroup => ({
						key: p.marker.bucket,
						dashXs: [p.x],
						label: p.marker.label,
						commits: [...p.marker.commits],
						boxLeft: p.x,
						boxWidth: 0,
					}),
				),
				labeled: false,
			}
		}
		return { groups: layoutMarkerLabels(positioned, plotLeft, plotRight), labeled: true }
	}, [markers, xScale, plotRect])

	if (!plotRect || groups.length === 0) return null

	// Once a card is OPEN, the layer swallows pointer events over the whole plot so they
	// never reach the chart underneath — no focus ring or crosshair fighting the commit
	// card. While merely hovering (before the card opens) or idle it stays transparent so
	// the plot still drives the chart's own focus and tooltip.
	//
	// This is a plain `pointer-events` gate now. Under Recharts it also needed
	// `stopPropagation` on every hitbox, because Recharts listened with REACT handlers on
	// an ancestor of the overlay and so saw the synthetic event bubble up the React tree.
	// The TanStack renderer binds native listeners to its own container element, which is
	// a sibling of this layer rather than an ancestor, so an event this layer takes never
	// reaches the chart in the first place.
	const blockChart = openKey !== null

	return (
		<div
			data-commit-markers=""
			className={cn("absolute inset-0", blockChart ? "pointer-events-auto" : "pointer-events-none")}
		>
			{groups.map((group) => (
				<MarkerGroup
					key={group.key}
					group={group}
					plotTop={plotRect.y}
					plotHeight={plotRect.height}
					showLabel={labeled}
					active={hoverKey === group.key || openKey === group.key}
					open={openKey === group.key}
					onArmLine={() => arm(group.key, LINE_OPEN_DELAY)}
					onArmLabel={() => arm(group.key, LABEL_OPEN_DELAY)}
					onLeave={scheduleClose}
				/>
			))}
		</div>
	)
}

/**
 * Binds the overlay to the enclosing `PlotFrame`.
 *
 * Both hooks publish from the chart's RENDER CALLBACK rather than from render, so this
 * component is always one store notification behind the scene it annotates, and both
 * return `null` outside a frame or before the first render. Neither is an error state —
 * the overlay simply draws nothing until the plot has a shape.
 */
export function CommitMarkersLayer({ markers }: CommitMarkersLayerProps) {
	const scales = usePlotScales()
	const plotRect = usePlotRect()
	return <CommitMarkersOverlay markers={markers} plotRect={plotRect} xScale={scales?.x ?? null} />
}

interface MarkerGroupProps {
	group: LabelGroup
	plotTop: number
	plotHeight: number
	/** False in dashes-only (dense) mode: the label chip is skipped and each dash
	 * spans exactly the plot height, hover cards remaining the detail path. */
	showLabel: boolean
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
	showLabel,
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
	// Without a label there's nothing to connect to, so the dash spans the plot exactly.
	const dashTop = showLabel ? plotTop - LABEL_GAP : plotTop
	const dashHeight = showLabel ? Math.max(plotHeight + LABEL_GAP, 0) : plotHeight
	const badge = group.commits.length - 1
	// The card anchors under the centre of the label box (the cluster's visual centre),
	// not on any one dash, since a merged group has several.
	const anchorX = group.boxLeft + group.boxWidth / 2

	const dashColor = active ? "var(--foreground)" : "var(--muted-foreground)"

	return (
		<>
			{group.dashXs.map((x, i) => (
				// `pointer-events-auto`: the layer above is `pointer-events-none` while idle
				// so the plot keeps its own hover, and each annotation opts back in.
				<div
					key={`${group.key}-dash-${i}`}
					data-commit-marker-dash=""
					className="pointer-events-auto"
					onMouseEnter={onArmLine}
					onMouseLeave={onLeave}
					style={{
						position: "absolute",
						left: x - DASH_HIT,
						top: dashTop,
						width: DASH_HIT * 2,
						height: dashHeight,
						display: "flex",
						justifyContent: "center",
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

			{showLabel ? (
				<div
					data-commit-marker-label=""
					onMouseEnter={onArmLabel}
					onMouseLeave={onLeave}
					style={{
						position: "absolute",
						left: group.boxLeft,
						top: labelTop,
						// Render at exactly the laid-out width (NOT w-fit) so the pill matches the
						// box the placement math reserved — every owned dash sits under it and its
						// vertical connects. Text is centered and truncates within.
						width: group.boxWidth,
						height: LABEL_HEIGHT,
					}}
					className={cn(
						"pointer-events-auto flex cursor-pointer items-center justify-center gap-1 rounded-[5px] border px-1.5 font-mono text-[11px] leading-none backdrop-blur-sm transition-colors",
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
			) : null}

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
