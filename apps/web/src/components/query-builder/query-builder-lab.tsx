import * as React from "react"
import { Result, useAtomValue } from "@effect-atom/atom-react"
import { PulseIcon, XmarkIcon, PlusIcon, MagnifierIcon } from "@/components/icons"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { WhereClauseEditor } from "@/components/query-builder/where-clause-editor"
import {
  getLogsFacetsResultAtom,
  getQueryBuilderTimeseriesResultAtom,
  getTracesFacetsResultAtom,
  listMetricsResultAtom,
} from "@/lib/services/atoms/tinybird-query-atoms"
import {
  type FormulaDraft,
  type TimeseriesPoint,
} from "@/components/query-builder/formula-results"
import { type QueryBuilderTimeseriesInput } from "@/api/tinybird/query-builder-timeseries"
import {
  AGGREGATIONS_BY_SOURCE,
  createFormulaDraft,
  createQueryDraft,
  formulaLabel,
  QUERY_BUILDER_METRIC_TYPES,
  queryLabel,
  resetQueryForDataSource as resetQueryForDataSourceModel,
  type QueryBuilderDataSource,
  type QueryBuilderMetricType,
  type QueryBuilderQueryDraft,
} from "@/lib/query-builder/model"

type DataSource = QueryBuilderDataSource
type QueryDraft = QueryBuilderQueryDraft
type MetricType = QueryBuilderMetricType
type AddOnKey = keyof QueryDraft["addOns"]

interface MetricOption {
  value: string
  label: string
  metricName: string
  metricType: MetricType
}

interface QueryBuilderLabProps {
  startTime: string
  endTime: string
}

const DATA_SOURCES: Array<{ label: string; value: DataSource }> = [
  { label: "Traces", value: "traces" },
  { label: "Logs", value: "logs" },
  { label: "Metrics", value: "metrics" },
]

const SIGNAL_SOURCES: Array<{ label: string; value: "default" | "meter" }> = [
  { label: "Default", value: "default" },
  { label: "Meter", value: "meter" },
]

const ADD_ONS: Array<{ key: AddOnKey; label: string }> = [
  { key: "groupBy", label: "Group By" },
  { key: "having", label: "Having" },
  { key: "orderBy", label: "Order By" },
  { key: "limit", label: "Limit" },
  { key: "legend", label: "Legend" },
]

function createQuery(index: number): QueryDraft {
  return createQueryDraft(index)
}

function createFormula(index: number, queryNames: string[]): FormulaDraft {
  return createFormulaDraft(index, queryNames)
}

function applyDataSourcePreset(
  query: QueryDraft,
  dataSource: DataSource,
): QueryDraft {
  return resetQueryForDataSourceModel(query, dataSource)
}

function parseMetricSelection(raw: string): { metricName: string; metricType: MetricType } | null {
  const [metricName, metricType] = raw.split("::")
  if (!metricName || !metricType) {
    return null
  }

  if (!QUERY_BUILDER_METRIC_TYPES.includes(metricType as MetricType)) {
    return null
  }

  return {
    metricName,
    metricType: metricType as MetricType,
  }
}

function toRunPoints(
  rows: Array<Record<string, string | number>>,
): TimeseriesPoint[] {
  return rows.map((row) => {
    const series: Record<string, number> = {}
    for (const [key, value] of Object.entries(row)) {
      if (key === "bucket") {
        continue
      }

      const numeric = typeof value === "number" ? value : Number(value)
      if (Number.isFinite(numeric)) {
        series[key] = numeric
      }
    }

    return {
      bucket: String(row.bucket ?? ""),
      series,
    }
  })
}

function debugWarnings(debug: unknown): string[] {
  if (!debug || typeof debug !== "object") {
    return []
  }

  const debugObj = debug as {
    queries?: Array<{ queryName?: string; fallbackUsed?: boolean }>
  }

  const warnings: string[] = []
  for (const entry of debugObj.queries ?? []) {
    if (entry.fallbackUsed) {
      warnings.push(`${entry.queryName ?? "query"} used fallback range`)
    }
  }

  return warnings
}

