import {
	createQueryDraft,
	formatFiltersAsWhereClause,
	formulaLabel,
	queryLabel,
	type QueryBuilderDataSource,
	type QueryBuilderFormulaDraft,
	type QueryBuilderMetricType,
	type QueryBuilderQueryDraft,
} from "@maple/query-engine/query-builder"
import type { ListColumnDraft, ListDataSource } from "@/lib/query-builder/list-widget-config"
import type {
	TimeRange,
	ValueUnit,
	VisualizationType,
	WidgetDataSource,
} from "@/components/dashboard-builder/types"
import type { LegendPosition } from "@/components/dashboard-builder/config/settings-fields"
import { STAT_AGGREGATES, type StatAggregate } from "@maple/domain/http"
import type { FunnelBreakdownBy, FunnelKeyBy, QueryComparisonMode } from "@maple/query-model"
import type { FunnelStepDraft } from "@/lib/query-builder/funnel-filters"
import { DEFAULT_FUNNEL_KEY_BY, DEFAULT_FUNNEL_WINDOW_SECONDS } from "@/components/funnels/definition"
import type { HeatmapColorScale, HeatmapScaleType } from "@maple/domain/http"
import { normalizeKey, parseBoolean, parseWhereClause as parseWhereClauses } from "@maple/domain/where-clause"

// Shared widget-builder vocabulary.
//
// Everything here is type-agnostic: the editor's state shape, the parsers that
// read a persisted widget back into it, and the predicates each panel type's
// builder needs. It lives apart from `widget-builder-utils.ts` so the per-type
// definitions under `components/dashboard-builder/widgets/types/` can import it
// without an import cycle through the registry those dispatchers read.

// The single widget-side spelling of the shared reducer table.
export { STAT_AGGREGATES, type StatAggregate } from "@maple/domain/http"

export type PointsMode = "auto" | "always" | "never"

/** `chartPresentation.showPoints` ⇄ `PointsMode`: absent is Auto. */
export const pointsModeFromShowPoints = (showPoints: boolean | undefined): PointsMode =>
	showPoints === undefined ? "auto" : showPoints ? "always" : "never"
export const showPointsFromPointsMode = (mode: PointsMode): boolean | undefined =>
	mode === "auto" ? undefined : mode === "always"

export interface QueryBuilderWidgetState {
	visualization: VisualizationType
	title: string
	description: string
	/**
	 * The widget's own time range, or `null` to follow the dashboard's — the
	 * default, and what every widget carried before overrides existed.
	 */
	timeRange: TimeRange | null
	chartId: string
	stacked: boolean
	curveType: "linear" | "monotone"
	queries: QueryBuilderQueryDraft[]
	formulas: QueryBuilderFormulaDraft[]
	comparisonMode: QueryComparisonMode
	includePercentChange: boolean
	statAggregate: StatAggregate
	statValueField: string
	unit: ValueUnit
	legendPosition: LegendPosition
	seriesStatsEnabled: boolean
	/**
	 * Point dots on line/area series. `auto` (no stored preference) dots isolated
	 * points always and every point only when they fit the width; the other two
	 * pin `chartPresentation.showPoints`.
	 */
	pointsMode: PointsMode
	tableLimit: string
	// Threshold lines (chart) / threshold coloring (stat, gauge)
	thresholds: Array<{ value: number; color: string }>
	gaugeMin: string
	gaugeMax: string
	// Stat-specific: render a trend sparkline behind the value
	sparklineEnabled: boolean
	listDataSource: ListDataSource
	listWhereClause: string
	listLimit: string
	listColumns: ListColumnDraft[]
	listRootOnly: boolean
	/**
	 * `undefined` means "never chosen" — the rail shows
	 * `DEFAULT_HEATMAP_COLOR_SCALE` (what the chart already renders) and Apply
	 * leaves `display.heatmap.colorScale` absent, so opening the editor cannot
	 * repaint a widget the user never touched the palette on.
	 */
	heatmapColorScale: HeatmapColorScale | undefined
	heatmapScaleType: HeatmapScaleType
	// Markdown-specific: the note body. Static — never hits the warehouse.
	markdownContent: string
	/**
	 * Funnel-specific: the product-event funnel definition, edited as the
	 * widget's query panel. `source` is the panel's source choice — "Product
	 * events" fetches through the funnel route from this definition; the query
	 * set draws a group-by breakdown as a funnel, exactly as before.
	 */
	funnel: FunnelWidgetDraft
}

