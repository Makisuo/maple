// ---------------------------------------------------------------------------
// Typed Traces Queries
//
// DSL-based query definitions for traces timeseries, breakdown, and list.
// ---------------------------------------------------------------------------

import type { TracesMetric, AttributeFilter } from "../../query-engine"
import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import { Traces, TraceListMv } from "../tables"
import { compile, str } from "../../sql/sql-fragment"
import {
  METRIC_NEEDS,
  TRACE_LIST_MV_ATTR_MAP,
  TRACE_LIST_MV_RESOURCE_MAP,
  canUseTraceListMv,
  buildAttrFilterSQL,
} from "../../traces-shared"

// ---------------------------------------------------------------------------
// Metric SELECT expressions
// ---------------------------------------------------------------------------

function metricSelectExprs(
  $: any,
  metric: TracesMetric,
  apdexThresholdMs: number,
  needsSampling: boolean,
  allMetrics?: boolean,
) {
  const needs = allMetrics
    ? new Set<string>(["count", "avg_duration", "quantiles", "error_rate", "apdex"])
    : new Set(METRIC_NEEDS[metric])
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

// trace_list_mv constants + canUseTraceListMv imported from traces-shared.ts

// ---------------------------------------------------------------------------
// GROUP BY expression builder
// ---------------------------------------------------------------------------

function buildGroupNameExpr(
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
  return CH.rawCond(buildAttrFilterSQL(af, useMv, mapName, mvMap))
}

function buildWhereConditions(
  $: any,
  opts: TracesQueryOpts,
  useTraceListMv: boolean,
): Array<CH.Condition | undefined> {
  const mm = opts.matchModes
  const conditions: Array<CH.Condition | undefined> = [
    $.OrgId.eq(param.string("orgId")),
    $.Timestamp.gte(param.dateTime("startTime")),
    $.Timestamp.lte(param.dateTime("endTime")),
    CH.when(opts.serviceName, (v: string) =>
      mm?.serviceName === "contains"
        ? CH.rawCond(`positionCaseInsensitive(ServiceName, ${compile(str(v))}) > 0`)
        : $.ServiceName.eq(v),
    ),
    CH.when(opts.spanName, (v: string) =>
      mm?.spanName === "contains"
        ? CH.rawCond(`positionCaseInsensitive(SpanName, ${compile(str(v))}) > 0`)
        : $.SpanName.eq(v),
    ),
    CH.whenTrue(!!opts.rootOnly && !useTraceListMv, () =>
      CH.rawCond("(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')"),
    ),
  ]

  // Duration filters (Duration column is nanoseconds in both MV and raw table)
  if (opts.minDurationMs != null) {
    conditions.push(CH.rawCond(`Duration >= ${opts.minDurationMs} * 1000000`))
  }
  if (opts.maxDurationMs != null) {
    conditions.push(CH.rawCond(`Duration <= ${opts.maxDurationMs} * 1000000`))
  }

  if (opts.errorsOnly) {
    if (useTraceListMv) {
      conditions.push(CH.rawCond("HasError = 1"))
    } else {
      conditions.push(CH.rawCond("StatusCode = 'Error'"))
    }
  }

  if (opts.environments?.length) {
    if (mm?.deploymentEnv === "contains" && opts.environments.length === 1) {
      const envCol = useTraceListMv ? "DeploymentEnv" : "ResourceAttributes['deployment.environment']"
      conditions.push(CH.rawCond(`positionCaseInsensitive(${envCol}, ${compile(str(opts.environments[0]))}) > 0`))
    } else if (useTraceListMv) {
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

interface TracesMatchModes {
  serviceName?: "contains"
  spanName?: "contains"
  deploymentEnv?: "contains"
}

interface TracesQueryOpts {
  serviceName?: string
  spanName?: string
  rootOnly?: boolean
  errorsOnly?: boolean
  environments?: readonly string[]
  commitShas?: readonly string[]
  minDurationMs?: number
  maxDurationMs?: number
  matchModes?: TracesMatchModes
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
  /** When true, emit all metric columns regardless of the selected metric. Used by custom charts. */
  allMetrics?: boolean
}

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
  const tbl = useTraceListMv ? TraceListMv : Traces

  return from(tbl as typeof Traces)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      groupName: buildGroupNameExpr(opts.groupBy, opts.groupByAttributeKeys, useTraceListMv),
      ...metricSelectExprs($, opts.metric, apdexThresholdMs, opts.needsSampling, opts.allMetrics),
    }))
    .where(($) => buildWhereConditions($, opts, useTraceListMv))
    .groupBy("bucket", "groupName")
    .orderBy(["bucket", "asc"], ["groupName", "asc"])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string; bucketSeconds: number }>()
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
  /** When true, emit all metric columns regardless of the selected metric. Used by custom charts. */
  allMetrics?: boolean
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
    .select(($) => {
      const { sampledSpanCount, unsampledSpanCount, dominantThreshold, ...metrics } =
        metricSelectExprs($, opts.metric, apdexThresholdMs, false, opts.allMetrics)
      return {
        name: buildBreakdownGroupExpr(opts.groupBy, opts.groupByAttributeKey),
        ...metrics,
      }
    })
    .where(($) => buildWhereConditions($, opts, useTraceListMv))
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(limit)
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export interface TracesListOpts extends TracesQueryOpts {
  limit?: number
  offset?: number
  columns?: readonly string[]
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

/**
 * Build a ClickHouse map() literal that extracts only the requested attribute
 * keys, using MV columns when available and falling back to the raw Map.
 */
function buildProjectedMapExpr(
  requestedKeys: string[],
  useMv: boolean,
  mapName: "SpanAttributes" | "ResourceAttributes",
  mvMap: Record<string, string>,
): string {
  if (requestedKeys.length === 0) return "map()"
  const pairs: string[] = []
  for (const key of requestedKeys) {
    const escaped = `'${key.replace(/'/g, "\\'")}'`
    const mvCol = useMv ? mvMap[key] : undefined
    const value = mvCol ?? `${mapName}[${escaped}]`
    pairs.push(`${escaped}, ${value}`)
  }
  return `map(${pairs.join(", ")})`
}

export function tracesListQuery(
  opts: TracesListOpts,
): CHQuery<any, TracesListOutput, { orgId: string; startTime: string; endTime: string }> {
  const limit = opts.limit ?? 25
  const offset = opts.offset ?? 0
  const useTraceListMv = canUseTraceListMv({ ...opts, rootOnly: opts.rootOnly })
  const tbl = useTraceListMv ? TraceListMv : Traces

  // Parse requested columns to determine which attribute keys are needed
  const requestedSpanAttrKeys: string[] = []
  const requestedResourceAttrKeys: string[] = []
  let needsFullMaps = !opts.columns // backward-compatible when columns not specified

  if (opts.columns) {
    for (const col of opts.columns) {
      if (col.startsWith("spanAttributes.")) {
        requestedSpanAttrKeys.push(col.slice("spanAttributes.".length))
      } else if (col.startsWith("resourceAttributes.")) {
        requestedResourceAttrKeys.push(col.slice("resourceAttributes.".length))
      }
    }
  }

  // When using the raw table and no specific attr columns are requested, skip the full maps
  const spanAttrExpr = needsFullMaps && !useTraceListMv
    ? undefined // use $.SpanAttributes directly
    : CH.rawExpr<Record<string, string>>(
        buildProjectedMapExpr(requestedSpanAttrKeys, useTraceListMv, "SpanAttributes", TRACE_LIST_MV_ATTR_MAP),
      )
  const resourceAttrExpr = needsFullMaps && !useTraceListMv
    ? undefined // use $.ResourceAttributes directly
    : CH.rawExpr<Record<string, string>>(
        buildProjectedMapExpr(requestedResourceAttrKeys, useTraceListMv, "ResourceAttributes", TRACE_LIST_MV_RESOURCE_MAP),
      )

  let q = from(tbl as typeof Traces)
    .select(($) => ({
      traceId: $.TraceId,
      timestamp: $.Timestamp,
      spanId: useTraceListMv ? CH.rawExpr<string>("''") : $.SpanId,
      serviceName: $.ServiceName,
      spanName: $.SpanName,
      durationMs: CH.rawExpr<number>("Duration / 1000000"),
      statusCode: $.StatusCode,
      spanKind: useTraceListMv ? CH.rawExpr<string>("SpanKind") : $.SpanKind,
      hasError: useTraceListMv
        ? CH.rawExpr<number>("HasError")
        : CH.rawExpr<number>("if(StatusCode = 'Error', 1, 0)"),
      spanAttributes: spanAttrExpr ?? $.SpanAttributes,
      resourceAttributes: resourceAttrExpr ?? $.ResourceAttributes,
    }))
    .where(($) => buildWhereConditions($, opts, useTraceListMv))
    .orderBy(["timestamp", "desc"])
    .limit(limit)
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()

  if (offset > 0) {
    q = q.offset(offset)
  }

  return q
}

// ---------------------------------------------------------------------------
// Root trace list query (aggregated root-span-level, for trace list UI)
// ---------------------------------------------------------------------------

export interface TracesRootListOpts extends TracesQueryOpts {
  limit?: number
  offset?: number
}

export interface TracesRootListOutput {
  readonly traceId: string
  readonly startTime: string
  readonly endTime: string
  readonly durationMicros: number
  readonly spanCount: number
  readonly services: string[]
  readonly rootSpanName: string
  readonly rootSpanKind: string
  readonly rootSpanStatusCode: string
  readonly rootHttpMethod: string
  readonly rootHttpRoute: string
  readonly rootHttpStatusCode: string
  readonly hasError: number
}

export function tracesRootListQuery(
  opts: TracesRootListOpts,
): CHQuery<any, TracesRootListOutput, { orgId: string; startTime: string; endTime: string }> {
  const limit = opts.limit ?? 25
  const offset = opts.offset ?? 0
  const useTraceListMv = canUseTraceListMv({ ...opts, rootOnly: true })
  const tbl = useTraceListMv ? TraceListMv : Traces

  let q = from(tbl as typeof Traces)
    .select(($) => ({
      traceId: $.TraceId,
      startTime: $.Timestamp,
      endTime: $.Timestamp,
      durationMicros: CH.rawExpr<number>("intDiv(Duration, 1000)"),
      spanCount: CH.rawExpr<number>("toUInt64(1)"),
      services: CH.rawExpr<string[]>("[ServiceName]"),
      rootSpanName: $.SpanName,
      rootSpanKind: $.SpanKind,
      rootSpanStatusCode: $.StatusCode,
      rootHttpMethod: useTraceListMv
        ? CH.rawExpr<string>("HttpMethod")
        : CH.rawExpr<string>("SpanAttributes['http.method']"),
      rootHttpRoute: useTraceListMv
        ? CH.rawExpr<string>("HttpRoute")
        : CH.rawExpr<string>("SpanAttributes['http.route']"),
      rootHttpStatusCode: useTraceListMv
        ? CH.rawExpr<string>("HttpStatusCode")
        : CH.rawExpr<string>("SpanAttributes['http.status_code']"),
      hasError: useTraceListMv
        ? CH.rawExpr<number>("HasError")
        : CH.rawExpr<number>("if(StatusCode = 'Error', 1, 0)"),
    }))
    .where(($) => buildWhereConditions($, { ...opts, rootOnly: true }, useTraceListMv))
    .orderBy(["startTime", "desc"])
    .limit(limit)
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()

  if (offset > 0) {
    q = q.offset(offset)
  }

  return q
}
