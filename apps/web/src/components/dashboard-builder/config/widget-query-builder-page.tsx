import * as React from "react"
import { Result, useAtomValue } from "@/lib/effect-atom"

import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { ListWidget } from "@/components/dashboard-builder/widgets/list-widget"
import { QueryPanel } from "@/components/dashboard-builder/config/query-panel"
import { FormulaPanel } from "@/components/dashboard-builder/config/formula-panel"
import { WidgetSettingsBar } from "@/components/dashboard-builder/config/widget-settings-bar"
import {
  ListConfigPanel,
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
import { useDashboardTimeRange } from "@/components/dashboard-builder/dashboard-providers"
import { useWidgetData } from "@/hooks/use-widget-data"
import {
  buildTimeseriesQuerySpec,
  createFormulaDraft,
  createQueryDraft,
  formatFiltersAsWhereClause,
  formulaLabel,
  QUERY_BUILDER_METRIC_TYPES,
  queryLabel,
  resetAggregationForMetricType,
  resetQueryForDataSource,
  type QueryBuilderDataSource,
  type QueryBuilderFormulaDraft,
  type QueryBuilderMetricType,
  type QueryBuilderQueryDraft,
} from "@/lib/query-builder/model"
import {
  getLogsFacetsResultAtom,
  getMetricAttributeKeysResultAtom,
  getResourceAttributeKeysResultAtom,
  getResourceAttributeValuesResultAtom,
  getSpanAttributeKeysResultAtom,
  getSpanAttributeValuesResultAtom,
  getTracesFacetsResultAtom,
  listMetricsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import {
  normalizeKey,
  parseBoolean,
  parseWhereClause as parseWhereClauses,
} from "@maple/query-engine/where-clause"

type StatAggregate = "sum" | "first" | "count" | "avg" | "max" | "min"

interface WidgetQueryBuilderPageProps {
  widget: DashboardWidget
  onApply: (updates: {
    visualization: VisualizationType
    dataSource: WidgetDataSource
    display: WidgetDisplayConfig
  }) => void
  onCancel: () => void
}

interface QueryBuilderWidgetState {
  visualization: VisualizationType
  title: string
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
  tableLimit: string
  // List-specific
  listDataSource: ListDataSource
  listWhereClause: string
  listLimit: string
  listColumns: ListColumnDraft[]
}

function parsePositiveNumber(raw: string): number | undefined {
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
  if (input === "sum" || input === "gauge" || input === "histogram" || input === "exponential_histogram") return input
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
    isMonotonic: raw.isMonotonic ?? (raw.metricType === "sum"),
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

function cloneWidgetState(state: QueryBuilderWidgetState): QueryBuilderWidgetState {
  return {
    ...state,
    queries: state.queries.map((query) => ({ ...query, addOns: { ...query.addOns } })),
    formulas: state.formulas.map((formula) => ({ ...formula })),
    listColumns: state.listColumns.map((col) => ({ ...col })),
  }
}

function toSeriesFieldOptions(state: QueryBuilderWidgetState): string[] {
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
  for (const query of state.queries) addUnique(query.legend.trim() || query.name)
  for (const formula of state.formulas) addUnique(formula.legend.trim() || formula.name)
  return options
}

function toInitialState(widget: DashboardWidget): QueryBuilderWidgetState {
  const params = (widget.dataSource.params ?? {}) as Record<string, unknown>
  const rawComparison =
    params.comparison && typeof params.comparison === "object"
      ? (params.comparison as Record<string, unknown>)
      : {}

  const listDs =
    widget.display.listDataSource === "logs" ? "logs" as const : "traces" as const
  const baseFromWidget = {
    visualization: widget.visualization,
    title: widget.display.title ?? "",
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
    unit: widget.display.unit ?? "number",
    tableLimit:
      typeof widget.dataSource.transform?.limit === "number"
        ? String(widget.dataSource.transform.limit)
        : "",
    listDataSource: listDs,
    listWhereClause: widget.display.listWhereClause ?? "",
    listLimit:
      typeof widget.display.listLimit === "number"
        ? String(widget.display.listLimit)
        : "",
    listColumns: (widget.display.columns ?? (listDs === "logs" ? LOG_DEFAULT_COLUMNS : TRACE_DEFAULT_COLUMNS)) as ListColumnDraft[],
  } satisfies Omit<QueryBuilderWidgetState, "queries" | "formulas">

  // List widgets don't use the query builder — return early with a dummy query
  if (widget.visualization === "list") {
    return { ...baseFromWidget, queries: [createQueryDraft(0)], formulas: [] }
  }

  if (
    widget.dataSource.endpoint === "custom_query_builder_timeseries" &&
    Array.isArray(params.queries)
  ) {
    const loadedQueries = params.queries
      .filter((query): query is QueryBuilderQueryDraft =>
        query != null &&
        typeof query === "object" &&
        typeof (query as QueryBuilderQueryDraft).id === "string" &&
        typeof (query as QueryBuilderQueryDraft).whereClause === "string"
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
              typeof (formula as QueryBuilderFormulaDraft).legend === "string"
          )
          .map((formula, index) => ({ ...formula, name: formula.name || formulaLabel(index) }))
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
      typeof ((params.filters as Record<string, unknown> | undefined)?.metricName) === "string"
        ? ((params.filters as Record<string, unknown>).metricName as string)
        : fallbackQuery.metricName,
    metricType: toMetricType(
      (params.filters as Record<string, unknown> | undefined)?.metricType,
      fallbackQuery.metricType
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
        params.attributeKey = key.slice(5)
        if (clause.operator !== "exists") params.attributeValue = clause.value
      } else if (key.startsWith("resource.")) {
        params.resourceAttributeKey = key.slice(9)
        if (clause.operator !== "exists") params.resourceAttributeValue = clause.value
      }
    }
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

function buildWidgetDataSource(
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
    const queryForEngine: QueryBuilderQueryDraft = {
      ...listQuery,
      dataSource: state.listDataSource,
      whereClause: state.listWhereClause,
      aggregation: "count", // required by the spec builder but unused for list
    }
    return {
      endpoint: "custom_query_builder_list" as const,
      params: {
        queries: [queryForEngine],
        limit,
      },
    }
  }

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
  }

  if (state.visualization === "stat") {
    return {
      ...base,
      transform: {
        reduceToValue: {
          field: state.statValueField || seriesFieldOptions[0] || "A",
          aggregate: state.statAggregate,
        },
      },
    }
  }

  if (state.visualization === "table") {
    const limit = parsePositiveNumber(state.tableLimit)
    const hasGroupBy = state.queries.some(
      (q) =>
        q.enabled &&
        q.addOns.groupBy &&
        q.groupBy.some(
          (g) => g.trim() !== "" && g.trim().toLowerCase() !== "none",
        ),
    )

    if (hasGroupBy) {
      return {
        endpoint: "custom_query_builder_breakdown",
        params: { queries: state.queries },
        transform: limit ? { limit } : undefined,
      }
    }

    if (!limit) return base
    return { ...base, transform: { limit } }
  }

  return base
}

function buildWidgetDisplay(
  widget: DashboardWidget,
  state: QueryBuilderWidgetState,
): WidgetDisplayConfig {
  if (state.visualization === "list") {
    return {
      title: state.title.trim() || undefined,
      listDataSource: state.listDataSource,
      listWhereClause: state.listWhereClause,
      listLimit: parsePositiveNumber(state.listLimit) ?? 50,
      columns: state.listColumns.length > 0 ? state.listColumns : undefined,
    }
  }

  const display: WidgetDisplayConfig = {
    ...widget.display,
    title: state.title.trim() ? state.title.trim() : undefined,
    chartPresentation: {
      ...widget.display.chartPresentation,
      legend: "visible",
    },
  }
  if (state.visualization === "chart") {
    display.chartId = state.chartId
    display.stacked = state.stacked
    display.curveType = state.curveType
  }
  if (state.visualization === "stat") display.unit = state.unit
  if (state.visualization === "table") {
    const groupByQuery = state.queries.find(
      (q) =>
        q.enabled &&
        q.addOns.groupBy &&
        q.groupBy.some(
          (g) => g.trim() !== "" && g.trim().toLowerCase() !== "none",
        ),
    )
    if (groupByQuery) {
      const groupLabel =
        groupByQuery.groupBy.find(
          (g) => g.trim() && g.trim().toLowerCase() !== "none",
        ) ?? "name"
      display.columns = [
        { field: "name", header: groupLabel, align: "left" as const },
        {
          field: "value",
          header: groupByQuery.aggregation ?? "value",
          unit: "number",
          align: "right" as const,
        },
      ]
    } else {
      display.columns = undefined
    }
  }
  return display
}

function validateQueries(state: QueryBuilderWidgetState): string | null {
  if (state.visualization === "list") return null
  const enabledQueries = state.queries.filter((query) => query.enabled)
  if (enabledQueries.length === 0) return "Enable at least one query"
  for (const query of enabledQueries) {
    const built = buildTimeseriesQuerySpec(query)
    if (!built.query) return `${query.name}: ${built.error ?? "invalid query"}`
  }
  return null
}

const WidgetPreview = React.memo(function WidgetPreview({ widget }: { widget: DashboardWidget }) {
  const { dataState } = useWidgetData(widget)

  if (widget.visualization === "stat") {
    return <StatWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
  }
  if (widget.visualization === "table") {
    return <TableWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
  }
  if (widget.visualization === "list") {
    return <ListWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
  }
  return <ChartWidget dataState={dataState} display={widget.display} mode="view" onRemove={() => {}} />
})

export function WidgetQueryBuilderPage({
  widget,
  onApply,
  onCancel,
}: WidgetQueryBuilderPageProps) {
  const [state, setState] = React.useState<QueryBuilderWidgetState>(() => toInitialState(widget))
  const [stagedState, setStagedState] = React.useState<QueryBuilderWidgetState>(() =>
    cloneWidgetState(toInitialState(widget))
  )
  const [validationError, setValidationError] = React.useState<string | null>(null)
  const [collapsedQueries, setCollapsedQueries] = React.useState<Set<string>>(new Set())
  const [activeAttributeKey, setActiveAttributeKey] = React.useState<string | null>(null)
  const [activeResourceAttributeKey, setActiveResourceAttributeKey] = React.useState<string | null>(null)
  const [metricSearch, setMetricSearch] = React.useState("")
  const [debouncedMetricSearch, setDebouncedMetricSearch] = React.useState("")

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedMetricSearch(metricSearch), 250)
    return () => clearTimeout(timer)
  }, [metricSearch])

  const { state: { resolvedTimeRange: resolvedTime } } = useDashboardTimeRange()

  const metricsResult = useAtomValue(
    listMetricsResultAtom({ data: { limit: 100, search: debouncedMetricSearch || undefined } }),
  )

  const tracesFacetsResult = useAtomValue(
    getTracesFacetsResultAtom({ data: {} }),
  )

  const logsFacetsResult = useAtomValue(
    getLogsFacetsResultAtom({ data: {} }),
  )

  const spanAttributeKeysResult = useAtomValue(
    getSpanAttributeKeysResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
      },
    }),
  )

  const spanAttributeValuesResult = useAtomValue(
    getSpanAttributeValuesResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
        attributeKey: activeAttributeKey ?? "",
      },
    }),
  )

  const metricAttributeKeysResult = useAtomValue(
    getMetricAttributeKeysResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
      },
    }),
  )

  const resourceAttributeKeysResult = useAtomValue(
    getResourceAttributeKeysResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
      },
    }),
  )

  const resourceAttributeValuesResult = useAtomValue(
    getResourceAttributeValuesResultAtom({
      data: {
        startTime: resolvedTime?.startTime,
        endTime: resolvedTime?.endTime,
        attributeKey: activeResourceAttributeKey ?? "",
      },
    }),
  )

  const attributeKeys = React.useMemo(
    () =>
      Result.builder(spanAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => []),
    [spanAttributeKeysResult],
  )

  const attributeValues = React.useMemo(
    () =>
      activeAttributeKey
        ? Result.builder(spanAttributeValuesResult)
            .onSuccess((response) => response.data.map((row) => row.attributeValue))
            .orElse(() => [])
        : [],
    [activeAttributeKey, spanAttributeValuesResult],
  )

  const resourceAttributeKeys = React.useMemo(
    () =>
      Result.builder(resourceAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => []),
    [resourceAttributeKeysResult],
  )

  const resourceAttributeValues = React.useMemo(
    () =>
      activeResourceAttributeKey
        ? Result.builder(resourceAttributeValuesResult)
            .onSuccess((response) => response.data.map((row) => row.attributeValue))
            .orElse(() => [])
        : [],
    [activeResourceAttributeKey, resourceAttributeValuesResult],
  )

  const metricAttributeKeys = React.useMemo(
    () =>
      Result.builder(metricAttributeKeysResult)
        .onSuccess((response) => response.data.map((row) => row.attributeKey))
        .orElse(() => []),
    [metricAttributeKeysResult],
  )

  const metricRows = React.useMemo(
    () =>
      Result.builder(metricsResult)
        .onSuccess((response) => response.data)
        .orElse(() => []),
    [metricsResult],
  )

  const metricSelectionOptions = React.useMemo(() => {
    const seen = new Set<string>()
    const options: Array<{ value: string; label: string; isMonotonic: boolean }> = []
    for (const row of metricRows) {
      if (
        row.metricType !== "sum" &&
        row.metricType !== "gauge" &&
        row.metricType !== "histogram" &&
        row.metricType !== "exponential_histogram"
      ) continue
      const value = `${row.metricName}::${row.metricType}`
      if (seen.has(value)) continue
      seen.add(value)
      options.push({ value, label: `${row.metricName} (${row.metricType})`, isMonotonic: row.isMonotonic })
    }
    return options
  }, [metricRows])

  const autocompleteValuesBySource = React.useMemo(() => {
    const tracesFacets = Result.builder(tracesFacetsResult)
      .onSuccess((response) => response.data)
      .orElse(() => ({
        services: [],
        spanNames: [],
        deploymentEnvs: [],
      }))

    const logsFacets = Result.builder(logsFacetsResult)
      .onSuccess((response) => response.data)
      .orElse(() => ({
        services: [],
        severities: [],
      }))

    const toNames = (items: Array<{ name: string }>): string[] => {
      const seen = new Set<string>()
      const values: string[] = []
      for (const item of items) {
        const next = item.name.trim()
        if (!next || seen.has(next)) continue
        seen.add(next)
        values.push(next)
      }
      return values
    }

    const metricServices = toNames(
      metricRows
        .map((row) => ({ name: row.serviceName }))
        .filter((row) => row.name.trim()),
    )

    return {
      traces: {
        services: toNames(tracesFacets.services),
        spanNames: toNames(tracesFacets.spanNames),
        environments: toNames(tracesFacets.deploymentEnvs),
        attributeKeys,
        attributeValues,
        resourceAttributeKeys,
        resourceAttributeValues,
      },
      logs: {
        services: toNames(logsFacets.services),
        severities: toNames(logsFacets.severities),
        attributeKeys,
        attributeValues,
        resourceAttributeKeys,
        resourceAttributeValues,
      },
      metrics: {
        services: metricServices,
        metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
        attributeKeys: metricAttributeKeys,
      },
    }
  }, [logsFacetsResult, metricRows, tracesFacetsResult, attributeKeys, attributeValues, resourceAttributeKeys, resourceAttributeValues, metricAttributeKeys])

  const appliedMetricDefaultRef = React.useRef(false)
  if (metricSelectionOptions.length > 0 && !appliedMetricDefaultRef.current) {
    const [defaultMetricName, defaultMetricTypeRaw] = metricSelectionOptions[0].value.split("::")
    const defaultMetricType = defaultMetricTypeRaw as QueryBuilderMetricType
    const needsDefault = state.queries.some(
      (query) => query.dataSource === "metrics" && !query.metricName && defaultMetricName && defaultMetricType,
    )
    if (needsDefault) {
      appliedMetricDefaultRef.current = true
      setState((current) => {
        let changed = false
        const queries = current.queries.map((query) => {
          if (query.dataSource !== "metrics" || query.metricName || !defaultMetricName || !defaultMetricType) return query
          changed = true
          const defaultIsMonotonic = metricSelectionOptions[0]?.isMonotonic ?? (defaultMetricType === "sum")
          return {
            ...query,
            metricName: defaultMetricName,
            metricType: defaultMetricType,
            isMonotonic: defaultIsMonotonic,
            aggregation: resetAggregationForMetricType(query.aggregation, defaultMetricType, defaultIsMonotonic),
          }
        })
        return changed ? { ...current, queries } : current
      })
    }
  }

  const seriesFieldOptions = React.useMemo(() => toSeriesFieldOptions(state), [state])

  const effectiveStatValueField =
    state.visualization === "stat" &&
    seriesFieldOptions.length > 0 &&
    (!state.statValueField || !seriesFieldOptions.includes(state.statValueField))
      ? seriesFieldOptions[0]
      : state.statValueField

  const previewWidget = React.useMemo(() => {
    // List widgets use live state (no query builder compilation needed).
    // Chart/Stat/Table use stagedState to avoid re-querying on every keystroke.
    const previewState = state.visualization === "list" ? state : (stagedState ?? state)
    const previewSeriesOptions = toSeriesFieldOptions(previewState)
    return {
      ...widget,
      visualization: previewState.visualization,
      dataSource: buildWidgetDataSource(widget, previewState, previewSeriesOptions),
      display: buildWidgetDisplay(widget, previewState),
    }
  }, [state, stagedState, widget])

  const runPreview = () => {
    const error = validateQueries(state)
    if (error) { setValidationError(error); return }
    setValidationError(null)
    setStagedState(cloneWidgetState(state))
  }

  const applyChanges = () => {
    const error = validateQueries(state)
    if (error) { setValidationError(error); return }
    setValidationError(null)
    onApply({
      visualization: state.visualization,
      dataSource: buildWidgetDataSource(widget, state, seriesFieldOptions),
      display: buildWidgetDisplay(widget, state),
    })
  }

  const updateQuery = (
    id: string,
    updater: (query: QueryBuilderQueryDraft) => QueryBuilderQueryDraft,
  ) => {
    setState((current) => ({
      ...current,
      queries: current.queries.map((query) => (query.id === id ? updater(query) : query)),
    }))
  }

  const addQuery = () => {
    setState((current) => ({
      ...current,
      queries: [...current.queries, createQueryDraft(current.queries.length)],
    }))
  }

  const cloneQuery = (id: string) => {
    setState((current) => {
      const source = current.queries.find((query) => query.id === id)
      if (!source) return current
      const duplicate: QueryBuilderQueryDraft = { ...source, id: crypto.randomUUID() }
      return {
        ...current,
        queries: [...current.queries, duplicate].map((query, index) => ({
          ...query,
          name: queryLabel(index),
        })),
      }
    })
  }

  const removeQuery = (id: string) => {
    setState((current) => {
      if (current.queries.length === 1) return current
      return {
        ...current,
        queries: current.queries
          .filter((query) => query.id !== id)
          .map((query, index) => ({ ...query, name: queryLabel(index) })),
      }
    })
    setCollapsedQueries((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const addFormula = () => {
    setState((current) => ({
      ...current,
      formulas: [
        ...current.formulas,
        createFormulaDraft(current.formulas.length, current.queries.map((q) => q.name)),
      ],
    }))
  }

  const removeFormula = (id: string) => {
    setState((current) => ({
      ...current,
      formulas: current.formulas
        .filter((formula) => formula.id !== id)
        .map((formula, index) => ({ ...formula, name: formulaLabel(index) })),
    }))
  }

  const updateFormula = (
    id: string,
    updater: (f: QueryBuilderFormulaDraft) => QueryBuilderFormulaDraft,
  ) => {
    setState((current) => ({
      ...current,
      formulas: current.formulas.map((f) => (f.id === id ? updater(f) : f)),
    }))
  }

  const toggleCollapse = (id: string) => {
    setCollapsedQueries((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-200 flex flex-col -m-4 -mt-4 min-h-0 flex-1">
      {/* Sticky header bar */}
      <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur-sm px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors text-sm"
          >
            &larr; Back
          </button>
          <div className="h-4 w-px bg-border shrink-0" />
          <Input
            value={state.title}
            onChange={(event) =>
              setState((current) => ({ ...current, title: event.target.value }))
            }
            placeholder="Untitled widget"
            className="border-none bg-transparent text-base font-bold shadow-none px-0 focus-visible:ring-0 max-w-md"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={applyChanges}>
            Apply
          </Button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {/* Preview hero section */}
        <div className="border-b bg-muted/30 px-6 py-6">
          <div className="h-[400px]">
            <WidgetPreview widget={previewWidget} />
          </div>
        </div>

        {/* Configuration */}
        <div className="px-6 py-6 space-y-6">
          {/* Widget settings */}
          <WidgetSettingsBar
            visualization={state.visualization}
            onVisualizationChange={(visualization) =>
              setState((current) => ({ ...current, visualization }))
            }
            chartId={state.chartId}
            stacked={state.stacked}
            curveType={state.curveType}
            comparisonMode={state.comparisonMode}
            includePercentChange={state.includePercentChange}
            debug={state.debug}
            statAggregate={state.statAggregate}
            statValueField={effectiveStatValueField}
            unit={state.unit}
            tableLimit={state.tableLimit}
            seriesFieldOptions={seriesFieldOptions}
            onChange={(updates) =>
              setState((current) => ({ ...current, ...updates }))
            }
          />

          {validationError && (
            <p className="text-xs text-destructive font-medium">{validationError}</p>
          )}

          {state.visualization === "list" ? (
            <>
              <ListConfigPanel
                listDataSource={state.listDataSource}
                whereClause={state.listWhereClause}
                limit={state.listLimit}
                columns={state.listColumns}
                autocompleteValues={autocompleteValuesBySource}
                onActiveAttributeKey={setActiveAttributeKey}
                onActiveResourceAttributeKey={setActiveResourceAttributeKey}
                onChange={(updates) =>
                  setState((current) => ({ ...current, ...updates }))
                }
              />
              <div className="flex items-center gap-3 border-t pt-4">
                <Button size="sm" onClick={runPreview}>
                  Run Preview
                </Button>
              </div>
            </>
          ) : (
            <>
              {/* Query panels */}
              <div className="space-y-3">
                {state.queries.map((query, index) => (
                  <QueryPanel
                    key={query.id}
                    query={query}
                    index={index}
                    collapsed={collapsedQueries.has(query.id)}
                    canRemove={state.queries.length > 1}
                    metricSelectionOptions={metricSelectionOptions}
                    onMetricSearch={setMetricSearch}
                    autocompleteValues={autocompleteValuesBySource}
                    onActiveAttributeKey={setActiveAttributeKey}
                    onActiveResourceAttributeKey={setActiveResourceAttributeKey}
                    onUpdate={(updater) => updateQuery(query.id, updater)}
                    onClone={() => cloneQuery(query.id)}
                    onRemove={() => removeQuery(query.id)}
                    onToggleCollapse={() => toggleCollapse(query.id)}
                    onDataSourceChange={(ds) =>
                      updateQuery(query.id, (current) =>
                        resetQueryForDataSource(current, ds)
                      )
                    }
                  />
                ))}
              </div>

              {/* Formula panels */}
              {state.formulas.length > 0 && (
                <div className="space-y-3">
                  {state.formulas.map((formula) => (
                    <FormulaPanel
                      key={formula.id}
                      formula={formula}
                      onUpdate={(updater) => updateFormula(formula.id, updater)}
                      onRemove={() => removeFormula(formula.id)}
                    />
                  ))}
                </div>
              )}

              {/* Toolbar */}
              <div className="flex items-center gap-3 border-t pt-4">
                <Button variant="outline" size="sm" onClick={addQuery}>
                  + Query
                </Button>
                <Button variant="outline" size="sm" onClick={addFormula}>
                  + Formula
                </Button>
                <Button size="sm" onClick={runPreview}>
                  Run Preview
                </Button>
                <span className="text-[11px] text-muted-foreground ml-auto">
                  {state.queries.map((q) => q.name).join(", ")}
                  {state.formulas.length > 0 && `, ${state.formulas.map((f) => f.name).join(", ")}`}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
