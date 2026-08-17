import { cn } from "@maple/ui/lib/utils"
import { CanvasChart, Chart as SvgChart } from "@tanstack/charts/react/tooltip"
import type { ChartTooltipBodyRenderContext } from "@tanstack/charts/react/tooltip"
import type { ChartValue, DomChartDefinition } from "@tanstack/charts"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import "./tooltip.css"

export type TanstackRenderer = "tanstack-svg" | "tanstack-canvas"

/**
 * `<Chart>` has no intrinsic sizing: without explicit `width`/`height` it falls
 * back to `initialWidth: 640` plus an aspect ratio and sits inset in its
 * container. Every arm measures its own frame and passes pixels.
 */
function useMeasuredSize() {
	const ref = useRef<HTMLDivElement | null>(null)
	const [size, setSize] = useState<{ width: number; height: number } | null>(null)

	// `useLayoutEffect`, not `useMountEffect`: the chart cannot paint until it has
	// pixels, and `useMountEffect` wraps `useEffect`, which would cost an extra
	// empty frame on every mount — visible noise in a bench that counts frames.
	useLayoutEffect(() => {
		const node = ref.current
		if (!node) return

		const apply = (width: number, height: number) => {
			// Round: sub-pixel churn would rebuild the whole scene on every container
			// reflow and pollute the React commit counts this bench measures.
			const next = { width: Math.round(width), height: Math.round(height) }
			setSize((prev) =>
				prev && prev.width === next.width && prev.height === next.height ? prev : next,
			)
		}

		// Measure ONCE, synchronously, before handing the box to the observer.
		//
		// This is what stops the chart flashing blank on mount. `size` starts null
		// and the chart renders nothing until it has one, and `observe()` does NOT
		// call back inline: ResizeObserver delivers its first record during a later
		// frame's rendering steps, so the sequence was mount → paint nothing →
		// observer fires → React re-renders → paint the chart. Two painted frames of
		// empty card minimum, and the gallery mounts twenty-odd of these at once,
		// each with its own delivery and its own commit.
		//
		// A `setState` inside a LAYOUT effect is flushed before the browser paints,
		// so reading the box here puts the chart in the very first paint instead.
		// Layout is already clean at this point in the commit, and every frame does
		// its read before any of them writes, so this is not a thrashing read.
		const box = node.getBoundingClientRect()
		if (box.width > 0 && box.height > 0) apply(box.width, box.height)

		// The observer now only handles LATER size changes — container resize, a
		// legend rewrapping to a second row, the card reflowing.
		const observer = new ResizeObserver((entries) => {
			const contentRect = entries[0]?.contentRect
			if (!contentRect) return
			apply(contentRect.width, contentRect.height)
		})
		observer.observe(node)
		return () => observer.disconnect()
	}, [])

	return { ref, size }
}

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
	const { ref, size } = useMeasuredSize()
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
				{size ? (
					<ChartComponent
						definition={definition}
						ariaLabel={ariaLabel}
						width={size.width}
						height={size.height}
						renderTooltipBody={renderTooltipBody}
					/>
				) : null}
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
