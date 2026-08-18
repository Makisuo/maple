import type { CSSProperties, MouseEvent, PointerEvent, RefObject } from "react"
import { useRef } from "react"

/**
 * Linked cursor for a container of independent plots, under either renderer.
 *
 * Recharts' own `syncId` synchronizes charts through its event bus: every
 * pointer move re-renders every synced chart's tooltip store (a render storm on
 * grids of 4+ charts). This hook keeps each chart fully independent and instead
 * paints a lightweight CSS-variable-driven cursor line across the sibling
 * plots — pointer moves only touch DOM style properties, never React state.
 *
 * Usage:
 * - Spread `containerProps` on the element that wraps all linked charts.
 * - Mark each chart's positioned wrapper (the element containing the plot) with
 *   {@link linkedCursorChartProps} and render a {@link LinkedCursorOverlay}
 *   inside it, absolutely positioned against it.
 *
 * The overlay is aligned to each chart's own plot rect when the pointer enters
 * the container, so charts with different y-axis widths and margins all show
 * the cursor at the same time-bucket ratio — no chart has to be told what width
 * its neighbours resolved to. The hovered chart keeps its own native
 * cursor+tooltip (its overlay is hidden via the `data-linked-cursor-source`
 * marker); siblings show the CSS line.
 */

export const LINKED_CURSOR_CHART_ATTR = "data-linked-cursor-chart"
const CHART_SELECTOR = `[${LINKED_CURSOR_CHART_ATTR}]`
const OVERLAY_SELECTOR = "[data-linked-cursor-overlay]"
/**
 * The plot rect — the region inside the axes — under either renderer. Recharts
 * paints `.recharts-cartesian-grid`; `PlotFrame` positions an aria-hidden
 * `[data-chart-plot]` over the same box from its render callback.
 *
 * Mirrors `apps/web/perf/plot-locator.ts`, which the Playwright specs import.
 * Deliberately duplicated rather than shared: `perf/` is a separate Playwright
 * project outside the app's `src` graph, and reaching across that boundary to
 * save one string would put test-harness code in the production bundle's import
 * graph.
 */
const PLOT_SELECTOR = "[data-chart-plot], .recharts-cartesian-grid"
const TOOLTIP_UPDATE_INTERVAL_MS = 1000 / 30

interface LinkedCursorStyle extends CSSProperties {
	"--linked-cursor-ratio": number
	"--linked-cursor-visible": number
}

const LINKED_CURSOR_STYLE: LinkedCursorStyle = {
	"--linked-cursor-ratio": 0,
	"--linked-cursor-visible": 0,
}

export interface LinkedCursorContainerProps {
	style: CSSProperties | undefined
	onPointerEnter: (event: PointerEvent<HTMLElement>) => void
	onMouseMoveCapture: (event: MouseEvent<HTMLElement>) => void
	onPointerMove: (event: PointerEvent<HTMLElement>) => void
	onPointerLeave: (event: PointerEvent<HTMLElement>) => void
}

/** Marks a chart wrapper as a linked-cursor participant. Pass `undefined` to opt out. */
export function linkedCursorChartProps(chartId: string | undefined): Record<string, string> {
	return chartId == null ? {} : { [LINKED_CURSOR_CHART_ATTR]: chartId }
}

function setCursorSource(activeChartRef: RefObject<HTMLElement | null>, nextChart: HTMLElement | null) {
	if (activeChartRef.current === nextChart) return

	activeChartRef.current?.querySelector<HTMLElement>(OVERLAY_SELECTOR)?.removeAttribute("hidden")
	activeChartRef.current?.removeAttribute("data-linked-cursor-source")

	activeChartRef.current = nextChart
	nextChart?.setAttribute("data-linked-cursor-source", "")
	nextChart?.querySelector<HTMLElement>(OVERLAY_SELECTOR)?.setAttribute("hidden", "")
}

function hideLinkedCursor(container: HTMLElement, activeChartRef: RefObject<HTMLElement | null>) {
	container.style.setProperty("--linked-cursor-visible", "0")
	setCursorSource(activeChartRef, null)
}

/**
 * Snap every overlay onto its chart's plot rect. Runs on container pointer
 * enter — the cursor is only visible while hovering, so that is the only
 * moment alignment matters, and it keeps per-pointer-move work at zero reads.
 */
