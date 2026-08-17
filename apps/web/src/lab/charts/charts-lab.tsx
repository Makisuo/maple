import { pickValueField, toBreakdownRows } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { heatmapSampleData, pieSampleData } from "@maple/ui/components/charts/_shared/sample-data"
import { QueryBuilderAreaChart } from "@maple/ui/components/charts/area/query-builder-area-chart"
import { QueryBuilderBarChart } from "@maple/ui/components/charts/bar/query-builder-bar-chart"
import { QueryBuilderHeatmapChart } from "@maple/ui/components/charts/heatmap/query-builder-heatmap-chart"
import { QueryBuilderHistogramChart } from "@maple/ui/components/charts/histogram/query-builder-histogram-chart"
import { QueryBuilderLineChart } from "@maple/ui/components/charts/line/query-builder-line-chart"
import { QueryBuilderPieChart } from "@maple/ui/components/charts/pie/query-builder-pie-chart"
import { Profiler, useMemo, type ReactNode } from "react"

import { useMountEffect } from "@/hooks/use-mount-effect"
import {
	createReactRecorder,
	startInteractionBench,
	type InteractionBenchHarness,
} from "@/lab/bench/interaction-bench"
import { AreaLegendSpike, AreaSpike } from "@/lab/charts/area-spike"
import { BoxPlotSpike, boxPlotSpikeRows } from "@/lab/charts/box-plot-spike"
import { HeatmapSpike, type HeatmapSpikeRow } from "@/lab/charts/heatmap-spike"
import { HistogramSpike, histogramSpikeRows } from "@/lab/charts/histogram-spike"
import { LineLegendSpike, LineSpike } from "@/lab/charts/line-spike"
import { PieLegendSpike, PieSpike, type PieSpikeRow } from "@/lab/charts/pie-spike"
import { SankeyLegendSpike, SankeySpike } from "@/lab/charts/sankey-spike"
import {
	StackedBarLegendSpike,
	StackedBarSceneLegendSpike,
	StackedBarSpike,
} from "@/lab/charts/stacked-bar-spike"
import {
	STACKED_BAR_PARTIAL_ROWS,
	STACKED_BAR_SPIKE_ROWS,
	TIMESERIES_PARTIAL_ROWS,
	TIMESERIES_SPIKE_ROWS,
	toLatencyProductionRows,
	toStackedBarProductionRows,
	toThroughputProductionRows,
} from "@/lab/charts/timeseries-data"
import { TraceScatterSpike, TRACE_SCATTER_SPIKE_ROWS } from "@/lab/charts/trace-scatter-spike"
import { TreemapLegendSpike, TreemapSpike } from "@/lab/charts/treemap-spike"

export type ChartsLabRenderer = "tanstack-svg" | "tanstack-canvas"

/**
 * Which chart to isolate for measurement, as `<chart>-<arm>`. Absent = the full
 * gallery with no harness.
 */
export type ChartsLabArm =
	| "pie-production"
	| "pie-tanstack"
	| "histogram-production"
	| "histogram-tanstack"
	| "heatmap-production"
	| "heatmap-tanstack"
	| "line-production"
	| "line-tanstack"
	| "area-production"
	| "area-tanstack"
	| "stacked-bar-production"
	| "stacked-bar-tanstack"
	| "line-incomplete-production"
	| "line-incomplete-tanstack"
	| "area-incomplete-production"
	| "area-incomplete-tanstack"
	| "stacked-bar-incomplete-tanstack"
	| "box-plot"
	| "trace-scatter"
	| "sankey"
	| "treemap"
	// Legends. Every `*-production` arm above already renders `QueryBuilderLegend`,
	// so these pair against the EXISTING production arms rather than adding their
	// own; the legend-less TanStack arms stay as they are so FINDINGS.md's baseline
	// numbers remain comparable.
	| "line-legend-tanstack"
	| "area-legend-tanstack"
	| "stacked-bar-legend-tanstack"
	| "stacked-bar-legend-scene-tanstack"
	| "pie-legend-tanstack"
	| "treemap-legend"
	| "sankey-legend"

declare global {
	interface Window {
		__chartsLabBench?: InteractionBenchHarness
	}
}

