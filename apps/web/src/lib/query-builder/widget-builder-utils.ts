import {
	buildTimeseriesQuerySpec,
	createQueryDraft,
	formatFiltersAsWhereClause,
	formulaLabel,
	queryLabel,
	type QueryBuilderDataSource,
	type QueryBuilderFormulaDraft,
	type QueryBuilderMetricType,
	type QueryBuilderQueryDraft,
} from "@/lib/query-builder/model"
import {
	TRACE_DEFAULT_COLUMNS,
	LOG_DEFAULT_COLUMNS,
	type ListColumnDraft,
	type ListDataSource,
} from "@/components/dashboard-builder/config/list-config-panel"
import type {
	DashboardWidget,
	ValueUnit,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import type { LegendPosition } from "@/components/dashboard-builder/config/widget-settings-bar"
import {
	normalizeKey,
	parseBoolean,
	parseWhereClause as parseWhereClauses,
} from "@maple/query-engine/where-clause"

export type StatAggregate = "sum" | "first" | "count" | "avg" | "max" | "min"

export interface QueryBuilderWidgetState {
	visualization: VisualizationType
	title: string
	description: string
	chartId: string
	stacked: boolean
	curveType: "linear" | "monotone"
	queries: QueryBuilderQueryDraft[]
	formulas: QueryBuilderFormulaDraft[]
	comparisonMode: "none" | "previous_period"
	includePercentChange: boolean
	debug: boolean
	statAggregate: StatAggregate
	statValueField: string
	unit: ValueUnit
	legendPosition: LegendPosition
	tableLimit: string
	// List-specific
	listDataSource: ListDataSource
	listWhereClause: string
	listLimit: string
	listColumns: ListColumnDraft[]
	listRootOnly: boolean
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

function toQueryGroupByArray(groupBy: unknown): string[] {
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

function normalizeLoadedQuery(raw: QueryBuilderQueryDraft, index: number): QueryBuilderQueryDraft {
	const base = createQueryDraft(index)
	return {
		...base,
		...raw,
		name: raw.name || queryLabel(index),
		dataSource:
			raw.dataSource === "traces" || raw.dataSource === "logs" || raw.dataSource === "metrics"
				? raw.dataSource
				: base.dataSource,
		signalSource:
			raw.signalSource === "default" || raw.signalSource === "meter"
				? raw.signalSource
				: base.signalSource,
		metricType: toMetricType(raw.metricType, base.metricType),
		isMonotonic: raw.isMonotonic ?? raw.metricType === "sum",
		groupBy: toQueryGroupByArray(raw.groupBy),
		addOns: {
			groupBy: raw.addOns?.groupBy ?? base.addOns.groupBy,
			having: raw.addOns?.having ?? base.addOns.having,
			orderBy: raw.addOns?.orderBy ?? base.addOns.orderBy,
			limit: raw.addOns?.limit ?? base.addOns.limit,
			legend: raw.addOns?.legend ?? base.addOns.legend,
		},
	}
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

function isVisibleQuery(query: QueryBuilderQueryDraft): boolean {
	return query.enabled !== false && !query.hidden
}

function hasActiveGroupBy(query: QueryBuilderQueryDraft): boolean {
	return (
		query.addOns.groupBy &&
		query.groupBy.some((g) => g.trim() !== "" && g.trim().toLowerCase() !== "none")
	)
}

function toHiddenSeriesBaseNames(state: QueryBuilderWidgetState): string[] {
	const names = new Set<string>()
	for (const query of state.queries) {
		if (query.hidden) names.add(query.legend.trim() || query.name)
	}
	for (const formula of state.formulas) {
		if (formula.hidden) names.add(formula.legend.trim() || formula.name)
	}
	return [...names]
}

export function toInitialState(widget: DashboardWidget): QueryBuilderWidgetState {
	const params = (widget.dataSource.params ?? {}) as Record<string, unknown>
	const rawComparison =
		params.comparison && typeof params.comparison === "object"
			? (params.comparison as Record<string, unknown>)
			: {}

	const listDs = widget.display.listDataSource === "logs" ? ("logs" as const) : ("traces" as const)
	const legendRaw = widget.display.chartPresentation?.legend
	const legendPosition: LegendPosition =
		legendRaw === "hidden" ? "hidden" : legendRaw === "right" ? "right" : "bottom"

	const baseFromWidget = {
		visualization: widget.visualization,
		title: widget.display.title ?? "",
		description: widget.display.description ?? "",
		chartId: widget.display.chartId ?? "query-builder-line",
		stacked: widget.display.stacked ?? false,
		curveType: widget.display.curveType ?? "linear",
		comparisonMode: rawComparison.mode === "previous_period" ? "previous_period" : "none",
		includePercentChange:
			typeof rawComparison.includePercentChange === "boolean"
				? rawComparison.includePercentChange
				: true,
		debug: params.debug === true,
		statAggregate: widget.dataSource.transform?.reduceToValue?.aggregate ?? "first",
		statValueField: widget.dataSource.transform?.reduceToValue?.field ?? "",
		unit:
			widget.display.unit ??
			inferDefaultUnitForQueries((params.queries as QueryBuilderQueryDraft[] | undefined) ?? []) ??
			"number",
		legendPosition,
		tableLimit:
			typeof widget.dataSource.transform?.limit === "number"
				? String(widget.dataSource.transform.limit)
				: "",
		listDataSource: listDs,
		listWhereClause: widget.display.listWhereClause ?? "",
		listLimit: typeof widget.display.listLimit === "number" ? String(widget.display.listLimit) : "",
		listColumns: (widget.display.columns ??
			(listDs === "logs" ? LOG_DEFAULT_COLUMNS : TRACE_DEFAULT_COLUMNS)) as ListColumnDraft[],
		listRootOnly: widget.display.listRootOnly ?? true,
	} satisfies Omit<QueryBuilderWidgetState, "queries" | "formulas">

	// List widgets don't use the query builder — return early with a dummy query
	if (widget.visualization === "list") {
		return { ...baseFromWidget, queries: [createQueryDraft(0)], formulas: [] }
	}

	if (
		(widget.dataSource.endpoint === "custom_query_builder_timeseries" ||
			widget.dataSource.endpoint === "custom_query_builder_breakdown") &&
		Array.isArray(params.queries)
	) {
		const loadedQueries = params.queries
			.filter(
				(query): query is QueryBuilderQueryDraft =>
					query != null &&
					typeof query === "object" &&
					typeof (query as QueryBuilderQueryDraft).id === "string" &&
					typeof (query as QueryBuilderQueryDraft).whereClause === "string",
			)
			.map((query, index) => normalizeLoadedQuery(query, index))

		const loadedFormulas = Array.isArray(params.formulas)
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

		if (loadedQueries.length > 0) {
			return { ...baseFromWidget, queries: loadedQueries, formulas: loadedFormulas }
		}
	}

	const fallbackQuery = createQueryDraft(0)
	const source: QueryBuilderDataSource =
		params.source === "traces" || params.source === "logs" || params.source === "metrics"
			? params.source
			: "traces"

	const fallback: QueryBuilderQueryDraft = {
		...fallbackQuery,
		dataSource: source,
		aggregation: typeof params.metric === "string" ? params.metric : fallbackQuery.aggregation,
		stepInterval:
			typeof params.bucketSeconds === "number"
				? String(params.bucketSeconds)
				: fallbackQuery.stepInterval,
		whereClause: formatFiltersAsWhereClause(params),
		groupBy: toQueryGroupByArray(params.groupBy),
		metricName:
			typeof (params.filters as Record<string, unknown> | undefined)?.metricName === "string"
				? ((params.filters as Record<string, unknown>).metricName as string)
				: fallbackQuery.metricName,
		metricType: toMetricType(
			(params.filters as Record<string, unknown> | undefined)?.metricType,
			fallbackQuery.metricType,
		),
		addOns: {
			...fallbackQuery.addOns,
			groupBy: Array.isArray(params.groupBy) ? params.groupBy.length > 0 : false,
		},
	}

	return { ...baseFromWidget, queries: [fallback], formulas: [] }
}

function buildListEndpointParams(
	dataSource: ListDataSource,
	whereClause: string,
	limit: number,
): Record<string, unknown> {
	const { clauses } = parseWhereClauses(whereClause)
	// NOTE: startTime/endTime are injected by useWidgetData from the dashboard
	// time range — do NOT include them here or they'll clash with interpolation.
	const params: Record<string, unknown> = { limit }

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

export function buildWidgetDataSource(
	_widget: DashboardWidget,
	state: QueryBuilderWidgetState,
	seriesFieldOptions: string[],
): WidgetDataSource {
	if (state.visualization === "list") {
		const limit = parsePositiveNumber(state.listLimit) ?? 50
		// For logs without rich filtering, fall back to the simple list_logs endpoint
		if (state.listDataSource === "logs") {
			return {
				endpoint: "list_logs" as const,
				params: buildListEndpointParams(state.listDataSource, state.listWhereClause, limit),
			}
		}
		// For traces, use the query engine which supports full attr.* filtering
		const listQuery = createQueryDraft(0)
		// Inject root_only filter when toggle is on (enables MV usage for faster queries)
		const effectiveWhereClause = state.listRootOnly
			? state.listWhereClause.trim()
				? `root_only = true AND ${state.listWhereClause}`
				: "root_only = true"
			: state.listWhereClause
		const queryForEngine: QueryBuilderQueryDraft = {
			...listQuery,
			dataSource: state.listDataSource,
			whereClause: effectiveWhereClause,
			aggregation: "count", // required by the spec builder but unused for list
		}
		const columnFields = state.listColumns.map((c) => c.field).filter(Boolean)
		return {
			endpoint: "custom_query_builder_list" as const,
			params: {
				queries: [queryForEngine],
				limit,
				columns: columnFields.length > 0 ? columnFields : undefined,
			},
		}
	}

	const hiddenSeriesBaseNames = toHiddenSeriesBaseNames(state)
	const sharedTransform =
		hiddenSeriesBaseNames.length > 0
			? {
					hideSeries: {
						baseNames: hiddenSeriesBaseNames,
					},
				}
			: undefined

	const base: WidgetDataSource = {
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
	}

	if (state.visualization === "stat") {
		return {
			...base,
			transform: {
				...sharedTransform,
				reduceToValue: {
					field: state.statValueField || seriesFieldOptions[0] || "A",
					aggregate: state.statAggregate,
				},
			},
		}
	}

	if (state.visualization === "table") {
		const limit = parsePositiveNumber(state.tableLimit)
		const visibleQueries = state.queries.filter(isVisibleQuery)
		const hasGroupBy = visibleQueries.some(hasActiveGroupBy)

		if (hasGroupBy) {
			return {
				endpoint: "custom_query_builder_breakdown",
				params: { queries: visibleQueries },
				transform: limit ? { limit } : undefined,
			}
		}

		if (!limit) return base
		return {
			...base,
			transform: {
				...sharedTransform,
				limit,
			},
		}
	}

	return base
}

export function buildWidgetDisplay(
	widget: DashboardWidget,
	state: QueryBuilderWidgetState,
): WidgetDisplayConfig {
	if (state.visualization === "list") {
		return {
			title: state.title.trim() || undefined,
			description: state.description.trim() || undefined,
			listDataSource: state.listDataSource,
			listWhereClause: state.listWhereClause,
			listLimit: parsePositiveNumber(state.listLimit) ?? 25,
			listRootOnly: state.listRootOnly,
			columns: state.listColumns.length > 0 ? state.listColumns : undefined,
		}
	}

	const legendValue =
		state.legendPosition === "hidden"
			? ("hidden" as const)
			: state.legendPosition === "right"
				? ("right" as const)
				: ("visible" as const)

	const display: WidgetDisplayConfig = {
		...widget.display,
		title: state.title.trim() ? state.title.trim() : undefined,
		description: state.description.trim() || undefined,
		chartPresentation: {
			...widget.display.chartPresentation,
			legend: legendValue,
		},
	}
	if (state.visualization === "chart") {
		display.chartId = state.chartId
		display.stacked = state.stacked
		display.curveType = state.curveType
		display.unit = state.unit
	}
	if (state.visualization === "stat") display.unit = state.unit
	if (state.visualization === "table") {
		const groupByQuery = state.queries.find((query) => isVisibleQuery(query) && hasActiveGroupBy(query))
		if (groupByQuery) {
			const groupLabel =
				groupByQuery.groupBy.find((g) => g.trim() && g.trim().toLowerCase() !== "none") ?? "name"
			display.columns = [
				{ field: "name", header: groupLabel, align: "left" as const },
				{
					field: "value",
					header: groupByQuery.aggregation ?? "value",
					unit: inferDisplayUnitForQuery(groupByQuery) ?? "number",
					align: "right" as const,
				},
			]
		} else {
			display.columns = undefined
		}
	}
	return display
}

export function validateQueries(state: QueryBuilderWidgetState): string | null {
	if (state.visualization === "list") return null
	const activeQueries = state.queries.filter((query) => query.enabled !== false)
	if (activeQueries.length === 0) return "Add at least one query"
	for (const query of activeQueries) {
		const built = buildTimeseriesQuerySpec(query)
		if (!built.query) return `${query.name}: ${built.error ?? "invalid query"}`
	}
	return null
}
