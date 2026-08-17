import { usePlotColors, type PlotColorToken } from "@maple/ui/components/plot/theme"
import { defineChart } from "@tanstack/charts"
import { treemap } from "@tanstack/charts/hierarchy/treemap"
import { tooltip } from "@tanstack/charts/tooltip"
import { memo, useMemo, type ReactNode } from "react"

import {
	ChartSeriesLegend,
	useChartLegendState,
	type LegendSeriesSpec,
} from "@/lab/bench/tanstack/chart-legend"
import { TanstackChartFrame, type TanstackRenderer } from "@/lab/bench/tanstack/tanstack-chart"

/**
 * One warehouse row: span count for a `(service, operation)` pair — the shape
 * `getServiceTopOperations` already returns, flattened to what an area-weighted
 * breakdown needs.
 *
 * Closed row type, no index signature: `treemap` wraps rows in
 * `TreemapNode<TDatum>` whose `data` is `TDatum | null`, and every derived
 * `Omit`/`keyof` in the package collapses the moment an index signature exists
 * (see `pie-spike.tsx`).
 */
export interface TreemapSpikeRow {
	service: string
	operation: string
	spanCount: number
}

const TILE_TOKENS = {
	c1: ["--chart-1", "#6366f1"],
	c2: ["--chart-2", "#ec4899"],
	c3: ["--chart-3", "#f59e0b"],
	c4: ["--chart-4", "#10b981"],
	c5: ["--chart-5", "#3b82f6"],
	label: ["--background", "#0b0b0f"],
	tileStroke: ["--background", "#0b0b0f"],
} as const satisfies Record<string, readonly [PlotColorToken, string]>

/**
 * Deterministic fixture: 6 services × 3–5 operations, span counts in a realistic
 * spread (a hot HTTP handler dominates; background jobs are a rounding error).
 * No `Math.random()` / `Date.now()` — the lab route remounts on renderer and
 * theme switches and a moving fixture makes every comparison meaningless.
 */
export const TREEMAP_SPIKE_ROWS: readonly TreemapSpikeRow[] = [
	{ service: "api", operation: "GET /v2/traces", spanCount: 184_200 },
	{ service: "api", operation: "POST /v2/query", spanCount: 96_400 },
	{ service: "api", operation: "GET /v2/dashboards", spanCount: 41_800 },
	{ service: "api", operation: "GET /health", spanCount: 22_600 },
	{ service: "api", operation: "POST /v2/alerts", spanCount: 8_150 },

	{ service: "query-engine", operation: "executeSql", spanCount: 142_700 },
	{ service: "query-engine", operation: "compileCH", spanCount: 88_300 },
	{ service: "query-engine", operation: "cache.lookup", spanCount: 61_500 },
	{ service: "query-engine", operation: "decodeRows", spanCount: 30_900 },

	{ service: "ingest", operation: "otlp.traces", spanCount: 268_400 },
	{ service: "ingest", operation: "otlp.logs", spanCount: 74_100 },
	{ service: "ingest", operation: "key.resolve", spanCount: 52_300 },

	{ service: "web", operation: "ssr.render", spanCount: 39_600 },
	{ service: "web", operation: "loader.dashboard", spanCount: 27_200 },
	{ service: "web", operation: "loader.traces", spanCount: 19_450 },
	{ service: "web", operation: "loader.alerts", spanCount: 11_300 },

	{ service: "auth", operation: "token.validate", spanCount: 58_900 },
	{ service: "auth", operation: "org.resolve", spanCount: 24_700 },
	{ service: "auth", operation: "session.refresh", spanCount: 6_050 },

	{ service: "alerting", operation: "rule.evaluate", spanCount: 33_800 },
	{ service: "alerting", operation: "incident.upsert", spanCount: 9_400 },
	{ service: "alerting", operation: "notify.dispatch", spanCount: 4_120 },
	{ service: "alerting", operation: "check.persist", spanCount: 2_980 },
]

/**
 * NUL, because operation names are routes and contain both `/` and spaces. The
 * `delimiter` default is `/`, so `"api/GET /v2/traces"` would silently split
 * into three levels with no error. See the `path` note in the component comment.
 */
const PATH_DELIMITER = "\u0000"

const compactCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

