// ---------------------------------------------------------------------------
// Typed Error Queries
//
// DSL-based query definitions for error aggregation and timeseries.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import { ErrorSpans } from "../tables"
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
    .select(() => ({
      errorType: CH.rawExpr<string>(ERROR_FINGERPRINT_SQL),
      sampleMessage: CH.rawExpr<string>("any(StatusMessage)"),
      count: CH.count(),
      affectedServicesCount: CH.rawExpr<number>("uniq(ServiceName)"),
      firstSeen: CH.rawExpr<string>("min(Timestamp)"),
      lastSeen: CH.rawExpr<string>("max(Timestamp)"),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.whenTrue(!!opts.rootOnly, () => CH.rawCond("ParentSpanId = ''")),
      opts.services?.length
        ? CH.inList(CH.rawExpr<string>("ServiceName"), opts.services)
        : undefined,
      opts.deploymentEnvs?.length
        ? CH.inList(CH.rawExpr<string>("DeploymentEnv"), opts.deploymentEnvs)
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
        ? CH.inList(CH.rawExpr<string>("ServiceName"), opts.services)
        : undefined,
    ])
    .groupBy("bucket")
    .orderBy(["bucket", "asc"])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string; bucketSeconds: number }>()
}

// ---------------------------------------------------------------------------
// Span hierarchy (raw SQL — needs toJSONString, conditional span name rewrite)
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

export function spanHierarchySQL(
  opts: SpanHierarchyOpts,
  params: { orgId: string },
): CompiledQuery<SpanHierarchyOutput> {
  const esc = escapeClickHouseString
  const relationshipExpr = opts.spanId
    ? `if(SpanId = '${esc(opts.spanId)}', 'target', 'related')`
    : `'related'`

  const sql = `SELECT
  TraceId AS traceId,
  SpanId AS spanId,
  ParentSpanId AS parentSpanId,
  if(
    (SpanName LIKE 'http.server %' OR SpanName IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'))
    AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != ''),
    concat(
      if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName),
      ' ',
      if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])
    ),
    SpanName
  ) AS spanName,
  ServiceName AS serviceName,
  SpanKind AS spanKind,
  Duration / 1000000 AS durationMs,
  Timestamp AS startTime,
  StatusCode AS statusCode,
  StatusMessage AS statusMessage,
  toJSONString(SpanAttributes) AS spanAttributes,
  toJSONString(ResourceAttributes) AS resourceAttributes,
  ${relationshipExpr} AS relationship
FROM traces
WHERE TraceId = '${esc(opts.traceId)}'
  AND OrgId = '${esc(params.orgId)}'
ORDER BY Timestamp ASC
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<SpanHierarchyOutput>,
  }
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

export function tracesDurationStatsSQL(
  opts: TracesDurationStatsOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<TracesDurationStatsOutput> {
  const esc = escapeClickHouseString
  const mm = opts.matchModes
  const conditions: string[] = [
    `OrgId = '${esc(params.orgId)}'`,
    `Timestamp >= '${esc(params.startTime)}'`,
    `Timestamp <= '${esc(params.endTime)}'`,
  ]

  if (opts.serviceName) {
    conditions.push(
      mm?.serviceName === "contains"
        ? `positionCaseInsensitive(ServiceName, '${esc(opts.serviceName)}') > 0`
        : `ServiceName = '${esc(opts.serviceName)}'`,
    )
  }
  if (opts.spanName) {
    conditions.push(
      mm?.spanName === "contains"
        ? `positionCaseInsensitive(SpanName, '${esc(opts.spanName)}') > 0`
        : `SpanName = '${esc(opts.spanName)}'`,
    )
  }
  if (opts.hasError) conditions.push("HasError = 1")
  if (opts.minDurationMs != null) conditions.push(`Duration >= ${opts.minDurationMs} * 1000000`)
  if (opts.maxDurationMs != null) conditions.push(`Duration <= ${opts.maxDurationMs} * 1000000`)
  if (opts.httpMethod) conditions.push(`HttpMethod = '${esc(opts.httpMethod)}'`)
  if (opts.httpStatusCode) conditions.push(`HttpStatusCode = '${esc(opts.httpStatusCode)}'`)
  if (opts.deploymentEnv) {
    conditions.push(
      mm?.deploymentEnv === "contains"
        ? `positionCaseInsensitive(DeploymentEnv, '${esc(opts.deploymentEnv)}') > 0`
        : `DeploymentEnv = '${esc(opts.deploymentEnv)}'`,
    )
  }

  const sql = `SELECT
  min(Duration) / 1000000.0 AS minDurationMs,
  max(Duration) / 1000000.0 AS maxDurationMs,
  quantile(0.5)(Duration) / 1000000.0 AS p50DurationMs,
  quantile(0.95)(Duration) / 1000000.0 AS p95DurationMs
FROM trace_list_mv
WHERE ${conditions.join("\n  AND ")}
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<TracesDurationStatsOutput>,
  }
}