function QueryBuilderAtomResults({
  input,
}: {
  input: QueryBuilderTimeseriesInput
}) {
  const result = useAtomValue(
    getQueryBuilderTimeseriesResultAtom({ data: input }),
  )

  return (
    <>
      {Result.builder(result)
        .onInitial(() => (
          <p className="text-xs text-muted-foreground">Running query...</p>
        ))
        .onError((error) => (
          <div className="space-y-2 border p-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono">
                Combined result
              </Badge>
              <Badge variant="destructive">error</Badge>
              <span className="text-[11px] text-muted-foreground">query_engine</span>
            </div>
            <p className="text-[11px] text-destructive">{error.message}</p>
          </div>
        ))
        .onSuccess((response) => {
          const data = toRunPoints(response.data)
          const warnings = debugWarnings(response.debug)
          const seriesKeys = Array.from(
            new Set(data.flatMap((point) => Object.keys(point.series))),
          ).slice(0, 6)

          return (
            <div className="space-y-2 border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono">
                  Combined result
                </Badge>
                <Badge variant="secondary">success</Badge>
                <span className="text-[11px] text-muted-foreground">query_engine</span>
                <span className="text-[11px] text-muted-foreground">
                  {data.length} buckets
                </span>
              </div>

              {warnings.length > 0 && (
                <div className="space-y-1">
                  {warnings.map((warning, index) => (
                    <p key={`w-${index}`} className="text-[11px] text-muted-foreground">
                      - {warning}
                    </p>
                  ))}
                </div>
              )}

              {data.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>bucket</TableHead>
                      {seriesKeys.map((key) => (
                        <TableHead key={key}>{key}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.slice(0, 12).map((point) => (
                      <TableRow key={point.bucket}>
                        <TableCell className="font-mono text-[11px]">
                          {point.bucket}
                        </TableCell>
                        {seriesKeys.map((key) => (
                          <TableCell key={`${point.bucket}-${key}`} className="font-mono text-[11px]">
                            {point.series[key] ?? 0}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )
        })}
    </>
  )
}

export function QueryBuilderLab({
  startTime,
  endTime,
}: QueryBuilderLabProps) {
  const [queries, setQueries] = React.useState<QueryDraft[]>([
    createQuery(0),
    createQuery(1),
  ])
  const [formulas, setFormulas] = React.useState<FormulaDraft[]>([
    createFormula(0, ["A", "B"]),
  ])
  const [lastRunAt, setLastRunAt] = React.useState<string | null>(null)
  const [submittedInput, setSubmittedInput] = React.useState<QueryBuilderTimeseriesInput | null>(null)
  const [noQueriesError, setNoQueriesError] = React.useState<string | null>(null)

  const queryNames = React.useMemo(
    () => queries.map((query) => query.name),
    [queries],
  )

  const metricsResult = useAtomValue(
    listMetricsResultAtom({
      data: {
        limit: 300,
      },
    }),
  )

  const tracesFacetsResult = useAtomValue(
    getTracesFacetsResultAtom({
      data: {
        startTime,
        endTime,
      },
    }),
  )

  const logsFacetsResult = useAtomValue(
    getLogsFacetsResultAtom({
      data: {
        startTime,
        endTime,
      },
    }),
  )

  const metricRows = React.useMemo(
    () =>
      Result.builder(metricsResult)
        .onSuccess((response) => response.data)
        .orElse(() => []),
    [metricsResult],
  )

  const metricOptions = React.useMemo<MetricOption[]>(() => {
    const map = new Map<string, MetricOption>()

    for (const row of metricRows) {
      if (!QUERY_BUILDER_METRIC_TYPES.includes(row.metricType as MetricType)) {
        continue
      }

      const metricType = row.metricType as MetricType
      const value = `${row.metricName}::${metricType}`

      if (!map.has(value)) {
        map.set(value, {
          value,
          label: `${row.metricName} (${metricType})`,
          metricName: row.metricName,
          metricType,
        })
      }
    }

    return [...map.values()]
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
    const firstMetric = metricOptions[0]
    if (!firstMetric) {
      return
    }

    setQueries((previous) =>
      previous.map((query) => {
        if (query.dataSource !== "metrics") {
          return query
        }

        if (query.metricName) {
          return query
        }

        return {
          ...query,
          metricName: firstMetric.metricName,
          metricType: firstMetric.metricType,
        }
      }),
    )
  }, [metricOptions])

  const updateQuery = React.useCallback(
    (id: string, updater: (query: QueryDraft) => QueryDraft) => {
      setQueries((previous) =>
        previous.map((query) => (query.id === id ? updater(query) : query)),
      )
    },
    [],
  )

  const addQuery = React.useCallback(() => {
    setQueries((previous) => {
      const nextQuery = createQuery(previous.length)
      return [...previous, nextQuery]
    })
  }, [])

  const cloneQuery = React.useCallback((id: string) => {
    setQueries((previous) => {
      const source = previous.find((query) => query.id === id)
      if (!source) {
        return previous
      }

      const duplicate: QueryDraft = {
        ...source,
        id: crypto.randomUUID(),
      }

      const next = [...previous, duplicate]
      return next.map((query, index) => ({
        ...query,
        name: queryLabel(index),
      }))
    })
  }, [])

  const removeQuery = React.useCallback((id: string) => {
    setQueries((previous) => {
      if (previous.length === 1) {
        return previous
      }

      const next = previous.filter((query) => query.id !== id)
      return next.map((query, index) => ({
        ...query,
        name: queryLabel(index),
      }))
    })
  }, [])

  const addFormula = React.useCallback(() => {
    setFormulas((previous) => [
      ...previous,
      createFormula(previous.length, queryNames),
    ])
  }, [queryNames])

  const removeFormula = React.useCallback((id: string) => {
    setFormulas((previous) =>
      previous
        .filter((formula) => formula.id !== id)
        .map((formula, index) => ({
          ...formula,
          name: formulaLabel(index),
        })),
    )
  }, [])

  const runQueries = React.useCallback(() => {
    const enabledQueries = queries.filter((query) => query.enabled)

    if (enabledQueries.length === 0) {
      setNoQueriesError("No enabled queries to run")
      setSubmittedInput(null)
      return
    }

    setNoQueriesError(null)
    setSubmittedInput({ startTime, endTime, queries, formulas, debug: true })
    setLastRunAt(new Date().toLocaleTimeString())
  }, [endTime, formulas, queries, startTime])

  return (
    <Card className="py-0">
      <CardHeader className="border-b py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <PulseIcon size={16} />
           Query Builder MVP
        </CardTitle>
        <CardDescription>
          Executes enabled queries against Maple Query Engine and returns real
          Tinybird-backed timeseries data.
        </CardDescription>
      </CardHeader>

      <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-b border-t bg-card">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={addQuery}>
            <PlusIcon size={14} />
            Add Query
          </Button>
          <Button variant="outline" size="sm" onClick={addFormula}>
            <PlusIcon size={14} />
            Add Formula
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {startTime}{" -> "}{endTime}
          </span>
          {lastRunAt && (
            <span className="text-[11px] text-muted-foreground">
              last run: {lastRunAt}
            </span>
          )}
          <Button size="sm" onClick={runQueries}>
            <MagnifierIcon size={14} />
            Run Query
          </Button>
        </div>
      </CardFooter>

      <ScrollArea className="h-[min(72vh,52rem)]">
        <CardContent className="space-y-3 p-3">
          <Card size="sm" className="gap-2">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs">Execution Results</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {noQueriesError ? (
                <div className="space-y-2 border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono">-</Badge>
                    <Badge variant="destructive">error</Badge>
                    <span className="text-[11px] text-muted-foreground">query_engine</span>
                  </div>
                  <p className="text-[11px] text-destructive">{noQueriesError}</p>
                </div>
              ) : submittedInput ? (
                <QueryBuilderAtomResults input={submittedInput} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Run query to fetch Tinybird data.
                </p>
              )}
            </CardContent>
          </Card>

          <div className="space-y-2">
            {queries.map((query) => {
              const aggregateOptions = AGGREGATIONS_BY_SOURCE[query.dataSource]
              const metricValue =
                query.metricName && query.metricType
                  ? `${query.metricName}::${query.metricType}`
                  : undefined

              return (
                <div key={query.id} className="grid grid-cols-[44px_1fr] gap-2">
                  <Badge
                    variant="outline"
                    className="h-7 w-11 justify-center self-start font-mono text-[11px]"
                  >
                    {query.name}
                  </Badge>

                  <Card size="sm" className={query.enabled ? "" : "opacity-60"}>
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            Query {query.name}
                          </span>
                          <Select
                            value={query.dataSource}
                            onValueChange={(value) =>
                              updateQuery(query.id, (current) =>
                                applyDataSourcePreset(
                                  current,
                                  (value as DataSource) ?? current.dataSource,
                                ),
                              )
                            }
                          >
                            <SelectTrigger className="w-[120px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {DATA_SOURCES.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="flex items-center gap-1">
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
                            <Label
                              htmlFor={`query-enabled-${query.id}`}
                              className="text-[11px] text-muted-foreground"
                            >
                              enabled
                            </Label>
                          </div>

                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => cloneQuery(query.id)}
                          >
                            Clone
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => removeQuery(query.id)}
                          >
                            <XmarkIcon size={14} />
                            Remove
                          </Button>
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent>
                      <div className="space-y-2 border-l border-dashed pl-3">
                        {query.dataSource === "metrics" && (
                          <div className="grid gap-2 md:grid-cols-2">
                            <div className="space-y-1">
                              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Metric
                              </p>
                              <Select
                                value={metricValue}
                                onValueChange={(value) => {
                                  const parsed = value
                                    ? parseMetricSelection(value)
                                    : null
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
                                  {metricOptions.length === 0 ? (
                                    <SelectItem value="__none__" disabled>
                                      No metrics available
                                    </SelectItem>
                                  ) : (
                                    metricOptions.map((metric) => (
                                      <SelectItem
                                        key={metric.value}
                                        value={metric.value}
                                      >
                                        {metric.label}
                                      </SelectItem>
                                    ))
                                  )}
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-1">
                              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Signal Source
                              </p>
                              <Select
                                value={query.signalSource}
                                onValueChange={(value) =>
                                  updateQuery(query.id, (current) => ({
                                    ...current,
                                    signalSource:
                                      (value as "default" | "meter") ??
                                      current.signalSource,
                                  }))
                                }
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue placeholder="Default" />
                                </SelectTrigger>
                                <SelectContent>
                                  {SIGNAL_SOURCES.map((option) => (
                                    <SelectItem
                                      key={option.label}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                        )}

                        <div className="space-y-1">
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Where Clause (MVP supports key = value joined by AND)
                          </p>
                          <div className="relative">
                            <MagnifierIcon
                              size={12}
                              className="pointer-events-none absolute left-2 top-2.5 text-muted-foreground"
                            />
                            <WhereClauseEditor
                              rows={2}
                              textareaClassName="pl-7"
                              value={query.whereClause}
                              dataSource={query.dataSource}
                              values={autocompleteValuesBySource[query.dataSource]}
                              onChange={(nextWhereClause) =>
                                updateQuery(query.id, (current) => ({
                                  ...current,
                                  whereClause: nextWhereClause,
                                }))
                              }
                              placeholder='Leave empty for all services. Example: deployment.environment = "production"'
                              ariaLabel={`Where clause for query ${query.name}`}
                            />
                          </div>
                        </div>

                        <div className="grid gap-2 md:grid-cols-[1.1fr_1fr]">
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
                              placeholder="Auto (e.g. 60, 5m, 1h)"
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Add-ons
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {ADD_ONS.map((addOn) => {
                              const isActive = query.addOns[addOn.key]

                              return (
                                <Button
                                  key={addOn.key}
                                  variant={isActive ? "secondary" : "outline"}
                                  size="xs"
                                  onClick={() =>
                                    updateQuery(query.id, (current) => ({
                                      ...current,
                                      addOns: {
                                        ...current.addOns,
                                        [addOn.key]: !current.addOns[addOn.key],
                                      },
                                    }))
                                  }
                                >
                                  {addOn.label}
                                </Button>
                              )
                            })}
                          </div>
                        </div>

                        {query.addOns.groupBy && (
                          <div className="space-y-1">
                            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Group By
                            </Label>
                            <Input
                              value={query.groupBy}
                              onChange={(event) =>
                                updateQuery(query.id, (current) => ({
                                  ...current,
                                  groupBy: event.target.value,
                                }))
                              }
                              placeholder="service.name | span.name | severity | none | attr.http.route"
                            />
                          </div>
                        )}

                        {query.addOns.having && (
                          <div className="space-y-1">
                            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Having (UI-only)
                            </Label>
                            <Input
                              value={query.having}
                              onChange={(event) =>
                                updateQuery(query.id, (current) => ({
                                  ...current,
                                  having: event.target.value,
                                }))
                              }
                              placeholder='count() > 10'
                            />
                          </div>
                        )}

                        {query.addOns.orderBy && (
                          <div className="grid gap-2 md:grid-cols-[1fr_1fr]">
                            <div className="space-y-1">
                              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Order By (UI-only)
                              </Label>
                              <Input
                                value={query.orderBy}
                                onChange={(event) =>
                                  updateQuery(query.id, (current) => ({
                                    ...current,
                                    orderBy: event.target.value,
                                  }))
                                }
                                placeholder="p95(duration)"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Direction
                              </Label>
                              <Select
                                value={query.orderByDirection}
                                onValueChange={(value) =>
                                  updateQuery(query.id, (current) => ({
                                    ...current,
                                    orderByDirection:
                                      (value as "desc" | "asc") ??
                                      current.orderByDirection,
                                  }))
                                }
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="desc">desc</SelectItem>
                                  <SelectItem value="asc">asc</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                        )}

                        {query.addOns.limit && (
                          <div className="space-y-1">
                            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Limit (UI-only)
                            </Label>
                            <Input
                              value={query.limit}
                              onChange={(event) =>
                                updateQuery(query.id, (current) => ({
                                  ...current,
                                  limit: event.target.value,
                                }))
                              }
                              placeholder="10"
                              type="number"
                            />
                          </div>
                        )}

                        {query.addOns.legend && (
                          <div className="space-y-1">
                            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              Legend Format (UI-only)
                            </Label>
                            <Input
                              value={query.legend}
                              onChange={(event) =>
                                updateQuery(query.id, (current) => ({
                                  ...current,
                                  legend: event.target.value,
                                }))
                              }
                              placeholder="{{service.name}} - {{status.code}}"
                            />
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )
            })}

            {formulas.map((formula) => (
              <div key={formula.id} className="grid grid-cols-[44px_1fr] gap-2">
                <Badge
                  variant="outline"
                  className="h-7 w-11 justify-center self-start font-mono text-[11px]"
                >
                  {formula.name}
                </Badge>
                <Card size="sm" className="border-dashed">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        Formula {formula.name} (executed after query runs)
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => removeFormula(formula.id)}
                      >
                        <XmarkIcon size={14} />
                        Remove
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-2 md:grid-cols-[1.3fr_1fr]">
                      <Input
                        value={formula.expression}
                        onChange={(event) =>
                          setFormulas((previous) =>
                            previous.map((item) =>
                              item.id === formula.id
                                ? { ...item, expression: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder="A / B, (A + B) / 2, F1 * 100"
                        className="font-mono"
                      />
                      <Input
                        value={formula.legend}
                        onChange={(event) =>
                          setFormulas((previous) =>
                            previous.map((item) =>
                              item.id === formula.id
                                ? { ...item, legend: event.target.value }
                                : item,
                            ),
                          )
                        }
                        placeholder="Legend"
                      />
                    </div>
                  </CardContent>
                </Card>
              </div>
            ))}
          </div>

          <Separator />

          <div>
            <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              UI State Preview
            </p>
            <pre className="max-h-72 overflow-auto rounded-none border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(
                {
                  startTime,
                  endTime,
                  queries,
                  formulas,
                  submittedInput,
                },
                null,
                2,
              )}
            </pre>
          </div>
        </CardContent>
      </ScrollArea>
    </Card>
  )
}