/**
 * What `MetricsGrid` passes every production chart (metrics-grid.tsx:127).
 *
 * `aspect-auto` is the load-bearing part: `ChartContainer` sets `aspect-video`,
 * so without this the chart sizes itself 16:9 — taller than a 320px card — and
 * the x axis is pushed out and clipped. Omitting it made the production
 * histogram look like it had no axis at all.
 */
const PRODUCTION_CHART_CLASS = "h-full w-full aspect-auto"

const heatmapRows: readonly HeatmapSpikeRow[] = heatmapSampleData

/**
 * The same raw observations the spike bins, widened for the production chart's
 * loose row prop.
 *
 * An interface has no implicit index signature, so `HistogramSpikeRow[]` is not
 * assignable to `Record<string, unknown>[]` — but a fresh object literal is.
 * Rebuilding the rows is the cast-free way across that boundary, and it keeps
 * both arms provably on identical data.
 */
const histogramProductionRows: Record<string, unknown>[] = histogramSpikeRows.map((row) => ({
	value: row.value,
}))

/**
 * The timeseries fixtures widened for the production charts, once at module
 * scope — the query-builder charts memoize on the `data` identity, so a fresh
 * array per render would rebuild every series on every commit and make the
 * Recharts arms look worse than they are.
 */
const lineProductionRows = toLatencyProductionRows(TIMESERIES_SPIKE_ROWS)
const linePartialProductionRows = toLatencyProductionRows(TIMESERIES_PARTIAL_ROWS)
const areaProductionRows = toThroughputProductionRows(TIMESERIES_SPIKE_ROWS)
const areaPartialProductionRows = toThroughputProductionRows(TIMESERIES_PARTIAL_ROWS)
const stackedBarProductionRows = toStackedBarProductionRows(STACKED_BAR_SPIKE_ROWS)

