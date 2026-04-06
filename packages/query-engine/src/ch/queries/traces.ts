// ---------------------------------------------------------------------------
// Typed Traces Queries
//
// DSL-based query definitions for traces timeseries, breakdown, and list.
// ---------------------------------------------------------------------------

import type { TracesMetric, AttributeFilter } from "../../query-engine"
import * as CH from "../expr"
import { param } from "../param"
import { from, type ColumnAccessor } from "../query"
import { Traces, TraceListMv } from "../tables"
import {
  METRIC_NEEDS,
  TRACE_LIST_MV_ATTR_MAP,
  TRACE_LIST_MV_RESOURCE_MAP,
  canUseTraceListMv,
  buildAttrFilterCondition,
} from "../../traces-shared"

// ---------------------------------------------------------------------------
// Metric SELECT expressions
// ---------------------------------------------------------------------------

function metricSelectExprs(
  $: ColumnAccessor<typeof Traces.columns>,
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
      ? CH.if_(CH.count().gt(0), CH.countIf($.StatusCode.eq("Error")).mul(100.0).div(CH.count()), CH.lit(0))
      : CH.lit(0),
    satisfiedCount: needs.has("apdex")
      ? CH.countIf($.Duration.div(1000000).lt(Number(t)))
      : CH.lit(0),
    toleratingCount: needs.has("apdex")
      ? CH.countIf($.Duration.div(1000000).gte(Number(t)).and($.Duration.div(1000000).lt(Number(t) * 4)))
      : CH.lit(0),
    apdexScore: needs.has("apdex")
      ? CH.if_(
          CH.count().gt(0),
          CH.round_(
            CH.countIf($.Duration.div(1000000).lt(Number(t)))
              .add(CH.countIf($.Duration.div(1000000).gte(Number(t)).and($.Duration.div(1000000).lt(Number(t) * 4))).mul(0.5))
              .div(CH.count()),
            4,
          ),
          CH.lit(0),
        )
      : CH.lit(0),
    sampledSpanCount: needsSampling
      ? CH.countIf($.TraceState.like("%th:%"))
      : CH.lit(0),
    unsampledSpanCount: needsSampling
      ? CH.countIf($.TraceState.eq("").or($.TraceState.notLike("%th:%")))
      : CH.lit(0),
    dominantThreshold: needsSampling
      ? CH.anyIf(CH.extract_($.TraceState, "th:([0-9a-f]+)"), $.TraceState.like("%th:%"))
      : CH.lit(""),
  }
}

// trace_list_mv constants + canUseTraceListMv imported from traces-shared.ts

// ---------------------------------------------------------------------------
// GROUP BY expression builder
// ---------------------------------------------------------------------------

function buildGroupNameExpr(
  $: ColumnAccessor<typeof Traces.columns>,
  groupBy: readonly string[] | undefined,
  groupByAttributeKeys: readonly string[] | undefined,
  useTraceListMv: boolean,
): CH.Expr<string> {
  if (!groupBy || groupBy.length === 0) {
    return CH.lit("all")
  }

  const parts: CH.Expr<string>[] = []
  for (const g of groupBy) {
    switch (g) {
      case "service":
        parts.push(CH.toString_($.ServiceName))
        break
      case "span_name":
        parts.push(CH.toString_($.SpanName))
        break
      case "status_code":
        parts.push(CH.toString_($.StatusCode))
        break
      case "http_method":
        if (useTraceListMv) {
          parts.push(CH.toString_(CH.dynamicColumn<string>("HttpMethod")))
        } else {
          parts.push(CH.toString_($.SpanAttributes.get("http.method")))
        }
        break
      case "attribute":
        if (groupByAttributeKeys?.length) {
          const keys: CH.Expr<string>[] = groupByAttributeKeys.map((k) => {
            const mvCol = useTraceListMv ? TRACE_LIST_MV_ATTR_MAP[k] : undefined
            return mvCol
              ? CH.toString_(CH.dynamicColumn<string>(mvCol))
              : CH.toString_($.SpanAttributes.get(k))
          })
          // When multiple attribute keys, join them into a single part
          if (keys.length === 1) {
            parts.push(keys[0])
          } else {
            parts.push(CH.arrayStringConcat(keys, " \u00b7 "))
          }
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
    return CH.coalesce(CH.nullIf(parts[0], ""), CH.lit("all"))
  }

  // Multi-part: filter empty strings before joining with separator
  const filtered = CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts))
  return CH.coalesce(
    CH.nullIf(CH.arrayStringConcat(filtered, " \u00b7 "), ""),
    CH.lit("all"),
  )
}

