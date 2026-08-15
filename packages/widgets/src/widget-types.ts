import type { RawSqlDisplayType } from "./raw-sql-display"

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

export type PanelType =
	| "line"
	| "bar"
	| "hbar"
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
 *
 * A const tuple rather than a bare union because schema v2 closes the stored
 * field against it (`Schema.Literals(WIDGET_VISUALIZATIONS)`), and a union alone
 * has no runtime value to close it with. This is still the single declaration:
 * `WIDGET_TYPES` is typed `Record<PanelType, WidgetTypeMeta>`, so no entry can
 * name a visualization missing from here, and `widget-types.test.ts` asserts the
 * reverse — every member is claimed by at least one panel type.
 */
export const WIDGET_VISUALIZATIONS = [
	"chart",
	"hbar",
	"stat",
	"gauge",
	"table",
	"list",
	"pie",
	"histogram",
	"heatmap",
	"funnel",
	"markdown",
] as const

export type WidgetVisualization = (typeof WIDGET_VISUALIZATIONS)[number]

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
	/** Width override for MCP-added widgets, where a gauge is deliberately narrow. */
	readonly mcpWidth?: number
	/** Raw-SQL display type. `undefined` for types with no SQL rendering (notes). */
	readonly rawSqlDisplayType?: RawSqlDisplayType
	/**
	 * Renders a single number, so its query must be reduced to one via a
	 * `reduceToValue` transform for the tile to read `data[0].value`.
	 *
	 * A flag rather than a `visualization === "stat" || === "gauge"` test because
	 * that test was written out in four places — the web raw-SQL builder, the MCP
	 * one, the Perses importer and the widget editor — and the Perses copy had
	 * already drifted (it also fires on `displayType === "stat"`).
	 */
	readonly isScalar: boolean
	readonly ownedDisplayKeys: ReadonlyArray<OwnedDisplayKey>
	/** Lowers to the breakdown endpoint, which is meaningless without a group-by. */
	readonly requiresGroupBy: boolean
	/** Offered by the `add_dashboard_widget` / `create_dashboard` MCP tools. */
	readonly mcpExposed: boolean
	/** Perses panel `kind`s that import as this panel type. */
	readonly persesKinds: ReadonlyArray<string>
}

const CHART_LAYOUT = { w: 4, h: 6, minW: 2, minH: 2 } as const
const WIDE_LAYOUT = { w: 6, h: 5, minW: 3, minH: 3 } as const

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
	rawSqlDisplayType: panelType,
	isScalar: false,
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
	panelType: "pie" | "histogram" | "heatmap" | "funnel" | "hbar",
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
	rawSqlDisplayType: panelType,
	isScalar: false,
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
		// Taller than the other compact tiles: a stat gets room for a sparkline.
		defaultLayout: { w: 3, h: 4, minW: 2, minH: 2 },
		rawSqlDisplayType: "stat",
		isScalar: true,
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
		mcpWidth: 3,
		// A gauge is a scalar on an arc — the same single-row SQL shape as a stat,
		// and there is no `gauge` member of `RawSqlDisplayType`.
		rawSqlDisplayType: "stat",
		isScalar: true,
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
		rawSqlDisplayType: "table",
		isScalar: false,
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
		// Deliberately absent. A list is configured by `ListConfigPanel`, never by
		// SQL — the widget editor hides the Raw SQL toggle for it — so it has no
		// raw-SQL rendering and falls back to `line` like every other type without
		// one. Giving it `"table"` looks right but silently changes what an
		// MCP-created `visualization: "list"` + `sql` widget renders as.
		isScalar: false,
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
	// A funnel implies sequential stages with a monotonic drop-off, and it labels
	// each bar as a share of the *largest* bar. A ranked "top N by volume"
	// breakdown is neither — four unrelated operations of equal size all read
	// "100%". `hbar` is that panel: rows sorted by value, each labelled with its
	// share of the **total**.
	funnel: breakdownPanel("funnel", "Funnel", { requiresGroupBy: true }),
	hbar: breakdownPanel("hbar", "Horizontal Bar", {
		requiresGroupBy: true,
		// Perses' BarChart is horizontal, but `bar` has imported it since the
		// importer existed and re-pointing it would silently restyle every
		// imported dashboard. New imports stay on `bar`.
		persesKinds: [],
	}),

	markdown: {
		panelType: "markdown",
		label: "Note",
		visualization: "markdown",
		// Notes sit at the chart width but the wide height — they are read, not
		// scanned in a row of tiles.
		defaultLayout: { w: 4, h: 5, minW: 2, minH: 3 },
		isScalar: false,
		ownedDisplayKeys: ["markdown"],
		requiresGroupBy: false,
		mcpExposed: true,
		persesKinds: ["Markdown"],
	},
} satisfies Record<PanelType, WidgetTypeMeta>

