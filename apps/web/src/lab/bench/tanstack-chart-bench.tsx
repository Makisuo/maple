import { ErrorRateAreaChart } from "@maple/ui/components/charts/area/error-rate-area-chart"
import { ThroughputAreaChart } from "@maple/ui/components/charts/area/throughput-area-chart"
import { LatencyLineChart } from "@maple/ui/components/charts/line/latency-line-chart"
import { Profiler, useMemo } from "react"

import { useMountEffect } from "@/hooks/use-mount-effect"
import {
	createReactRecorder,
	startInteractionBench,
	type InteractionBenchHarness,
} from "@/lab/bench/interaction-bench"
import { overviewBenchRows } from "@/lab/bench/tanstack/bench-data"
import { TanstackErrorRateAreaChart } from "@/lab/bench/tanstack/error-rate-area"
import { TanstackLatencyLineChart } from "@/lab/bench/tanstack/latency-line"
import { TanstackThroughputAreaChart } from "@/lab/bench/tanstack/throughput-area"
import type { TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"

export type ChartRenderer = "recharts" | TanstackRenderer

declare global {
	interface Window {
		__tanstackBench?: InteractionBenchHarness
	}
}

const CHART_COUNT = 3
const CHART_CLASS = "h-[220px] w-full"

/**
 * Synthetic `/lab/bench/tanstack` page: the three `/` overview charts rendered by
 * one of three renderers off identical rows.
 *
 * Deliberately NOT wired to `useLinkedCursor`. That hook locates each plot rect
 * via the `.recharts-cartesian-grid` selector and throttles by exploiting
 * Recharts' bubble-phase mouse handling, neither of which a TanStack chart
 * provides. Faking it would distort the hover cost this bench exists to measure,
 * so every arm uses its own native hover + tooltip path.
 */
export function TanstackChartBench({ renderer = "recharts" }: { renderer?: ChartRenderer }) {
	const recorder = useMemo(() => createReactRecorder(), [])
	const isTanstack = renderer !== "recharts"

	useMountEffect(() => {
		const bench = startInteractionBench({
			recorder,
			// Per-renderer readiness: `.recharts-wrapper` only exists in the Recharts
			// arm, so both paths report through a wrapper this bench emits itself.
			isReady: () =>
				document.querySelectorAll(
					isTanstack
						? "[data-testid='tanstack-chart-bench'] [data-bench-chart] svg, [data-testid='tanstack-chart-bench'] [data-bench-chart] canvas"
						: "[data-testid='tanstack-chart-bench'] .recharts-wrapper",
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
					{isTanstack ? (
						<>
							<TanstackThroughputAreaChart renderer={renderer} className={CHART_CLASS} />
							<TanstackErrorRateAreaChart renderer={renderer} className={CHART_CLASS} />
							<TanstackLatencyLineChart renderer={renderer} className={CHART_CLASS} />
						</>
					) : (
						<>
							<ThroughputAreaChart
								data={overviewBenchRows}
								rateMode="per_second"
								className={CHART_CLASS}
							/>
							<ErrorRateAreaChart data={overviewBenchRows} className={CHART_CLASS} />
							<LatencyLineChart data={overviewBenchRows} className={CHART_CLASS} />
						</>
					)}
				</div>
			</Profiler>
		</div>
	)
}
