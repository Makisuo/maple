// ---------------------------------------------------------------------------
// Typed Logs Queries
//
// DSL-based query definitions for logs timeseries and breakdown.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery, type ColumnAccessor } from "../query"
import { unionAll, type CHUnionQuery } from "../union"
import { Logs } from "../tables"

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
  return from(Logs)
    .select(($) => ({
      name: opts.groupBy === "severity" ? $.SeverityText : $.ServiceName,
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
      CH.when(opts.search, (v: string) => $.Body.ilike(`%${v}%`)),
    ])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}

// ---------------------------------------------------------------------------
// List query
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

type LogsListParams = { orgId: string; startTime: string; endTime: string }

export function logsListQuery(
  opts: LogsListOpts,
): CHQuery<any, LogsListOutput, LogsListParams> {
  return from(Logs)
    .select(($) => ({
      timestamp: $.Timestamp,
      severityText: $.SeverityText,
      severityNumber: $.SeverityNumber,
      serviceName: $.ServiceName,
      body: $.Body,
      traceId: $.TraceId,
      spanId: $.SpanId,
      logAttributes: CH.toJSONString($.LogAttributes),
      resourceAttributes: CH.toJSONString($.ResourceAttributes),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
      CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
      CH.when(opts.minSeverity, (v: number) => $.SeverityNumber.gte(v)),
      CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
      CH.when(opts.spanId, (v: string) => $.SpanId.eq(v)),
      CH.when(opts.cursor, (v: string) => $.Timestamp.lt(v)),
      CH.when(opts.search, (v: string) => $.Body.ilike(`%${v}%`)),
    ])
    .orderBy(["timestamp", "desc"])
    .limit(opts.limit ?? 50)
    .format("JSON")
    .withParams<LogsListParams>()
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
      errorLogs: CH.countIf(CH.inList($.SeverityText, ["ERROR", "FATAL"])),
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
// Logs facets (UNION ALL — severity + service facets)
// ---------------------------------------------------------------------------

export interface LogsFacetsOutput {
  readonly severityText: string
  readonly serviceName: string
  readonly count: number
  readonly facetType: string
}

type LogsFacetsParams = { orgId: string; startTime: string; endTime: string }

export function logsFacetsQuery(
  opts: LogsQueryOpts,
): CHUnionQuery<LogsFacetsOutput, LogsFacetsParams> {
  const baseWhere = ($: ColumnAccessor<typeof Logs.columns>): Array<CH.Condition | undefined> => [
    $.OrgId.eq(param.string("orgId")),
    $.Timestamp.gte(param.dateTime("startTime")),
    $.Timestamp.lte(param.dateTime("endTime")),
    CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
    CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
  ]

  const severityQuery = from(Logs)
    .select(($) => ({
      severityText: $.SeverityText,
      serviceName: CH.lit(""),
      count: CH.count(),
      facetType: CH.lit("severity"),
    }))
    .where(baseWhere)
    .groupBy("severityText")
    .withParams<LogsFacetsParams>()

  const serviceQuery = from(Logs)
    .select(($) => ({
      severityText: CH.lit(""),
      serviceName: $.ServiceName,
      count: CH.count(),
      facetType: CH.lit("service"),
    }))
    .where(baseWhere)
    .groupBy("serviceName")
    .withParams<LogsFacetsParams>()

  return unionAll(severityQuery, serviceQuery)
    .orderBy(["count", "desc"])
    .format("JSON")
}
