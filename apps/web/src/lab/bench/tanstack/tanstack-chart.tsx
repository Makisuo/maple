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
		const observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect
			if (!box) return
			// Round: sub-pixel churn would rebuild the whole scene on every container
			// reflow and pollute the React commit counts this bench measures.
			const next = { width: Math.round(box.width), height: Math.round(box.height) }
			setSize((prev) =>
				prev && prev.width === next.width && prev.height === next.height ? prev : next,
			)
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
		<div ref={ref} data-bench-chart={renderer} className={cn("select-none", className)}>
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
	)
}
