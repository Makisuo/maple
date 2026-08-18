import * as React from "react"

import { formatDurationAtStep } from "../../lib/format"
import { TIME_AXIS_HEIGHT } from "./trace-timeline-types"
import { computeTimeAxisTicks } from "./use-trace-timeline"
import type { ViewportController } from "./use-viewport-controller"

interface TraceTimelineTimeAxisProps {
	controller: ViewportController
	/** Measured width of the timeline column (px) — the tick budget is derived from it. */
	columnWidthPx: number
	/**
	 * Full-height grid element. Ticks are mirrored into it as hairlines behind the rows, from
	 * the same spacing computation, so a label can never drift from its gridline.
	 */
	gridRef?: React.RefObject<HTMLElement | null>
}

/**
 * Time ruler, painted imperatively.
 *
 * Ticks are `document.createElement` nodes mutated in place rather than React children: they
 * change on every zoom frame, and reconciling ~20 nodes per frame is exactly the work the
 * viewport controller exists to avoid. The DOM is diffed by count — append or remove to reach
 * the target, then rewrite text and position on the survivors.
 */
export function TraceTimelineTimeAxis({ controller, columnWidthPx, gridRef }: TraceTimelineTimeAxisProps) {
	const axisRef = React.useRef<HTMLDivElement>(null)
	const widthRef = React.useRef(columnWidthPx)
	widthRef.current = columnWidthPx

	React.useEffect(() => {
		const paint = (vp: { startMs: number; endMs: number }) => {
			const axis = axisRef.current
			if (!axis) return
			const width = widthRef.current
			const { ticks, intervalMs } = computeTimeAxisTicks(vp, controller.traceStartMs, width)
			const visible = vp.endMs - vp.startMs
			const vp0 = vp.startMs - controller.traceStartMs

			syncChildren(axis, ticks.length, () => {
				const el = document.createElement("span")
				el.className =
					"pointer-events-none absolute bottom-1 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] font-medium text-muted-foreground"
				return el
			})
			const grid = gridRef?.current ?? null
			if (grid) {
				syncChildren(grid, ticks.length, () => {
					const el = document.createElement("span")
					el.className = "pointer-events-none absolute inset-y-0 w-px bg-border/40"
					return el
				})
			}

			for (let i = 0; i < ticks.length; i++) {
				const offset = ticks[i]
				const leftPct = ((offset - vp0) / visible) * 100
				const label = axis.children[i] as HTMLElement
				label.style.left = `${leftPct}%`
				const text = formatDurationAtStep(offset, intervalMs)
				// textContent writes are not free at 60fps; most frames only move the ticks.
				if (label.textContent !== text) label.textContent = text
				const line = grid?.children[i] as HTMLElement | undefined
				if (line) line.style.left = `${leftPct}%`
			}
		}
		return controller.subscribe(paint)
	}, [controller, gridRef])

	// A panel resize changes the tick budget without moving the viewport, so nothing would
	// otherwise repaint. Re-commit the current window to drive one pass.
	React.useEffect(() => {
		controller.set(controller.get())
	}, [controller, columnWidthPx])

	return (
		<div
			ref={axisRef}
			className="relative h-full w-full"
			style={{ height: TIME_AXIS_HEIGHT }}
			aria-hidden
		/>
	)
}

/** Grow or shrink `parent` to exactly `count` children, creating new ones with `make`. */
function syncChildren(parent: HTMLElement, count: number, make: () => HTMLElement): void {
	while (parent.children.length > count) parent.removeChild(parent.lastChild as ChildNode)
	while (parent.children.length < count) parent.appendChild(make())
}