/**
 * `/lab/charts` — production charts beside their TanStack counterparts, over
 * byte-identical rows, plus the charts Maple cannot render today at all.
 *
 * Deliberately separate from `/lab/bench/tanstack`: that route is the perf gate's
 * fixture and its numbers are only comparable across runs if it never changes.
 * This one is the visual-diff surface and is expected to churn.
 *
 * `?arm=<chart>-<impl>` isolates one chart and installs the interaction harness —
 * the Profiler has to wrap a single subtree, or commit counts include every other
 * chart on the page.
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
	const pieRows: PieSpikeRow[] = useMemo(
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
			// NOT `svg, canvas`: the production heatmap is a CSS grid of divs and
			// draws neither, so that check never becomes true for it. Any painted
			// child is the portable signal — the arm renders its content only once
			// the chart has mounted.
			isReady: () => {
				const host = document.querySelector("[data-chart-arm]")
				return host != null && host.querySelectorAll("svg, canvas, [style*='grid']").length > 0
			},
		})
		window.__chartsLabBench = bench.harness

		return () => {
			bench.dispose()
			if (window.__chartsLabBench === bench.harness) delete window.__chartsLabBench
		}
	})

	// `satisfies`, not an annotation: an explicit open dictionary discards the
	// literal keys, and the arm switch below relies on them.
	const cards = {
		"pie-production": {
			title: "Pie — production (hand-rolled SVG arcs, 518 lines)",
			// The production charts take loose `Record<string, unknown>` rows, so they
			// read the fixtures directly; the spikes take closed row types. Same
			// source arrays either way.
			node: (
				<QueryBuilderPieChart
					data={pieSampleData}
					legend="right"
					tooltip="visible"
					className={PRODUCTION_CHART_CLASS}
				/>
			),
		},
		"pie-tanstack": {
			title: "Pie — TanStack (polar + pie + radialArc) · no hover affordance",
			node: <PieSpike rows={pieRows} renderer={renderer} className="h-full w-full" />,
		},
		"histogram-production": {
			title: "Histogram — production (JS binning → string labels, 161 lines)",
			// Both arms get the SAME raw observations: the production chart bins them
			// in JS via its own `bucketize`, the spike hands them to `binX`.
			node: (
				<QueryBuilderHistogramChart
					data={histogramProductionRows}
					tooltip="visible"
					className={PRODUCTION_CHART_CLASS}
				/>
			),
		},
		"histogram-tanstack": {
			title: "Histogram — TanStack (binX + rect, numeric intervals)",
			node: <HistogramSpike rows={histogramSpikeRows} renderer={renderer} className="h-full w-full" />,
		},
		"heatmap-production": {
			title: "Heatmap — production (CSS grid + layout solver, 925 lines)",
			node: (
				<QueryBuilderHeatmapChart
					data={heatmapSampleData}
					tooltip="visible"
					className={PRODUCTION_CHART_CLASS}
				/>
			),
		},
		"heatmap-tanstack": {
			title: "Heatmap — TanStack (cell + scaleBand + sequential colour)",
			node: <HeatmapSpike rows={heatmapRows} renderer={renderer} className="h-full w-full" />,
		},
		"line-production": {
			title: "Line — production (recharts LineChart, one <Line> per series)",
			node: (
				<QueryBuilderLineChart
					data={lineProductionRows}
					tooltip="visible"
					className={PRODUCTION_CHART_CLASS}
				/>
			),
		},
		"line-tanstack": {
			title: "Line — TanStack (lineY × 3, pinned point scale)",
			node: <LineSpike rows={TIMESERIES_SPIKE_ROWS} renderer={renderer} className="h-full w-full" />,
		},
		"area-production": {
			title: "Area — production (recharts AreaChart + gradient defs)",
			node: (
				<QueryBuilderAreaChart
					data={areaProductionRows}
					tooltip="visible"
					className={PRODUCTION_CHART_CLASS}
				/>
			),
		},
		"area-tanstack": {
			title: "Area — TanStack (fill-only areaY + lineY, spec gradients)",
			node: <AreaSpike rows={TIMESERIES_SPIKE_ROWS} renderer={renderer} className="h-full w-full" />,
		},
		"stacked-bar-production": {
			title: "Stacked bar — production (one <Bar stackId> per service, wide rows)",
			node: (
				<QueryBuilderBarChart
					data={stackedBarProductionRows}
					stacked
					tooltip="visible"
					className={PRODUCTION_CHART_CLASS}
				/>
			),
		},
		"stacked-bar-tanstack": {
			title: "Stacked bar — TanStack (one barY, z channel + stack layout)",
			node: (
				<StackedBarSpike
					rows={STACKED_BAR_SPIKE_ROWS}
					renderer={renderer}
					className="h-full w-full"
				/>
			),
		},
		"line-incomplete-production": {
			title: "Line + partial tail — production (twin _incomplete columns)",
			node: (
				<QueryBuilderLineChart
					data={linePartialProductionRows}
					tooltip="visible"
					className={PRODUCTION_CHART_CLASS}
				/>
			),
		},
		"line-incomplete-tanstack": {
			title: "Line + partial tail — TanStack (second mark over a slice)",
			node: (
				<LineSpike
					rows={TIMESERIES_PARTIAL_ROWS}
					renderer={renderer}
					incomplete
					className="h-full w-full"
				/>
			),
		},
		"area-incomplete-production": {
			title: "Area + partial tail — production (faded gradient + dashed <Line>)",
			node: (
				<QueryBuilderAreaChart
					data={areaPartialProductionRows}
					tooltip="visible"
					className={PRODUCTION_CHART_CLASS}
				/>
			),
		},
		"area-incomplete-tanstack": {
			title: "Area + partial tail — TanStack (faded areaY + dashed lineY)",
			node: (
				<AreaSpike
					rows={TIMESERIES_PARTIAL_ROWS}
					renderer={renderer}
					incomplete
					className="h-full w-full"
				/>
			),
		},
		"stacked-bar-incomplete-tanstack": {
			title: "Stacked bar + partial tail — NEW (barY strokeDasharray channel; recharts bars have no incomplete support at all)",
			node: (
				<StackedBarSpike
					rows={STACKED_BAR_PARTIAL_ROWS}
					renderer={renderer}
					incomplete
					className="h-full w-full"
				/>
			),
		},
		"box-plot": {
			title: "Box plot — NEW (boxY, Tukey summaries from raw observations)",
			node: <BoxPlotSpike rows={boxPlotSpikeRows} renderer={renderer} className="h-full w-full" />,
		},
		"trace-scatter": {
			title: "Trace scatter — NEW (hexbin over 5,000 spans, screen-space density)",
			node: (
				<TraceScatterSpike
					rows={TRACE_SCATTER_SPIKE_ROWS}
					renderer={renderer}
					className="h-full w-full"
				/>
			),
		},
		sankey: {
			title: "Service flow — NEW (sankeyDiagram, weighted by call volume)",
			node: <SankeySpike renderer={renderer} className="h-full w-full" />,
		},
		treemap: {
			title: "Span volume — NEW (hierarchy/treemap, service → operation)",
			node: <TreemapSpike renderer={renderer} className="h-full w-full" />,
		},
		"line-legend-tanstack": {
			title: "Line + legend — TanStack (DOM series key, click to hide, y axis rescales)",
			node: (
				<LineLegendSpike rows={TIMESERIES_SPIKE_ROWS} renderer={renderer} className="h-full w-full" />
			),
		},
		"area-legend-tanstack": {
			title: "Area + legend — TanStack (DOM series key over a fill-only areaY)",
			node: (
				<AreaLegendSpike rows={TIMESERIES_SPIKE_ROWS} renderer={renderer} className="h-full w-full" />
			),
		},
		"stacked-bar-legend-tanstack": {
			title: "Stacked bar + legend — TanStack (DOM key; hiding filters rows and re-pins stackMax)",
			node: (
				<StackedBarLegendSpike
					rows={STACKED_BAR_SPIKE_ROWS}
					renderer={renderer}
					className="h-full w-full"
				/>
			),
		},
		"stacked-bar-legend-scene-tanstack": {
			title: "Stacked bar + legend — TanStack's OWN legend (interactiveColorLegend, zero DOM — but hiding a band leaves a hole, it cannot restack)",
			node: (
				<StackedBarSceneLegendSpike
					rows={STACKED_BAR_SPIKE_ROWS}
					renderer={renderer}
					className="h-full w-full"
				/>
			),
		},
		"pie-legend-tanstack": {
			title: "Pie + legend — TanStack (the only hover-adjacent affordance radialArc allows)",
			node: <PieLegendSpike rows={pieRows} renderer={renderer} className="h-full w-full" />,
		},
		"treemap-legend": {
			title: "Span volume + legend — NEW (the mark paints leaves only, so colour IS the grouping)",
			node: <TreemapLegendSpike renderer={renderer} className="h-full w-full" />,
		},
		"sankey-legend": {
			title: "Service flow + status key — NEW (bands filter edges, not series)",
			node: <SankeyLegendSpike renderer={renderer} className="h-full w-full" />,
		},
	} satisfies Record<ChartsLabArm, { title: string; node: ReactNode }>

	if (arm) {
		const card = cards[arm]
		return (
			<LabShell renderer={renderer} arm={arm}>
				<Profiler id={`charts-lab-${arm}`} onRender={recorder.onRender}>
					<div className="grid grid-cols-1 gap-4">
						<ChartArm name={arm} title={card.title}>
							{card.node}
						</ChartArm>
					</div>
				</Profiler>
			</LabShell>
		)
	}

	return (
		<LabShell renderer={renderer} arm={arm}>
			<Section title="Consolidation — production beside its TanStack replacement">
				<Pair a="pie-production" b="pie-tanstack" cards={cards} />
				<Pair a="histogram-production" b="histogram-tanstack" cards={cards} />
				<Pair a="heatmap-production" b="heatmap-tanstack" cards={cards} />
				<Pair a="line-production" b="line-tanstack" cards={cards} />
				<Pair a="area-production" b="area-tanstack" cards={cards} />
				<Pair a="stacked-bar-production" b="stacked-bar-tanstack" cards={cards} />
			</Section>

			<Section title="Trailing partial buckets — the dashed future segment">
				<Pair a="line-incomplete-production" b="line-incomplete-tanstack" cards={cards} />
				<Pair a="area-incomplete-production" b="area-incomplete-tanstack" cards={cards} />
				<ChartArm
					name="stacked-bar-incomplete-tanstack"
					title={cards["stacked-bar-incomplete-tanstack"].title}
				>
					{cards["stacked-bar-incomplete-tanstack"].node}
				</ChartArm>
			</Section>

			<Section title="Legends — production beside the TanStack series key">
				{/*
				 * Paired against the EXISTING production arms, not new ones: every
				 * `QueryBuilder*Chart` already renders `QueryBuilderLegend`, so the
				 * legend-less TanStack arms above have been comparing a chart with a
				 * legend against a chart without one this whole time. This is the
				 * like-for-like row.
				 */}
				<Pair a="line-production" b="line-legend-tanstack" cards={cards} />
				<Pair a="area-production" b="area-legend-tanstack" cards={cards} />
				<Pair a="stacked-bar-production" b="stacked-bar-legend-tanstack" cards={cards} />
				<Pair a="pie-production" b="pie-legend-tanstack" cards={cards} />
				{/*
				 * The one chart where BOTH legends are reachable — see
				 * `StackedBarSceneLegendSpike` for why it is the only one. Left is DOM,
				 * right is the `SceneNode` the renderer paints; hide the bottom band on
				 * the right to watch it punch a hole rather than restack.
				 *
				 * This section repeats four `*-production` arms from the section above,
				 * so a handful of `data-chart-arm` values appear twice in the GALLERY.
				 * Safe rather than sloppy: the harness installs only under `?arm=`, and
				 * that path renders exactly one `ChartArm`, so nothing ever selects
				 * across two nodes carrying the same name.
				 */}
				<Pair a="stacked-bar-legend-tanstack" b="stacked-bar-legend-scene-tanstack" cards={cards} />
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{(["treemap-legend", "sankey-legend"] as const).map((key) => (
						<ChartArm key={key} name={key} title={cards[key].title}>
							{cards[key].node}
						</ChartArm>
					))}
				</div>
			</Section>

			<Section title="Unlock — charts Maple cannot render today">
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{(["box-plot", "trace-scatter", "sankey", "treemap"] as const).map((key) => (
						<ChartArm key={key} name={key} title={cards[key].title}>
							{cards[key].node}
						</ChartArm>
					))}
				</div>
			</Section>
		</LabShell>
	)
}

