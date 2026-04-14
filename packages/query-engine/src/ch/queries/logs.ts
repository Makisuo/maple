// ---------------------------------------------------------------------------
// Typed Logs Queries
//
// DSL-based query definitions for logs timeseries and breakdown.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from, type ColumnAccessor } from "../query"
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
  environments?: readonly string[]
  matchModes?: {
    deploymentEnv?: "contains"
  }
}

function environmentCondition(
  $: ColumnAccessor<typeof Logs.columns>,
  opts: LogsQueryOpts,
): CH.Condition | undefined {
  if (!opts.environments?.length) return undefined
  const envAttr = $.ResourceAttributes.get("deployment.environment")
  if (opts.matchModes?.deploymentEnv === "contains" && opts.environments.length === 1) {
    return CH.positionCaseInsensitive(envAttr, CH.lit(opts.environments[0]!)).gt(0)
  }
  return CH.inList(envAttr, opts.environments)
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
) {
  const groupByService = opts.groupBy?.includes("service")
  const groupBySeverity = opts.groupBy?.includes("severity")

  return from(Logs)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      groupName: buildLogsGroupNameExpr($, groupByService, groupBySeverity),
      count: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
      CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
      environmentCondition($, opts),
    ])
    .groupBy("bucket", "groupName")
    .orderBy(["bucket", "asc"], ["groupName", "asc"])
    .format("JSON")
}

function buildLogsGroupNameExpr(
  $: { ServiceName: CH.Expr<string>; SeverityText: CH.Expr<string> },
  groupByService?: boolean,
  groupBySeverity?: boolean,
): CH.Expr<string> {
  if (!groupByService && !groupBySeverity) {
    return CH.lit("all")
  }

  const parts: CH.Expr<string>[] = []
  if (groupByService) parts.push(CH.toString_($.ServiceName))
  if (groupBySeverity) parts.push(CH.toString_($.SeverityText))

  if (parts.length === 1) {
    return CH.coalesce(CH.nullIf(parts[0]!, ""), CH.lit("all"))
  }

  // Multi-part: filter empty strings before joining with separator
  const filtered = CH.arrayFilter("x -> x != ''", CH.arrayOf(...parts))
  return CH.coalesce(
    CH.nullIf(CH.arrayStringConcat(filtered, " \u00b7 "), ""),
    CH.lit("all"),
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
) {
  return from(Logs)
    .select(($) => ({
      name: opts.groupBy === "severity" ? $.SeverityText : $.ServiceName,
      count: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
      CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
      environmentCondition($, opts),
    ])
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(opts.limit ?? 10)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Count query
// ---------------------------------------------------------------------------

export interface LogsCountOutput {
  readonly total: number
}

export function logsCountQuery(
  opts: LogsQueryOpts,
) {
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
      environmentCondition($, opts),
    ])
    .format("JSON")
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

export function logsListQuery(
  opts: LogsListOpts,
) {
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
      environmentCondition($, opts),
    ])
    .orderBy(["timestamp", "desc"])
    .limit(opts.limit ?? 50)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Error rate by service
// ---------------------------------------------------------------------------

export interface ErrorRateByServiceOutput {
  readonly serviceName: string
  readonly totalLogs: number
  readonly errorLogs: number
  readonly errorRate: number
}

export function errorRateByServiceQuery(
) {
  return from(Logs)
    .select(($) => ({
      serviceName: $.ServiceName,
      totalLogs: CH.count(),
      errorLogs: CH.countIf(CH.inList($.SeverityText, ["ERROR", "FATAL"])),
      errorRate: CH.round_(CH.countIf(CH.inList($.SeverityText, ["ERROR", "FATAL"])).div(CH.count()), 6),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
    ])
    .groupBy("serviceName")
    .orderBy(["errorRate", "desc"])
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Logs facets (UNION ALL — severity + service facets)
// ---------------------------------------------------------------------------

export interface LogsFacetsOutput {
  readonly severityText: string
  readonly serviceName: string
  readonly deploymentEnv: string
  readonly count: number
  readonly facetType: string
}

export function logsFacetsQuery(
  opts: LogsQueryOpts,
): CHUnionQuery<LogsFacetsOutput> {
  const baseWhere = ($: ColumnAccessor<typeof Logs.columns>): Array<CH.Condition | undefined> => [
    $.OrgId.eq(param.string("orgId")),
    $.Timestamp.gte(param.dateTime("startTime")),
    $.Timestamp.lte(param.dateTime("endTime")),
    CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
    CH.when(opts.severity, (v: string) => $.SeverityText.eq(v)),
    environmentCondition($, opts),
  ]

  const severityQuery = from(Logs)
    .select(($) => ({
      severityText: $.SeverityText,
      serviceName: CH.lit(""),
      deploymentEnv: CH.lit(""),
      count: CH.count(),
      facetType: CH.lit("severity"),
    }))
    .where(baseWhere)
    .groupBy("severityText")

  const serviceQuery = from(Logs)
    .select(($) => ({
      severityText: CH.lit(""),
      serviceName: $.ServiceName,
      deploymentEnv: CH.lit(""),
      count: CH.count(),
      facetType: CH.lit("service"),
    }))
    .where(baseWhere)
    .groupBy("serviceName")

  const envQuery = from(Logs)
    .select(($) => ({
      severityText: CH.lit(""),
      serviceName: CH.lit(""),
      deploymentEnv: $.ResourceAttributes.get("deployment.environment"),
      count: CH.count(),
      facetType: CH.lit("deploymentEnv"),
    }))
    .where(($) => [
      ...baseWhere($),
      $.ResourceAttributes.get("deployment.environment").neq(""),
    ])
    .groupBy("deploymentEnv")

  return unionAll(severityQuery, serviceQuery, envQuery)
    .orderBy(["count", "desc"])
    .format("JSON")
}
