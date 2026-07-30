import type { RawSqlDisplayType } from "./query-engine"

// ---------------------------------------------------------------------------
// The widget type table.
//
// A dashboard widget has two persisted axes: `visualization` (which renderer and
// which data-source endpoint) and `display.chartId` (which `chartRegistry` entry
// a `chart` widget mounts). A **panel type** collapses them into one closed list
// — see `apps/web/src/lib/query-builder/panel-types.ts` for the history.
//
// This module is the single description of that list. It carries only what both
// runtimes can agree on: no React, no `@maple/ui`, no chart components. The web
// registry (`apps/web/src/components/dashboard-builder/widgets/widget-type-registry.tsx`)
// layers renderers, config panels and builder logic on top of these entries.
//
// Before this existed the same facts were forked across the web store, the
// portable-dashboard importer, the MCP tools and the Perses importer, and they
// had already drifted. Anything a new widget type needs to declare belongs here.
// ---------------------------------------------------------------------------

export type PanelType =
	| "line"
	| "bar"
	| "area"
	| "stat"
	| "gauge"
	| "table"
	| "list"
	| "pie"
	| "histogram"
	| "heatmap"
	| "funnel"
	| "markdown"

/**
 * The persisted `visualization` field. Narrower than `PanelType`: line, bar and
 * area all persist as `"chart"` and are told apart by `display.chartId`.
 */
export type WidgetVisualization =
	| "chart"
	| "stat"
	| "gauge"
	| "table"
	| "list"
	| "pie"
	| "histogram"
	| "heatmap"
	| "funnel"
	| "markdown"

/**
 * Display keys owned by exactly one panel type. `buildWidgetDisplay` clears the
 * union of these before each type writes back the ones it owns, so nothing leaks
 * across a type switch — a line chart switched to Pie must not keep
 * `chartId: "query-builder-line"`.
 *
 * Keys absent from this union (`pie`, `funnel`, `histogram`, `xAxis`, …) are
 * never written by the builder and are therefore preserved across a switch.
 */
export type OwnedDisplayKey =
	| "chartId"
	| "stacked"
	| "curveType"
	| "thresholds"
	| "sparkline"
	| "gauge"
	| "heatmap"
	| "markdown"
	| "columns"
	| "listDataSource"
	| "listWhereClause"
	| "listLimit"
	| "listRootOnly"

export interface WidgetTypeMeta {
	readonly panelType: PanelType
	/** Label shown in the Type picker and in chat approval cards. */
	readonly label: string
	/** The persisted `visualization`. Line, bar and area all share `"chart"`. */
	readonly visualization: WidgetVisualization
	/** Canonical `chartRegistry` id written for panel types that mount a chart. */
	readonly chartId?: string
	/**
	 * The `chartRegistry` category this panel type corresponds to. Stored rather
	 * than looked up because this package must not depend on `@maple/ui`; the web
	 * side cross-checks it against the live registry.
	 */
	readonly chartCategory?: string
	/**
	 * Grid size used by every path that auto-places a hand-added widget (the web
	 * store, the portable-dashboard importer, the MCP tools).
	 *
	 * The canvas is a 12-column grid with `rowHeight: 60` and a 12px gutter, so a
	 * tile's pixel height is `h * 60 + (h - 1) * 12` — charts at `h: 6` render
	 * 420px tall.
	 */
	readonly defaultLayout: {
		readonly w: number
		readonly h: number
		readonly minW: number
		readonly minH: number
	}
	/**
	 * Compact height used by dashboard templates, which pack stat rows tighter
	 * than a hand-added stat (`h: 2` vs the `h: 4` that leaves room for a
	 * sparkline). Reconciling the two is a separate change.
	 */
	readonly templateHeight: { readonly h: number; readonly minH: number }
	/** Width override for MCP-added widgets, where a gauge is deliberately narrow. */
	readonly mcpWidth?: number
	/** Raw-SQL display type. `undefined` for types with no SQL rendering (notes). */
	readonly rawSqlDisplayType?: RawSqlDisplayType
	readonly ownedDisplayKeys: ReadonlyArray<OwnedDisplayKey>
	/** Lowers to the breakdown endpoint, which is meaningless without a group-by. */
	readonly requiresGroupBy: boolean
	/** Offered by the `add_dashboard_widget` / `create_dashboard` MCP tools. */
	readonly mcpExposed: boolean
	/** Perses panel `kind`s that import as this panel type. */
	readonly persesKinds: ReadonlyArray<string>
}

