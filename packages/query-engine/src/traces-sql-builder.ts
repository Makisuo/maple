import type { TracesMetric, AttributeFilter } from "./query-engine"
import {
  type SqlFragment,
  escapeClickHouseString,
  raw,
  str,
  ident,
  as_,
  when,
  compile,
} from "./sql/sql-fragment"
import { compileQuery } from "./sql/sql-query"
import { attrFilter, eq, gte, lte, inList, toStartOfInterval } from "./sql/clickhouse"
import {
  METRIC_NEEDS,
  TRACE_LIST_MV_ATTR_MAP,
  TRACE_LIST_MV_RESOURCE_MAP,
  canUseTraceListMv,
} from "./traces-shared"

export { escapeClickHouseString }

// ---------------------------------------------------------------------------
// Row types returned by SQL queries
// ---------------------------------------------------------------------------

export interface TracesTimeseriesRow {
  readonly bucket: string | Date
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

export interface TracesBreakdownRow {
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

// ---------------------------------------------------------------------------
// Metric → SELECT columns mapping (imported from traces-shared.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Metric SELECT fragments
// ---------------------------------------------------------------------------

function metricSelectFragments(
  metric: TracesMetric,
  needsSampling: boolean,
  apdexThresholdMs: number,
): SqlFragment[] {
  const needs = new Set(METRIC_NEEDS[metric])
  const cols: SqlFragment[] = [raw("count() AS count")]

  if (needs.has("avg_duration")) {
    cols.push(raw("avg(Duration) / 1000000 AS avgDuration"))
  } else {
    cols.push(raw("0 AS avgDuration"))
  }

  if (needs.has("quantiles")) {
    cols.push(
      raw("quantile(0.5)(Duration) / 1000000 AS p50Duration"),
      raw("quantile(0.95)(Duration) / 1000000 AS p95Duration"),
      raw("quantile(0.99)(Duration) / 1000000 AS p99Duration"),
    )
  } else {
    cols.push(raw("0 AS p50Duration"), raw("0 AS p95Duration"), raw("0 AS p99Duration"))
  }

  if (needs.has("error_rate")) {
    cols.push(raw("if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0) AS errorRate"))
  } else {
    cols.push(raw("0 AS errorRate"))
  }

  const t = String(apdexThresholdMs)
  if (needs.has("apdex")) {
    cols.push(
      raw(`countIf(Duration / 1000000 < ${t}) AS satisfiedCount`),
      raw(`countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) AS toleratingCount`),
      raw(`if(count() > 0, round((countIf(Duration / 1000000 < ${t}) + countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) * 0.5) / count(), 4), 0) AS apdexScore`),
    )
  } else {
    cols.push(raw("0 AS satisfiedCount"), raw("0 AS toleratingCount"), raw("0 AS apdexScore"))
  }

  if (needsSampling) {
    cols.push(
      raw("countIf(TraceState LIKE '%th:%') AS sampledSpanCount"),
      raw("countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS unsampledSpanCount"),
      raw("anyIf(extract(TraceState, 'th:([0-9a-f]+)'), TraceState LIKE '%th:%') AS dominantThreshold"),
    )
  } else {
    cols.push(raw("0 AS sampledSpanCount"), raw("0 AS unsampledSpanCount"), raw("'' AS dominantThreshold"))
  }

  return cols
}

function breakdownMetricSelectFragments(
  metric: TracesMetric,
  apdexThresholdMs: number,
): SqlFragment[] {
  const needs = new Set(METRIC_NEEDS[metric])
  const cols: SqlFragment[] = [raw("count() AS count")]

  if (needs.has("avg_duration")) {
    cols.push(raw("avg(Duration) / 1000000 AS avgDuration"))
  } else {
    cols.push(raw("0 AS avgDuration"))
  }

  if (needs.has("quantiles")) {
    cols.push(
      raw("quantile(0.5)(Duration) / 1000000 AS p50Duration"),
      raw("quantile(0.95)(Duration) / 1000000 AS p95Duration"),
      raw("quantile(0.99)(Duration) / 1000000 AS p99Duration"),
    )
  } else {
    cols.push(raw("0 AS p50Duration"), raw("0 AS p95Duration"), raw("0 AS p99Duration"))
  }

  if (needs.has("error_rate")) {
    cols.push(raw("if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0) AS errorRate"))
  } else {
    cols.push(raw("0 AS errorRate"))
  }

  const t = String(apdexThresholdMs)
  if (needs.has("apdex")) {
    cols.push(
      raw(`countIf(Duration / 1000000 < ${t}) AS satisfiedCount`),
      raw(`countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) AS toleratingCount`),
      raw(`if(count() > 0, round((countIf(Duration / 1000000 < ${t}) + countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) * 0.5) / count(), 4), 0) AS apdexScore`),
    )
  } else {
    cols.push(raw("0 AS satisfiedCount"), raw("0 AS toleratingCount"), raw("0 AS apdexScore"))
  }

  return cols
}

// ---------------------------------------------------------------------------
// GROUP BY expression builder
// ---------------------------------------------------------------------------

function groupNameFragment(
  groupBy: readonly string[] | undefined,
  groupByAttributeKeys: readonly string[] | undefined,
  useTraceListMv: boolean,
): SqlFragment {
  if (!groupBy || groupBy.length === 0) {
    return raw("'all' AS groupName")
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
          parts.push(`arrayStringConcat([${keys.join(", ")}], ' · ')`)
        }
        break
      case "none":
        break
    }
  }