/**
 * Phase 0 spike: does `treemap` render an area-weighted service → operation
 * breakdown, and are in-cell labels expressible?
 *
 * Both yes, and unlike the polar spike nothing here is a dead end.
 *
 * **Which overload.** `treemap` has two: `path` (a delimited string per row) and
 * `nodeId`/`parentId`. **`path` is the right one for warehouse output** and this
 * spike uses it. The reason is structural, not stylistic: a `GROUP BY service,
 * operation` result has NO row for the parent — there is no "api" row, only
 * `(api, GET /v2/traces)` rows. The `nodeId`/`parentId` form therefore forces you
 * to synthesize a parent row per service and give it a null/zero value, which
 * means fabricating rows that the query never returned and that then have to be
 * excluded from the tooltip. `path` derives the internal nodes from the leaves,
 * which is exactly the shape the data already has.
 *
 * The one catch: `delimiter` defaults to `/`, and Maple operation names are
 * routes — `"api/GET /v2/traces"` would split into three levels. Passing an
 * explicit delimiter that cannot occur in a segment (NUL here) is mandatory, not
 * defensive. A caller who forgets gets a silently deeper tree, no error.
 *
 * **Labels compose INSIDE the mark, and that is the interesting finding.** There
 * is no need for a separate `text` mark — `treemap` takes `label` /`labelFill` /
 * `labelFontSize` / `labelFontWeight` / `labelPadding` directly, and the layout
 * measures each cell and DROPS the label when it does not fit (`labelPadding`,
 * default 4, is the minimum painted margin it insists on). That is strictly
 * better than a composed `text` mark would be: a `text` mark has no knowledge of
 * cell extents and would overflow the small tiles. Contrast with the sankey
 * spike, where node labels genuinely do need their own `text` mark.
 *
 * **`states` works** — `treemap`'s `states` is a plain
 * `ChartMarkState<TreemapNode<TDatum>, ChartRectStateStyle<…>>`, so the hover
 * affordance the pie could not express by any route is one option here.
 *
 * **What does NOT work at 0.14.0:** the mark paints LEAVES only. `TreemapNode`
 * carries `internal` / `external` / `depth` / `ancestorIds`, so you can *read*
 * the service grouping in a `fill` accessor (that is how the per-service colour
 * below works), but there is no way to paint a parent frame, a service header
 * band, or padding-that-reads-as-a-group border. `paddingOuter` insets children
 * from a parent box that is never drawn. So a Plotly/Grafana-style treemap with
 * labelled service rectangles enclosing their operations is not expressible —
 * only the flat leaf mosaic, grouped by colour. Confirmed by resolving the scene
 * headlessly: 11 rows in, 11 painted points out, all `external: true`.
 */
export const TreemapSpike = memo(function TreemapSpike({
	rows = TREEMAP_SPIKE_ROWS,
	renderer,
	className,
}: {
	rows?: readonly TreemapSpikeRow[]
	renderer: TanstackRenderer
	className?: string
}) {
	const { colors, serviceColor } = useTreemapColors(rows)
	return (
		<TreemapFigure
			rows={rows}
			renderer={renderer}
			className={className}
			colors={colors}
			serviceColor={serviceColor}
		/>
	)
})

/**
 * Chrome colours plus service → tile colour.
 *
 * `rows` here is always the FULL list, never a filtered one: the palette index is
 * assigned in first-seen order, so hiding a service would otherwise renumber
 * every service after it and recolour tiles the legend never touched.
 */
function useTreemapColors(rows: readonly TreemapSpikeRow[]) {
	const colors = usePlotColors(TILE_TOKENS)

	// Only `--chart-1`..`--chart-5` exist in `packages/ui/src/styles/tokens.css`;
	// the sixth service wraps rather than inventing a `--chart-6` that would
	// resolve to its literal fallback and ignore the theme.
	const serviceColor = useMemo(() => {
		const palette = [colors.c1, colors.c2, colors.c3, colors.c4, colors.c5]
		const order = new Map<string, number>()
		for (const row of rows) {
			if (!order.has(row.service)) order.set(row.service, order.size)
		}
		return (service: string) => palette[(order.get(service) ?? 0) % palette.length] ?? palette[0]
	}, [rows, colors])

	return { colors, serviceColor }
}