// ---------------------------------------------------------------------------
// Traces facets (raw SQL — 6 UNION ALL on trace_list_mv)
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

export function tracesFacetsSQL(
  opts: TracesFacetsOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<TracesFacetsOutput> {
  const esc = escapeClickHouseString
  const baseConditions: string[] = [
    `OrgId = '${esc(params.orgId)}'`,
    `Timestamp >= '${esc(params.startTime)}'`,
    `Timestamp <= '${esc(params.endTime)}'`,
  ]

  if (opts.serviceName) {
    baseConditions.push(
      opts.matchModes?.serviceName === "contains"
        ? `positionCaseInsensitive(ServiceName, '${esc(opts.serviceName)}') > 0`
        : `ServiceName = '${esc(opts.serviceName)}'`,
    )
  }
  if (opts.spanName) {
    baseConditions.push(
      opts.matchModes?.spanName === "contains"
        ? `positionCaseInsensitive(SpanName, '${esc(opts.spanName)}') > 0`
        : `SpanName = '${esc(opts.spanName)}'`,
    )
  }
  if (opts.hasError) baseConditions.push("HasError = 1")
  if (opts.minDurationMs != null) baseConditions.push(`Duration >= ${opts.minDurationMs} * 1000000`)
  if (opts.maxDurationMs != null) baseConditions.push(`Duration <= ${opts.maxDurationMs} * 1000000`)
  if (opts.httpMethod) baseConditions.push(`HttpMethod = '${esc(opts.httpMethod)}'`)
  if (opts.httpStatusCode) baseConditions.push(`HttpStatusCode = '${esc(opts.httpStatusCode)}'`)
  if (opts.deploymentEnv) {
    baseConditions.push(
      opts.matchModes?.deploymentEnv === "contains"
        ? `positionCaseInsensitive(DeploymentEnv, '${esc(opts.deploymentEnv)}') > 0`
        : `DeploymentEnv = '${esc(opts.deploymentEnv)}'`,
    )
  }

  // Attribute filter EXISTS subqueries
  if (opts.attributeFilterKey) {
    const matchExpr = opts.attributeFilterValueMatchMode === "contains"
      ? `positionCaseInsensitive(t_attr.SpanAttributes['${esc(opts.attributeFilterKey)}'], '${esc(opts.attributeFilterValue ?? "")}') > 0`
      : `t_attr.SpanAttributes['${esc(opts.attributeFilterKey)}'] = '${esc(opts.attributeFilterValue ?? "")}'`
    baseConditions.push(`EXISTS (
      SELECT 1 FROM traces AS t_attr
      WHERE t_attr.TraceId = TraceId AND t_attr.OrgId = '${esc(params.orgId)}'
        AND t_attr.Timestamp >= '${esc(params.startTime)}'
        AND t_attr.Timestamp <= '${esc(params.endTime)}'
        AND ${matchExpr}
    )`)
  }
  if (opts.resourceFilterKey) {
    const matchExpr = opts.resourceFilterValueMatchMode === "contains"
      ? `positionCaseInsensitive(t_res.ResourceAttributes['${esc(opts.resourceFilterKey)}'], '${esc(opts.resourceFilterValue ?? "")}') > 0`
      : `t_res.ResourceAttributes['${esc(opts.resourceFilterKey)}'] = '${esc(opts.resourceFilterValue ?? "")}'`
    baseConditions.push(`EXISTS (
      SELECT 1 FROM traces AS t_res
      WHERE t_res.TraceId = TraceId AND t_res.OrgId = '${esc(params.orgId)}'
        AND t_res.Timestamp >= '${esc(params.startTime)}'
        AND t_res.Timestamp <= '${esc(params.endTime)}'
        AND ${matchExpr}
    )`)
  }

  const where = baseConditions.join("\n    AND ")

  const facetQuery = (col: string, alias: string, facetType: string, extra?: string, limit = 50) =>
    `SELECT ${col} AS name, count() AS count, '${facetType}' AS facetType
FROM trace_list_mv
WHERE ${where}${extra ? `\n    AND ${extra}` : ""}
GROUP BY ${col}
ORDER BY count DESC
LIMIT ${limit}`

  const sql = `${facetQuery("ServiceName", "name", "service")}
UNION ALL
${facetQuery("SpanName", "name", "spanName", "SpanName != ''", 20)}
UNION ALL
${facetQuery("HttpMethod", "name", "httpMethod", "HttpMethod != ''", 20)}
UNION ALL
${facetQuery("HttpStatusCode", "name", "httpStatus", "HttpStatusCode != ''", 20)}
UNION ALL
${facetQuery("DeploymentEnv", "name", "deploymentEnv", "DeploymentEnv != ''", 20)}
UNION ALL
SELECT 'error' AS name, count() AS count, 'errorCount' AS facetType
FROM trace_list_mv
WHERE ${where}
    AND HasError = 1
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<TracesFacetsOutput>,
  }
}

// ---------------------------------------------------------------------------
// Errors facets (raw SQL — 3 UNION ALL facet subqueries)
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

export function errorsFacetsSQL(
  opts: ErrorsFacetsOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ErrorsFacetsOutput> {
  const esc = escapeClickHouseString
  const baseConditions: string[] = [
    `OrgId = '${esc(params.orgId)}'`,
    `Timestamp >= '${esc(params.startTime)}'`,
    `Timestamp <= '${esc(params.endTime)}'`,
  ]
  if (opts.rootOnly) baseConditions.push("ParentSpanId = ''")
  if (opts.services?.length) {
    baseConditions.push(`ServiceName IN (${opts.services.map((s) => `'${esc(s)}'`).join(", ")})`)
  }
  if (opts.deploymentEnvs?.length) {
    baseConditions.push(`DeploymentEnv IN (${opts.deploymentEnvs.map((e) => `'${esc(e)}'`).join(", ")})`)
  }
  if (opts.errorTypes?.length) {
    baseConditions.push(`${ERROR_FINGERPRINT_SQL} IN (${opts.errorTypes.map((t) => `'${esc(t)}'`).join(", ")})`)
  }
  const where = baseConditions.join("\n    AND ")

  const sql = `SELECT name, count, facetType FROM (
SELECT
  ServiceName AS name,
  count() AS count,
  'service' AS facetType
FROM error_spans
WHERE ${where}
GROUP BY name
ORDER BY count DESC
LIMIT 100

UNION ALL

SELECT
  DeploymentEnv AS name,
  count() AS count,
  'environment' AS facetType
FROM error_spans
WHERE ${where}
  AND DeploymentEnv != ''
GROUP BY name
ORDER BY count DESC
LIMIT 100

UNION ALL

SELECT
  ${ERROR_FINGERPRINT_SQL} AS name,
  count() AS count,
  'error_type' AS facetType
FROM error_spans
WHERE ${where}
GROUP BY name
ORDER BY count DESC
LIMIT 50
)
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<ErrorsFacetsOutput>,
  }
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
