// ---------------------------------------------------------------------------
// Typed Logs Queries
//
// DSL-based query definitions for logs timeseries and breakdown.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import { Logs } from "../tables"
import { escapeClickHouseString } from "../../sql/sql-fragment"
import type { CompiledQuery } from "../compile"

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

interface LogsQueryOpts {
  serviceName?: string
  severity?: string
  traceId?: string
  search?: string
}

// ---------------------------------------------------------------------------
// Timeseries query
// ---------------------------------------------------------------------------

export interface LogsTimeseriesOpts extends LogsQueryOpts {
  groupBy?: readonly string[]
}

export interface LogsTimeseriesOutput {
  readonly bucket: string
  readonly groupName: string
  readonly count: number
}

export function logsTimeseriesQuery(
  opts: LogsTimeseriesOpts,
): CHQuery<any, LogsTimeseriesOutput, { orgId: string; startTime: string; endTime: string; bucketSeconds: number }> {
  const groupByService = opts.groupBy?.includes("service")
  const groupBySeverity = opts.groupBy?.includes("severity")

  const groupNameExpr = buildLogsGroupNameExpr(groupByService, groupBySeverity)

  return from(Logs)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      groupName: groupNameExpr,
      count: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
      CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
    ])
    .groupBy("bucket", "groupName")
    .orderBy(["bucket", "asc"], ["groupName", "asc"])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string; bucketSeconds: number }>()
}

function buildLogsGroupNameExpr(
  groupByService?: boolean,
  groupBySeverity?: boolean,
): CH.Expr<string> {
  if (!groupByService && !groupBySeverity) {
    return CH.lit("all")
  }

  const parts: string[] = []
  if (groupByService) parts.push("toString(ServiceName)")
  if (groupBySeverity) parts.push("toString(SeverityText)")

  if (parts.length === 1) {
    return CH.rawExpr<string>(`coalesce(nullIf(${parts[0]}, ''), 'all')`)
  }

  return CH.rawExpr<string>(
    `coalesce(nullIf(arrayStringConcat(arrayFilter(x -> x != '', [${parts.join(", ")}]), ' \u00b7 '), ''), 'all')`,
  )
}

// ---------------------------------------------------------------------------
// Breakdown query
// ---------------------------------------------------------------------------

export interface LogsBreakdownOpts extends LogsQueryOpts {
  groupBy: "service" | "severity"
  limit?: number
}

export interface LogsBreakdownOutput {
  readonly name: string
  readonly count: number
}

export function logsBreakdownQuery(
  opts: LogsBreakdownOpts,
): CHQuery<any, LogsBreakdownOutput, { orgId: string; startTime: string; endTime: string }> {
  const nameExpr = opts.groupBy === "severity"
    ? CH.rawExpr<string>("SeverityText")
    : CH.rawExpr<string>("ServiceName")

  return from(Logs)
    .select(() => ({
      name: nameExpr,
      count: CH.count(),
    }))
    .where(({ OrgId, Timestamp, ServiceName, SeverityText }) => [
      OrgId.eq(param.string("orgId")),
      Timestamp.gte(param.dateTime("startTime")),
      Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => ServiceName.eq(v)),
      CH.when(opts.severity, (v: string) => SeverityText.eq(v)),
    ])
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(opts.limit ?? 10)
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}

// ---------------------------------------------------------------------------
// Count query
// ---------------------------------------------------------------------------

export interface LogsCountOutput {
  readonly total: number
}

