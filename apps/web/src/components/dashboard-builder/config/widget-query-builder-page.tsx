import * as React from "react"
import { Result, useAtomValue } from "@effect-atom/atom-react"

import { Button } from "@maple/ui/components/ui/button"
import { Input } from "@maple/ui/components/ui/input"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import { QueryPanel } from "@/components/dashboard-builder/config/query-panel"
import { FormulaPanel } from "@/components/dashboard-builder/config/formula-panel"
import { WidgetSettingsBar } from "@/components/dashboard-builder/config/widget-settings-bar"
import type {
  DashboardWidget,
  ValueUnit,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import { useWidgetData } from "@/hooks/use-widget-data"
import {
  buildTimeseriesQuerySpec,
  createFormulaDraft,
  createQueryDraft,
  formatFiltersAsWhereClause,
  formulaLabel,
  QUERY_BUILDER_METRIC_TYPES,
  queryLabel,
  resetQueryForDataSource,
  type QueryBuilderDataSource,
  type QueryBuilderFormulaDraft,
  type QueryBuilderMetricType,
  type QueryBuilderQueryDraft,
} from "@/lib/query-builder/model"
import {
  getLogsFacetsResultAtom,
  getTracesFacetsResultAtom,
  listMetricsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"

type StatAggregate = "sum" | "first" | "count" | "avg" | "max" | "min"

interface WidgetQueryBuilderPageProps {
  widget: DashboardWidget
  onApply: (updates: {
    dataSource: WidgetDataSource
    display: WidgetDisplayConfig
  }) => void
  onCancel: () => void
}

interface QueryBuilderWidgetState {
  title: string
  chartId: string
  queries: QueryBuilderQueryDraft[]
  formulas: QueryBuilderFormulaDraft[]
  comparisonMode: "none" | "previous_period"
  includePercentChange: boolean
  debug: boolean
  statAggregate: StatAggregate
  statValueField: string
  unit: ValueUnit
  tableLimit: string
}

function parsePositiveNumber(raw: string): number | undefined {
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function toQueryGroupByToken(groupBy: unknown): string {
  if (typeof groupBy !== "string" || !groupBy.trim()) return "service.name"
  switch (groupBy) {
    case "service": return "service.name"
    case "span_name": return "span.name"
    case "status_code": return "status.code"
    case "http_method": return "http.method"
    case "none": return "none"
    default: return groupBy
  }
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

  const baseFromWidget = {
    title: widget.display.title ?? "",
    chartId: widget.display.chartId ?? "query-builder-line",
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
  } satisfies Omit<QueryBuilderWidgetState, "queries" | "formulas">

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
    groupBy: toQueryGroupByToken(params.groupBy),
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
      groupBy: typeof params.groupBy === "string" && params.groupBy.trim().length > 0,
    },
  }

  return { ...baseFromWidget, queries: [fallback], formulas: [] }
}

function buildWidgetDataSource(
  widget: DashboardWidget,
  state: QueryBuilderWidgetState,
  seriesFieldOptions: string[],
): WidgetDataSource {
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

  if (widget.visualization === "stat") {
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

  if (widget.visualization === "table") {
    const limit = parsePositiveNumber(state.tableLimit)
    if (!limit) return base
    return { ...base, transform: { limit } }
  }

  return base
}

function buildWidgetDisplay(
  widget: DashboardWidget,
  state: QueryBuilderWidgetState,
): WidgetDisplayConfig {
  const display: WidgetDisplayConfig = {
    ...widget.display,
    title: state.title.trim() ? state.title.trim() : undefined,
    chartPresentation: {
      ...widget.display.chartPresentation,
      legend: "visible",
    },
  }
  if (widget.visualization === "chart") display.chartId = state.chartId
  if (widget.visualization === "stat") display.unit = state.unit
  if (widget.visualization === "table") display.columns = undefined
  return display
}

function validateQueries(state: QueryBuilderWidgetState): string | null {
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

  const metricsResult = useAtomValue(
    listMetricsResultAtom({ data: { limit: 300 } }),
  )

  const tracesFacetsResult = useAtomValue(
    getTracesFacetsResultAtom({ data: {} }),
  )

  const logsFacetsResult = useAtomValue(
    getLogsFacetsResultAtom({ data: {} }),
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
    const options: Array<{ value: string; label: string }> = []
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
      options.push({ value, label: `${row.metricName} (${row.metricType})` })
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
      },
      logs: {
        services: toNames(logsFacets.services),
        severities: toNames(logsFacets.severities),
      },
      metrics: {
        services: metricServices,
        metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
      },
    }
  }, [logsFacetsResult, metricRows, tracesFacetsResult])

  React.useEffect(() => {
    if (metricSelectionOptions.length === 0) return
    setState((current) => {
      const [defaultMetricName, defaultMetricTypeRaw] = metricSelectionOptions[0].value.split("::")
      const defaultMetricType = defaultMetricTypeRaw as QueryBuilderMetricType
      let changed = false
      const queries = current.queries.map((query) => {
        if (query.dataSource !== "metrics" || query.metricName || !defaultMetricName || !defaultMetricType) return query
        changed = true
        return { ...query, metricName: defaultMetricName, metricType: defaultMetricType }
      })
      return changed ? { ...current, queries } : current
    })
  }, [metricSelectionOptions])

  const seriesFieldOptions = React.useMemo(() => toSeriesFieldOptions(state), [state])

  React.useEffect(() => {
    if (widget.visualization !== "stat" || seriesFieldOptions.length === 0) return
    if (state.statValueField && seriesFieldOptions.includes(state.statValueField)) return
    setState((current) => {
      if (current.statValueField && seriesFieldOptions.includes(current.statValueField)) return current
      return { ...current, statValueField: seriesFieldOptions[0] }
    })
  }, [widget, state, seriesFieldOptions])

  const previewWidget = React.useMemo(() => {
    const previewState = stagedState ?? state
    const previewSeriesOptions = toSeriesFieldOptions(previewState)
    return {
      ...widget,
      dataSource: buildWidgetDataSource(widget, previewState, previewSeriesOptions),
      display: buildWidgetDisplay(widget, previewState),
    }
  }, [stagedState, widget])

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
            visualization={widget.visualization}
            chartId={state.chartId}
            comparisonMode={state.comparisonMode}
            includePercentChange={state.includePercentChange}
            debug={state.debug}
            statAggregate={state.statAggregate}
            statValueField={state.statValueField}
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
                autocompleteValues={autocompleteValuesBySource}
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
        </div>
      </div>
    </div>
  )
}
