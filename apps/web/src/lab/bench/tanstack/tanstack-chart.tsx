import { cn } from "@maple/ui/lib/utils"
import { CanvasChart, Chart as SvgChart } from "@tanstack/charts/react/tooltip"
import type { ChartTooltipBodyRenderContext } from "@tanstack/charts/react/tooltip"
import type { ChartValue, DomChartDefinition } from "@tanstack/charts"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import "./tooltip.css"

export type TanstackRenderer = "tanstack-svg" | "tanstack-canvas"

/**
 * Only the HEIGHT is measured, and that is the documented shape.
 *
 * An earlier revision of this file measured both axes and passed both to
 * `<Chart>`, with a comment claiming the component "has no intrinsic sizing".
 * That was wrong, and it caused the mount flash: `width` is optional, and the
 * host renders `width: width === undefined ? "100%" : width`
 * (`dist/react/RendererChart.js`), so omitting it makes the chart follow its
 * container. The renderer then installs its OWN `ResizeObserver` on the
 * container (`dist/renderer.js:151`) and — this is the part that matters —
 * `adapter.mount()` runs inside a layout effect and `createScene()` reads
 * `container.getBoundingClientRect().width` synchronously there
 * (`dist/renderer.js:659`), so the first paint is already correctly sized.
 *
 * Taking that over meant gating the chart behind our own observer, whose first
 * record only arrives during a LATER frame's rendering steps: mount → paint an
 * empty card → observer fires → re-render → paint the chart. Two blank frames
 * minimum, twenty-one of them on the gallery, each with its own commit.
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
		// reflow and pollute the React commit counts this bench measures.
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

export interface TanstackChartFrameProps<TDatum, TXValue extends ChartValue, TYValue extends ChartValue> {
	renderer: TanstackRenderer
	definition: DomChartDefinition<TDatum, TXValue, TYValue>
	ariaLabel: string
	className?: string
	renderTooltipBody?: (context: ChartTooltipBodyRenderContext<TDatum, TXValue, TYValue>) => ReactNode
	/**
	 * A DOM legend rendered beneath the plot — see `chart-legend.tsx` for why the
	 * package's own legends do not apply to most of these charts.
	 *
	 * The strip is a flex SIBLING of the measured chart box rather than a height
	 * subtracted from it. That matters: the existing `ResizeObserver` then reports
	 * whatever the legend left over, so a legend that rewraps to a second row on
	 * toggle re-measures the plot with no arithmetic and no second observer.
	 */
	legend?: ReactNode
}

/**
 * One frame, one renderer. `@tanstack/charts/react/tooltip` exports the SVG and
 * Canvas components with an identical prop surface, so the two TanStack arms
 * differ only in which component is mounted — the definition is the same object.
 */
export function TanstackChartFrame<TDatum, TXValue extends ChartValue, TYValue extends ChartValue>({
	renderer,
	definition,
	ariaLabel,
	className,
	renderTooltipBody,
	legend,
}: TanstackChartFrameProps<TDatum, TXValue, TYValue>) {
	const { ref, height } = useMeasuredHeight()
	const ChartComponent = renderer === "tanstack-canvas" ? CanvasChart : SvgChart

	return (
		// `select-none`: a chart is a figure, not prose. Without it, dragging the
		// pointer across one — which is exactly what hovering a timeseries looks
		// like — starts a text selection and paints the browser's selection
		// highlight over the whole `<svg>`/`<canvas>`. Recharts charts sit inside
		// `ChartContainer`, which has never had this problem because its content is
		// unselectable by construction.
		<div data-bench-chart={renderer} className={cn("flex flex-col select-none", className)}>
			{/*
			 * `min-h-0` is load-bearing on a flex child: a flex item's default
			 * `min-height: auto` refuses to shrink below its content, and the chart's
			 * content is whatever height it was last measured at — so without this the
			 * plot ratchets and pushes the legend out of the card instead of yielding
			 * to it.
			 */}
			<div ref={ref} className="min-h-0 flex-1">
				{/*
				 * No `width`, deliberately — see `useMeasuredHeight`. The host takes
				 * `width: 100%` and measures itself before first paint, which is both
				 * the documented behaviour and the reason this no longer flashes.
				 * Rendering is not gated on a measurement either: `FALLBACK_HEIGHT`
				 * covers the frame before the layout effect resolves.
				 */}
				<ChartComponent
					definition={definition}
					ariaLabel={ariaLabel}
					height={height ?? FALLBACK_HEIGHT}
					renderTooltipBody={renderTooltipBody}
				/>
			</div>
			{/*
			 * `max-h-[45%]` is `query-builder-legend.tsx`'s `MAX_LEGEND_FRACTION`,
			 * expressed as a CSS cap rather than as `responsiveLegendHeight`'s pixel
			 * arithmetic. The production legend has to compute a number because
			 * Recharts wants an explicit `<Legend height>`; here flexbox already does
			 * the division, so the only thing left to state is the ceiling that keeps a
			 * long series list from starving the plot.
			 */}
			{legend ? <div className="max-h-[45%] shrink-0 overflow-auto">{legend}</div> : null}
		</div>
	)
}
