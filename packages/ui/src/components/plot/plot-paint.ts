import type { ChartLinearGradient } from "@tanstack/charts"
import { useId } from "react"

/**
 * A DOM-safe unique id for gradients and anything else referenced as `url(#…)`.
 *
 * Gradient ids used to be module constants, which meant two instances of the
 * same chart on one page emitted duplicate `<defs>` ids and the second silently
 * painted with the first's stops. An earlier revision worked around it by
 * threading an `idPrefix` prop down from every call site — prop-drilling a
 * uniqueness concern the component can own.
 *
 * `useId()` alone is not enough: React 19 returns `«r0»`, and those brackets
 * inside a `fill="url(#…)"` reference are a portability risk across the SVG and
 * canvas renderers. Sanitizing to `[A-Za-z0-9_-]` is stable under any
 * `identifierPrefix`.
 */
export function useChartId(prefix: string): string {
	const raw = useId()
	return `${prefix}-${raw.replace(/[^A-Za-z0-9_-]/g, "")}`
}

/**
 * A vertical fill gradient, expressed as a TanStack spec gradient.
 *
 * TanStack takes gradients as data on the spec rather than as `<defs>` JSX, so
 * this is the structural equivalent of the `VerticalGradient` component the
 * Recharts charts used.
 */
export function verticalGradient(
	id: string,
	color: string,
	startOpacity = 0.8,
	endOpacity = 0.1,
): ChartLinearGradient {
	return {
		id,
		x1: 0,
		y1: 0,
		x2: 0,
		y2: 1,
		stops: [
			{ offset: 0.05, color, opacity: startOpacity },
			{ offset: 0.95, color, opacity: endOpacity },
		],
	}
}

/**
 * A dasharray that actually reads as dashes under a `lineY` mark.
 *
 * `lineY` hard-codes `lineCap: "round"` / `lineJoin: "round"` on every line node
 * it emits (`dist/line.js:123-124`) and `LineYOptions` exposes no `lineCap`, so
 * a semicircular cap of radius `strokeWidth / 2` is added to BOTH ends of every
 * dash. A `"4 4"` that reads crisply under a butt cap paints `4 + strokeWidth`
 * of ink against a `4 - strokeWidth` gap here — at a 2.5px stroke that is 6.5px
 * on, 1.5px off, which is why an unadjusted dashed line reads as a wobbly solid
 * one.
 *
 * The fix is geometry, not taste: take the cap out of the dash and give it to
 * the gap. `on` and `off` are the widths you want to SEE.
 *
 * This applies to `lineY` and `areaY` only. `barY` emits rect nodes with butt
 * caps, so its dasharrays must NOT go through here.
 */
export function roundCapDasharray(on: number, off: number, strokeWidth: number): string {
	// A zero-length dash under a round cap still paints a dot, which is the
	// degenerate case worth keeping rather than collapsing to nothing.
	return `${Math.max(0.01, on - strokeWidth)} ${off + strokeWidth}`
}
