import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { defineChart, type ChartCurve } from "@tanstack/charts"
import { link } from "@tanstack/charts/link"
import { sankeyDiagram } from "@tanstack/charts/network/sankey"
import { rect } from "@tanstack/charts/rect"
import { text } from "@tanstack/charts/text"
import { tooltip } from "@tanstack/charts/tooltip"
import { memo, useMemo, type ReactNode } from "react"

import { type TanstackRenderer, plotRendererFor } from "@/lab/bench/tanstack/renderer-arm"
import { muteColor } from "@maple/ui/components/plot/color-scale"
import { PlotFrame } from "@maple/ui/components/plot/plot-frame"
import {
	MUTED_COLOR_AMOUNT,
	type PlotLegendSeries,
	PlotSeriesLegend,
	usePlotLegendHighlight,
} from "@maple/ui/components/plot/plot-legend"

/**
 * The service-map edge shape the query engine already returns —
 * `ServiceDependenciesOutput` in
 * `packages/query-engine/src/ch/queries/service-map.ts`, narrowed to the four
 * fields a flow diagram needs. Deliberately NOT `Record<string, unknown>`-shaped:
 * `sankeyDiagram`'s node/link contexts are generic over the row type, and an
 * index signature poisons every derived `Omit`/`keyof` the same way it does in
 * `pie-spike.tsx`.
 */
export interface SankeySpikeEdge {
	sourceService: string
	targetService: string
	callCount: number
	errorCount: number
}

/**
 * `sankeyDiagram` wants nodes AND links — it does not derive the node set from
 * the edges. This is the closed row type for the derived node list.
 */
interface SankeySpikeNode {
	service: string
}