export const PANEL_TYPES: ReadonlyArray<WidgetTypeMeta> = [
	// Ordered as the Type picker shows them, not alphabetically.
	WIDGET_TYPES.line,
	WIDGET_TYPES.bar,
	WIDGET_TYPES.hbar,
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

/**
 * Rows a list widget shows when its limit is left blank.
 *
 * One constant because there were four different answers for one field: the
 * fetch used `?? 50`, the save persisted `?? 25`, presets seeded `25`, and
 * templates and the MCP tools wrote `10`. A list saved with an empty limit
 * therefore fetched 50 rows, stored 25, and came back showing 25 — the row count
 * changed across a reload with no edit.
 *
 * 50 rather than 25 because it is what the widget already fetches, so existing
 * lists keep rendering the same number of rows and only the persisted value
 * changes. An explicit limit — the `10`s in templates and presets — is a
 * deliberate per-widget choice and is untouched; it simply stops being a default.
 */
export const DEFAULT_LIST_LIMIT = 50

/** Narrows an arbitrary stored/user-supplied string to the closed set. */
export const isWidgetVisualization = (value: unknown): value is WidgetVisualization =>
	WIDGET_VISUALIZATIONS.some((candidate) => candidate === value)

/** Distinct `visualization` values the MCP dashboard tools accept. */
export const MCP_VISUALIZATIONS: ReadonlyArray<WidgetVisualization> = [
	...new Set(PANEL_TYPES.filter((meta) => meta.mcpExposed).map((meta) => meta.visualization)),
]

/** Narrows to the MCP-exposed subset — what `add_dashboard_widget` accepts. */
export const isMcpVisualization = (value: unknown): value is WidgetVisualization =>
	MCP_VISUALIZATIONS.some((candidate) => candidate === value)

/** Grid size for an auto-placed widget, by persisted `visualization`. */
export const defaultWidgetLayout = (
	visualization: string,
): { w: number; h: number; minW: number; minH: number } => ({
	...(widgetTypeByVisualization(visualization)?.defaultLayout ?? CHART_LAYOUT),
})

/**
 * Which of line/bar/area a `visualization: "chart"` widget draws, from its
 * `chartId`.
 *
 * One function because there were three, and they disagreed: this module matched
 * `chartId.includes("bar")`, `dashboard-templates/index.ts` matched
 * `endsWith("-bar")` (checking area first), and the web consulted the live chart
 * registry. No id in the registry contains both "bar" and "area", so they agreed
 * on every real input and differed only on hypotheticals — but the next id added
 * decides which of three answers a widget gets, depending on who asks.
 *
 * Exact match against the canonical ids first, so the ids the builder actually
 * writes never depend on substring luck. The suffix and substring passes are the
 * legacy fallback, kept because non-canonical styles predate the canonical ids
 * (`gradient-area`, `latency-line`, `default-bar`, …) and are still stored.
 */
export const chartFamilyForChartId = (chartId: string | undefined): "line" | "bar" | "area" => {
	if (chartId === undefined) return "line"
	if (chartId === WIDGET_TYPES.bar.chartId) return "bar"
	if (chartId === WIDGET_TYPES.area.chartId) return "area"
	if (chartId === WIDGET_TYPES.line.chartId) return "line"
	if (chartId.endsWith("-bar")) return "bar"
	if (chartId.endsWith("-area")) return "area"
	if (chartId.includes("bar")) return "bar"
	if (chartId.includes("area")) return "area"
	return "line"
}

/**
 * The raw-SQL display type a widget renders with. `chartId` disambiguates the
 * three panel types that share `visualization: "chart"`.
 */
export const rawSqlDisplayTypeFor = (visualization: string, chartId?: string): RawSqlDisplayType => {
	if (visualization === "chart") return chartFamilyForChartId(chartId)
	return widgetTypeByVisualization(visualization)?.rawSqlDisplayType ?? "line"
}

/**
 * The heatmap widget's sequential colour ramps. The actual OKLCH stops live in
 * `packages/ui/src/styles/tokens.css` as `--heatmap-<name>-0..4` (theme-aware —
 * each ramp starts clear of `--heatmap-grout` and climbs to a saturated hot end,
 * so it inverts between light and dark).
 *
 * This list is the single source of truth: the persisted schemas
 * (`dashboards.ts`, `v2/dashboards.ts`), the chart's prop type, the builder
 * state and the settings Select all derive from it. `amber` leads because it is
 * the default — it's Maple's brand hue, so an unconfigured heatmap reads as ours.
 */
export const HEATMAP_COLOR_SCALES = ["amber", "blues", "reds", "viridis", "magma", "cividis"] as const

export type HeatmapColorScale = (typeof HEATMAP_COLOR_SCALES)[number]

export const HEATMAP_SCALE_TYPES = ["linear", "log"] as const

export type HeatmapScaleType = (typeof HEATMAP_SCALE_TYPES)[number]