/** What a funnel widget's one query panel reads from. */
export type FunnelSource = "product_events" | "query_set"

export type FunnelAddOnKey = "keyBy" | "window" | "breakdown"

/** The funnel widget's editor state for its `display.funnel` definition block. */
export interface FunnelWidgetDraft {
	source: FunnelSource
	/** Wire steps plus the raw filter text an event step is typed with. */
	steps: FunnelStepDraft[]
	keyBy: FunnelKeyBy
	windowSeconds: number
	breakdownBy?: FunnelBreakdownBy
	/** The population filter as typed; compiled to `display.funnel.filters` on Apply. */
	filterClause: string
	/** `display.funnel.showStepPercent` — the chart's tri-state label mode. */
	showStepPercent: boolean | undefined
	/** Which optional rows the panel shows, mirroring a query panel's add-on bar. */
	addOns: Record<FunnelAddOnKey, boolean>
}

/** A fresh funnel draft: the query-set funnel, no steps, the /analytics defaults. */
export const defaultFunnelDraft = (): FunnelWidgetDraft => ({
	source: "query_set",
	steps: [],
	keyBy: DEFAULT_FUNNEL_KEY_BY,
	windowSeconds: DEFAULT_FUNNEL_WINDOW_SECONDS,
	filterClause: "",
	showStepPercent: undefined,
	addOns: { keyBy: false, window: false, breakdown: false },
})

/** Whether the widget is a product-event funnel — fetched from its definition, not its query set. */
export const isProductEventsFunnel = (
	state: Pick<QueryBuilderWidgetState, "visualization" | "funnel">,
): boolean => state.visualization === "funnel" && state.funnel.source === "product_events"

/**
 * What a panel type's `buildDataSource` is handed. `base` is the timeseries
 * data source every query-driven type starts from, already carrying the shared
 * `hideSeries` transform, so a type that has nothing special to say can return
 * it unchanged.
 */
export interface BuildDataSourceContext {
	state: QueryBuilderWidgetState
	base: WidgetDataSource
	sharedTransform: WidgetDataSource["transform"]
	seriesFieldOptions: string[]
	/** Queries that are both enabled and not hidden. */
	visibleQueries: QueryBuilderQueryDraft[]
}

/**
 * The numeric column a group-by-less histogram bucketizes client-side.
 *
 * Only traces expose one; logs and metrics have no per-row numeric field, so a
 * histogram over them must group by something instead (see the histogram panel's
 * `validate`).
 */
export function histogramValueColumn(dataSource: QueryBuilderDataSource): string | undefined {
	return dataSource === "traces" ? "durationMs" : undefined
}

export function inferDisplayUnitForQuery(query: QueryBuilderQueryDraft): ValueUnit | undefined {
	if (query.dataSource === "traces") {
		if (query.aggregation === "error_rate") return "percent"
		if (
			query.aggregation === "avg_duration" ||
			query.aggregation === "p50_duration" ||
			query.aggregation === "p95_duration" ||
			query.aggregation === "p99_duration"
		) {
			return "duration_ms"
		}
		if (query.aggregation === "count") return "number"
		return undefined
	}

	if (query.dataSource === "logs") {
		return "number"
	}

	if (query.dataSource === "metrics") {
		const lower = query.metricName.toLowerCase()
		if (/\b(error[._ -]?rate|percentage|percent)\b/.test(lower)) return "percent"
		if (/[._](seconds|s)$/.test(lower) || /\b(duration[._]seconds)\b/.test(lower)) return "duration_s"
		if (/\b(duration|latency|response[._]time)\b/.test(lower)) return "duration_ms"
		if (/\b(bytes|memory|size)\b/.test(lower)) return "bytes"
		if (query.aggregation === "rate") return "requests_per_sec"
		if (
			query.aggregation === "count" ||
			query.aggregation === "sum" ||
			query.aggregation === "avg" ||
			query.aggregation === "min" ||
			query.aggregation === "max" ||
			query.aggregation === "increase"
		) {
			return "number"
		}
	}

	return undefined
}