const FLOW_TOKENS = {
	node: ["--chart-2", "#ec4899"],
	nodeLabel: ["--foreground", "#e6e6e6"],
	healthy: ["--chart-1", "#6366f1"],
	warning: ["--chart-3", "#f59e0b"],
	error: ["--destructive", "#ef4444"],
	// What a muted ribbon mixes toward, resolved in the same call as the rest so
	// it re-reads on a theme flip.
	background: ["--background", "#0c0a09"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * Deterministic fixture: 8 services, 14 edges, shaped exactly like the warehouse
 * output. No `Math.random()` / `Date.now()` — the lab route re-renders on every
 * theme flip and renderer switch, and a moving fixture makes visual diffs and
 * perf comparisons meaningless.
 */
export const SANKEY_SPIKE_EDGES: readonly SankeySpikeEdge[] = [
	{ sourceService: "edge-gateway", targetService: "web", callCount: 48_200, errorCount: 96 },
	{ sourceService: "edge-gateway", targetService: "api", callCount: 31_400, errorCount: 210 },
	{ sourceService: "web", targetService: "api", callCount: 26_800, errorCount: 134 },
	{ sourceService: "web", targetService: "auth", callCount: 12_050, errorCount: 24 },
	{ sourceService: "api", targetService: "auth", callCount: 18_900, errorCount: 57 },
	{ sourceService: "api", targetService: "query-engine", callCount: 22_400, errorCount: 1_120 },
	{ sourceService: "api", targetService: "billing", callCount: 4_300, errorCount: 602 },
	{ sourceService: "api", targetService: "postgres", callCount: 15_600, errorCount: 31 },
	{ sourceService: "auth", targetService: "postgres", callCount: 9_800, errorCount: 12 },
	{ sourceService: "billing", targetService: "postgres", callCount: 3_150, errorCount: 189 },
	{ sourceService: "query-engine", targetService: "clickhouse", callCount: 20_100, errorCount: 402 },
	{ sourceService: "query-engine", targetService: "postgres", callCount: 2_400, errorCount: 8 },
	{ sourceService: "billing", targetService: "clickhouse", callCount: 1_260, errorCount: 302 },
	{ sourceService: "auth", targetService: "clickhouse", callCount: 890, errorCount: 4 },
]

/** Stable node order — `nodeSort: null` preserves it, so this is the column order. */
const SANKEY_SPIKE_NODES: readonly SankeySpikeNode[] = [
	{ service: "edge-gateway" },
	{ service: "web" },
	{ service: "api" },
	{ service: "auth" },
	{ service: "query-engine" },
	{ service: "billing" },
	{ service: "postgres" },
	{ service: "clickhouse" },
]

const NODE_WIDTH = 14

const compactCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

/**
 * Horizontal-bump curve, hand-rolled.
 *
 * `@tanstack/charts` ships NO curve presets — the only adapter is
 * `d3Curve(curve: CurveFactory)` from `@tanstack/charts/d3/shape`, which needs
 * `d3-shape` as a real import. `d3-shape` is a transitive dep of
 * `@tanstack/charts` and is NOT resolvable from `apps/web`, so using `d3Curve`
 * would mean adding a d3 dependency for one bezier. `ChartCurve` is a two-method
 * structural interface, and `link` only ever calls `.line()` (with exactly the
 * two endpoints), so implementing it directly is both smaller and honest.
 *
 * This reproduces `d3.curveBumpX`: control points on the horizontal midline,
 * which is what `d3.sankeyLinkHorizontal` draws.
 */
const bumpX: ChartCurve = {
	line: (points) => {
		if (points.length === 0) return ""
		const [first, ...rest] = points
		if (!first) return ""
		let path = `M${first[0]},${first[1]}`
		let previous = first
		for (const point of rest) {
			const midX = (previous[0] + point[0]) / 2
			path += `C${midX},${previous[1]},${midX},${point[1]},${point[0]},${point[1]}`
			previous = point
		}
		return path
	},
	// `link` never calls this; a rect fallback keeps the interface total rather
	// than lying with a throw inside a render path.
	area: (top, bottom) => {
		if (top.length === 0) return ""
		const forward = bumpX.line(top)
		const back = [...bottom].reverse()
		const backPath = bumpX.line(back).replace("M", "L")
		return `${forward}${backPath}Z`
	},
}

/**
 * Phase 0 spike: can `sankeyDiagram` express a service-flow map, and does its
 * "compose ordinary marks over final pixels" shape actually hold?
 *
 * It does, and this is the most pleasant composite in the package so far.
 * `sankeyDiagram` is NOT a mark that draws anything: it runs d3-sankey and calls
 * `marks: (context) => [...]` with `context.nodes` / `context.links` already
 * materialized in FINAL PLOT PIXELS (`x0/x1/y0/y1` on nodes, `x1/y1/x2/y2` plus
 * `width` on links). You then draw them with plain `rect` / `link` / `text`.
 * Internally the children are composed with `coordinates: "pixel"`, so no scale
 * is consulted — which is why `x: null` / `y: null` below is correct rather than
 * a workaround, exactly like the polar spike.
 *
 * What this buys, versus the polar spike's dead end: the children are ORDINARY
 * `ChartMark`s, so everything that works on a cartesian mark works here —
 * `states` on `rect` (the pie's missing hover affordance is available on sankey
 * nodes), `focus: "nearest"`, per-datum `VisualChannel` strokes. The
 * `whenFocused(mark: ChartMark)` vs `PolarMark` incompatibility that killed the
 * pie's hover has NO analogue here: `SankeyMarks` is `readonly [AnyChartMark,
 * ...]`, i.e. plain `ChartMark`, so `whenFocused` would typecheck if wanted.
 *
 * Three things that do bite:
 *
 * 1. **You must supply `nodes` yourself.** `sankeyDiagram` does not derive the
 *    node set from the links; passing only links throws inside `resolveNetworkGraph`.
 *    Derived here from the edge list so a caller only has to pass edges.
 * 2. **`link.strokeWidth` is the only ribbon primitive.** There is no
 *    variable-width band mark, so a sankey ribbon is a stroked `link` at
 *    `strokeWidth: l.width` with `curve: d3Curve(curveBumpX)`, which is exactly
 *    what `d3.sankeyLinkHorizontal` draws. The consequence is real: a stroke has
 *    ONE width for its whole length, so ribbons cannot taper between endpoints
 *    of different thickness. d3-sankey's own ribbons don't taper either, so this
 *    matches the reference rendering — but a tapered flow (Plotly-style) is not
 *    expressible at 0.14.0.
 * 3. **The mark's datum type is a UNION.** `sankeyDiagram` returns
 *    `ChartMark<ChartMarkDatum<TMarks[number]>, …>`, so the tooltip datum is
 *    `SankeyNode | SankeyLink | SankeySpikeNode`(from the text mark). Both node
 *    and link contexts carry a literal `kind: "node" | "link"` discriminant,
 *    which is clearly deliberate and makes the tooltip body a clean narrow.
 */
export const SankeySpike = memo(function SankeySpike({
	edges = SANKEY_SPIKE_EDGES,
	renderer,
	className,
}: {
	edges?: readonly SankeySpikeEdge[]
	renderer: TanstackRenderer
	className?: string
}) {
	return <SankeyFigure edges={edges} renderer={renderer} className={className} />
})

/**
 * Error-rate bands, in severity order. The thresholds are `strokeForEdge`'s.
 *
 * This is why the sankey's legend is a STATUS key rather than a series key:
 * nothing here is a series. The ribbons are one mark over one edge list and their
 * colour is a function of a computed rate, so the only thing a legend can name is
 * what the three colours mean — which is also the thing a viewer cannot otherwise
 * discover, since a healthy ribbon and an erroring one look identical apart from
 * hue.
 */
const FLOW_BANDS = [
	{ key: "error", label: "≥ 5% errors", token: "error" },
	{ key: "warning", label: "1–5% errors", token: "warning" },
	{ key: "healthy", label: "< 1% errors", token: "healthy" },
] as const satisfies readonly {
	key: string
	label: string
	token: keyof typeof FLOW_TOKENS
}[]

type FlowBand = (typeof FLOW_BANDS)[number]["key"]

function bandForEdge(edge: SankeySpikeEdge): FlowBand {
	const rate = edge.callCount === 0 ? 0 : edge.errorCount / edge.callCount
	if (rate >= 0.05) return "error"
	if (rate >= 0.01) return "warning"
	return "healthy"
}

function SankeyFigure({
	edges,
	renderer,
	className,
	mutedBands,
	legend,
}: {
	edges: readonly SankeySpikeEdge[]
	renderer: TanstackRenderer
	className?: string
	mutedBands?: ReadonlySet<string>
	legend?: ReactNode
}) {
	const colors = usePlotColors(FLOW_TOKENS)

	// Node set derived from the edges, in first-seen order. `sankeyDiagram`
	// requires `nodes` explicitly, and a fixed known list would silently drop any
	// service the caller's edges introduce.
	const nodes = useMemo(() => {
		const seen = new Set<string>()
		const derived: SankeySpikeNode[] = []
		for (const node of SANKEY_SPIKE_NODES) {
			if (edges.some((e) => e.sourceService === node.service || e.targetService === node.service)) {
				seen.add(node.service)
				derived.push(node)
			}
		}
		for (const edge of edges) {
			for (const service of [edge.sourceService, edge.targetService]) {
				if (seen.has(service)) continue
				seen.add(service)
				derived.push({ service })
			}
		}
		return derived
	}, [edges])

	// Error rate → colour. Three bands rather than a continuous ramp: `stroke` is
	// a `VisualChannel`, so a per-datum interpolation would also be legal, but
	// banding reads far better against a dark palette at 1–2px ribbon widths.
	const strokeForEdge = useMemo(
		() => (edge: SankeySpikeEdge) => {
			const band = bandForEdge(edge)
			// `link.strokeOpacity` is a flat number like every other opacity in the
			// package, and all fourteen ribbons come from ONE mark — so a per-band fade
			// has to be a per-band COLOUR. See `muteColor`.
			return mutedBands?.has(band)
				? muteColor(colors[band], colors.background, MUTED_COLOR_AMOUNT)
				: colors[band]
		},
		[colors, mutedBands],
	)

	const definition = useMemo(() => {
		return defineChart({
			marks: [
				sankeyDiagram({
					nodes,
					links: edges,
					// Accessors, never `"service"` field-name strings — `TransformValue`
					// resolves the same `ChannelField` machinery the pie spike documents,
					// and accessors keep the row types honest under `Omit`.
					nodeKey: (node: SankeySpikeNode) => node.service,
					source: (edge: SankeySpikeEdge) => edge.sourceService,
					target: (edge: SankeySpikeEdge) => edge.targetService,
					value: (edge: SankeySpikeEdge) => edge.callCount,
					nodeWidth: NODE_WIDTH,
					nodePadding: 14,
					// Room on the right for the terminal column's labels, which are drawn
					// outside the node box.
					inset: { top: 8, right: 96, bottom: 8, left: 8 },
					// `null`, not `undefined`: `undefined` lets d3 reorder rows, which
					// would make the fixture's column order depend on layout internals.
					nodeSort: null,
					marks: (context) => [
						// Ribbons first so nodes paint over their endpoints.
						link(context.links, {
							x1: (l) => l.x1,
							y1: (l) => l.y1,
							x2: (l) => l.x2,
							y2: (l) => l.y2,
							// See `bumpX` above: no curve presets ship, and the only adapter
							// (`d3Curve`) needs a `d3-shape` import apps/web cannot resolve.
							curve: bumpX,
							stroke: (l) => strokeForEdge(l.data),
							// The layout hands back the proportional band thickness; a
							// stroked link is the only way to paint it (see note 2 above).
							strokeWidth: (l) => Math.max(1, l.width),
							strokeOpacity: 0.38,
							lineCap: "butt",
							key: (l) => l.key,
						}),
						rect(context.nodes, {
							x1: (n) => n.x0,
							x2: (n) => n.x1,
							y1: (n) => n.y0,
							y2: (n) => n.y1,
							fill: colors.node,
							radius: 2,
							key: (n) => n.key,
							// PROOF that composite children keep full mark capability:
							// `states` is a plain `ChartRectStateStyle`, so the hover
							// affordance the pie could not express at all works here.
							states: [
								{ when: { focus: "primary" }, style: { fillOpacity: 1 } },
								{ when: { focus: "unmatched" }, style: { fillOpacity: 0.4 } },
							],
						}),
						text(context.nodes, {
							x: (n) => n.x1 + 6,
							y: (n) => n.y,
							text: (n) => n.data.service,
							anchor: "start",
							fill: colors.nodeLabel,
							fontSize: 11,
							fontWeight: 500,
							dy: 4,
							key: (n) => n.key,
						}),
					],
				}),
			],
			// Pixel-space composite: there is no x/y domain to infer, and letting one
			// be inferred draws axes over an empty scale.
			x: null,
			y: null,
			guides: false,
			// Unlike the polar spike, `focus: "nearest"` DOES engage — the children
			// are ordinary cartesian marks in pixel coordinates.
			focus: "nearest",
			focusRing: false,
			tooltip: { use: tooltip, className: "maple-plot-tooltip" },
		})
	}, [nodes, edges, colors, strokeForEdge])

	return (
		<PlotFrame
			renderer={plotRendererFor(renderer)}
			className={className}
			ariaLabel="Service call flow"
			definition={definition}
			legend={legend}
			renderTooltipBody={({ points }) => {
				const datum = points[0]?.datum
				if (!datum || !("kind" in datum)) return null

				if (datum.kind === "node") {
					return (
						<div className="flex items-center gap-2">
							<span
								className="size-2.5 shrink-0 rounded-[2px]"
								style={{ backgroundColor: colors.node }}
							/>
							<span className="text-muted-foreground">{datum.data.service}</span>
							<span className="font-mono font-semibold tabular-nums">
								{compactCount.format(datum.value)} calls
							</span>
						</div>
					)
				}

				const edge = datum.data
				const rate = edge.callCount === 0 ? 0 : edge.errorCount / edge.callCount
				return (
					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<span
								className="size-2.5 shrink-0 rounded-[2px]"
								style={{ backgroundColor: strokeForEdge(edge) }}
							/>
							<span className="text-muted-foreground">
								{edge.sourceService} → {edge.targetService}
							</span>
						</div>
						<div className="flex items-center justify-between gap-4 pl-[18px]">
							<span className="text-muted-foreground">calls</span>
							<span className="font-mono font-semibold tabular-nums">
								{compactCount.format(edge.callCount)}
							</span>
						</div>
						<div className="flex items-center justify-between gap-4 pl-[18px]">
							<span className="text-muted-foreground">errors</span>
							<span className="font-mono font-semibold tabular-nums">
								{compactCount.format(edge.errorCount)} ({Math.round(rate * 1000) / 10}%)
							</span>
						</div>
					</div>
				)
			}}
		/>
	)
}

/**
 * The same flow map with a status key beneath it.
 *
 * Unlike every other legend in the lab this one is not a series list — see
 * `FLOW_BANDS`. Picking a band brings those ribbons forward and quiets the rest,
 * which is the read this diagram actually needs: an all-healthy sankey is a wall
 * of ribbons and the erroring ones are the thin ones, easily lost. Filtering the
 * edges instead would drop whole services out of the node set and rerun the
 * layout, so the columns would jump.
 */
export const SankeyLegendSpike = memo(function SankeyLegendSpike({
	edges = SANKEY_SPIKE_EDGES,
	renderer,
	className,
}: {
	edges?: readonly SankeySpikeEdge[]
	renderer: TanstackRenderer
	className?: string
}) {
	const colors = usePlotColors(FLOW_TOKENS)

	const legendSeries = useMemo<PlotLegendSeries[]>(
		() => FLOW_BANDS.map((band) => ({ key: band.key, label: band.label, color: colors[band.token] })),
		[colors],
	)
	const { highlighted, highlight } = usePlotLegendHighlight()

	const mutedBands = useMemo(
		() =>
			new Set(
				highlighted === null
					? []
					: FLOW_BANDS.filter((band) => band.key !== highlighted).map((band) => band.key),
			),
		[highlighted],
	)

	return (
		<SankeyFigure
			edges={edges}
			renderer={renderer}
			className={className}
			mutedBands={mutedBands}
			legend={
				<PlotSeriesLegend
					series={legendSeries}
					highlighted={highlighted}
					onHighlight={highlight}
					label="Flow health"
				/>
			}
		/>
	)
})