function alignOverlays(container: HTMLElement) {
	const placements: Array<{
		overlay: HTMLElement
		left: number
		top: number
		width: number
		height: number
	}> = []
	for (const chart of container.querySelectorAll<HTMLElement>(CHART_SELECTOR)) {
		const overlay = chart.querySelector<HTMLElement>(OVERLAY_SELECTOR)
		const plot = chart.querySelector<Element>(PLOT_SELECTOR)
		const host = overlay?.offsetParent
		if (!overlay || !plot || !(host instanceof HTMLElement)) continue
		const plotBounds = plot.getBoundingClientRect()
		if (plotBounds.width === 0) continue
		const hostBounds = host.getBoundingClientRect()
		placements.push({
			overlay,
			left: plotBounds.left - hostBounds.left - host.clientLeft,
			top: plotBounds.top - hostBounds.top - host.clientTop,
			width: plotBounds.width,
			height: plotBounds.height,
		})
	}
	for (const { overlay, left, top, width, height } of placements) {
		overlay.style.left = `${left}px`
		overlay.style.top = `${top}px`
		overlay.style.width = `${width}px`
		overlay.style.height = `${height}px`
	}
}

export function useLinkedCursor(enabled: boolean): { containerProps: LinkedCursorContainerProps } {
	const activeChartRef = useRef<HTMLElement | null>(null)
	const lastTooltipUpdateRef = useRef(0)

	const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
		if (!enabled) return
		alignOverlays(event.currentTarget)
	}

	const handleMouseMoveCapture = (event: MouseEvent<HTMLElement>) => {
		if (!enabled) return

		const elapsed = event.timeStamp - lastTooltipUpdateRef.current
		if (lastTooltipUpdateRef.current === 0 || elapsed >= TOOLTIP_UPDATE_INTERVAL_MS) {
			lastTooltipUpdateRef.current = event.timeStamp
			return
		}

		// Recharts handles mouse movement through React's BUBBLE phase, on an
		// ancestor of the plot, so stopping the synthetic event here keeps the
		// hovered Recharts chart's tooltip store at 30 updates/sec while the CSS
		// cursor stays at pointer-event speed.
		//
		// This does nothing for a TanStack chart, and does not need to: its renderer
		// binds NATIVE `pointermove` listeners to its own container
		// (`dist/renderer.js`, `dist/interaction-cursor.js`), a sibling of this React
		// tree — a synthetic `mousemove` stopped in React's capture phase never
		// reaches a native listener on a descendant element, and TanStack's tooltip
		// is imperative rather than React state, so there is no store to throttle.
		// The throttle survives because the infra grids (host metrics, k8s workloads,
		// the correlation panel) are still Recharts and still linked.
		event.stopPropagation()
	}

	const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
		if (!enabled) return

		const target = event.target
		const chart = target instanceof Element ? target.closest<HTMLElement>(CHART_SELECTOR) : null
		const plot = chart?.querySelector<Element>(PLOT_SELECTOR)
		if (!chart || !plot || !event.currentTarget.contains(chart)) {
			hideLinkedCursor(event.currentTarget, activeChartRef)
			return
		}

		const bounds = plot.getBoundingClientRect()
		const insidePlot =
			event.clientX >= bounds.left &&
			event.clientX <= bounds.right &&
			event.clientY >= bounds.top &&
			event.clientY <= bounds.bottom
		if (!insidePlot || bounds.width === 0) {
			hideLinkedCursor(event.currentTarget, activeChartRef)
			return
		}

		const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
		setCursorSource(activeChartRef, chart)
		event.currentTarget.style.setProperty("--linked-cursor-ratio", String(ratio))
		event.currentTarget.style.setProperty("--linked-cursor-visible", "1")
	}

	const handlePointerLeave = (event: PointerEvent<HTMLElement>) => {
		if (!enabled) return
		lastTooltipUpdateRef.current = 0
		hideLinkedCursor(event.currentTarget, activeChartRef)
	}

	return {
		containerProps: {
			style: enabled ? LINKED_CURSOR_STYLE : undefined,
			onPointerEnter: handlePointerEnter,
			onMouseMoveCapture: handleMouseMoveCapture,
			onPointerMove: handlePointerMove,
			onPointerLeave: handlePointerLeave,
		},
	}
}

/**
 * The cursor line painted over sibling charts. Render inside a positioned
 * chart wrapper carrying {@link linkedCursorChartProps}; `alignOverlays`
 * positions it over the plot area on hover.
 */
export function LinkedCursorOverlay({ chartId }: { chartId: string }) {
	return (
		<div
			aria-hidden="true"
			data-linked-cursor-overlay={chartId}
			className="pointer-events-none absolute"
			style={{
				containerType: "inline-size",
				opacity: "var(--linked-cursor-visible)",
			}}
		>
			<div
				className="absolute inset-y-0 left-0 w-px bg-border will-change-transform"
				style={{
					transform: "translateX(calc(var(--linked-cursor-ratio) * (100cqw - 1px)))",
				}}
			/>
		</div>
	)
}