export function inferDefaultUnitForQueries(queries: QueryBuilderQueryDraft[]): ValueUnit | undefined {
	const activeQueries = queries.filter((query) => query.enabled !== false && !query.hidden)
	if (activeQueries.length === 0) return undefined

	const inferredUnits = activeQueries.map(inferDisplayUnitForQuery)
	const [firstUnit] = inferredUnits
	if (!firstUnit) return undefined
	return inferredUnits.every((unit) => unit === firstUnit) ? firstUnit : undefined
}

export function parsePositiveNumber(raw: string): number | undefined {
	const parsed = Number.parseInt(raw.trim(), 10)
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined
	return parsed
}

export function parseFiniteNumber(raw: string): number | undefined {
	const trimmed = raw.trim()
	if (trimmed.length === 0) return undefined
	const parsed = Number(trimmed)
	return Number.isFinite(parsed) ? parsed : undefined
}

export function toQueryGroupByArray(groupBy: unknown): string[] {
	if (Array.isArray(groupBy)) {
		return groupBy.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
	}
	return ["service.name"]
}

function toMetricType(input: unknown, fallback: QueryBuilderMetricType): QueryBuilderMetricType {
	if (input === "sum" || input === "gauge" || input === "histogram" || input === "exponential_histogram")
		return input
	return fallback
}

export function toStatAggregate(value: unknown): StatAggregate {
	return STAT_AGGREGATES.find((candidate) => candidate === value) ?? "first"
}

function normalizeLoadedQuery(raw: QueryBuilderQueryDraft, index: number): QueryBuilderQueryDraft {
	const base = createQueryDraft(index)
	const source: QueryBuilderDataSource =
		raw.dataSource === "traces" || raw.dataSource === "logs" || raw.dataSource === "metrics"
			? raw.dataSource
			: base.dataSource

	const shared = {
		id: raw.id || base.id,
		name: raw.name || queryLabel(index),
		enabled: raw.enabled ?? base.enabled,
		hidden: raw.hidden ?? base.hidden,
		whereClause: raw.whereClause ?? base.whereClause,
		aggregation: raw.aggregation || base.aggregation,
		stepInterval: raw.stepInterval ?? base.stepInterval,
		orderByDirection: raw.orderByDirection ?? base.orderByDirection,
		addOns: {
			groupBy: raw.addOns?.groupBy ?? base.addOns.groupBy,
			having: raw.addOns?.having ?? base.addOns.having,
			orderBy: raw.addOns?.orderBy ?? base.addOns.orderBy,
			limit: raw.addOns?.limit ?? base.addOns.limit,
			legend: raw.addOns?.legend ?? base.addOns.legend,
		},
		groupBy: toQueryGroupByArray(raw.groupBy),
		having: raw.having ?? base.having,
		orderBy: raw.orderBy ?? base.orderBy,
		limit: raw.limit ?? base.limit,
		legend: raw.legend ?? base.legend,
	}

	if (source === "metrics") {
		const metrics = raw.dataSource === "metrics" ? raw : undefined
		return {
			...shared,
			dataSource: "metrics",
			signalSource: metrics?.signalSource === "meter" ? "meter" : "default",
			metricName: metrics?.metricName ?? "",
			metricType: toMetricType(metrics?.metricType, "gauge"),
			isMonotonic: metrics?.isMonotonic ?? metrics?.metricType === "sum",
		}
	}
	return source === "logs" ? { ...shared, dataSource: "logs" } : { ...shared, dataSource: "traces" }
}

export function toSeriesFieldOptions(state: QueryBuilderWidgetState): string[] {
	const usedNames = new Set<string>()
	const options: string[] = []
	const addUnique = (base: string) => {
		if (!usedNames.has(base)) {
			usedNames.add(base)
			options.push(base)
			return
		}
		let suffix = 2
		while (usedNames.has(`${base} (${suffix})`)) suffix += 1
		const next = `${base} (${suffix})`
		usedNames.add(next)
		options.push(next)
	}
	for (const query of state.queries) {
		if (!query.hidden) addUnique(query.legend.trim() || query.name)
	}
	for (const formula of state.formulas) {
		if (!formula.hidden) addUnique(formula.legend.trim() || formula.name)
	}
	return options
}

