/// <reference types="vite/client" />
import { CanvasChart, Chart as SvgChart } from "@tanstack/charts/react/tooltip"
import type { ChartTooltipBodyRenderContext } from "@tanstack/charts/react/tooltip"
import type {
	ChartBounds,
	ChartPoint,
	ChartScene,
	ChartValue,
	DomChartDefinition,
	ResolvedScale,
} from "@tanstack/charts"
import {
	createContext,
	use,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react"

import { cn } from "../../lib/utils"
import { warnUnresolvedColors } from "./plot-colors-guard"

// The tooltip shell theming. Imported HERE rather than from `plot-tooltip.tsx`
// because a chart can build its own tooltip config without going through
// `cursorTooltip` (polar, hexbin, sankey and treemap all do) but no chart can
// skip the frame.
import "./plot-tooltip.css"

export type PlotRenderer = "svg" | "canvas"

/**
 * `maxFocusDistance` for a chart that must resolve focus ANYWHERE in the plot.
 *
 * The renderer caps focus at 48px from the resolved point
 * (`dist/renderer.js:764`), which is a sensible default for a scatter and wrong
 * for a bucketed series: Recharts snapped to the nearest bucket wherever the
 * pointer was, so a 7-day board at day buckets (7 points across ~800px, 133px
 * apart) now has dead gaps between every column where the tooltip, the crosshair
 * and the focus dot all disappear.
 *
 * A very large FINITE cap rather than `Infinity`. The two resolve identically
 * today, and the finite one is the safer statement of it: the renderer squares
 * this value and subtracts it while ranking candidates (`dist/nearest.js`), and
 * a finite number cannot fall out of that arithmetic as `NaN`.
 */
export const UNBOUNDED_FOCUS_DISTANCE = Number.MAX_SAFE_INTEGER

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
 * The chart's RESOLVED scales — `{ x, y, … }` keyed by scale id, each with the
 * `map(value) => pixel` the marks were painted with.
 *
 * This is the replacement for Recharts' `useXAxisScale()`, and it is what lets
 * an overlay place DOM at a data coordinate. It rides the same store mechanism
 * as `PlotRect` and for the same reason: `onRender` runs outside React's render
 * phase, so publishing through state would cost a commit per pointer tick.
 */
export type PlotScales = Readonly<Record<string, ResolvedScale>>

export interface PlotScalesStore {
	subscribe: (listener: () => void) => () => void
	getSnapshot: () => PlotScales | null
}

const PlotScalesContext = createContext<PlotScalesStore | null>(null)

/**
 * The resolved scales of the nearest enclosing `PlotFrame`, or `null` outside
 * one. Pair it with `usePlotRect()` — a scale maps a value to a plot-relative
 * pixel, so the rect is what turns that into a position in the overlay.
 */
export function usePlotScales(): PlotScales | null {
	const store = use(PlotScalesContext)
	return useSyncExternalStore(
		store?.subscribe ?? noopSubscribe,
		store?.getSnapshot ?? nullSnapshot,
		nullSnapshot,
	)
}

/**
 * `Date` domains are rebuilt per scene, so identity comparison would report a
 * change on every pointer tick even when nothing moved.
 */
function sameChartValue(a: ChartValue, b: ChartValue): boolean {
	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
	return Object.is(a, b)
}

function sameDomain(a: readonly ChartValue[], b: readonly ChartValue[]): boolean {
	if (a.length !== b.length) return false
	for (let index = 0; index < a.length; index += 1) {
		const left = a[index]
		const right = b[index]
		if (left === undefined || right === undefined) {
			if (left !== right) return false
			continue
		}
		if (!sameChartValue(left, right)) return false
	}
	return true
}

/**
 * Whether two resolved scale maps are INTERCHANGEABLE — not identical objects.
 *
 * The scene hands back a fresh `scales` record on every update, including every
 * hover tick, so publishing it by identity would notify subscribers constantly.
 * A scale's `map` is a pure function of its domain and its range, so when the
 * descriptors below all match, the cached snapshot's older closure returns the
 * same pixel for the same value and may be kept.
 *
 * `viewport` is included because a pan or zoom shifts the mapping while leaving
 * the content domain alone — that is exactly the case a naive domain-only check
 * would miss. The plot bounds are the other half of the range and are compared
 * by the store, which sees them on the same callback.
 *
 * Exported for its own tests: getting this wrong is silent, and shows up only as
 * either a stale overlay or a per-tick render storm.
 */
export function plotScalesInterchangeable(a: PlotScales | null, b: PlotScales): boolean {
	if (a === null) return false
	const aKeys = Object.keys(a)
	const bKeys = Object.keys(b)
	if (aKeys.length !== bKeys.length) return false

	for (const key of aKeys) {
		const left = a[key]
		const right = b[key]
		if (left === undefined || right === undefined) return false
		if (left.id !== right.id || left.type !== right.type) return false
		if (left.bandwidth !== right.bandwidth) return false
		if (!sameDomain(left.domain, right.domain)) return false

		const leftViewport = left.viewport
		const rightViewport = right.viewport
		if ((leftViewport === undefined) !== (rightViewport === undefined)) return false
		if (leftViewport && rightViewport) {
			if (leftViewport.translate !== rightViewport.translate) return false
			if (!sameDomain(leftViewport.domain, rightViewport.domain)) return false
		}
	}
	return true
}

function createPlotScalesStore(): PlotScalesStore & {
	set: (next: PlotScales, bounds: ChartBounds) => void
} {
	let snapshot: PlotScales | null = null
	let boundsKey: string | null = null
	const listeners = new Set<() => void>()

	return {
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		getSnapshot: () => snapshot,
		set: (next, bounds) => {
			// The bounds ARE the scales' range, so a resize changes every mapping
			// even when the domains are untouched.
			const nextBoundsKey = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
			if (boundsKey === nextBoundsKey && plotScalesInterchangeable(snapshot, next)) return
			boundsKey = nextBoundsKey
			snapshot = next
			for (const listener of listeners) listener()
		},
	}
}

/**
 * One entry in a hoisted legend — the same `{ key, label, colour }` triple the
 * in-plot legend draws, in the shape the host strip consumes.
 */
export interface PlotLegendItem {
	key: string
	label: ReactNode
	color?: string
	/**
	 * Draw the swatch as a dashed outline rather than a filled square, matching
	 * the stroke the series is painted with.
	 *
	 * Carried rather than rendered here — the host strip owns the chip — but it
	 * has to be carried, because a header that draws every series solid states
	 * something FALSE about a chart whose error line is dashed. That mismatch is
	 * why the fixed-metric charts refused to hoist at all while they had an error
	 * series, and kept an under-plot strip nobody wanted on a dashboard tile.
	 */
	dashed?: boolean
}

/**
 * A slot an ancestor opens to say "I will draw this chart's legend myself".
 *
 * The dashboard card header is the only consumer today: a board tile hides the
 * in-plot legend to keep the plot tall, and prints `api • web • worker` beside
 * the title instead, which is the only thing telling a reader which line is
 * which.
 *
 * Declared HERE rather than reused from `components/ui/chart.tsx`, whose
 * identical slot serves the Recharts `ChartContainer`. That module imports
 * `recharts` at the top, so importing its context would pull the whole library
 * into every plot chart's graph — the opposite of what the port is for. A host
 * that wants to serve both mounts both providers over one piece of state; they
 * cannot both fire, because a tile holds one chart.
 */
export interface PlotLegendSlot {
	setItems: (items: readonly PlotLegendItem[]) => void
}

export const PlotLegendSlotContext = createContext<PlotLegendSlot | null>(null)

/**
 * Whether two published legends say the SAME thing.
 *
 * `label` is a `ReactNode` and is compared by identity, which is exact for the
 * strings every chart actually passes and errs toward republishing for an
 * element — the safe direction, since a missed publish is a stale header while a
 * spurious one is a single extra commit.
 */
function sameLegendItems(a: readonly PlotLegendItem[], b: readonly PlotLegendItem[]): boolean {
	if (a === b) return true
	if (a.length !== b.length) return false
	for (let index = 0; index < a.length; index += 1) {
		const left = a[index]
		const right = b[index]
		if (left === undefined || right === undefined) {
			if (left !== right) return false
			continue
		}
		if (left.key !== right.key) return false
		if (left.color !== right.color) return false
		if (left.dashed !== right.dashed) return false
		if (!Object.is(left.label, right.label)) return false
	}
	return true
}

/** Stable empty reference, so clearing the slot cannot loop the publish effect. */
const NO_LEGEND_ITEMS: readonly PlotLegendItem[] = []

/**
 * Publishes a chart's series into an enclosing legend slot, if one is open.
 *
 * An effect, because this writes into state that an ANCESTOR owns — the one
 * case where a render-phase write is not available. Publishing is guarded by
 * CONTENT rather than by array identity, because identity alone made an
 * unmemoised caller a hang rather than a slow path: a fresh `items` array per
 * render republishes, the host's `setState` re-renders the chart, and the chart
 * builds another fresh array. `mapSeries` passed inline was one arrow function
 * away from that loop, with only a doc comment holding the line.
 *
 * Memoising `items` is still worth doing — it skips the effect entirely rather
 * than skipping its body — but it is no longer load-bearing.
 *
 * Pass `null` when the chart draws its own legend, so the header does not
 * duplicate what the plot already shows.
 *
 * Returns whether the items were HOISTED — a slot was open and was handed a
 * list. That is what lets a chart decide whether to also draw its own strip,
 * which is a different answer in the two places the same chart renders: inside a
 * dashboard tile the strip duplicates the card header, and on the service detail
 * page, where no shell opens a slot, dropping it loses the legend outright.
 *
 * Derived from the context and the argument, never from the published state:
 * the publish runs in an effect, so a value read back out of it would be a frame
 * late and would flash the strip on first paint before withdrawing it. Both
 * inputs here are known during render.
 */
export function usePlotLegendSlot(items: readonly PlotLegendItem[] | null): boolean {
	const slot = use(PlotLegendSlotContext)
	// What the slot was last handed, so an equal republish can be skipped. A ref
	// rather than state: nothing renders off it.
	const published = useRef<readonly PlotLegendItem[] | null>(null)

	useEffect(() => {
		if (!slot) return
		const next = items ?? NO_LEGEND_ITEMS
		if (published.current === next) return  // TEMP: identity-only, the old behaviour
		published.current = next
		slot.setItems(next)
	}, [slot, items])

	// Clearing is keyed on the SLOT alone, deliberately. Folding it into the
	// publish effect above would make every `items` change a clear-then-set pair,
	// which is two host commits per change and reintroduces the loop the guard
	// exists to close. What it has to catch is a tile that swaps chart type: the
	// old chart's series would otherwise stay in the card header forever.
	useEffect(() => {
		if (!slot) return
		return () => {
			published.current = null
			slot.setItems(NO_LEGEND_ITEMS)
		}
	}, [slot])
	// `null` means the caller declined to hoist, so it is `false` even under an
	// open slot — the slot received an empty list, and an empty header is not a
	// legend the chart can rely on.
	return slot !== null && items !== null
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
	 * A DOM legend rendered beside or beneath the plot.
	 *
	 * The strip is a flex SIBLING of the measured chart box rather than a height
	 * subtracted from it. That matters: the existing `ResizeObserver` then reports
	 * whatever the legend left over, so a legend that rewraps to a second row on
	 * toggle re-measures the plot with no arithmetic and no second observer.
	 */
	legend?: ReactNode
	/**
	 * Which axis the legend sits on. `"bottom"` is the default because it is the
	 * shape every chart in the port already asks for, and because it is the only
	 * one that is always safe: a strip under the plot costs height, which a card
	 * has, while a column beside it costs width, which a narrow tile may not.
	 *
	 * `"right"` is what `ChartLegendMode`'s own `"right"` has always meant and
	 * what the frame could not express — a chart asking for it got a single
	 * narrow column stacked UNDER the plot, eating up to 45% of the tile while
	 * the right side stayed empty. A chart choosing it owns the decision that its
	 * card is wide enough (the pie measures and degrades to chips below a
	 * threshold); the frame only lays it out.
	 */
	legendPlacement?: "bottom" | "right"
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
	/**
	 * A DOM layer stacked OVER the plot, for annotations that need real pointer
	 * semantics — hover cards, focus, open/close delays — which a mark cannot
	 * provide. The commit deploy markers are the reason it exists.
	 *
	 * This is the replacement for passing a node as a Recharts CHILD (the old
	 * `overlay` prop), which only worked because Recharts exposed `usePlotArea`,
	 * `useXAxisScale` and `ZIndexLayer` from inside its own tree. Here the layer
	 * is an ordinary sibling and reads the same information from `usePlotRect()`
	 * and `usePlotScales()`.
	 *
	 * Anything that merely PAINTS still belongs in the definition as a mark, where
	 * it participates in scale resolution — wrap it in `decorative()` so it feeds
	 * the scale without taking focus away from the series.
	 */
	overlay?: ReactNode
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
	legendPlacement = "bottom",
	onFocusChange,
	footer,
	overlay,
}: PlotFrameProps<TDatum, TXValue, TYValue>) {
	const { ref, height } = useMeasuredHeight()
	const anchorRef = useRef<HTMLDivElement | null>(null)
	const rectStore = useMemo(createPlotRectStore, [])
	const scalesStore = useMemo(createPlotScalesStore, [])

	if (import.meta.env.DEV) warnUnresolvedColors(definition, ariaLabel)

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
			scalesStore.set(context.scene.scales, bounds)
		},
		[rectStore, scalesStore],
	)

	const ChartComponent = renderer === "canvas" && supportsCanvas2d() ? CanvasChart : SvgChart

	const sideLegend = legendPlacement === "right" && legend != null

	/*
	 * `min-h-0` is load-bearing on a flex child: a flex item's default
	 * `min-height: auto` refuses to shrink below its content, and the chart's
	 * content is whatever height it was last measured at — so without this the
	 * plot ratchets and pushes the legend out of the card instead of yielding
	 * to it.
	 *
	 * `min-w-0` is the same argument turned ninety degrees, and it is why the
	 * row arm cannot simply reuse the column markup: beside a legend the plot is
	 * a horizontal flex item, `min-width: auto` holds it at its last measured
	 * width, and the legend gets pushed out of the card instead. It is added
	 * only in row mode so the bottom layout keeps byte-identical markup.
	 */
	const plot = (
		<div ref={ref} className={cn("relative min-h-0 flex-1", sideLegend && "min-w-0")}>
			{/*
			 * No `width`, deliberately — see `useMeasuredHeight`. The host takes
			 * `width: 100%` and measures itself before first paint. Rendering is
			 * not gated on a measurement either: `FALLBACK_HEIGHT` covers the
			 * frame before the layout effect resolves.
			 *
			 * The measurement is still the plot box's OWN height in both arms, and
			 * in row mode there is nothing to subtract: the legend is a sibling on
			 * the other axis, so the box already reports the full row height.
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
			{/*
			 * The overlay layer. Last child, so it stacks above the chart surface
			 * without a z-index.
			 *
			 * `pointer-events-none` on the LAYER with the annotations opting back
			 * in: a full-bleed transparent div that swallowed the pointer would
			 * kill hover on every chart that has an overlay, which is the whole
			 * plot. `overflow` is left visible on purpose — chips sit above the
			 * plot's top edge, and under Recharts that needed the `foreignObject`
			 * box extending upward to stay hoverable. A DOM sibling has no such
			 * limit, so the overhang is now just layout.
			 */}
			{overlay ? (
				<div data-chart-overlay="" className="pointer-events-none absolute inset-0">
					{overlay}
				</div>
			) : null}
		</div>
	)

	return (
		<PlotRectContext value={rectStore}>
			<PlotScalesContext value={scalesStore}>
				{/*
				 * `select-none`: a chart is a figure, not prose. Without it, dragging the
				 * pointer across one — which is exactly what hovering a timeseries looks
				 * like — starts a text selection and paints the browser's selection
				 * highlight over the whole `<svg>`/`<canvas>`.
				 *
				 * The host stays a COLUMN in both arms, and the side legend gets its own
				 * row wrapper rather than flipping this axis: `footer` is a caption under
				 * the whole figure, and turning the host into a row would make it a third
				 * column beside the legend.
				 */}
				<div data-chart-host={renderer} className={cn("flex flex-col select-none", className)}>
					{sideLegend ? (
						<div data-chart-legend-row="" className="flex min-h-0 flex-1 flex-row gap-3">
							{plot}
							{/*
							 * `max-w-[45%]` is the bottom arm's `max-h-[45%]` turned ninety
							 * degrees: the same ceiling, keeping a long series list from
							 * starving the plot, on the axis this layout spends. A legend that
							 * wants a precise width sets one on its own content — the pie's
							 * table does, because its columns collapse below a known minimum —
							 * and this cap only bounds one that does not.
							 */}
							<div className="max-w-[45%] shrink-0 overflow-auto">{legend}</div>
						</div>
					) : (
						plot
					)}
					{/*
					 * `max-h-[45%]` is the legend ceiling that keeps a long series list from
					 * starving the plot, expressed as a CSS cap rather than pixel arithmetic.
					 * Recharts needed a computed number because it wants an explicit
					 * `<Legend height>`; here flexbox already does the division.
					 */}
					{legend && !sideLegend ? (
						<div className="max-h-[45%] shrink-0 overflow-auto">{legend}</div>
					) : null}
					{footer ? <div className="shrink-0">{footer}</div> : null}
				</div>
			</PlotScalesContext>
		</PlotRectContext>
	)
}