const CHART_LAYOUT = { w: 4, h: 6, minW: 2, minH: 2 } as const
const CHART_TEMPLATE_HEIGHT = { h: 6, minH: 2 } as const
const WIDE_LAYOUT = { w: 6, h: 5, minW: 3, minH: 3 } as const
const WIDE_TEMPLATE_HEIGHT = { h: 5, minH: 3 } as const

const chartPanel = (
	panelType: "line" | "bar" | "area",
	label: string,
	persesKinds: ReadonlyArray<string>,
): WidgetTypeMeta => ({
	panelType,
	label,
	visualization: "chart",
	chartId: `query-builder-${panelType}`,
	chartCategory: panelType,
	defaultLayout: CHART_LAYOUT,
	templateHeight: CHART_TEMPLATE_HEIGHT,
	rawSqlDisplayType: panelType,
	ownedDisplayKeys: ["chartId", "stacked", "curveType", "thresholds"],
	requiresGroupBy: false,
	// One `chart` entry covers line/bar/area for the MCP tools; the display type
	// is chosen separately there.
	mcpExposed: panelType === "line",
	persesKinds,
})

/**
 * A panel type that is its own `visualization` and also mounts a chart component.
 */
const breakdownPanel = (
	panelType: "pie" | "histogram" | "heatmap" | "funnel",
	label: string,
	options: {
		requiresGroupBy: boolean
		ownedDisplayKeys?: ReadonlyArray<OwnedDisplayKey>
		persesKinds?: ReadonlyArray<string>
	},
): WidgetTypeMeta => ({
	panelType,
	label,
	visualization: panelType,
	chartId: `query-builder-${panelType}`,
	chartCategory: panelType,
	defaultLayout: CHART_LAYOUT,
	templateHeight: CHART_TEMPLATE_HEIGHT,
	rawSqlDisplayType: panelType,
	ownedDisplayKeys: options.ownedDisplayKeys ?? ["chartId"],
	requiresGroupBy: options.requiresGroupBy,
	mcpExposed: true,
	persesKinds: options.persesKinds ?? [],
})

export const WIDGET_TYPES: Record<PanelType, WidgetTypeMeta> = {
	line: chartPanel("line", "Line", ["TimeSeriesChart"]),
	bar: chartPanel("bar", "Bar", ["BarChart"]),
	area: chartPanel("area", "Area", []),

	stat: {
		panelType: "stat",
		label: "Stat",
		visualization: "stat",
		// Deliberately taller than the `h: 2` template tiles — a hand-added stat
		// gets room for a sparkline.
		defaultLayout: { w: 3, h: 4, minW: 2, minH: 2 },
		templateHeight: { h: 2, minH: 2 },
		rawSqlDisplayType: "stat",
		ownedDisplayKeys: ["sparkline", "thresholds"],
		requiresGroupBy: false,
		mcpExposed: true,
		persesKinds: ["StatChart"],
	},

	gauge: {
		panelType: "gauge",
		label: "Gauge",
		visualization: "gauge",
		defaultLayout: CHART_LAYOUT,
		templateHeight: CHART_TEMPLATE_HEIGHT,
		mcpWidth: 3,
		// A gauge is a scalar on an arc — the same single-row SQL shape as a stat,
		// and there is no `gauge` member of `RawSqlDisplayType`.
		rawSqlDisplayType: "stat",
		ownedDisplayKeys: ["gauge", "thresholds"],
		requiresGroupBy: false,
		mcpExposed: true,
		persesKinds: ["GaugeChart"],
	},

	table: {
		panelType: "table",
		label: "Table",
		visualization: "table",
		defaultLayout: WIDE_LAYOUT,
		templateHeight: WIDE_TEMPLATE_HEIGHT,
		rawSqlDisplayType: "table",
		ownedDisplayKeys: ["columns"],
		requiresGroupBy: false,
		mcpExposed: true,
		persesKinds: ["Table", "LogsTable", "TimeSeriesTable"],
	},

	list: {
		panelType: "list",
		label: "List",
		visualization: "list",
		defaultLayout: WIDE_LAYOUT,
		templateHeight: WIDE_TEMPLATE_HEIGHT,
		// Deliberately absent. A list is configured by `ListConfigPanel`, never by
		// SQL — the widget editor hides the Raw SQL toggle for it — so it has no
		// raw-SQL rendering and falls back to `line` like every other type without
		// one. Giving it `"table"` looks right but silently changes what an
		// MCP-created `visualization: "list"` + `sql` widget renders as.
		ownedDisplayKeys: ["columns", "listDataSource", "listWhereClause", "listLimit", "listRootOnly"],
		requiresGroupBy: false,
		mcpExposed: true,
		persesKinds: [],
	},

	pie: breakdownPanel("pie", "Pie", { requiresGroupBy: true, persesKinds: ["PieChart"] }),
	// A histogram is a *distribution*, so it has two legitimate shapes: grouped
	// (pre-bucketed bars) or raw per-row values the chart bucketizes client-side.
	// The second is valid without a group-by, so the blanket requirement is off
	// and the panel validates its own narrower rule.
	histogram: breakdownPanel("histogram", "Histogram", {
		requiresGroupBy: false,
		persesKinds: ["Histogram", "HistogramChart"],
	}),
	heatmap: breakdownPanel("heatmap", "Heatmap", {
		requiresGroupBy: true,
		ownedDisplayKeys: ["chartId", "heatmap"],
		persesKinds: ["HeatMap", "HeatMapChart", "Heatmap"],
	}),
	funnel: breakdownPanel("funnel", "Funnel", { requiresGroupBy: true }),

	markdown: {
		panelType: "markdown",
		label: "Note",
		visualization: "markdown",
		// Notes sit at the chart width but the wide height — they are read, not
		// scanned in a row of tiles.
		defaultLayout: { w: 4, h: 5, minW: 2, minH: 3 },
		templateHeight: WIDE_TEMPLATE_HEIGHT,
		ownedDisplayKeys: ["markdown"],
		requiresGroupBy: false,
		mcpExposed: true,
		persesKinds: ["Markdown"],
	},
}

