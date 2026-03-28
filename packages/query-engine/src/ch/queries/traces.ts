// ---------------------------------------------------------------------------
// Typed Traces Queries
//
// Replaces traces-sql-builder.ts with DSL-based query definitions.
// The output row types are fully inferred from the SELECT clause.
// ---------------------------------------------------------------------------

import type { TracesMetric, AttributeFilter } from "../../query-engine"
import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import { Traces, TraceListMv } from "../tables"
import { compile, str } from "../../sql/sql-fragment"

// ---------------------------------------------------------------------------
// Metric needs — which metric columns to compute
// ---------------------------------------------------------------------------

type MetricNeed = "count" | "avg_duration" | "quantiles" | "error_rate" | "apdex"

const METRIC_NEEDS: Record<TracesMetric, MetricNeed[]> = {
  count: ["count"],
  avg_duration: ["count", "avg_duration"],
  p50_duration: ["count", "quantiles"],
  p95_duration: ["count", "quantiles"],
  p99_duration: ["count", "quantiles"],
  error_rate: ["count", "error_rate"],
  apdex: ["count", "apdex"],
}

// ---------------------------------------------------------------------------
// Metric SELECT expressions
// ---------------------------------------------------------------------------

function metricSelectExprs(
  $: any,
  metric: TracesMetric,
  apdexThresholdMs: number,
  needsSampling: boolean,
) {
  const needs = new Set(METRIC_NEEDS[metric])
  const t = String(apdexThresholdMs)

  return {
    count: CH.count(),
    avgDuration: needs.has("avg_duration")
      ? CH.avg($.Duration).div(1000000)
      : CH.lit(0),
    p50Duration: needs.has("quantiles")
      ? CH.quantile(0.5)($.Duration).div(1000000)
      : CH.lit(0),
    p95Duration: needs.has("quantiles")
      ? CH.quantile(0.95)($.Duration).div(1000000)
      : CH.lit(0),
    p99Duration: needs.has("quantiles")
      ? CH.quantile(0.99)($.Duration).div(1000000)
      : CH.lit(0),
    errorRate: needs.has("error_rate")
      ? CH.rawExpr<number>(`if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0)`)
      : CH.lit(0),
    satisfiedCount: needs.has("apdex")
      ? CH.rawExpr<number>(`countIf(Duration / 1000000 < ${t})`)
      : CH.lit(0),
    toleratingCount: needs.has("apdex")
      ? CH.rawExpr<number>(`countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4)`)
      : CH.lit(0),
    apdexScore: needs.has("apdex")
      ? CH.rawExpr<number>(`if(count() > 0, round((countIf(Duration / 1000000 < ${t}) + countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) * 0.5) / count(), 4), 0)`)
      : CH.lit(0),
    sampledSpanCount: needsSampling
      ? CH.rawExpr<number>("countIf(TraceState LIKE '%th:%')")
      : CH.lit(0),
    unsampledSpanCount: needsSampling
      ? CH.rawExpr<number>("countIf(TraceState = '' OR TraceState NOT LIKE '%th:%')")
      : CH.lit(0),
    dominantThreshold: needsSampling
      ? CH.rawExpr<string>("anyIf(extract(TraceState, 'th:([0-9a-f]+)'), TraceState LIKE '%th:%')")
      : CH.rawExpr<string>("''"),
  }
}

function breakdownMetricSelectExprs(
  $: any,
  metric: TracesMetric,
  apdexThresholdMs: number,
) {
  const needs = new Set(METRIC_NEEDS[metric])
  const t = String(apdexThresholdMs)

  return {
    count: CH.count(),
    avgDuration: needs.has("avg_duration")
      ? CH.avg($.Duration).div(1000000)
      : CH.lit(0),
    p50Duration: needs.has("quantiles")
      ? CH.quantile(0.5)($.Duration).div(1000000)
      : CH.lit(0),
    p95Duration: needs.has("quantiles")
      ? CH.quantile(0.95)($.Duration).div(1000000)
      : CH.lit(0),
    p99Duration: needs.has("quantiles")
      ? CH.quantile(0.99)($.Duration).div(1000000)
      : CH.lit(0),
    errorRate: needs.has("error_rate")
      ? CH.rawExpr<number>(`if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0)`)
      : CH.lit(0),
    satisfiedCount: needs.has("apdex")
      ? CH.rawExpr<number>(`countIf(Duration / 1000000 < ${t})`)
      : CH.lit(0),
    toleratingCount: needs.has("apdex")
      ? CH.rawExpr<number>(`countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4)`)
      : CH.lit(0),
    apdexScore: needs.has("apdex")
      ? CH.rawExpr<number>(`if(count() > 0, round((countIf(Duration / 1000000 < ${t}) + countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) * 0.5) / count(), 4), 0)`)
      : CH.lit(0),
  }
}

