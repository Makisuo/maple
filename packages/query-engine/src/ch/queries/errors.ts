// ---------------------------------------------------------------------------
// Typed Error Queries
//
// DSL-based query definitions for error aggregation and timeseries.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery, type ColumnAccessor } from "../query"
import { unionAll, type CHUnionQuery } from "../union"
import { ErrorSpans, TraceListMv, Traces } from "../tables"
import { escapeClickHouseString } from "../../sql/sql-fragment"
import type { CompiledQuery } from "../compile"

// ---------------------------------------------------------------------------
// Shared: Error fingerprint SQL expression
// ---------------------------------------------------------------------------

export const ERROR_FINGERPRINT_SQL = `if(StatusMessage = '', 'Unknown Error',
  left(StatusMessage, multiIf(
    position(StatusMessage, ': ') > 3, toInt64(position(StatusMessage, ': ')) - 1,
    position(StatusMessage, ' (') > 3, toInt64(position(StatusMessage, ' (')) - 1,
    position(StatusMessage, '\\n') > 3, toInt64(position(StatusMessage, '\\n')) - 1,
    position(StatusMessage, '{') > 10, toInt64(position(StatusMessage, '{')) - 1,
    least(toInt64(length(StatusMessage)), 150)
  ))
)`

// ---------------------------------------------------------------------------
// Errors by type
// ---------------------------------------------------------------------------

export interface ErrorsByTypeOpts {
  rootOnly?: boolean
  services?: readonly string[]
  deploymentEnvs?: readonly string[]
  errorTypes?: readonly string[]
  limit?: number
}

export interface ErrorsByTypeOutput {
  readonly errorType: string
  readonly sampleMessage: string
  readonly count: number
  readonly affectedServicesCount: number
  readonly firstSeen: string
  readonly lastSeen: string
}

export function errorsByTypeQuery(
  opts: ErrorsByTypeOpts,
): CHQuery<any, ErrorsByTypeOutput, { orgId: string; startTime: string; endTime: string }> {
  return from(ErrorSpans)
    .select(($) => ({
      errorType: CH.rawExpr<string>(ERROR_FINGERPRINT_SQL),
      sampleMessage: CH.any_($.StatusMessage),
      count: CH.count(),
      affectedServicesCount: CH.uniq($.ServiceName),
      firstSeen: CH.min_($.Timestamp),
      lastSeen: CH.max_($.Timestamp),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
      opts.services?.length
        ? CH.inList($.ServiceName, opts.services)
        : undefined,
      opts.deploymentEnvs?.length
        ? CH.inList($.DeploymentEnv, opts.deploymentEnvs)
        : undefined,
      opts.errorTypes?.length
        ? CH.inList(CH.rawExpr<string>(ERROR_FINGERPRINT_SQL), opts.errorTypes)
        : undefined,
    ])
    .groupBy("errorType")
    .orderBy(["count", "desc"])
    .limit(opts.limit ?? 50)
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}

// ---------------------------------------------------------------------------
// Errors timeseries
// ---------------------------------------------------------------------------

export interface ErrorsTimeseriesOpts {
  errorType: string
  services?: readonly string[]
}

export interface ErrorsTimeseriesOutput {
  readonly bucket: string
  readonly count: number
}

export function errorsTimeseriesQuery(
  opts: ErrorsTimeseriesOpts,
): CHQuery<any, ErrorsTimeseriesOutput, { orgId: string; startTime: string; endTime: string; bucketSeconds: number }> {
  const esc = escapeClickHouseString
  return from(ErrorSpans)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      count: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      CH.rawCond(`${ERROR_FINGERPRINT_SQL} = '${esc(opts.errorType)}'`),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      opts.services?.length
        ? CH.inList($.ServiceName, opts.services)
        : undefined,
    ])
    .groupBy("bucket")
    .orderBy(["bucket", "asc"])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string; bucketSeconds: number }>()
}

// ---------------------------------------------------------------------------
// Span hierarchy
// ---------------------------------------------------------------------------

export interface SpanHierarchyOpts {
  traceId: string
  spanId?: string
}

export interface SpanHierarchyOutput {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string
  readonly spanName: string
  readonly serviceName: string
  readonly spanKind: string
  readonly durationMs: number
  readonly startTime: string
  readonly statusCode: string
  readonly statusMessage: string
  readonly spanAttributes: string
  readonly resourceAttributes: string
  readonly relationship: string
}