export const PANEL_TYPES: ReadonlyArray<WidgetTypeMeta> = [
	// Ordered as the Type picker shows them, not alphabetically.
	WIDGET_TYPES.line,
	WIDGET_TYPES.bar,
	WIDGET_TYPES.area,
	WIDGET_TYPES.pie,
	WIDGET_TYPES.stat,
	WIDGET_TYPES.gauge,
	WIDGET_TYPES.table,
	WIDGET_TYPES.list,
	WIDGET_TYPES.histogram,
	WIDGET_TYPES.heatmap,
	WIDGET_TYPES.funnel,
	WIDGET_TYPES.markdown,
]

export const isPanelType = (value: string): value is PanelType => value in WIDGET_TYPES

/**
 * The panel type whose `visualization` matches, ignoring `chartId`. Ambiguous for
 * `"chart"` — which resolves to `line` — so callers that hold a `chartId` should
 * use the web-side `toPanelType`, which consults the chart registry.
 */
export const widgetTypeByVisualization = (visualization: string): WidgetTypeMeta | undefined =>
	visualization === "chart"
		? WIDGET_TYPES.line
		: isPanelType(visualization)
			? WIDGET_TYPES[visualization]
			: undefined

/** The panel type a Perses panel `kind` imports as. Unknown kinds become a line chart. */
export const widgetTypeByPersesKind = (kind: string | undefined): WidgetTypeMeta =>
	PANEL_TYPES.find((meta) => kind != null && meta.persesKinds.includes(kind)) ?? WIDGET_TYPES.line

/** Distinct `visualization` values the MCP dashboard tools accept. */
export const MCP_VISUALIZATIONS: ReadonlyArray<string> = [
	...new Set(PANEL_TYPES.filter((meta) => meta.mcpExposed).map((meta) => meta.visualization)),
]

/**
 * Grid rows a widget occupies in a dashboard template, and the smallest it may be
 * resized to. Auto-placing paths want {@link WidgetTypeMeta.defaultLayout} instead
 * — this is the tighter packing templates use.
 */
export const defaultWidgetHeight = (visualization: string): { h: number; minH: number } => {
	const meta = widgetTypeByVisualization(visualization)
	return meta ? { ...meta.templateHeight } : { ...CHART_TEMPLATE_HEIGHT }
}

/** Grid size for an auto-placed widget, by persisted `visualization`. */
export const defaultWidgetLayout = (
	visualization: string,
): { w: number; h: number; minW: number; minH: number } => ({
	...(widgetTypeByVisualization(visualization)?.defaultLayout ?? CHART_LAYOUT),
})

/**
 * The raw-SQL display type a widget renders with. `chartId` disambiguates the
 * three panel types that share `visualization: "chart"`.
 */
export const rawSqlDisplayTypeFor = (visualization: string, chartId?: string): RawSqlDisplayType => {
	if (visualization === "chart") {
		if (chartId?.includes("bar")) return "bar"
		if (chartId?.includes("area")) return "area"
		return "line"
	}
	return widgetTypeByVisualization(visualization)?.rawSqlDisplayType ?? "line"
}
