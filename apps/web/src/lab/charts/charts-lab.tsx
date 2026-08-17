import { pickValueField, toBreakdownRows } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { pieSampleData } from "@maple/ui/components/charts/_shared/sample-data"
import { QueryBuilderPieChart } from "@maple/ui/components/charts/pie/query-builder-pie-chart"
import { Profiler, useMemo, type ReactNode } from "react"

import { useMountEffect } from "@/hooks/use-mount-effect"
import {
	createReactRecorder,
	startInteractionBench,
	type InteractionBenchHarness,
} from "@/lab/bench/interaction-bench"
import { PieSpike, type PieSpikeRow } from "@/lab/charts/pie-spike"

export type ChartsLabRenderer = "tanstack-svg" | "tanstack-canvas"

/** Which implementation to isolate for measurement. Absent = side-by-side gallery. */
export type ChartsLabArm = "production" | "tanstack"

declare global {
	interface Window {
		__chartsLabBench?: InteractionBenchHarness
	}
}

/**
 * `/lab/charts` — production chart beside its TanStack counterpart, over
 * byte-identical rows.
 *
 * Deliberately separate from `/lab/bench/tanstack`: that route is the perf gate's
 * fixture and its numbers are only comparable across runs if it never changes.
 * This one is the visual-diff surface and is expected to churn.
 *
 * `?arm=production|tanstack` isolates one implementation and installs the
 * interaction harness — the Profiler has to wrap a single subtree or the commit
 * counts include the chart being compared against.
 */
export function ChartsLab({
	renderer = "tanstack-canvas",
	arm,
}: {
	renderer?: ChartsLabRenderer
	arm?: ChartsLabArm
}) {
	// `toBreakdownRows` is the existing normalizer for `{name, value}` charts — it
	// also guards the mis-wired case where timeseries rows arrive instead of a
	// breakdown. Reused here so the spike's typed row shape is produced, not cast.
	const rows: PieSpikeRow[] = useMemo(
		() =>
			toBreakdownRows(pieSampleData, pickValueField(pieSampleData)).map((row) => ({
				name: row.name,
				value: row.value,
			})),
		[],
	)

	const recorder = useMemo(() => createReactRecorder(), [])

	useMountEffect(() => {
		if (!arm) return
		const bench = startInteractionBench({
			recorder,
			// Both implementations draw an <svg>; the TanStack canvas arm draws a
			// <canvas>. Counting either keeps one readiness check for all three.
			isReady: () =>
				document.querySelectorAll("[data-chart-arm] svg, [data-chart-arm] canvas").length > 0,
		})
		window.__chartsLabBench = bench.harness

		return () => {
			bench.dispose()
			if (window.__chartsLabBench === bench.harness) delete window.__chartsLabBench
		}
	})

	const production = (
		<ChartArm name="production" title="Pie — production (hand-rolled SVG arcs, 518 lines)">
			{/* The production chart takes loose `Record<string, unknown>` rows, so it
			    reads the fixture directly; the spike takes the normalized shape.
			    Same source array either way. */}
			<QueryBuilderPieChart data={pieSampleData} legend="right" tooltip="visible" />
		</ChartArm>
	)

	const tanstack = (
		<ChartArm name="tanstack" title="Pie — TanStack (polar + pie + radialArc)">
			<PieSpike rows={rows} renderer={renderer} className="h-full w-full" />
		</ChartArm>
	)

	const body = arm ? (
		<Profiler id={`charts-lab-${arm}`} onRender={recorder.onRender}>
			<div className="grid grid-cols-1 gap-4">{arm === "production" ? production : tanstack}</div>
		</Profiler>
	) : (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
			{production}
			{tanstack}
		</div>
	)

	return (
		<div
			data-testid="charts-lab"
			data-charts-lab-renderer={renderer}
			data-charts-lab-arm={arm ?? "both"}
			className="min-h-screen bg-background p-6 text-foreground"
		>
			<header className="mb-6">
				<h1 className="font-semibold text-lg">TanStack charts</h1>
				<p className="text-muted-foreground text-sm">
					Production (Recharts or bespoke) on the left, TanStack on the right, same rows.
					<code className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
						?renderer=tanstack-svg|tanstack-canvas&amp;arm=production|tanstack
					</code>
				</p>
			</header>
			{body}
		</div>
	)
}

function ChartArm({ name, title, children }: { name: ChartsLabArm; title: string; children: ReactNode }) {
	return (
		<div data-chart-arm={name} className="flex flex-col rounded-xl border bg-card">
			<div className="border-b px-4 py-2 font-medium text-muted-foreground text-xs">{title}</div>
			<div className="h-[320px] min-h-0 p-2">{children}</div>
		</div>
	)
}