function TreemapFigure({
	rows,
	renderer,
	className,
	colors,
	serviceColor,
	legend,
}: {
	rows: readonly TreemapSpikeRow[]
	renderer: TanstackRenderer
	className?: string
	colors: Readonly<Record<keyof typeof TILE_TOKENS, string>>
	serviceColor: (service: string) => string
	legend?: ReactNode
}) {
	const definition = useMemo(() => {
		return defineChart({
			marks: [
				treemap(rows, {
					// Accessor, not the `"…"` field-name string form: `TransformValue`
					// runs the same `ChannelField` resolution the pie spike documents.
					path: (row: TreemapSpikeRow) => `${row.service}${PATH_DELIMITER}${row.operation}`,
					delimiter: PATH_DELIMITER,
					value: (row: TreemapSpikeRow) => row.spanCount,
					method: "squarify",
					paddingInner: 2,
					round: true,
					radius: 3,
					// `node.data` is `TDatum | null` — null on the internal nodes the
					// mark constructs but never paints. Verified against a headless
					// `createChartScene`: every PAINTED point is a leaf (`external:
					// true`) carrying the original row, so `data.service` is the read.
					//
					// `ancestorIds` looked like the tidier answer and is a trap: it holds
					// synthetic IDs, not names — `["/", "/api"]` — with `/` inside a
					// segment escaped as `\/`. Colouring off it would key on `"/api"`.
					fill: (node) => serviceColor(node.data?.service ?? node.name),
					fillOpacity: 0.82,
					stroke: colors.tileStroke,
					strokeWidth: 1,
					states: [
						{ when: { focus: "primary" }, style: { fillOpacity: 1 } },
						{ when: { focus: "unmatched" }, style: { fillOpacity: 0.45 } },
					],
					// In-cell labels, measured and dropped by the mark when they do not
					// fit. `node.name` is the LAST path segment, i.e. the operation.
					label: (node) => node.name,
					labelFill: colors.label,
					labelFontSize: 10,
					labelFontWeight: 600,
					labelPadding: 6,
				}),
			],
			// A treemap resolves its own plot-space rectangles; an inferred x/y domain
			// would draw axes over coordinates that mean nothing.
			x: null,
			y: null,
			guides: false,
			focus: "nearest",
			focusRing: false,
			tooltip: { use: tooltip, className: "maple-bench-tooltip" },
		})
	}, [rows, colors, serviceColor])

	const total = useMemo(() => rows.reduce((sum, row) => sum + row.spanCount, 0), [rows])

	return (
		<TanstackChartFrame
			renderer={renderer}
			className={className}
			ariaLabel="Span volume by service and operation"
			definition={definition}
			legend={legend}
			// Mandatory: the default body prints the mark's x/y channels, which for a
			// treemap are the tile's resolved pixel edges.
			renderTooltipBody={({ points }) => {
				const node = points[0]?.datum
				if (!node) return null
				const service = node.data?.service ?? node.name
				const share = total === 0 ? 0 : node.value / total
				return (
					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<span
								className="size-2.5 shrink-0 rounded-[2px]"
								style={{ backgroundColor: serviceColor(service) }}
							/>
							<span className="text-muted-foreground">{service}</span>
							<span className="font-medium">{node.data?.operation ?? node.name}</span>
						</div>
						<div className="flex items-center justify-between gap-4 pl-[18px]">
							<span className="text-muted-foreground">spans</span>
							<span className="font-mono font-semibold tabular-nums">
								{compactCount.format(node.value)} ({Math.round(share * 1000) / 10}%)
							</span>
						</div>
					</div>
				)
			}}
		/>
	)
}

/**
 * The same mosaic with a service key beneath it.
 *
 * This is the legend the treemap most needs, and for a reason specific to the
 * mark: `treemap` paints LEAVES only, so the service grouping exists in the
 * colouring and nowhere else — there is no parent frame or header band to label
 * it (see the note above). Without a key, a viewer can see that four tiles share
 * a hue but not what the hue means.
 *
 * Hiding a service drops its rows before the layout runs, so the survivors
 * retile across the full area rather than leaving a hole.
 */
export const TreemapLegendSpike = memo(function TreemapLegendSpike({
	rows = TREEMAP_SPIKE_ROWS,
	renderer,
	className,
}: {
	rows?: readonly TreemapSpikeRow[]
	renderer: TanstackRenderer
	className?: string
}) {
	const { colors, serviceColor } = useTreemapColors(rows)

	const legendSeries = useMemo<LegendSeriesSpec[]>(() => {
		const seen = new Set<string>()
		const items: LegendSeriesSpec[] = []
		for (const row of rows) {
			if (seen.has(row.service)) continue
			seen.add(row.service)
			items.push({ key: row.service, label: row.service, color: serviceColor(row.service) })
		}
		return items
	}, [rows, serviceColor])

	const { hidden, toggle } = useChartLegendState(legendSeries)

	const visibleRows = useMemo(() => rows.filter((row) => !hidden.has(row.service)), [rows, hidden])

	return (
		<TreemapFigure
			rows={visibleRows}
			renderer={renderer}
			className={className}
			colors={colors}
			serviceColor={serviceColor}
			legend={
				<ChartSeriesLegend
					series={legendSeries}
					hidden={hidden}
					onToggle={toggle}
					label="Span volume by service"
				/>
			}
		/>
	)
})