type SpanHierarchyParams = { orgId: string }

export function spanHierarchyQuery(
  opts: SpanHierarchyOpts,
): CHQuery<any, SpanHierarchyOutput, SpanHierarchyParams> {
  // HTTP span name rewriting: "http.server GET" + route → "GET /api/users"
  const httpRewriteExpr = CH.if_(
    CH.rawCond(
      "(SpanName LIKE 'http.server %' OR SpanName IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'))" +
      " AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')",
    ),
    CH.rawExpr<string>(
      "concat(" +
        "if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), " +
        "' ', " +
        "if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])" +
      ")",
    ),
    CH.rawExpr<string>("SpanName"),
  )

  const relationshipExpr = opts.spanId
    ? CH.if_(CH.rawExpr<string>("SpanId").eq(opts.spanId), CH.lit("target"), CH.lit("related"))
    : CH.lit("related")

  return from(Traces)
    .select(($) => ({
      traceId: $.TraceId,
      spanId: $.SpanId,
      parentSpanId: $.ParentSpanId,
      spanName: httpRewriteExpr,
      serviceName: $.ServiceName,
      spanKind: $.SpanKind,
      durationMs: $.Duration.div(1000000),
      startTime: $.Timestamp,
      statusCode: $.StatusCode,
      statusMessage: $.StatusMessage,
      spanAttributes: CH.toJSONString($.SpanAttributes),
      resourceAttributes: CH.toJSONString($.ResourceAttributes),
      relationship: relationshipExpr,
    }))
    .where(($) => [
      $.TraceId.eq(opts.traceId),
      $.OrgId.eq(param.string("orgId")),
    ])
    .orderBy(["startTime", "asc"])
    .format("JSON")
    .withParams<SpanHierarchyParams>()
}

// ---------------------------------------------------------------------------
// Traces duration stats
// ---------------------------------------------------------------------------

export interface TracesDurationStatsOpts {
  serviceName?: string
  spanName?: string
  hasError?: boolean
  minDurationMs?: number
  maxDurationMs?: number
  httpMethod?: string
  httpStatusCode?: string
  deploymentEnv?: string
  matchModes?: {
    serviceName?: "contains"
    spanName?: "contains"
    deploymentEnv?: "contains"
  }
}

export interface TracesDurationStatsOutput {
  readonly minDurationMs: number
  readonly maxDurationMs: number
  readonly p50DurationMs: number
  readonly p95DurationMs: number
}

type TracesDurationStatsParams = { orgId: string; startTime: string; endTime: string }

export function tracesDurationStatsQuery(
  opts: TracesDurationStatsOpts,
): CHQuery<any, TracesDurationStatsOutput, TracesDurationStatsParams> {
  const mm = opts.matchModes

  return from(TraceListMv)
    .select(($) => ({
      minDurationMs: CH.min_($.Duration).div(1000000),
      maxDurationMs: CH.max_($.Duration).div(1000000),
      p50DurationMs: CH.quantile(0.5)($.Duration).div(1000000),
      p95DurationMs: CH.quantile(0.95)($.Duration).div(1000000),
    }))
    .where(($) => [
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
      CH.whenTrue(!!opts.hasError, () => $.HasError.eq(1)),
      CH.when(opts.minDurationMs, (v: number) => $.Duration.gte(v * 1000000)),
      CH.when(opts.maxDurationMs, (v: number) => $.Duration.lte(v * 1000000)),
      CH.when(opts.httpMethod, (v: string) => $.HttpMethod.eq(v)),
      CH.when(opts.httpStatusCode, (v: string) => $.HttpStatusCode.eq(v)),
      CH.when(opts.deploymentEnv, (v: string) =>
        mm?.deploymentEnv === "contains"
          ? CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(v)).gt(0)
          : $.DeploymentEnv.eq(v),
      ),
    ])
    .format("JSON")
    .withParams<TracesDurationStatsParams>()
}

// ---------------------------------------------------------------------------
// Traces facets (UNION ALL — 6 facet dimensions on trace_list_mv)
// ---------------------------------------------------------------------------

