import * as React from "react"
import { Result, useAtomValue } from "@effect-atom/atom-react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Checkbox } from "@maple/ui/components/ui/checkbox"
import { Input } from "@maple/ui/components/ui/input"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@maple/ui/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@maple/ui/components/ui/sheet"
import { chartRegistry } from "@maple/ui/components/charts/registry"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import { ChartWidget } from "@/components/dashboard-builder/widgets/chart-widget"
import { StatWidget } from "@/components/dashboard-builder/widgets/stat-widget"
import { TableWidget } from "@/components/dashboard-builder/widgets/table-widget"
import type {
  DashboardWidget,
  ValueUnit,
  WidgetDataSource,
  WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"
import { useWidgetData } from "@/hooks/use-widget-data"
import {
  AGGREGATIONS_BY_SOURCE,
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

interface WidgetQueryBuilderSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  widget: DashboardWidget | null
  onApply: (
    widgetId: string,
    updates: {
      dataSource: WidgetDataSource
      display: WidgetDisplayConfig
    }
  ) => void
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

const UNIT_OPTIONS: Array<{ value: ValueUnit; label: string }> = [
  { value: "none", label: "None" },
  { value: "number", label: "Number" },
  { value: "percent", label: "Percent" },
  { value: "duration_ms", label: "Duration (ms)" },
  { value: "duration_us", label: "Duration (us)" },
  { value: "bytes", label: "Bytes" },
  { value: "requests_per_sec", label: "Requests/sec" },
  { value: "short", label: "Short" },
]

function parseMetricSelection(raw: string): {
  metricName: string
  metricType: QueryBuilderMetricType
} | null {
  const [metricName, metricType] = raw.split("::")

  if (!metricName || !metricType) {
    return null
  }

  if (!QUERY_BUILDER_METRIC_TYPES.includes(metricType as QueryBuilderMetricType)) {
    return null
  }

  return {
    metricName,
    metricType: metricType as QueryBuilderMetricType,
  }
}

function parsePositiveNumber(raw: string): number | undefined {
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

function toQueryGroupByToken(groupBy: unknown): string {
  if (typeof groupBy !== "string" || !groupBy.trim()) {
    return "service.name"
  }

  switch (groupBy) {
    case "service":
      return "service.name"
    case "span_name":
      return "span.name"
    case "status_code":
      return "status.code"
    case "http_method":
      return "http.method"
    case "none":
      return "none"
    default:
      return groupBy
  }
}

function toMetricType(input: unknown, fallback: QueryBuilderMetricType): QueryBuilderMetricType {
  if (
    input === "sum" ||
    input === "gauge" ||
    input === "histogram" ||
    input === "exponential_histogram"
  ) {
    return input
  }

  return fallback
}

function normalizeLoadedQuery(raw: QueryBuilderQueryDraft, index: number): QueryBuilderQueryDraft {
  const base = createQueryDraft(index)

  return {
    ...base,
    ...raw,
    name: raw.name || queryLabel(index),
    dataSource:
      raw.dataSource === "traces" ||
      raw.dataSource === "logs" ||
      raw.dataSource === "metrics"
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
    queries: state.queries.map((query) => ({
      ...query,
      addOns: { ...query.addOns },
    })),
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
    while (usedNames.has(`${base} (${suffix})`)) {
      suffix += 1
    }

    const next = `${base} (${suffix})`
    usedNames.add(next)
    options.push(next)
  }

  for (const query of state.queries) {
    addUnique(query.legend.trim() || query.name)
  }

  for (const formula of state.formulas) {
    addUnique(formula.legend.trim() || formula.name)
  }

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
    comparisonMode:
      rawComparison.mode === "previous_period" ? "previous_period" : "none",
    includePercentChange:
      typeof rawComparison.includePercentChange === "boolean"
        ? rawComparison.includePercentChange
        : true,
    debug: params.debug === true,
    statAggregate:
      widget.dataSource.transform?.reduceToValue?.aggregate ?? "first",
    statValueField:
      widget.dataSource.transform?.reduceToValue?.field ?? "",
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
      .filter((query): query is QueryBuilderQueryDraft => {
        return (
          query != null &&
          typeof query === "object" &&
          typeof (query as QueryBuilderQueryDraft).id === "string" &&
          typeof (query as QueryBuilderQueryDraft).whereClause === "string"
        )
      })
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
          .map((formula, index) => ({
            ...formula,
            name: formula.name || formulaLabel(index),
          }))
      : []

    if (loadedQueries.length > 0) {
      return {
        ...baseFromWidget,
        queries: loadedQueries,
        formulas: loadedFormulas,
      }
    }
  }

  const fallbackQuery = createQueryDraft(0)
  const source: QueryBuilderDataSource =
    params.source === "traces" ||
    params.source === "logs" ||
    params.source === "metrics"
      ? params.source
      : "traces"

  const filters =
    params.filters && typeof params.filters === "object"
      ? (params.filters as Record<string, unknown>)
      : {}

  const fallback: QueryBuilderQueryDraft = {
    ...fallbackQuery,
    dataSource: source,
    aggregation:
      typeof params.metric === "string" ? params.metric : fallbackQuery.aggregation,
    stepInterval:
      typeof params.bucketSeconds === "number"
        ? String(params.bucketSeconds)
        : fallbackQuery.stepInterval,
    whereClause: formatFiltersAsWhereClause(params),
    groupBy: toQueryGroupByToken(params.groupBy),
    metricName:
      typeof filters.metricName === "string"
        ? filters.metricName
        : fallbackQuery.metricName,
    metricType: toMetricType(filters.metricType, fallbackQuery.metricType),
    addOns: {
      ...fallbackQuery.addOns,
      groupBy: typeof params.groupBy === "string" && params.groupBy.trim().length > 0,
    },
  }

  return {
    ...baseFromWidget,
    queries: [fallback],
    formulas: [],
  }
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

    return {
      ...base,
      transform: {
        limit,
      },
    }
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
  }

  if (widget.visualization === "chart") {
    display.chartId = state.chartId
  }

  if (widget.visualization === "stat") {
    display.unit = state.unit
  }

  if (widget.visualization === "table") {
    display.columns = undefined
  }

  return display
}

function validateQueries(state: QueryBuilderWidgetState): string | null {
  const enabledQueries = state.queries.filter((query) => query.enabled)
  if (enabledQueries.length === 0) {
    return "Enable at least one query"
  }

  for (const query of enabledQueries) {
    const built = buildTimeseriesQuerySpec(query)
    if (!built.query) {
      return `${query.name}: ${built.error ?? "invalid query"}`
    }
  }

  return null
}

function WidgetPreview({ widget }: { widget: DashboardWidget }) {
  const { dataState } = useWidgetData(widget)

  if (widget.visualization === "stat") {
    return (
      <StatWidget
        dataState={dataState}
        display={widget.display}
        mode="view"
        onRemove={() => {}}
      />
    )
  }

  if (widget.visualization === "table") {
    return (
      <TableWidget
        dataState={dataState}
        display={widget.display}
        mode="view"
        onRemove={() => {}}
      />
    )
  }

  return (
    <ChartWidget
      dataState={dataState}
      display={widget.display}
      mode="view"
      onRemove={() => {}}
    />
  )
}

export function WidgetQueryBuilderSheet({
  open,
  onOpenChange,
  widget,
  onApply,
}: WidgetQueryBuilderSheetProps) {
  const [state, setState] = React.useState<QueryBuilderWidgetState | null>(null)
  const [stagedState, setStagedState] = React.useState<QueryBuilderWidgetState | null>(null)
  const [validationError, setValidationError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!widget) {
      setState(null)
      setStagedState(null)
      setValidationError(null)
      return
    }

    const nextState = toInitialState(widget)
    setState(nextState)
    setStagedState(cloneWidgetState(nextState))
    setValidationError(null)
  }, [widget])

  const metricsResult = useAtomValue(
    listMetricsResultAtom({
      data: {
        limit: 300,
      },
    }),
  )

  const tracesFacetsResult = useAtomValue(
    getTracesFacetsResultAtom({
      data: {},
    }),
  )

  const logsFacetsResult = useAtomValue(
    getLogsFacetsResultAtom({
      data: {},
    }),
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
      ) {
        continue
      }

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
        if (!next || seen.has(next)) {
          continue
        }

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
    if (!state || metricSelectionOptions.length === 0) {
      return
    }

    setState((current) => {
      if (!current) return current

      let changed = false
      const [defaultMetricName, defaultMetricTypeRaw] =
        metricSelectionOptions[0].value.split("::")
      const defaultMetricType = defaultMetricTypeRaw as QueryBuilderMetricType

      const queries = current.queries.map((query) => {
        if (query.dataSource !== "metrics") {
          return query
        }

        if (query.metricName) {
          return query
        }

        if (!defaultMetricName || !defaultMetricType) {
          return query
        }

        changed = true
        return {
          ...query,
          metricName: defaultMetricName,
          metricType: defaultMetricType,
        }
      })

      return changed ? { ...current, queries } : current
    })
  }, [state, metricSelectionOptions])

  const seriesFieldOptions = React.useMemo(
    () => (state ? toSeriesFieldOptions(state) : []),
    [state],
  )

  React.useEffect(() => {
    if (!widget || !state) return
    if (widget.visualization !== "stat") return
    if (seriesFieldOptions.length === 0) return

    if (state.statValueField && seriesFieldOptions.includes(state.statValueField)) {
      return
    }

    setState((current) => {
      if (!current) return current

      if (current.statValueField && seriesFieldOptions.includes(current.statValueField)) {
        return current
      }

      return {
        ...current,
        statValueField: seriesFieldOptions[0],
      }
    })
  }, [widget, state, seriesFieldOptions])

  const previewWidget = React.useMemo(() => {
    if (!widget || !state) return null
    const previewState = stagedState ?? state
    const previewSeriesOptions = toSeriesFieldOptions(previewState)

    return {
      ...widget,
      dataSource: buildWidgetDataSource(widget, previewState, previewSeriesOptions),
      display: buildWidgetDisplay(widget, previewState),
    }
  }, [stagedState, state, widget])

  if (!widget || !state) {
    return null
  }

  const isChart = widget.visualization === "chart"
  const isStat = widget.visualization === "stat"
  const isTable = widget.visualization === "table"

  const chartStyleOptions = isChart
    ? chartRegistry.filter(
        (chart) => chart.id === "query-builder-line" || chart.id === state.chartId,
      )
    : []

  const runPreview = () => {
    const error = validateQueries(state)
    if (error) {
      setValidationError(error)
      return
    }

    setValidationError(null)
    setStagedState(cloneWidgetState(state))
  }

  const applyChanges = () => {
    const error = validateQueries(state)
    if (error) {
      setValidationError(error)
      return
    }

    setValidationError(null)

    onApply(widget.id, {
      dataSource: buildWidgetDataSource(widget, state, seriesFieldOptions),
      display: buildWidgetDisplay(widget, state),
    })

    onOpenChange(false)
  }

  const updateQuery = (
    id: string,
    updater: (query: QueryBuilderQueryDraft) => QueryBuilderQueryDraft,
  ) => {
    setState((current) => {
      if (!current) return current

      return {
        ...current,
        queries: current.queries.map((query) =>
          query.id === id ? updater(query) : query,
        ),
      }
    })
  }

  const addQuery = () => {
    setState((current) => {
      if (!current) return current

      return {
        ...current,
        queries: [...current.queries, createQueryDraft(current.queries.length)],
      }
    })
  }

  const cloneQuery = (id: string) => {
    setState((current) => {
      if (!current) return current

      const source = current.queries.find((query) => query.id === id)
      if (!source) return current

      const duplicate: QueryBuilderQueryDraft = {
        ...source,
        id: crypto.randomUUID(),
      }

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
      if (!current || current.queries.length === 1) return current

      return {
        ...current,
        queries: current.queries
          .filter((query) => query.id !== id)
          .map((query, index) => ({
            ...query,
            name: queryLabel(index),
          })),
      }
    })
  }

  const addFormula = () => {
    setState((current) => {
      if (!current) return current

      return {
        ...current,
        formulas: [
          ...current.formulas,
          createFormulaDraft(
            current.formulas.length,
            current.queries.map((query) => query.name),
          ),
        ],
      }
    })
  }

  const removeFormula = (id: string) => {
    setState((current) => {
      if (!current) return current

      return {
        ...current,
        formulas: current.formulas
          .filter((formula) => formula.id !== id)
          .map((formula, index) => ({
            ...formula,
            name: formulaLabel(index),
          })),
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[96vw] sm:max-w-5xl p-0" side="right">
        <div className="border-b px-4 py-3">
          <SheetHeader>
            <SheetTitle>Configure Widget</SheetTitle>
            <SheetDescription>
              Query and Formular builder test
            </SheetDescription>
          </SheetHeader>
        </div>

        <ScrollArea className="h-[calc(100vh-8.5rem)]">
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Live Preview</p>
              <div className="h-72">
                {previewWidget && <WidgetPreview widget={previewWidget} />}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Title
                </p>
                <Input
                  value={state.title}
                  onChange={(event) =>
                    setState((current) =>
                      current ? { ...current, title: event.target.value } : current,
                    )
                  }
                  placeholder="Widget title"
                />
              </div>

              {isChart && (
                <div className="space-y-1">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Chart Style
                  </p>
                  <Select
                    value={state.chartId}
                    onValueChange={(value) =>
                      setState((current) =>
                        current ? { ...current, chartId: value ?? current.chartId } : current,
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {chartStyleOptions.map((chart) => (
                        <SelectItem key={chart.id} value={chart.id}>
                          {chart.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Comparison
                </p>
                <Select
                  value={state.comparisonMode}
                  onValueChange={(value) =>
                    setState((current) =>
                      current
                        ? {
                            ...current,
                            comparisonMode:
                              value === "previous_period" ? "previous_period" : "none",
                          }
                        : current,
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="previous_period">Previous period</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Execution
                </p>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="query-builder-include-percent-change"
                    checked={state.includePercentChange}
                    disabled={state.comparisonMode === "none"}
                    onCheckedChange={(checked) =>
                      setState((current) =>
                        current
                          ? { ...current, includePercentChange: checked === true }
                          : current,
                      )
                    }
                  />
                  <label
                    htmlFor="query-builder-include-percent-change"
                    className="text-[11px] text-muted-foreground"
                  >
                    Include % change series
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="query-builder-debug-execution"
                    checked={state.debug}
                    onCheckedChange={(checked) =>
                      setState((current) =>
                        current ? { ...current, debug: checked === true } : current,
                      )
                    }
                  />
                  <label
                    htmlFor="query-builder-debug-execution"
                    className="text-[11px] text-muted-foreground"
                  >
                    Enable execution debug logs
                  </label>
                </div>
              </div>

              {isStat && (
                <>
                  <div className="space-y-1">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Aggregate
                    </p>
                    <Select
                      value={state.statAggregate}
                      onValueChange={(value) =>
                        setState((current) =>
                          current
                            ? {
                                ...current,
                                statAggregate: (value as StatAggregate) ?? current.statAggregate,
                              }
                            : current,
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="first">first</SelectItem>
                        <SelectItem value="sum">sum</SelectItem>
                        <SelectItem value="count">count</SelectItem>
                        <SelectItem value="avg">avg</SelectItem>
                        <SelectItem value="max">max</SelectItem>
                        <SelectItem value="min">min</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Value Field
                    </p>
                    <Select
                      value={state.statValueField || seriesFieldOptions[0]}
                      onValueChange={(value) =>
                        setState((current) =>
                          current
                            ? {
                                ...current,
                                statValueField: value ?? current.statValueField,
                              }
                            : current,
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select series" />
                      </SelectTrigger>
                      <SelectContent>
                        {seriesFieldOptions.map((field) => (
                          <SelectItem key={field} value={field}>
                            {field}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Unit
                    </p>
                    <Select
                      value={state.unit}
                      onValueChange={(value) =>
                        setState((current) =>
                          current
                            ? { ...current, unit: (value as ValueUnit) ?? current.unit }
                            : current,
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {UNIT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              {isTable && (
                <div className="space-y-1">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Row Limit (optional)
                  </p>
                  <Input
                    value={state.tableLimit}
                    onChange={(event) =>
                      setState((current) =>
                        current ? { ...current, tableLimit: event.target.value } : current,
                      )
                    }
                    placeholder="50"
                    type="number"
                    min={1}
                  />
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={addQuery}>
                Add Query
              </Button>
              <Button variant="outline" size="sm" onClick={addFormula}>
                Add Formula
              </Button>
              <Button size="sm" onClick={runPreview}>
                Run Preview
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Query aliases: {state.queries.map((query) => query.name).join(", ")}
              </span>
            </div>

            {validationError && (
              <p className="text-xs text-destructive">{validationError}</p>
            )}

            <div className="space-y-3">
              {state.queries.map((query) => {
                const aggregateOptions = AGGREGATIONS_BY_SOURCE[query.dataSource]
                const metricValue =
                  query.metricName && query.metricType
                    ? `${query.metricName}::${query.metricType}`
                    : undefined

                return (
                  <div key={query.id} className="border p-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono">
                          {query.name}
                        </Badge>
                        <div className="flex items-center gap-1.5">
                          <Checkbox
                            id={`query-enabled-${query.id}`}
                            checked={query.enabled}
                            onCheckedChange={(checked) =>
                              updateQuery(query.id, (current) => ({
                                ...current,
                                enabled: checked === true,
                              }))
                            }
                          />
                          <label
                            htmlFor={`query-enabled-${query.id}`}
                            className="text-[11px] text-muted-foreground"
                          >
                            enabled
                          </label>
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="xs" onClick={() => cloneQuery(query.id)}>
                          Clone
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => removeQuery(query.id)}
                          disabled={state.queries.length === 1}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="space-y-1">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Source
                        </p>
                        <Select
                          value={query.dataSource}
                          onValueChange={(value) =>
                            updateQuery(query.id, (current) =>
                              resetQueryForDataSource(
                                current,
                                (value as QueryBuilderDataSource) ?? current.dataSource,
                              ),
                            )
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="traces">Traces</SelectItem>
                            <SelectItem value="logs">Logs</SelectItem>
                            <SelectItem value="metrics">Metrics</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Aggregation
                        </p>
                        <Select
                          value={query.aggregation}
                          onValueChange={(value) =>
                            updateQuery(query.id, (current) => ({
                              ...current,
                              aggregation: value ?? current.aggregation,
                            }))
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {aggregateOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Every (seconds, 5m, 1h)
                        </p>
                        <Input
                          value={query.stepInterval}
                          onChange={(event) =>
                            updateQuery(query.id, (current) => ({
                              ...current,
                              stepInterval: event.target.value,
                            }))
                          }
                          placeholder="60, 5m, 1h"
                        />
                      </div>
                    </div>

                    {query.dataSource === "metrics" && (
                      <div className="space-y-1">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Metric
                        </p>
                        <Select
                          value={metricValue}
                          onValueChange={(value) => {
                            const parsed = value ? parseMetricSelection(value) : null
                            if (!parsed) return

                            updateQuery(query.id, (current) => ({
                              ...current,
                              metricName: parsed.metricName,
                              metricType: parsed.metricType,
                            }))
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select metric" />
                          </SelectTrigger>
                          <SelectContent>
                            {metricSelectionOptions.length === 0 ? (
                              <SelectItem value="__none__" disabled>
                                No metrics available
                              </SelectItem>
                            ) : (
                              metricSelectionOptions.map((metric) => (
                                <SelectItem key={metric.value} value={metric.value}>
                                  {metric.label}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Group By
                        </p>
                        <Input
                          value={query.groupBy}
                          onChange={(event) =>
                            updateQuery(query.id, (current) => ({
                              ...current,
                              groupBy: event.target.value,
                              addOns: {
                                ...current.addOns,
                                groupBy: true,
                              },
                            }))
                          }
                          placeholder="service.name | span.name | severity | none | attr.http.route"
                        />
                      </div>

                      <div className="space-y-1">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          Legend (optional)
                        </p>
                        <Input
                          value={query.legend}
                          onChange={(event) =>
                            updateQuery(query.id, (current) => ({
                              ...current,
                              legend: event.target.value,
                            }))
                          }
                          placeholder="Human-friendly series name"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Where Clause (supports key = value joined by AND)
                      </p>
                      <WhereClauseEditor
                        rows={2}
                        value={query.whereClause}
                        dataSource={query.dataSource}
                        values={autocompleteValuesBySource[query.dataSource]}
                        onChange={(nextWhereClause) =>
                          updateQuery(query.id, (current) => ({
                            ...current,
                            whereClause: nextWhereClause,
                          }))
                        }
                        placeholder='deployment.environment = "production" AND service.name = "checkout"'
                        ariaLabel={`Where clause for query ${query.name}`}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {state.formulas.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground">Formulas</p>
                {state.formulas.map((formula) => (
                  <div key={formula.id} className="border border-dashed p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="font-mono">
                        {formula.name}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => removeFormula(formula.id)}
                      >
                        Remove
                      </Button>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <Input
                        value={formula.expression}
                        onChange={(event) =>
                          setState((current) =>
                            current
                              ? {
                                  ...current,
                                  formulas: current.formulas.map((item) =>
                                    item.id === formula.id
                                      ? { ...item, expression: event.target.value }
                                      : item,
                                  ),
                                }
                              : current,
                          )
                        }
                        placeholder="A / B, (A + B) / 2, F1 * 100"
                        className="font-mono"
                      />
                      <Input
                        value={formula.legend}
                        onChange={(event) =>
                          setState((current) =>
                            current
                              ? {
                                  ...current,
                                  formulas: current.formulas.map((item) =>
                                    item.id === formula.id
                                      ? { ...item, legend: event.target.value }
                                      : item,
                                  ),
                                }
                              : current,
                          )
                        }
                        placeholder="Legend"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="border-t px-4 py-3 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={applyChanges}>
            Apply to Widget
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