  if (parts.length === 0) {
    return raw("'all' AS groupName")
  }

  if (parts.length === 1) {
    return raw(`coalesce(nullIf(${parts[0]}, ''), 'all') AS groupName`)
  }

  return raw(`coalesce(nullIf(arrayStringConcat(arrayFilter(x -> x != '', [${parts.join(", ")}]), ' · '), ''), 'all') AS groupName`)
}

function breakdownGroupFragment(groupBy: string, groupByAttributeKey?: string): SqlFragment {
  switch (groupBy) {
    case "service":
      return raw("ServiceName AS name")
    case "span_name":
      return raw("SpanName AS name")
    case "status_code":
      return raw("StatusCode AS name")
    case "http_method":
      return raw("SpanAttributes['http.method'] AS name")
    case "attribute":
      return groupByAttributeKey
        ? raw(`SpanAttributes[${compile(str(groupByAttributeKey))}] AS name`)
        : raw("ServiceName AS name")
    default:
      return raw("ServiceName AS name")
  }
}

// trace_list_mv column mapping + canUseTraceListMv imported from traces-shared.ts

// ---------------------------------------------------------------------------
// WHERE clause builder
// ---------------------------------------------------------------------------

interface WhereClauseParams {
  orgId: string
  startTime: string
  endTime: string
  serviceName?: string
  spanName?: string
  rootOnly?: boolean
  errorsOnly?: boolean
  environments?: readonly string[]
  commitShas?: readonly string[]
  attributeFilters?: readonly AttributeFilter[]
  resourceAttributeFilters?: readonly AttributeFilter[]
}

function buildWhereFragments(params: WhereClauseParams, useTraceListMv: boolean): SqlFragment[] {
  const clauses: SqlFragment[] = [
    eq("OrgId", str(params.orgId)),
  ]

  if (params.serviceName) {
    clauses.push(eq("ServiceName", str(params.serviceName)))
  }
  if (params.spanName) {
    clauses.push(eq("SpanName", str(params.spanName)))
  }

  clauses.push(
    gte("Timestamp", str(params.startTime)),
    lte("Timestamp", str(params.endTime)),
  )

  // Entry point spans: Server/Consumer spans or true root spans
  clauses.push(
    when(!!params.rootOnly && !useTraceListMv, raw("(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')")),
  )
  if (params.errorsOnly) {
    if (useTraceListMv) {
      clauses.push(raw("HasError = 1"))
    } else {
      clauses.push(raw("StatusCode = 'Error'"))
    }
  }
  if (params.environments?.length) {
    if (useTraceListMv) {
      clauses.push(inList("DeploymentEnv", params.environments.map(str)))
    } else {
      clauses.push(inList("ResourceAttributes['deployment.environment']", params.environments.map(str)))
    }
  }
  if (params.commitShas?.length) {
    clauses.push(inList("ResourceAttributes['deployment.commit_sha']", params.commitShas.map(str)))
  }

  if (params.attributeFilters) {
    for (const af of params.attributeFilters) {
      clauses.push(attrFilter(af, useTraceListMv, "SpanAttributes", TRACE_LIST_MV_ATTR_MAP))
    }
  }

  if (params.resourceAttributeFilters) {
    for (const rf of params.resourceAttributeFilters) {
      clauses.push(attrFilter(rf, useTraceListMv, "ResourceAttributes", TRACE_LIST_MV_RESOURCE_MAP))
    }
  }

  return clauses
}

// ---------------------------------------------------------------------------
// Timeseries SQL builder
// ---------------------------------------------------------------------------