export interface TracesFacetsOpts {
  serviceName?: string
  spanName?: string
  hasError?: boolean
  minDurationMs?: number
  maxDurationMs?: number
  httpMethod?: string
  httpStatusCode?: string
  deploymentEnv?: string
  matchModes?: {
    serviceName?: "contains"
    spanName?: "contains"
    deploymentEnv?: "contains"
  }
  attributeFilterKey?: string
  attributeFilterValue?: string
  attributeFilterValueMatchMode?: "contains"
  resourceFilterKey?: string
  resourceFilterValue?: string
  resourceFilterValueMatchMode?: "contains"
}

export interface TracesFacetsOutput {
  readonly name: string
  readonly count: number
  readonly facetType: string
}

type TracesFacetsParams = { orgId: string; startTime: string; endTime: string }

export function tracesFacetsQuery(
  opts: TracesFacetsOpts,
): CHUnionQuery<TracesFacetsOutput, TracesFacetsParams> {
  const esc = escapeClickHouseString

  const baseWhere = ($: ColumnAccessor<typeof TraceListMv.columns>): Array<CH.Condition | undefined> => {
    const conditions: Array<CH.Condition | undefined> = [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
    ]

    if (opts.serviceName) {
      conditions.push(
        opts.matchModes?.serviceName === "contains"
          ? CH.positionCaseInsensitive($.ServiceName, CH.lit(opts.serviceName)).gt(0)
          : $.ServiceName.eq(opts.serviceName),
      )
    }
    if (opts.spanName) {
      conditions.push(
        opts.matchModes?.spanName === "contains"
          ? CH.positionCaseInsensitive($.SpanName, CH.lit(opts.spanName)).gt(0)
          : $.SpanName.eq(opts.spanName),
      )
    }
    if (opts.hasError) conditions.push($.HasError.eq(1))
    if (opts.minDurationMs != null) conditions.push($.Duration.gte(opts.minDurationMs * 1000000))
    if (opts.maxDurationMs != null) conditions.push($.Duration.lte(opts.maxDurationMs * 1000000))
    if (opts.httpMethod) conditions.push($.HttpMethod.eq(opts.httpMethod))
    if (opts.httpStatusCode) conditions.push($.HttpStatusCode.eq(opts.httpStatusCode))
    if (opts.deploymentEnv) {
      conditions.push(
        opts.matchModes?.deploymentEnv === "contains"
          ? CH.positionCaseInsensitive($.DeploymentEnv, CH.lit(opts.deploymentEnv)).gt(0)
          : $.DeploymentEnv.eq(opts.deploymentEnv),
      )
    }

    // Attribute filter EXISTS subqueries (kept as rawCond — involves correlated subquery)
    if (opts.attributeFilterKey) {
      const matchExpr = opts.attributeFilterValueMatchMode === "contains"
        ? `positionCaseInsensitive(t_attr.SpanAttributes['${esc(opts.attributeFilterKey)}'], '${esc(opts.attributeFilterValue ?? "")}') > 0`
        : `t_attr.SpanAttributes['${esc(opts.attributeFilterKey)}'] = '${esc(opts.attributeFilterValue ?? "")}'`
      conditions.push(CH.rawCond(`EXISTS (
        SELECT 1 FROM traces AS t_attr
        WHERE t_attr.TraceId = TraceId AND t_attr.OrgId = __PARAM_orgId__
          AND t_attr.Timestamp >= __PARAM_startTime__
          AND t_attr.Timestamp <= __PARAM_endTime__
          AND ${matchExpr}
      )`))
    }
    if (opts.resourceFilterKey) {
      const matchExpr = opts.resourceFilterValueMatchMode === "contains"
        ? `positionCaseInsensitive(t_res.ResourceAttributes['${esc(opts.resourceFilterKey)}'], '${esc(opts.resourceFilterValue ?? "")}') > 0`
        : `t_res.ResourceAttributes['${esc(opts.resourceFilterKey)}'] = '${esc(opts.resourceFilterValue ?? "")}'`
      conditions.push(CH.rawCond(`EXISTS (
        SELECT 1 FROM traces AS t_res
        WHERE t_res.TraceId = TraceId AND t_res.OrgId = __PARAM_orgId__
          AND t_res.Timestamp >= __PARAM_startTime__
          AND t_res.Timestamp <= __PARAM_endTime__
          AND ${matchExpr}
      )`))
    }

    return conditions
  }

  const makeFacetQuery = (
    colName: string,
    facetType: string,
    extraWhere?: ($: ColumnAccessor<typeof TraceListMv.columns>) => CH.Condition,
    limit = 50,
  ) =>
    from(TraceListMv)
      .select((_$) => ({
        name: CH.dynamicColumn<string>(colName),
        count: CH.count(),
        facetType: CH.lit(facetType),
      }))
      .where(($) => [
        ...baseWhere($),
        extraWhere?.($),
      ])
      .groupBy("name")
      .orderBy(["count", "desc"])
      .limit(limit)
      .withParams<TracesFacetsParams>()

  return unionAll(
    makeFacetQuery("ServiceName", "service"),
    makeFacetQuery("SpanName", "spanName", ($) => $.SpanName.neq(""), 20),
    makeFacetQuery("HttpMethod", "httpMethod", ($) => $.HttpMethod.neq(""), 20),
    makeFacetQuery("HttpStatusCode", "httpStatus", ($) => $.HttpStatusCode.neq(""), 20),
    makeFacetQuery("DeploymentEnv", "deploymentEnv", ($) => $.DeploymentEnv.neq(""), 20),
    from(TraceListMv)
      .select(() => ({
        name: CH.lit("error"),
        count: CH.count(),
        facetType: CH.lit("errorCount"),
      }))
      .where(($) => [...baseWhere($), $.HasError.eq(1)])
      .withParams<TracesFacetsParams>(),
  ).format("JSON")
}