export function isVisibleQuery(query: QueryBuilderQueryDraft): boolean {
	return query.enabled !== false && !query.hidden
}

export function hasActiveGroupBy(query: QueryBuilderQueryDraft): boolean {
	return (
		query.addOns.groupBy &&
		query.groupBy.some((g) => g.trim() !== "" && g.trim().toLowerCase() !== "none")
	)
}

export function toHiddenSeriesBaseNames(state: QueryBuilderWidgetState): string[] {
	const names = new Set<string>()
	for (const query of state.queries) {
		if (query.hidden) names.add(query.legend.trim() || query.name)
	}
	for (const formula of state.formulas) {
		if (formula.hidden) names.add(formula.legend.trim() || formula.name)
	}
	return [...names]
}

const TRACES_AGGREGATION_TITLES: Record<string, string> = {
	count: "Count of traces",
	avg_duration: "Avg duration",
	p50_duration: "P50 duration",
	p95_duration: "P95 duration",
	p99_duration: "P99 duration",
	error_rate: "Error rate",
	apdex: "Apdex",
} satisfies Record<string, string>

/**
 * Human-readable fallback title derived from the first visible query, e.g.
 * "Error rate by service.name" or "Count of logs by severity" — so widgets
 * added from the chart picker never render as "Untitled" (MAP-49).
 */
export function deriveDefaultWidgetTitle(queries: readonly QueryBuilderQueryDraft[]): string {
	const query = queries.find(isVisibleQuery) ?? queries[0]
	if (!query) return "Untitled"

	const groupBy = hasActiveGroupBy(query)
		? query.groupBy
				.map((g) => g.trim())
				.filter((g) => g !== "" && g.toLowerCase() !== "none")
				.join(", ")
		: ""
	const bySuffix = groupBy ? ` by ${groupBy}` : ""

	if (query.dataSource === "metrics") {
		const metric = query.metricName.trim()
		if (!metric) return "Metric"
		return `${query.aggregation} of ${metric}${bySuffix}`
	}
	if (query.dataSource === "logs") {
		return `Count of logs${bySuffix}`
	}
	const base = TRACES_AGGREGATION_TITLES[query.aggregation] ?? `${query.aggregation} of traces`
	return `${base}${bySuffix}`
}

/** Reads a persisted widget's `params.queries` back into editor drafts. */
/**
 * Editor drafts from a stored query set.
 *
 * Takes `{ queries, formulas }` rather than a params bag so callers hand it the
 * result of `dataSourceQuerySet` — the accessor that reads v2 and v3 alike —
 * instead of reaching into `dataSource.params` themselves.
 */
export function loadQueryDrafts(params: { queries?: unknown; formulas?: unknown }): {
	queries: QueryBuilderQueryDraft[]
	formulas: QueryBuilderFormulaDraft[]
} {
	const queries = Array.isArray(params.queries)
		? params.queries
				.filter(
					(query): query is QueryBuilderQueryDraft =>
						query != null &&
						typeof query === "object" &&
						typeof (query as QueryBuilderQueryDraft).id === "string" &&
						typeof (query as QueryBuilderQueryDraft).whereClause === "string",
				)
				.map((query, index) => normalizeLoadedQuery(query, index))
		: []

	const formulas = Array.isArray(params.formulas)
		? params.formulas
				.filter(
					(formula): formula is QueryBuilderFormulaDraft =>
						formula != null &&
						typeof formula === "object" &&
						typeof (formula as QueryBuilderFormulaDraft).id === "string" &&
						typeof (formula as QueryBuilderFormulaDraft).expression === "string" &&
						typeof (formula as QueryBuilderFormulaDraft).legend === "string",
				)
				.map((formula, index) => ({
					...formula,
					name: formula.name || formulaLabel(index),
					hidden: formula.hidden ?? false,
				}))
		: []

	return { queries, formulas }
}

