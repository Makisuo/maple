import { areaY, d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { useMemo } from "react"

import { PlotFrame } from "./plot-frame"
import { useChartId, verticalGradient } from "./plot-paint"
import { resolvePlotColor, type PlotColorToken } from "./theme"
import { useTheme } from "../../hooks/use-theme"

/**
 * A trend line with no chrome — no axes, no grid, no legend, no tooltip.
 *
 * One primitive for both sparklines in the product: the services table's
 * `Sparkline` and the stat widget's `StatSparkline`, which were separate
 * Recharts `<AreaChart>`s differing only in curve and gradient opacity. Those
 * two knobs are props here; everything else was already identical, down to the
 * 1.5px stroke.
 */
export interface PlotSparklineProps {
	/** The series, already reduced to plain numbers — index is the x position. */
	values: readonly number[]
	/** A `--token`, a `var(--token)` or a literal. Resolved before it reaches canvas. */
	color?: PlotColorToken
	curve?: "linear" | "monotone"
	/** Gradient stop opacities, top and bottom. */
	fillOpacity?: readonly [start: number, end: number]
	className?: string
}

const FALLBACK_COLOR = "#6366f1"
const STROKE_WIDTH = 1.5

interface SparkPoint {
	index: number
	value: number
}

export function PlotSparkline({
	values,
	color = "--chart-1",
	curve = "linear",
	fillOpacity = [0.35, 0],
	className,
}: PlotSparklineProps) {
	const gradientId = useChartId("spark")
	// `useTheme` is an invalidation key, not a read: canvas holds literals, so a
	// light/dark flip has to re-resolve or the sparkline keeps the old palette.
	const { theme } = useTheme()
	// oxlint-disable-next-line react-hooks/exhaustive-deps
	const stroke = useMemo(() => resolvePlotColor(color, FALLBACK_COLOR), [color, theme])

	const points = useMemo<SparkPoint[]>(() => values.map((value, index) => ({ index, value })), [values])

	const definition = useMemo(() => {
		const at = (point: SparkPoint) => point.index
		const value = (point: SparkPoint) => point.value
		const shape = curve === "monotone" ? d3Curve(curveMonotoneX) : undefined

		return defineChart({
			gradients: [verticalGradient(gradientId, stroke, fillOpacity[0], fillOpacity[1])],
			marks: [
				areaY(points, {
					x: at,
					y: value,
					// An explicit floor, so the band fills from the baseline rather than
					// from whatever the inferred domain's minimum happens to be.
					y1: () => 0,
					fill: `url(#${gradientId})`,
					stroke: "none",
					curve: shape,
				}),
				lineY(points, { x: at, y: value, stroke, strokeWidth: STROKE_WIDTH, curve: shape }),
			],
			// The bare FACTORIES, so both domains infer from the marks. An instance
			// keeps its own empty configured domain and paints nothing — and `axis:
			// false` hides the axis while keeping the scale, so a scale is still
			// required on both.
			x: { scale: scaleLinear, axis: false },
			y: { scale: scaleLinear, axis: false },
			// A sparkline is a shape, not an instrument: nothing to hover, nothing to
			// read off it. The number it annotates is always printed beside it.
			tooltip: false,
			focus: false,
			// No axes means no gutters — the line should reach every edge of its box.
			margin: { top: 2, right: 0, bottom: 0, left: 0 },
		})
	}, [points, stroke, gradientId, curve, fillOpacity])

	return <PlotFrame definition={definition} ariaLabel="Trend" className={className} />
}
