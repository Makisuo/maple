import type { PlotRenderer } from "@maple/ui/components/plot/plot-frame"

/**
 * A bench ARM name, which is deliberately not the same thing as a renderer.
 *
 * The gallery and the perf bench compare three arms — the production chart and
 * the two TanStack renderers — so an arm name has to be able to say "recharts"
 * and has to stay stable in URLs and perf-spec assertions. `PlotRenderer` is a
 * production concern with two values and no history. Collapsing them would put
 * a bench identifier in the shipped chart API.
 */
export type TanstackRenderer = "tanstack-svg" | "tanstack-canvas"

export function plotRendererFor(arm: TanstackRenderer): PlotRenderer {
	return arm === "tanstack-canvas" ? "canvas" : "svg"
}
