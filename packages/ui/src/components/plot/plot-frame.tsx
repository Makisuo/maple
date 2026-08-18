/// <reference types="vite/client" />
import { CanvasChart, Chart as SvgChart } from "@tanstack/charts/react/tooltip"
import type { ChartTooltipBodyRenderContext } from "@tanstack/charts/react/tooltip"
import type { ChartBounds, ChartPoint, ChartScene, ChartValue, DomChartDefinition } from "@tanstack/charts"
import {
	createContext,
	use,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react"

import { cn } from "../../lib/utils"
import { assertResolvedColors } from "./plot-colors-guard"

// The tooltip shell theming. Imported HERE rather than from `plot-tooltip.tsx`
// because a chart can build its own tooltip config without going through
// `cursorTooltip` (polar, hexbin, sankey and treemap all do) but no chart can
// skip the frame.
import "./plot-tooltip.css"

export type PlotRenderer = "svg" | "canvas"

/**
 * Only the HEIGHT is measured, and that is the documented shape.
 *
 * An earlier revision measured both axes and passed both to `<Chart>`, with a
 * comment claiming the component "has no intrinsic sizing". That was wrong, and
 * it caused a mount flash: `width` is optional, and the host renders
 * `width: width === undefined ? "100%" : width` (`dist/react/RendererChart.js`),
 * so omitting it makes the chart follow its container. The renderer then
 * installs its OWN `ResizeObserver` on the container (`dist/renderer.js:151`)
 * and — this is the part that matters — `adapter.mount()` runs inside a layout
 * effect and `createScene()` reads `container.getBoundingClientRect().width`
 * synchronously there (`dist/renderer.js:659`), so the first paint is already
 * correctly sized.
 *
 * Taking that over meant gating the chart behind our own observer, whose first
 * record only arrives during a LATER frame's rendering steps: mount → paint an
 * empty card → observer fires → re-render → paint the chart. Two blank frames
 * minimum, each with its own commit.
 *
 * The guide is explicit — omit `width` to follow the container, and choose
 * `height` OR `aspectRatio` but never both:
 * https://tanstack.com/charts/v0/docs/guides/responsive-charts
 *
 * `height` still has to be a number, because the scene height comes from
 * `options.height ?? 320` and is never read back off the container
 * (`dist/renderer.js:664`) — a CSS `height: 100%` would give a full-height host
 * drawing a 320px scale. These charts live in a flex column whose spare height
 * depends on whether a legend wrapped, so the number has to be measured.
 */
function useMeasuredHeight() {
	const ref = useRef<HTMLDivElement | null>(null)
	const [height, setHeight] = useState<number | null>(null)

	useLayoutEffect(() => {
		const node = ref.current
		if (!node) return

		// Round: sub-pixel churn would rebuild the whole scene on every container
		// reflow and pollute React commit counts.
		const apply = (next: number) => {
			const rounded = Math.round(next)
			setHeight((prev) => (prev === rounded ? prev : rounded))
		}

		// Synchronously first — a `setState` in a LAYOUT effect is flushed before
		// the browser paints, so the measured height lands in the first paint
		// rather than one observer delivery later.
		const box = node.getBoundingClientRect()
		if (box.height > 0) apply(box.height)

		const observer = new ResizeObserver((entries) => {
			const contentRect = entries[0]?.contentRect
			if (contentRect) apply(contentRect.height)
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])

	return { ref, height }
}

/**
 * What to draw at before the first measurement resolves. It is the package's own
 * default height, and it is a fallback rather than a guess that has to be right:
 * the layout effect above corrects it pre-paint. What it buys is that the chart
 * is never gated on a measurement at all, so no code path can reintroduce a
 * blank first frame.
 */
const FALLBACK_HEIGHT = 320

/**
 * The resolved plot rect — the region inside the axes — published for consumers
 * that have to align to it.
 *
 * A STORE, not state. `onRender` fires outside React's render phase on every
 * scene update, so calling `setState` there would add a commit per pointer tick
 * to the hottest path in the chart layer. `useSyncExternalStore` costs nothing
 * for the charts that never read it, and the anchor element below is positioned
 * imperatively so the perf specs' locator needs no subscriber at all.
 */
export interface PlotRect {
	x: number
	y: number
	width: number
	height: number
}

export interface PlotRectStore {
	subscribe: (listener: () => void) => () => void
	getSnapshot: () => PlotRect | null
}

const PlotRectContext = createContext<PlotRectStore | null>(null)

/**
 * The plot rect of the nearest enclosing `PlotFrame`, or `null` outside one.
 *
 * This is the replacement for Recharts' `usePlotArea()`. The difference that
 * matters: Recharts handed it to you inside the chart's React tree during
 * render; here it arrives from a render callback, so a consumer is always one
 * store notification behind the scene it describes.
 */
export function usePlotRect(): PlotRect | null {
	const store = use(PlotRectContext)
	return useSyncExternalStore(
		store?.subscribe ?? noopSubscribe,
		store?.getSnapshot ?? nullSnapshot,
		nullSnapshot,
	)
}

const noopSubscribe = () => () => {}
const nullSnapshot = () => null

function createPlotRectStore(): PlotRectStore & { set: (next: ChartBounds) => void } {
	let snapshot: PlotRect | null = null
	const listeners = new Set<() => void>()

	return {
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		// Returns the CACHED object, never a fresh literal — `useSyncExternalStore`
		// compares snapshots by identity and would loop forever on a new one.
		getSnapshot: () => snapshot,
		set: (next) => {
			if (
				snapshot &&
				snapshot.x === next.x &&
				snapshot.y === next.y &&
				snapshot.width === next.width &&
				snapshot.height === next.height
			) {
				return
			}
			snapshot = { x: next.x, y: next.y, width: next.width, height: next.height }
			for (const listener of listeners) listener()
		},
	}
}

/**
 * Whether this environment can actually paint to a canvas.
 *
 * The canvas renderer calls `getContext("2d")` during mount and THROWS when it
 * comes back null. That is not only a test concern — jsdom has no 2D context, so
 * every canvas chart would take a component test down with it — but the same
 * hole exists anywhere a 2D context is unavailable. Probing once and degrading
 * to the SVG renderer keeps the chart rendering instead of throwing, and the two
 * renderers take the identical definition, so nothing else changes.
 *
 * Lazy and cached: `document` may not exist at module-eval time under SSR, and
 * the answer cannot change within a document.
 */
let canvasSupport: boolean | null = null

function supportsCanvas2d(): boolean {
	if (canvasSupport !== null) return canvasSupport
	if (typeof document === "undefined") {
		// Server render: no canvas, and the SVG renderer is the one with complete
		// server output anyway.
		return false
	}
	try {
		canvasSupport = document.createElement("canvas").getContext("2d") != null
	} catch {
		canvasSupport = false
	}
	return canvasSupport
}

export interface PlotFrameProps<TDatum, TXValue extends ChartValue, TYValue extends ChartValue> {
	definition: DomChartDefinition<TDatum, TXValue, TYValue>
	ariaLabel: string
	/**
	 * Canvas by default. It does ~3.3x less React render work than Recharts and
	 * beats the SVG renderer, and it is the only renderer where `whenFocused`'s
	 * emit-a-node-per-datum behaviour costs nothing.
	 *
	 * Choose `"svg"` only for a stated reason: a CSS animation on a mark (the
	 * infra threshold line's draw-in), or the `motion()` renderer, which is SVG
	 * only and throws if it cannot find an `svg.ts-chart` root.
	 */
	renderer?: PlotRenderer
	className?: string
	renderTooltipBody?: (context: ChartTooltipBodyRenderContext<TDatum, TXValue, TYValue>) => ReactNode
	/**
	 * A DOM legend rendered beneath the plot.
	 *
	 * The strip is a flex SIBLING of the measured chart box rather than a height
	 * subtracted from it. That matters: the existing `ResizeObserver` then reports
	 * whatever the legend left over, so a legend that rewraps to a second row on
	 * toggle re-measures the plot with no arithmetic and no second observer.
	 */
	legend?: ReactNode
	/**
	 * Fires when the focused datum CHANGES — not on every pointer move — so a
	 * chart can drive a React-side hover affordance without a commit per tick.
	 *
	 * Polar marks take no `states`, so the only way to react to hover there is to
	 * rebuild the definition; that is only affordable because this is
	 * edge-triggered.
	 */
	onFocusChange?: (point: ChartPoint<TDatum, TXValue, TYValue> | null) => void
	/**
	 * A caption strip below the legend — e.g. a heatmap's "N empty columns hidden"
	 * footnote. A SIBLING of the measured plot for the same reason `legend` is.
	 */
	footer?: ReactNode
}

/**
 * One frame, one renderer. `@tanstack/charts/react/tooltip` exports the SVG and
 * Canvas components with an identical prop surface, so the two arms differ only
 * in which component is mounted — the definition is the same object.
 *
 * Keyboard navigation is NOT wired here on purpose: the library enables it by
 * default and computes `tabIndex` itself (`dist/adapter-shared.js:11` opts out
 * only on `keyboard: false`, `focus: false`, or a free-mode cursor). Setting
 * `tabIndex` from here would fight that.
 */
export function PlotFrame<TDatum, TXValue extends ChartValue, TYValue extends ChartValue>({
	definition,
	ariaLabel,
	renderer = "canvas",
	className,
	renderTooltipBody,
	legend,
	onFocusChange,
	footer,
}: PlotFrameProps<TDatum, TXValue, TYValue>) {
	const { ref, height } = useMeasuredHeight()
	const anchorRef = useRef<HTMLDivElement | null>(null)
	const rectStore = useMemo(createPlotRectStore, [])

	if (import.meta.env.DEV) assertResolvedColors(definition, ariaLabel)

	/**
	 * Positions the plot anchor imperatively and publishes the rect.
	 *
	 * The anchor exists because every perf spec and every alignment check needs a
	 * DOM handle on the plot region, and Recharts gave one away for free as
	 * `.recharts-cartesian-grid`. Writing it from `onRender` rather than from
	 * React keeps it free: no state, no commit, no subscriber required.
	 */
	const handleRender = useCallback(
		(context: { scene: ChartScene<TDatum, TXValue, TYValue> }) => {
			const bounds = context.scene.chart
			const node = anchorRef.current
			if (node) {
				node.style.transform = `translate(${bounds.x}px, ${bounds.y}px)`
				node.style.width = `${bounds.width}px`
				node.style.height = `${bounds.height}px`
			}
			rectStore.set(bounds)
		},
		[rectStore],
	)

	const ChartComponent = renderer === "canvas" && supportsCanvas2d() ? CanvasChart : SvgChart

	return (
		<PlotRectContext value={rectStore}>
			{/*
			 * `select-none`: a chart is a figure, not prose. Without it, dragging the
			 * pointer across one — which is exactly what hovering a timeseries looks
			 * like — starts a text selection and paints the browser's selection
			 * highlight over the whole `<svg>`/`<canvas>`.
			 */}
			<div data-chart-host={renderer} className={cn("flex flex-col select-none", className)}>
				{/*
				 * `min-h-0` is load-bearing on a flex child: a flex item's default
				 * `min-height: auto` refuses to shrink below its content, and the chart's
				 * content is whatever height it was last measured at — so without this the
				 * plot ratchets and pushes the legend out of the card instead of yielding
				 * to it.
				 */}
				<div ref={ref} className="relative min-h-0 flex-1">
					{/*
					 * No `width`, deliberately — see `useMeasuredHeight`. The host takes
					 * `width: 100%` and measures itself before first paint. Rendering is
					 * not gated on a measurement either: `FALLBACK_HEIGHT` covers the
					 * frame before the layout effect resolves.
					 */}
					<ChartComponent
						definition={definition}
						ariaLabel={ariaLabel}
						height={height ?? FALLBACK_HEIGHT}
						renderTooltipBody={renderTooltipBody}
						onFocusChange={onFocusChange}
						onRender={handleRender}
					/>
					{/*
					 * `pointer-events-none` and empty: this is a measurement handle, not a
					 * layer. Anything that needs to PAINT over the plot belongs in the
					 * definition as a mark, where it participates in scale resolution.
					 */}
					<div
						ref={anchorRef}
						data-chart-plot=""
						aria-hidden="true"
						className="pointer-events-none absolute top-0 left-0"
					/>
				</div>
				{/*
				 * `max-h-[45%]` is the legend ceiling that keeps a long series list from
				 * starving the plot, expressed as a CSS cap rather than pixel arithmetic.
				 * Recharts needed a computed number because it wants an explicit
				 * `<Legend height>`; here flexbox already does the division.
				 */}
				{legend ? <div className="max-h-[45%] shrink-0 overflow-auto">{legend}</div> : null}
				{footer ? <div className="shrink-0">{footer}</div> : null}
			</div>
		</PlotRectContext>
	)
}
