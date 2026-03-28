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
      ...metricSelectExprs($, opts.metric, apdexThresholdMs, opts.needsSampling),
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
        metricSelectExprs($, opts.metric, apdexThresholdMs, false)
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
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}