// ---------------------------------------------------------------------------
// Errors facets (UNION ALL — service + environment + error_type facets)
// ---------------------------------------------------------------------------

export interface ErrorsFacetsOpts {
  rootOnly?: boolean
  services?: readonly string[]
  deploymentEnvs?: readonly string[]
  errorTypes?: readonly string[]
}

export interface ErrorsFacetsOutput {
  readonly name: string
  readonly count: number
  readonly facetType: string
}

type ErrorsFacetsParams = { orgId: string; startTime: string; endTime: string }

export function errorsFacetsQuery(
  opts: ErrorsFacetsOpts,
): CHUnionQuery<ErrorsFacetsOutput, ErrorsFacetsParams> {
  const baseWhere = ($: ColumnAccessor<typeof ErrorSpans.columns>): Array<CH.Condition | undefined> => [
    $.OrgId.eq(param.string("orgId")),
    $.Timestamp.gte(param.dateTime("startTime")),
    $.Timestamp.lte(param.dateTime("endTime")),
    CH.whenTrue(!!opts.rootOnly, () => $.ParentSpanId.eq("")),
    opts.services?.length
      ? CH.inList($.ServiceName, opts.services)
      : undefined,
    opts.deploymentEnvs?.length
      ? CH.inList($.DeploymentEnv, opts.deploymentEnvs)
      : undefined,
    opts.errorTypes?.length
      ? CH.inList(CH.rawExpr<string>(ERROR_FINGERPRINT_SQL), opts.errorTypes)
      : undefined,
  ]

  const serviceQuery = from(ErrorSpans)
    .select(($) => ({
      name: $.ServiceName,
      count: CH.count(),
      facetType: CH.lit("service"),
    }))
    .where(baseWhere)
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(100)
    .withParams<ErrorsFacetsParams>()

  const envQuery = from(ErrorSpans)
    .select(($) => ({
      name: $.DeploymentEnv,
      count: CH.count(),
      facetType: CH.lit("environment"),
    }))
    .where(($) => [...baseWhere($), $.DeploymentEnv.neq("")])
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(100)
    .withParams<ErrorsFacetsParams>()

  const errorTypeQuery = from(ErrorSpans)
    .select(() => ({
      name: CH.rawExpr<string>(ERROR_FINGERPRINT_SQL),
      count: CH.count(),
      facetType: CH.lit("error_type"),
    }))
    .where(baseWhere)
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(50)
    .withParams<ErrorsFacetsParams>()

  return unionAll(serviceQuery, envQuery, errorTypeQuery)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Errors summary (raw SQL — CROSS JOIN between error_spans and service_usage)
// ---------------------------------------------------------------------------

export interface ErrorsSummaryOpts {
  rootOnly?: boolean
  services?: readonly string[]
  deploymentEnvs?: readonly string[]
  errorTypes?: readonly string[]
}

export interface ErrorsSummaryOutput {
  readonly totalErrors: number
  readonly totalSpans: number
  readonly errorRate: number
  readonly affectedServicesCount: number
  readonly affectedTracesCount: number
}

export function errorsSummarySQL(
  opts: ErrorsSummaryOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ErrorsSummaryOutput> {
  const esc = escapeClickHouseString
  const errorConditions: string[] = [
    `OrgId = '${esc(params.orgId)}'`,
    `Timestamp >= '${esc(params.startTime)}'`,
    `Timestamp <= '${esc(params.endTime)}'`,
  ]
  if (opts.rootOnly) errorConditions.push("ParentSpanId = ''")
  if (opts.services?.length) {
    errorConditions.push(`ServiceName IN (${opts.services.map((s) => `'${esc(s)}'`).join(", ")})`)
  }
  if (opts.deploymentEnvs?.length) {
    errorConditions.push(`DeploymentEnv IN (${opts.deploymentEnvs.map((e) => `'${esc(e)}'`).join(", ")})`)
  }
  if (opts.errorTypes?.length) {
    errorConditions.push(`${ERROR_FINGERPRINT_SQL} IN (${opts.errorTypes.map((t) => `'${esc(t)}'`).join(", ")})`)
  }

  const sql = `SELECT
  e.totalErrors AS totalErrors,
  s.totalSpans AS totalSpans,
  if(s.totalSpans > 0, round(e.totalErrors / s.totalSpans * 100, 4), 0) AS errorRate,
  e.affectedServicesCount AS affectedServicesCount,
  e.affectedTracesCount AS affectedTracesCount
FROM (
  SELECT
    count() AS totalErrors,
    uniq(ServiceName) AS affectedServicesCount,
    uniq(TraceId) AS affectedTracesCount
  FROM error_spans
  WHERE ${errorConditions.join("\n    AND ")}
) AS e
CROSS JOIN (
  SELECT sum(TraceCount) AS totalSpans
  FROM service_usage
  WHERE OrgId = '${esc(params.orgId)}'
    AND Hour >= '${esc(params.startTime)}'
    AND Hour <= '${esc(params.endTime)}'
) AS s
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<ErrorsSummaryOutput>,
  }
}

// ---------------------------------------------------------------------------
// Error detail traces (raw SQL — subquery + INNER JOIN)
// ---------------------------------------------------------------------------

export interface ErrorDetailTracesOpts {
  errorType: string
  rootOnly?: boolean
  services?: readonly string[]
  limit?: number
}

export interface ErrorDetailTracesOutput {
  readonly traceId: string
  readonly startTime: string
  readonly durationMicros: number
  readonly spanCount: number
  readonly services: string[]
  readonly rootSpanName: string
  readonly errorMessage: string
}

export function errorDetailTracesSQL(
  opts: ErrorDetailTracesOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ErrorDetailTracesOutput> {
  const esc = escapeClickHouseString
  const limit = opts.limit ?? 10
  const errorConditions: string[] = [
    `OrgId = '${esc(params.orgId)}'`,
    `${ERROR_FINGERPRINT_SQL} = '${esc(opts.errorType)}'`,
    `Timestamp >= '${esc(params.startTime)}'`,
    `Timestamp <= '${esc(params.endTime)}'`,
  ]
  if (opts.rootOnly) errorConditions.push("ParentSpanId = ''")
  if (opts.services?.length) {
    errorConditions.push(`ServiceName IN (${opts.services.map((s) => `'${esc(s)}'`).join(", ")})`)
  }

  const sql = `SELECT
  t.TraceId AS traceId,
  min(t.Timestamp) AS startTime,
  intDiv(max(t.Duration), 1000) AS durationMicros,
  count() AS spanCount,
  groupUniqArray(t.ServiceName) AS services,
  anyIf(t.SpanName, t.ParentSpanId = '') AS rootSpanName,
  any(t.StatusMessage) AS errorMessage
FROM traces AS t
INNER JOIN (
  SELECT DISTINCT TraceId
  FROM error_spans
  WHERE ${errorConditions.join("\n    AND ")}
  ORDER BY Timestamp DESC
  LIMIT ${Math.round(limit)}
) AS e ON t.TraceId = e.TraceId
WHERE t.OrgId = '${esc(params.orgId)}'
  AND t.Timestamp >= '${esc(params.startTime)}'
  AND t.Timestamp <= '${esc(params.endTime)}'
GROUP BY t.TraceId
ORDER BY startTime DESC
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<ErrorDetailTracesOutput>,
  }
}