function buildBreakdownGroupExpr(
  $: ColumnAccessor<typeof Traces.columns>,
  groupBy: string,
  groupByAttributeKey: string | undefined,
): CH.Expr<string> {
  switch (groupBy) {
    case "service":
      return $.ServiceName
    case "span_name":
      return $.SpanName
    case "status_code":
      return $.StatusCode
    case "http_method":
      return $.SpanAttributes.get("http.method")
    case "attribute":
      return groupByAttributeKey
        ? $.SpanAttributes.get(groupByAttributeKey)
        : $.ServiceName
    default:
      return $.ServiceName
  }
}

// ---------------------------------------------------------------------------
// WHERE clause builders
// ---------------------------------------------------------------------------

function buildWhereConditions(
  $: ColumnAccessor<typeof Traces.columns>,
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
        ? CH.positionCaseInsensitive($.ServiceName, CH.lit(v)).gt(0)
        : $.ServiceName.eq(v),
    ),
    CH.when(opts.spanName, (v: string) =>
      mm?.spanName === "contains"
        ? CH.positionCaseInsensitive($.SpanName, CH.lit(v)).gt(0)
        : $.SpanName.eq(v),
    ),
    CH.whenTrue(!!opts.rootOnly && !useTraceListMv, () =>
      $.SpanKind.in_("Server", "Consumer").or($.ParentSpanId.eq("")),
    ),
  ]

  // Duration filters (Duration column is nanoseconds in both MV and raw table)
  if (opts.minDurationMs != null) {
    conditions.push($.Duration.gte(opts.minDurationMs * 1000000))
  }
  if (opts.maxDurationMs != null) {
    conditions.push($.Duration.lte(opts.maxDurationMs * 1000000))
  }

  if (opts.errorsOnly) {
    if (useTraceListMv) {
      conditions.push(CH.dynamicColumn<number>("HasError").eq(1))
    } else {
      conditions.push($.StatusCode.eq("Error"))
    }
  }

  if (opts.environments?.length) {
    if (mm?.deploymentEnv === "contains" && opts.environments.length === 1) {
      const envExpr = useTraceListMv
        ? CH.dynamicColumn<string>("DeploymentEnv")
        : $.ResourceAttributes.get("deployment.environment")
      conditions.push(CH.positionCaseInsensitive(envExpr, CH.lit(opts.environments[0])).gt(0))
    } else if (useTraceListMv) {
      conditions.push(CH.inList(CH.dynamicColumn<string>("DeploymentEnv"), opts.environments))
    } else {
      conditions.push(CH.inList($.ResourceAttributes.get("deployment.environment"), opts.environments))
    }
  }

  if (opts.commitShas?.length) {
    conditions.push(CH.inList($.ResourceAttributes.get("deployment.commit_sha"), opts.commitShas))
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
) {
  const apdexThresholdMs = opts.apdexThresholdMs ?? 500
  const useTraceListMv = canUseTraceListMv(opts)
  const tbl = useTraceListMv ? TraceListMv : Traces

  return from(tbl as typeof Traces)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      groupName: buildGroupNameExpr($, opts.groupBy, opts.groupByAttributeKeys, useTraceListMv),
      ...metricSelectExprs($, opts.metric, apdexThresholdMs, opts.needsSampling, opts.allMetrics),
    }))
    .where(($) => buildWhereConditions($, opts, useTraceListMv))
    .groupBy("bucket", "groupName")
    .orderBy(["bucket", "asc"], ["groupName", "asc"])
    .format("JSON")
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
) {
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
        name: buildBreakdownGroupExpr($, opts.groupBy, opts.groupByAttributeKey),
        ...metrics,
      }
    })
    .where(($) => buildWhereConditions($, opts, useTraceListMv))
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(limit)
    .format("JSON")
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
): CH.Expr<Record<string, string>> {
  if (requestedKeys.length === 0) return CH.mapLiteral()
  const pairs: Array<[string, CH.Expr<string>]> = requestedKeys.map((key) => {
    const mvCol = useMv ? mvMap[key] : undefined
    const valueExpr: CH.Expr<string> = mvCol
      ? CH.dynamicColumn<string>(mvCol)
      : CH.mapGet(CH.dynamicColumn<Record<string, string>>(mapName), key)
    return [key, valueExpr]
  })
  return CH.mapLiteral(...pairs)
}

