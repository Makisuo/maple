import { buildTimeseriesQuerySpec, createQueryDraft } from "@/lib/query-builder/model"
import {
	TRACE_DEFAULT_COLUMNS,
	type ListColumnDraft,
} from "@/components/dashboard-builder/config/list-config-panel"
import type {
	DashboardWidget,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import type { LegendPosition } from "@/components/dashboard-builder/config/settings-fields"
import { widgetTypes } from "@/components/dashboard-builder/widgets/types"
import { fromPanelType, toPanelType } from "@/lib/query-builder/panel-types"
import {
	deriveDefaultWidgetTitle,
	hasActiveGroupBy,
	inferDefaultUnitForQueries,
	isVisibleQuery,
	legacyQueryDraft,
	loadQueryDrafts,
	toHiddenSeriesBaseNames,
	type BuildDataSourceContext,
	type QueryBuilderWidgetState,
} from "@/lib/query-builder/widget-builder-shared"
import { WIDGET_TYPES } from "@maple/domain/http"

/**
 * Endpoints whose `params.queries` are query-builder drafts. Histograms with no
 * group-by persist their raw value rows through the list endpoint — without it
 * the preset's query is dropped the moment the widget is opened and replaced by
 * the legacy fallback draft.
 */
const QUERY_BUILDER_ENDPOINTS = new Set([
	"custom_query_builder_timeseries",
	"custom_query_builder_breakdown",
	"custom_query_builder_list",
])

// ---------------------------------------------------------------------------
// Lowering the widget editor's state to a persisted widget, and back.
//
// This module owns only what every widget type shares. The per-type halves live
// in `components/dashboard-builder/widgets/types/*` — see `widget-type-registry`
// for why. What used to be four if-chains over `state.visualization` is now four
// dispatches through one registry.
// ---------------------------------------------------------------------------

export type { QueryBuilderWidgetState, StatAggregate } from "@/lib/query-builder/widget-builder-shared"
export {
	deriveDefaultWidgetTitle,
	histogramValueColumn,
	inferDefaultUnitForQueries,
	inferDisplayUnitForQuery,
	toSeriesFieldOptions,
} from "@/lib/query-builder/widget-builder-shared"

const definitionForState = (state: QueryBuilderWidgetState) =>
	widgetTypes[toPanelType(state.visualization, state.chartId)]

// ---------------------------------------------------------------------------
// Persisted widget → editor state
// ---------------------------------------------------------------------------

export function toInitialState(widget: DashboardWidget): QueryBuilderWidgetState {
	const params = (widget.dataSource.params ?? {}) as Record<string, unknown>
	const rawComparison =
		params.comparison && typeof params.comparison === "object"
			? (params.comparison as Record<string, unknown>)
			: {}

	// Normalize the (visualization, chartId) pair through the panel-type map on
	// open. This repairs widgets corrupted by the old "Chart Style" dropdown —
	// `visualization: "chart"` + `chartId: "query-builder-pie"` becomes a real pie
	// widget — so the picker, the settings sections and the endpoint can't
	// disagree about what the widget is.
	const panelType = toPanelType(widget.visualization, widget.display.chartId)
	const normalized = fromPanelType(panelType, widget.display.chartId)
	const definition = widgetTypes[panelType]

	const chartPresentation = widget.display.chartPresentation
	const legendRaw = chartPresentation?.legend
	const legendPosition: LegendPosition =
		legendRaw === "hidden"
			? "hidden"
			: legendRaw === "right"
				? "right"
				: legendRaw === "visible"
					? "bottom"
					: "hidden"

	const shared: QueryBuilderWidgetState = {
		visualization: normalized.visualization,
		title: widget.display.title ?? "",
		description: widget.display.description ?? "",
		timeRange: widget.timeRange ?? null,
		chartId: normalized.chartId ?? "query-builder-line",
		stacked: widget.display.stacked ?? false,
		curveType: widget.display.curveType ?? "linear",
		queries: [],
		formulas: [],
		comparisonMode: rawComparison.mode === "previous_period" ? "previous_period" : "none",
		includePercentChange:
			typeof rawComparison.includePercentChange === "boolean"
				? rawComparison.includePercentChange
				: true,
		debug: params.debug === true,
		statAggregate: "first",
		statValueField: "",
		unit: widget.display.unit ?? inferDefaultUnitForQueries(loadQueryDrafts(params).queries) ?? "number",
		legendPosition,
		// The Min/Max/Mean/Last table is opt-in: it costs up to 45% of the widget's
		// height, so a widget only shows it by asking for it. Widgets persisted
		// before the flag existed carry no `seriesStats` and therefore lose the
		// table — that is the intent, and re-ticking the box restores it.
		seriesStatsEnabled: chartPresentation?.seriesStats ?? false,
		tableLimit: "",
		thresholds: (widget.display.thresholds ?? []).map((threshold) => ({
			value: threshold.value,
			color: threshold.color,
		})),
		gaugeMin: "",
		gaugeMax: "",
		sparklineEnabled: false,
		listDataSource: "traces",
		listWhereClause: "",
		listLimit: "",
		listColumns: TRACE_DEFAULT_COLUMNS as ListColumnDraft[],
		listRootOnly: true,
		heatmapColorScale: "blues",
		heatmapScaleType: "linear",
		markdownContent: "",
		...definition.initialState?.(widget),
	}

	// A list is configured by `ListConfigPanel`, not the query builder; its draft
	// query exists only to satisfy the state shape.
	if (definition.queryEditor === "list") {
		return { ...shared, queries: [createQueryDraft(0)], formulas: [] }
	}

	if (QUERY_BUILDER_ENDPOINTS.has(widget.dataSource.endpoint)) {
		const { queries, formulas } = loadQueryDrafts(params)
		if (queries.length > 0) return { ...shared, queries, formulas }
	}

	return { ...shared, queries: [legacyQueryDraft(params)], formulas: [] }
}

// ---------------------------------------------------------------------------
// Editor state → persisted widget
// ---------------------------------------------------------------------------

/** The plain timeseries data source every query-driven type starts from. */
function timeseriesDataSource(state: QueryBuilderWidgetState): {
	base: WidgetDataSource
	sharedTransform: WidgetDataSource["transform"]
} {
	const hiddenSeriesBaseNames = toHiddenSeriesBaseNames(state)
	const sharedTransform =
		hiddenSeriesBaseNames.length > 0 ? { hideSeries: { baseNames: hiddenSeriesBaseNames } } : undefined

	return {
		sharedTransform,
		base: {
			endpoint: "custom_query_builder_timeseries",
			params: {
				queries: state.queries,
				formulas: state.formulas,
				comparison: {
					mode: state.comparisonMode,
					includePercentChange: state.includePercentChange,
				},
				debug: state.debug,
			},
			transform: sharedTransform,
		},
	}
}

function buildContext(state: QueryBuilderWidgetState, seriesFieldOptions: string[]): BuildDataSourceContext {
	const { base, sharedTransform } = timeseriesDataSource(state)
	return {
		state,
		base,
		sharedTransform,
		seriesFieldOptions,
		visibleQueries: state.queries.filter(isVisibleQuery),
	}
}

export function buildWidgetDataSource(
	_widget: DashboardWidget,
	state: QueryBuilderWidgetState,
	seriesFieldOptions: string[],
): WidgetDataSource {
	return definitionForState(state).buildDataSource(buildContext(state, seriesFieldOptions))
}

/**
 * Display keys owned by a panel type. Cleared before the type writes back the
 * ones it owns, so nothing leaks across a type switch — a line chart switched to
 * Pie must not keep `chartId: "query-builder-line"`, because the pie renderer's
 * `?? "query-builder-pie"` fallback never fires on a defined-but-wrong id and it
 * would mount a line chart over breakdown rows.
 */
const OWNED_DISPLAY_KEYS = [
	...new Set(Object.values(WIDGET_TYPES).flatMap((meta) => meta.ownedDisplayKeys)),
] as ReadonlyArray<keyof WidgetDisplayConfig>

export function buildWidgetDisplay(
	widget: DashboardWidget,
	state: QueryBuilderWidgetState,
): WidgetDisplayConfig {
	const definition = definitionForState(state)

	const legendValue =
		state.legendPosition === "hidden"
			? ("hidden" as const)
			: state.legendPosition === "right"
				? ("right" as const)
				: ("visible" as const)

	const base: WidgetDisplayConfig = {
		...widget.display,
		// Query-driven widgets saved without a title get a derived one
		// ("Error rate by service.name") instead of rendering as "Untitled".
		// Lists and notes have no queries to derive from.
		title: state.title.trim()
			? state.title.trim()
			: definition.queryEditor === "builder"
				? deriveDefaultWidgetTitle(state.queries)
				: undefined,
		description: state.description.trim() || undefined,
		chartPresentation: {
			...widget.display.chartPresentation,
			legend: legendValue,
			seriesStats: state.seriesStatsEnabled,
		},
	}

	for (const key of OWNED_DISPLAY_KEYS) {
		delete base[key]
	}

	// Every type that mounts a chartRegistry component gets an id, not just
	// `chart` — canonical for the panel type, or the state's own id when it
	// already belongs to that panel (preserving styles like `latency-line`).
	const { chartId } = fromPanelType(toPanelType(state.visualization, state.chartId), state.chartId)
	if (chartId) base.chartId = chartId

	return definition.buildDisplay({
		widget,
		state,
		base,
		timeseriesDataSource: timeseriesDataSource(state).base,
	})
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateQueries(state: QueryBuilderWidgetState): string | null {
	const definition = definitionForState(state)

	// Neither uses the query builder — a list is configured by ListConfigPanel and
	// a note doesn't query at all, so validating their placeholder draft would
	// block Apply on an error the user has no panel to fix.
	if (definition.queryEditor !== "builder") return null

	const activeQueries = state.queries.filter((query) => query.enabled !== false)
	if (activeQueries.length === 0) return "Add at least one query"
	for (const query of activeQueries) {
		const built = buildTimeseriesQuerySpec(query)
		if (!built.query) return `${query.name}: ${built.error ?? "invalid query"}`
	}

	const visibleQueries = activeQueries.filter(isVisibleQuery)

	// Types that lower to a breakdown render one row per category, so without a
	// group-by they render one row per time bucket. Catching it here surfaces the
	// inline message and disables Apply, instead of letting the server error land
	// as a tile after Run Preview.
	if (definition.meta.requiresGroupBy && !visibleQueries.some(hasActiveGroupBy)) {
		return "This visualization groups data into categories — add a group-by field"
	}

	return definition.validate?.({ state, activeQueries, visibleQueries }) ?? null
}