function LabShell({
	renderer,
	arm,
	children,
}: {
	renderer: ChartsLabRenderer
	arm?: ChartsLabArm
	children: ReactNode
}) {
	return (
		<div
			data-testid="charts-lab"
			data-charts-lab-renderer={renderer}
			data-charts-lab-arm={arm ?? "gallery"}
			className="min-h-screen bg-background p-6 text-foreground"
		>
			<header className="mb-6">
				<h1 className="font-semibold text-lg">TanStack charts</h1>
				<p className="text-muted-foreground text-sm">
					Production on the left, TanStack on the right, same rows.
					<code className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
						?renderer=tanstack-svg|tanstack-canvas&amp;arm=&lt;chart&gt;-&lt;impl&gt;
					</code>
				</p>
			</header>
			{children}
		</div>
	)
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="mb-8">
			<h2 className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{title}
			</h2>
			<div className="grid gap-4">{children}</div>
		</section>
	)
}

function Pair({
	a,
	b,
	cards,
}: {
	a: ChartsLabArm
	b: ChartsLabArm
	cards: Readonly<Record<ChartsLabArm, { title: string; node: ReactNode }>>
}) {
	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
			<ChartArm name={a} title={cards[a].title}>
				{cards[a].node}
			</ChartArm>
			<ChartArm name={b} title={cards[b].title}>
				{cards[b].node}
			</ChartArm>
		</div>
	)
}

function ChartArm({ name, title, children }: { name: ChartsLabArm; title: string; children: ReactNode }) {
	return (
		<div data-chart-arm={name} className="flex flex-col rounded-xl border bg-card">
			<div className="border-b px-4 py-2 font-medium text-muted-foreground text-xs">{title}</div>
			{/*
			 * `overflow-hidden` is load-bearing, not tidiness. `ChartContainer`
			 * deliberately sets `[&_.recharts-surface]:overflow-visible` so axis
			 * labels can escape the SVG box, and production clamps that at
			 * `CardContent` (widget-shell.tsx:213). Without the same clamp here,
			 * recharts labels bleed out of the card and land on top of the next
			 * chart — which looks like a chart defect and is really a missing rule.
			 */}
			<div className="h-[320px] min-h-0 overflow-hidden p-2">{children}</div>
		</div>
	)
}