export function tracesListQuery(
  opts: TracesListOpts,
) {
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
    : buildProjectedMapExpr(requestedSpanAttrKeys, useTraceListMv, "SpanAttributes", TRACE_LIST_MV_ATTR_MAP)
  const resourceAttrExpr = needsFullMaps && !useTraceListMv
    ? undefined // use $.ResourceAttributes directly
    : buildProjectedMapExpr(requestedResourceAttrKeys, useTraceListMv, "ResourceAttributes", TRACE_LIST_MV_RESOURCE_MAP)

  let q = from(tbl as typeof Traces)
    .select(($) => ({
      traceId: $.TraceId,
      timestamp: $.Timestamp,
      spanId: useTraceListMv ? CH.lit("") : $.SpanId,
      serviceName: $.ServiceName,
      spanName: $.SpanName,
      durationMs: $.Duration.div(1000000),
      statusCode: $.StatusCode,
      spanKind: useTraceListMv ? CH.dynamicColumn<string>("SpanKind") : $.SpanKind,
      hasError: useTraceListMv
        ? CH.dynamicColumn<number>("HasError")
        : CH.if_($.StatusCode.eq("Error"), CH.lit(1), CH.lit(0)),
      spanAttributes: spanAttrExpr ?? $.SpanAttributes,
      resourceAttributes: resourceAttrExpr ?? $.ResourceAttributes,
    }))
    .where(($) => buildWhereConditions($, opts, useTraceListMv))
    .orderBy(["timestamp", "desc"])
    .limit(limit)
    .format("JSON")

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
  readonly services: readonly string[]
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
) {
  const limit = opts.limit ?? 25
  const offset = opts.offset ?? 0
  const useTraceListMv = canUseTraceListMv({ ...opts, rootOnly: true })
  const tbl = useTraceListMv ? TraceListMv : Traces

  let q = from(tbl as typeof Traces)
    .select(($) => ({
      traceId: $.TraceId,
      startTime: $.Timestamp,
      endTime: $.Timestamp,
      durationMicros: CH.intDiv($.Duration, 1000),
      spanCount: CH.toUInt64(CH.lit(1)),
      services: CH.arrayOf($.ServiceName),
      rootSpanName: $.SpanName,
      rootSpanKind: $.SpanKind,
      rootSpanStatusCode: $.StatusCode,
      rootHttpMethod: useTraceListMv
        ? CH.dynamicColumn<string>("HttpMethod")
        : $.SpanAttributes.get("http.method"),
      rootHttpRoute: useTraceListMv
        ? CH.dynamicColumn<string>("HttpRoute")
        : $.SpanAttributes.get("http.route"),
      rootHttpStatusCode: useTraceListMv
        ? CH.dynamicColumn<string>("HttpStatusCode")
        : $.SpanAttributes.get("http.status_code"),
      hasError: useTraceListMv
        ? CH.dynamicColumn<number>("HasError")
        : CH.if_($.StatusCode.eq("Error"), CH.lit(1), CH.lit(0)),
    }))
    .where(($) => buildWhereConditions($, { ...opts, rootOnly: true }, useTraceListMv))
    .orderBy(["startTime", "desc"])
    .limit(limit)
    .format("JSON")

  if (offset > 0) {
    q = q.offset(offset)
  }

  return q
}