/**
 * The single draft query synthesized for a widget persisted before the query
 * builder existed, translating its flat `params` (source/metric/filters/groupBy)
 * into one draft.
 */
export function legacyQueryDraft(params: Record<string, unknown>): QueryBuilderQueryDraft {
	const fallbackQuery = createQueryDraft(0)
	const source: QueryBuilderDataSource =
		params.source === "traces" || params.source === "logs" || params.source === "metrics"
			? params.source
			: "traces"

	const fallbackBase = {
		id: fallbackQuery.id,
		name: fallbackQuery.name,
		enabled: fallbackQuery.enabled,
		hidden: fallbackQuery.hidden,
		whereClause: formatFiltersAsWhereClause(params),
		aggregation: typeof params.metric === "string" ? params.metric : fallbackQuery.aggregation,
		stepInterval:
			typeof params.bucketSeconds === "number"
				? String(params.bucketSeconds)
				: fallbackQuery.stepInterval,
		orderByDirection: fallbackQuery.orderByDirection,
		addOns: {
			...fallbackQuery.addOns,
			groupBy: Array.isArray(params.groupBy) ? params.groupBy.length > 0 : false,
		},
		groupBy: toQueryGroupByArray(params.groupBy),
		having: fallbackQuery.having,
		orderBy: fallbackQuery.orderBy,
		limit: fallbackQuery.limit,
		legend: fallbackQuery.legend,
	}

	const filterRecord = params.filters as Record<string, unknown> | undefined
	if (source === "metrics") {
		return {
			...fallbackBase,
			dataSource: "metrics",
			signalSource: "default",
			metricName: typeof filterRecord?.metricName === "string" ? filterRecord.metricName : "",
			metricType: toMetricType(filterRecord?.metricType, "gauge"),
			isMonotonic: false,
		}
	}
	return source === "logs"
		? { ...fallbackBase, dataSource: "logs" }
		: { ...fallbackBase, dataSource: "traces" }
}

export function buildListEndpointParams(
	dataSource: ListDataSource,
	whereClause: string,
	limit: number,
): Record<string, unknown> {
	const { clauses } = parseWhereClauses(whereClause)
	// NOTE: startTime/endTime are injected by useWidgetData from the dashboard
	// time range — do NOT include them here or they'll clash with interpolation.
	const params: Record<string, unknown> = { limit } satisfies Record<string, unknown>

	if (dataSource === "traces") {
		const attributeFilters: Array<{ key: string; value: string; matchMode?: string }> = []
		const resourceAttributeFilters: Array<{ key: string; value: string; matchMode?: string }> = []

		for (const clause of clauses) {
			const key = normalizeKey(clause.key)
			if (key === "service.name") params.service = clause.value
			else if (key === "span.name") params.spanName = clause.value
			else if (key === "has_error") {
				const b = parseBoolean(clause.value)
				if (b != null) params.hasError = b
			} else if (key === "root_only") {
				const b = parseBoolean(clause.value)
				if (b != null) params.rootOnly = b
			} else if (key === "deployment.environment") params.deploymentEnv = clause.value
			else if (key.startsWith("attr.")) {
				attributeFilters.push({
					key: key.slice(5),
					value: clause.operator !== "exists" ? clause.value : "",
					matchMode: clause.operator === "contains" ? "contains" : undefined,
				})
			} else if (key.startsWith("resource.")) {
				resourceAttributeFilters.push({
					key: key.slice(9),
					value: clause.operator !== "exists" ? clause.value : "",
					matchMode: clause.operator === "contains" ? "contains" : undefined,
				})
			}
		}

		if (attributeFilters.length > 0) params.attributeFilters = attributeFilters
		if (resourceAttributeFilters.length > 0) params.resourceAttributeFilters = resourceAttributeFilters
	} else {
		for (const clause of clauses) {
			const key = normalizeKey(clause.key)
			if (key === "service.name") params.service = clause.value
			else if (key === "severity") params.severity = clause.value
			else if (key === "search" || key === "body") params.search = clause.value
		}
	}

	return params
}