export function logsCountQuery(
  opts: LogsQueryOpts,
): CHQuery<any, LogsCountOutput, { orgId: string; startTime: string; endTime: string }> {
  return from(Logs)
    .select(() => ({
      total: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
      CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
      CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
      CH.when(opts.search, (v: string) =>
        CH.rawCond(`Body ILIKE '%${escapeClickHouseString(v)}%'`),
      ),
    ])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}

// ---------------------------------------------------------------------------
// List query (raw SQL — needs toJSONString, ILIKE, cursor pagination)
// ---------------------------------------------------------------------------

export interface LogsListOpts extends LogsQueryOpts {
  minSeverity?: number
  spanId?: string
  cursor?: string
  limit?: number
}

export interface LogsListOutput {
  readonly timestamp: string
  readonly severityText: string
  readonly severityNumber: number
  readonly serviceName: string
  readonly body: string
  readonly traceId: string
  readonly spanId: string
  readonly logAttributes: string
  readonly resourceAttributes: string
}

export function logsListSQL(
  opts: LogsListOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<LogsListOutput> {
  const esc = escapeClickHouseString
  const conditions: string[] = [
    `OrgId = '${esc(params.orgId)}'`,
    `Timestamp >= '${esc(params.startTime)}'`,
    `Timestamp <= '${esc(params.endTime)}'`,
  ]
  if (opts.serviceName) conditions.push(`ServiceName = '${esc(opts.serviceName)}'`)
  if (opts.severity) conditions.push(`SeverityText = '${esc(opts.severity)}'`)
  if (opts.minSeverity != null) conditions.push(`SeverityNumber >= ${Math.round(opts.minSeverity)}`)
  if (opts.traceId) conditions.push(`TraceId = '${esc(opts.traceId)}'`)
  if (opts.spanId) conditions.push(`SpanId = '${esc(opts.spanId)}'`)
  if (opts.cursor) conditions.push(`Timestamp < '${esc(opts.cursor)}'`)
  if (opts.search) conditions.push(`Body ILIKE '%${esc(opts.search)}%'`)

  const sql = `SELECT
  Timestamp AS timestamp,
  SeverityText AS severityText,
  SeverityNumber AS severityNumber,
  ServiceName AS serviceName,
  Body AS body,
  TraceId AS traceId,
  SpanId AS spanId,
  toJSONString(LogAttributes) AS logAttributes,
  toJSONString(ResourceAttributes) AS resourceAttributes
FROM logs
WHERE ${conditions.join("\n  AND ")}
ORDER BY Timestamp DESC
LIMIT ${Math.round(opts.limit ?? 50)}
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<LogsListOutput>,
  }
}

// ---------------------------------------------------------------------------
// Error rate by service
// ---------------------------------------------------------------------------

export interface ErrorRateByServiceOutput {
  readonly serviceName: string
  readonly totalLogs: number
  readonly errorLogs: number
  readonly errorRatePercent: number
}

export function errorRateByServiceQuery(
): CHQuery<any, ErrorRateByServiceOutput, { orgId: string; startTime: string; endTime: string }> {
  return from(Logs)
    .select(($) => ({
      serviceName: $.ServiceName,
      totalLogs: CH.count(),
      errorLogs: CH.countIf(CH.rawCond("SeverityText IN ('ERROR', 'FATAL')")),
      errorRatePercent: CH.rawExpr<number>("round(countIf(SeverityText IN ('ERROR', 'FATAL')) / count() * 100, 2)"),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
    ])
    .groupBy("serviceName")
    .orderBy(["errorRatePercent", "desc"])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}

// ---------------------------------------------------------------------------
// Logs facets (raw SQL — 2 UNION ALL subqueries)
// ---------------------------------------------------------------------------

export interface LogsFacetsOutput {
  readonly severityText: string
  readonly serviceName: string
  readonly count: number
  readonly facetType: string
}

export function logsFacetsSQL(
  opts: LogsQueryOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<LogsFacetsOutput> {
  const esc = escapeClickHouseString
  const baseWhere = [
    `OrgId = '${esc(params.orgId)}'`,
    `Timestamp >= '${esc(params.startTime)}'`,
    `Timestamp <= '${esc(params.endTime)}'`,
  ]
  if (opts.serviceName) baseWhere.push(`ServiceName = '${esc(opts.serviceName)}'`)
  if (opts.severity) baseWhere.push(`SeverityText = '${esc(opts.severity)}'`)
  const where = baseWhere.join(" AND ")

  const sql = `SELECT severityText, serviceName, count, facetType FROM (
SELECT
  SeverityText AS severityText,
  '' AS serviceName,
  count() AS count,
  'severity' AS facetType
FROM logs
WHERE ${where}
GROUP BY severityText

UNION ALL

SELECT
  '' AS severityText,
  ServiceName AS serviceName,
  count() AS count,
  'service' AS facetType
FROM logs
WHERE ${where}
GROUP BY serviceName
)
ORDER BY count DESC
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<LogsFacetsOutput>,
  }
}
