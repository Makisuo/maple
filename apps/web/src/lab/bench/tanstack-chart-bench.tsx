import { Profiler, useMemo } from "react"

import { useMountEffect } from "@/hooks/use-mount-effect"
import {
	createReactRecorder,
	startInteractionBench,
	type InteractionBenchHarness,
} from "@/lab/bench/interaction-bench"
import { TanstackErrorRateAreaChart } from "@/lab/bench/tanstack/error-rate-area"
import { TanstackLatencyLineChart } from "@/lab/bench/tanstack/latency-line"
import { TanstackThroughputAreaChart } from "@/lab/bench/tanstack/throughput-area"
import { type TanstackRenderer } from "@/lab/bench/tanstack/renderer-arm"

/**
 * The bench's arms.
 *
 * There WAS a third, `recharts`, which rendered the production overview charts
 * as the baseline the two TanStack renderers were measured against. Those charts
 * are TanStack now, so the arm rendered its own opposition — the A/B is over and
 * its numbers are recorded in `tanstack/FINDINGS.md` §1. What remains live is
 * canvas-vs-SVG, which is a standing choice: `PlotFrame` defaults to canvas, and
 * the SVG renderer is what a chart opts into for a CSS animation or `motion()`.
 */
export type ChartRenderer = TanstackRenderer

declare global {
	interface Window {
		__tanstackBench?: InteractionBenchHarness
	}
}

const CHART_COUNT = 3
const CHART_CLASS = "h-[220px] w-full"

/**
 * Synthetic `/lab/bench/tanstack` page: the three `/` overview charts rendered by
 * one of the two TanStack renderers off identical rows.
 *
 * Deliberately NOT wired to `useLinkedCursor`: the linked cursor's own cost is
 * measured at `/lab/bench/service-detail`, and adding it here would fold a
 * second variable into the renderer comparison this bench exists to isolate.
 */
export function TanstackChartBench({ renderer = "tanstack-canvas" }: { renderer?: ChartRenderer }) {
	const recorder = useMemo(() => createReactRecorder(), [])

	useMountEffect(() => {
		const bench = startInteractionBench({
			recorder,
			// Waits on the painted SURFACE, not on the wrapper: `[data-chart-host]`
			// exists from the first React commit, while the `svg`/`canvas` inside it
			// appears only once the renderer has mounted and measured. This used to
			// wait on a `[data-bench-chart]` element the bench emitted itself, which
			// stopped existing when the foundation moved into `packages/ui` — and the
			// stale selector silently made every arm "ready" with nothing on screen.
			isReady: () =>
				document.querySelectorAll(
					"[data-testid='tanstack-chart-bench'] [data-chart-host] svg, [data-testid='tanstack-chart-bench'] [data-chart-host] canvas",
				).length >= CHART_COUNT,
		})
		window.__tanstackBench = bench.harness

		return () => {
			bench.dispose()
			if (window.__tanstackBench === bench.harness) delete window.__tanstackBench
		}
	})

	return (
		<div
			data-testid="tanstack-chart-bench"
			data-bench-renderer={renderer}
			className="min-h-screen bg-background p-6 text-foreground"
		>
			<Profiler id={`tanstack-bench-${renderer}`} onRender={recorder.onRender}>
				<div className="grid grid-cols-1 gap-4">
					<TanstackThroughputAreaChart renderer={renderer} className={CHART_CLASS} />
					<TanstackErrorRateAreaChart renderer={renderer} className={CHART_CLASS} />
					<TanstackLatencyLineChart renderer={renderer} className={CHART_CLASS} />
				</div>
			</Profiler>
		</div>
	)
}