// ---------------------------------------------------------------------------
// trace_list_mv optimization
// ---------------------------------------------------------------------------

const TRACE_LIST_MV_ATTR_MAP: Record<string, string> = {
  "http.method": "HttpMethod",
  "http.request.method": "HttpMethod",
  "http.route": "HttpRoute",
  "url.path": "HttpRoute",
  "http.target": "HttpRoute",
  "http.status_code": "HttpStatusCode",
  "http.response.status_code": "HttpStatusCode",
}

const TRACE_LIST_MV_RESOURCE_MAP: Record<string, string> = {
  "deployment.environment": "DeploymentEnv",
}

const NUMERIC_MV_COLUMNS = new Set(["HttpStatusCode"])

function canUseTraceListMv(opts: {
  rootOnly?: boolean
  attributeFilters?: readonly AttributeFilter[]
  resourceAttributeFilters?: readonly AttributeFilter[]
  commitShas?: readonly string[]
  groupBy?: readonly string[]
  groupByAttributeKeys?: readonly string[]
  groupByAttributeKey?: string
}): boolean {
  if (!opts.rootOnly) return false
  if (opts.commitShas?.length) return false
  if (opts.attributeFilters) {
    for (const af of opts.attributeFilters) {
      if (!TRACE_LIST_MV_ATTR_MAP[af.key]) return false
    }
  }
  if (opts.resourceAttributeFilters) {
    for (const rf of opts.resourceAttributeFilters) {
      if (!TRACE_LIST_MV_RESOURCE_MAP[rf.key]) return false
    }
  }
  const groupByArray = opts.groupBy ?? []
  if (groupByArray.includes("attribute")) {
    const attrKeys = opts.groupByAttributeKeys ??
      (opts.groupByAttributeKey ? [opts.groupByAttributeKey] : [])
    for (const key of attrKeys) {
      if (!TRACE_LIST_MV_ATTR_MAP[key]) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// GROUP BY expression builder
// ---------------------------------------------------------------------------

function buildGroupNameExpr(
  _$: any,
  groupBy: readonly string[] | undefined,
  groupByAttributeKeys: readonly string[] | undefined,
  useTraceListMv: boolean,
): CH.Expr<string> {
  if (!groupBy || groupBy.length === 0) {
    return CH.lit("all")
  }

  const parts: string[] = []
  for (const g of groupBy) {
    switch (g) {
      case "service":
        parts.push("toString(ServiceName)")
        break
      case "span_name":
        parts.push("toString(SpanName)")
        break
      case "status_code":
        parts.push("toString(StatusCode)")
        break
      case "http_method":
        if (useTraceListMv) {
          parts.push("toString(HttpMethod)")
        } else {
          parts.push("toString(SpanAttributes['http.method'])")
        }
        break
      case "attribute":
        if (groupByAttributeKeys?.length) {
          const keys = groupByAttributeKeys.map((k) => {
            const mvCol = useTraceListMv ? TRACE_LIST_MV_ATTR_MAP[k] : undefined
            return mvCol ? `toString(${mvCol})` : `toString(SpanAttributes[${compile(str(k))}])`
          })
          parts.push(`arrayStringConcat([${keys.join(", ")}], ' \u00b7 ')`)
        }
        break
      case "none":
        break
    }
  }

  if (parts.length === 0) {
    return CH.lit("all")
  }

  if (parts.length === 1) {
    return CH.rawExpr<string>(`coalesce(nullIf(${parts[0]}, ''), 'all')`)
  }

  return CH.rawExpr<string>(
    `coalesce(nullIf(arrayStringConcat(arrayFilter(x -> x != '', [${parts.join(", ")}]), ' \u00b7 '), ''), 'all')`,
  )
}

function buildBreakdownGroupExpr(
  groupBy: string,
  groupByAttributeKey: string | undefined,
): CH.Expr<string> {
  switch (groupBy) {
    case "service":
      return CH.rawExpr<string>("ServiceName")
    case "span_name":
      return CH.rawExpr<string>("SpanName")
    case "status_code":
      return CH.rawExpr<string>("StatusCode")
    case "http_method":
      return CH.rawExpr<string>("SpanAttributes['http.method']")
    case "attribute":
      return groupByAttributeKey
        ? CH.rawExpr<string>(`SpanAttributes[${compile(str(groupByAttributeKey))}]`)
        : CH.rawExpr<string>("ServiceName")
    default:
      return CH.rawExpr<string>("ServiceName")
  }
}

// ---------------------------------------------------------------------------
// WHERE clause builders
// ---------------------------------------------------------------------------

function buildAttrFilterCondition(
  af: AttributeFilter,
  useMv: boolean,
  mapName: "SpanAttributes" | "ResourceAttributes",
  mvMap: Record<string, string>,
): CH.Condition {
  const mvColumn = useMv ? mvMap[af.key] : undefined
  const escapedKey = compile(str(af.key))
  const escapedValue = compile(str(af.value ?? ""))

  if (af.mode === "exists") {
    return mvColumn
      ? CH.rawCond(`${mvColumn} != ''`)
      : CH.rawCond(`mapContains(${mapName}, ${escapedKey})`)
  }

  if (af.mode === "contains") {
    const col = mvColumn ?? `${mapName}[${escapedKey}]`
    return CH.rawCond(`positionCaseInsensitive(${col}, ${escapedValue}) > 0`)
  }

  const MODE_TO_OP: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" }
  const op = MODE_TO_OP[af.mode]
  if (op) {
    if (mvColumn) {
      const cast = NUMERIC_MV_COLUMNS.has(mvColumn) ? `toUInt16OrZero(${mvColumn})` : mvColumn
      return CH.rawCond(`${cast} ${op} ${escapedValue}`)
    }
    const rawEscaped = af.value?.replace(/\\/g, "\\\\").replace(/'/g, "\\'") ?? ""
    return CH.rawCond(`toFloat64OrZero(${mapName}[${escapedKey}]) ${op} ${rawEscaped}`)
  }

  // equals (default)
  if (mvColumn) {
    return CH.rawCond(`${mvColumn} = ${escapedValue}`)
  }
  return CH.rawCond(`${mapName}[${escapedKey}] = ${escapedValue}`)
}

function buildWhereConditions(
  $: any,
  opts: TracesQueryOpts,
  useTraceListMv: boolean,
): Array<CH.Condition | undefined> {
  const conditions: Array<CH.Condition | undefined> = [
    $.OrgId.eq(param.string("orgId")),
    $.Timestamp.gte(param.dateTime("startTime")),
    $.Timestamp.lte(param.dateTime("endTime")),
    CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
    CH.when(opts.spanName, (v: string) => $.SpanName.eq(v)),
    CH.whenTrue(!!opts.rootOnly && !useTraceListMv, () => CH.rawCond("ParentSpanId = ''")),
  ]

  if (opts.errorsOnly) {
    if (useTraceListMv) {
      conditions.push(CH.rawCond("HasError = 1"))
    } else {
      conditions.push(CH.rawCond("StatusCode = 'Error'"))
    }
  }

  if (opts.environments?.length) {
    if (useTraceListMv) {
      conditions.push(CH.inList(CH.rawExpr<string>("DeploymentEnv"), opts.environments))
    } else {
      conditions.push(CH.inList(CH.rawExpr<string>("ResourceAttributes['deployment.environment']"), opts.environments))
    }
  }

  if (opts.commitShas?.length) {
    conditions.push(CH.inList(CH.rawExpr<string>("ResourceAttributes['deployment.commit_sha']"), opts.commitShas))
  }

  if (opts.attributeFilters) {
    for (const af of opts.attributeFilters) {
      conditions.push(buildAttrFilterCondition(af, useTraceListMv, "SpanAttributes", TRACE_LIST_MV_ATTR_MAP))
    }
  }

  if (opts.resourceAttributeFilters) {
    for (const rf of opts.resourceAttributeFilters) {
      conditions.push(buildAttrFilterCondition(rf, useTraceListMv, "ResourceAttributes", TRACE_LIST_MV_RESOURCE_MAP))
    }
  }

  return conditions
}

// ---------------------------------------------------------------------------
// Shared options interface
// ---------------------------------------------------------------------------

interface TracesQueryOpts {
  serviceName?: string
  spanName?: string
  rootOnly?: boolean
  errorsOnly?: boolean
  environments?: readonly string[]
  commitShas?: readonly string[]
  attributeFilters?: readonly AttributeFilter[]
  resourceAttributeFilters?: readonly AttributeFilter[]
}

// ---------------------------------------------------------------------------
// Timeseries query
// ---------------------------------------------------------------------------

export interface TracesTimeseriesOpts extends TracesQueryOpts {
  metric: TracesMetric
  needsSampling: boolean
  groupBy?: readonly string[]
  groupByAttributeKeys?: readonly string[]
  apdexThresholdMs?: number
}

/** Output row type — inferred from the SELECT clause */
export interface TracesTimeseriesOutput {
  readonly bucket: string
  readonly groupName: string
  readonly count: number
  readonly avgDuration: number
  readonly p50Duration: number
  readonly p95Duration: number
  readonly p99Duration: number
  readonly errorRate: number
  readonly satisfiedCount: number
  readonly toleratingCount: number
  readonly apdexScore: number
  readonly sampledSpanCount: number
  readonly unsampledSpanCount: number
  readonly dominantThreshold: string
}

export function tracesTimeseriesQuery(
  opts: TracesTimeseriesOpts,
): CHQuery<any, TracesTimeseriesOutput, { orgId: string; startTime: string; endTime: string; bucketSeconds: number }> {
  const apdexThresholdMs = opts.apdexThresholdMs ?? 500
  const useTraceListMv = canUseTraceListMv(opts)
  // TraceListMv and Traces have different column sets but we access only shared
  // columns via the proxy — the Cols type param is erased via `as any` return.
  const tbl = useTraceListMv ? TraceListMv : Traces

  return from(tbl as typeof Traces)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      groupName: buildGroupNameExpr($, opts.groupBy, opts.groupByAttributeKeys, useTraceListMv),
      ...metricSelectExprs($, opts.metric, apdexThresholdMs, opts.needsSampling),
    }))
    .where(($) => buildWhereConditions($, opts, useTraceListMv))
    .groupBy("bucket", "groupName")
    .orderBy(["bucket", "asc"], ["groupName", "asc"])
    .format("JSON") as any
}

// ---------------------------------------------------------------------------
// Breakdown query
// ---------------------------------------------------------------------------

export interface TracesBreakdownOpts extends TracesQueryOpts {
  metric: TracesMetric
  groupBy: string
  groupByAttributeKey?: string
  limit?: number
  apdexThresholdMs?: number
}

export interface TracesBreakdownOutput {
  readonly name: string
  readonly count: number
  readonly avgDuration: number
  readonly p50Duration: number
  readonly p95Duration: number
  readonly p99Duration: number
  readonly errorRate: number
  readonly satisfiedCount: number
  readonly toleratingCount: number
  readonly apdexScore: number
}

export function tracesBreakdownQuery(
  opts: TracesBreakdownOpts,
): CHQuery<any, TracesBreakdownOutput, { orgId: string; startTime: string; endTime: string }> {
  const apdexThresholdMs = opts.apdexThresholdMs ?? 500
  const limit = opts.limit ?? 10
  const useTraceListMv = canUseTraceListMv({
    ...opts,
    groupBy: [opts.groupBy],
    groupByAttributeKeys: opts.groupByAttributeKey ? [opts.groupByAttributeKey] : undefined,
  })
  const tbl = useTraceListMv ? TraceListMv : Traces

  return from(tbl as typeof Traces)
    .select(($) => ({
      name: buildBreakdownGroupExpr(opts.groupBy, opts.groupByAttributeKey),
      ...breakdownMetricSelectExprs($, opts.metric, apdexThresholdMs),
    }))
    .where(($) => buildWhereConditions($, opts, useTraceListMv))
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(limit)
    .format("JSON") as any
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export interface TracesListOpts extends TracesQueryOpts {
  limit?: number
}

export interface TracesListOutput {
  readonly traceId: string
  readonly timestamp: string
  readonly spanId: string
  readonly serviceName: string
  readonly spanName: string
  readonly durationMs: number
  readonly statusCode: string
  readonly spanKind: string
  readonly hasError: number
  readonly spanAttributes: Record<string, string>
  readonly resourceAttributes: Record<string, string>
}

export function tracesListQuery(
  opts: TracesListOpts,
): CHQuery<any, TracesListOutput, { orgId: string; startTime: string; endTime: string }> {
  const limit = opts.limit ?? 100

  // List queries always use the raw traces table for full attributes
  return from(Traces)
    .select(($) => ({
      traceId: $.TraceId,
      timestamp: $.Timestamp,
      spanId: $.SpanId,
      serviceName: $.ServiceName,
      spanName: $.SpanName,
      durationMs: CH.rawExpr<number>("Duration / 1000000"),
      statusCode: $.StatusCode,
      spanKind: $.SpanKind,
      hasError: CH.rawExpr<number>("if(StatusCode = 'Error', 1, 0)"),
      spanAttributes: $.SpanAttributes,
      resourceAttributes: $.ResourceAttributes,
    }))
    .where(($) => buildWhereConditions($, opts, false))
    .orderBy(["timestamp", "desc"])
    .limit(limit)
    .format("JSON") as any
}

// Re-export canUseTraceListMv for QueryEngineService
export { canUseTraceListMv }