export interface BuildTracesTimeseriesSQLParams {
  orgId: string
  startTime: string
  endTime: string
  bucketSeconds: number
  metric: TracesMetric
  needsSampling: boolean
  serviceName?: string
  spanName?: string
  rootOnly?: boolean
  errorsOnly?: boolean
  groupBy?: readonly string[]
  groupByAttributeKeys?: readonly string[]
  environments?: readonly string[]
  commitShas?: readonly string[]
  attributeFilters?: readonly AttributeFilter[]
  resourceAttributeFilters?: readonly AttributeFilter[]
  apdexThresholdMs?: number
}

export function buildTracesTimeseriesSQL(params: BuildTracesTimeseriesSQLParams): string {
  const apdexThresholdMs = params.apdexThresholdMs ?? 500
  const useTraceListMv = canUseTraceListMv(params)
  const tableName = useTraceListMv ? "trace_list_mv" : "traces"

  return compileQuery({
    select: [
      as_(toStartOfInterval("Timestamp", params.bucketSeconds), "bucket"),
      groupNameFragment(params.groupBy, params.groupByAttributeKeys, useTraceListMv),
      ...metricSelectFragments(params.metric, params.needsSampling, apdexThresholdMs),
    ],
    from: ident(tableName),
    where: buildWhereFragments(params, useTraceListMv),
    groupBy: [raw("bucket, groupName")],
    orderBy: [raw("bucket ASC, groupName ASC")],
    format: "JSON",
  })
}

// ---------------------------------------------------------------------------
// Breakdown SQL builder
// ---------------------------------------------------------------------------

export interface BuildTracesBreakdownSQLParams {
  orgId: string
  startTime: string
  endTime: string
  metric: TracesMetric
  groupBy: string
  groupByAttributeKey?: string
  limit?: number
  serviceName?: string
  spanName?: string
  rootOnly?: boolean
  errorsOnly?: boolean
  environments?: readonly string[]
  commitShas?: readonly string[]
  attributeFilters?: readonly AttributeFilter[]
  resourceAttributeFilters?: readonly AttributeFilter[]
  apdexThresholdMs?: number
}

// ---------------------------------------------------------------------------
// List SQL builder
// ---------------------------------------------------------------------------

export interface TracesListRow {
  readonly traceId: string
  readonly timestamp: string | Date
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

export interface BuildTracesListSQLParams {
  orgId: string
  startTime: string
  endTime: string
  limit?: number
  serviceName?: string
  spanName?: string
  rootOnly?: boolean
  errorsOnly?: boolean
  environments?: readonly string[]
  commitShas?: readonly string[]
  attributeFilters?: readonly AttributeFilter[]
  resourceAttributeFilters?: readonly AttributeFilter[]
}

export function buildTracesListSQL(params: BuildTracesListSQLParams): string {
  const limit = params.limit ?? 100
  // List queries always use the raw traces table (not MV) to get full attributes
  const useTraceListMv = false

  return compileQuery({
    select: [
      as_(ident("TraceId"), "traceId"),
      as_(ident("Timestamp"), "timestamp"),
      as_(ident("SpanId"), "spanId"),
      as_(ident("ServiceName"), "serviceName"),
      as_(ident("SpanName"), "spanName"),
      as_(raw("Duration / 1000000"), "durationMs"),
      as_(ident("StatusCode"), "statusCode"),
      as_(ident("SpanKind"), "spanKind"),
      as_(raw("if(StatusCode = 'Error', 1, 0)"), "hasError"),
      as_(ident("SpanAttributes"), "spanAttributes"),
      as_(ident("ResourceAttributes"), "resourceAttributes"),
    ],
    from: ident("traces"),
    where: buildWhereFragments(params, useTraceListMv),
    groupBy: [],
    orderBy: [raw("Timestamp DESC")],
    limit: raw(String(Math.round(limit))),
    format: "JSON",
  })
}

// ---------------------------------------------------------------------------
// Breakdown SQL builder
// ---------------------------------------------------------------------------

export function buildTracesBreakdownSQL(params: BuildTracesBreakdownSQLParams): string {
  const apdexThresholdMs = params.apdexThresholdMs ?? 500
  const limit = params.limit ?? 10
  const useTraceListMv = canUseTraceListMv(params)
  const tableName = useTraceListMv ? "trace_list_mv" : "traces"

  return compileQuery({
    select: [
      breakdownGroupFragment(params.groupBy, params.groupByAttributeKey),
      ...breakdownMetricSelectFragments(params.metric, apdexThresholdMs),
    ],
    from: ident(tableName),
    where: buildWhereFragments(params, useTraceListMv),
    groupBy: [ident("name")],
    orderBy: [raw("count DESC")],
    limit: raw(String(Math.round(limit))),
    format: "JSON",
  })
}
