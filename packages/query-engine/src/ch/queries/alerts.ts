// ---------------------------------------------------------------------------
// Typed Alert Aggregate Queries
//
// DSL-based query definitions for alert evaluation. These replace the
// legacy Tinybird named pipes: alert_traces_aggregate, alert_metrics_aggregate,
// alert_logs_aggregate, and their *_by_service variants.
// ---------------------------------------------------------------------------

import type { AttributeFilter, MetricType } from "../../query-engine"
import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import {
  Traces,
  Logs,
  MetricsSum,
  MetricsGauge,
  MetricsHistogram,
  MetricsExpHistogram,
} from "../tables"
import { buildAttrFilterSQL, TRACE_LIST_MV_ATTR_MAP, TRACE_LIST_MV_RESOURCE_MAP } from "../../traces-shared"

// ---------------------------------------------------------------------------
// Traces alert aggregate
// ---------------------------------------------------------------------------

export interface AlertTracesOpts {
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

export interface AlertTracesAggregateOutput {
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

export interface AlertTracesAggregateByServiceOutput extends AlertTracesAggregateOutput {
  readonly serviceName: string
}

type AlertTracesParams = { orgId: string; startTime: string; endTime: string }

function alertTracesSelectExprs($: any, apdexThresholdMs: number) {
  const t = apdexThresholdMs
  return {
    count: CH.count(),
    avgDuration: CH.avg($.Duration).div(1000000),
    p50Duration: CH.quantile(0.5)($.Duration).div(1000000),
    p95Duration: CH.quantile(0.95)($.Duration).div(1000000),
    p99Duration: CH.quantile(0.99)($.Duration).div(1000000),
    errorRate: CH.rawExpr<number>(`if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0)`),
    satisfiedCount: CH.countIf($.Duration.div(1000000).lt(t)),
    toleratingCount: CH.countIf($.Duration.div(1000000).gte(t).and($.Duration.div(1000000).lt(t * 4))),
    apdexScore: CH.rawExpr<number>(
      `if(count() > 0, round((countIf(Duration / 1000000 < ${t}) + countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) * 0.5) / count(), 4), 0)`,
    ),
  }
}

function alertTracesWhereConditions(
  $: any,
  opts: AlertTracesOpts,
): Array<CH.Condition | undefined> {
  const conditions: Array<CH.Condition | undefined> = [
    $.OrgId.eq(param.string("orgId")),
    $.Timestamp.gte(param.dateTime("startTime")),
    $.Timestamp.lte(param.dateTime("endTime")),
    CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
    CH.when(opts.spanName, (v: string) => $.SpanName.eq(v)),
    CH.whenTrue(!!opts.rootOnly, () =>
      CH.rawCond("(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')"),
    ),
    CH.whenTrue(!!opts.errorsOnly, () => $.StatusCode.eq("Error")),
  ]

  if (opts.environments?.length) {
    conditions.push(CH.inList($.ResourceAttributes.get("deployment.environment"), opts.environments))
  }
  if (opts.commitShas?.length) {
    conditions.push(CH.inList($.ResourceAttributes.get("deployment.commit_sha"), opts.commitShas))
  }
  if (opts.attributeFilters) {
    for (const af of opts.attributeFilters) {
      conditions.push(CH.rawCond(buildAttrFilterSQL(af, false, "SpanAttributes", TRACE_LIST_MV_ATTR_MAP)))
    }
  }
  if (opts.resourceAttributeFilters) {
    for (const rf of opts.resourceAttributeFilters) {
      conditions.push(CH.rawCond(buildAttrFilterSQL(rf, false, "ResourceAttributes", TRACE_LIST_MV_RESOURCE_MAP)))
    }
  }

  return conditions
}

export function alertTracesAggregateQuery(
  opts: AlertTracesOpts,
): CHQuery<any, AlertTracesAggregateOutput, AlertTracesParams> {
  const threshold = opts.apdexThresholdMs ?? 500

  return from(Traces)
    .select(($) => alertTracesSelectExprs($, threshold))
    .where(($) => alertTracesWhereConditions($, opts))
    .format("JSON")
    .withParams<AlertTracesParams>()
}

export function alertTracesAggregateByServiceQuery(
  opts: AlertTracesOpts,
): CHQuery<any, AlertTracesAggregateByServiceOutput, AlertTracesParams> {
  const threshold = opts.apdexThresholdMs ?? 500

  return from(Traces)
    .select(($) => ({
      serviceName: $.ServiceName,
      ...alertTracesSelectExprs($, threshold),
    }))
    .where(($) => alertTracesWhereConditions($, opts))
    .groupBy("serviceName")
    .orderBy(["count", "desc"])
    .format("JSON")
    .withParams<AlertTracesParams>()
}

// ---------------------------------------------------------------------------
// Metrics alert aggregate
// ---------------------------------------------------------------------------

export interface AlertMetricsOpts {
  metricType: MetricType
  serviceName?: string
}

export interface AlertMetricsAggregateOutput {
  readonly avgValue: number
  readonly minValue: number
  readonly maxValue: number
  readonly sumValue: number
  readonly dataPointCount: number
}

export interface AlertMetricsAggregateByServiceOutput extends AlertMetricsAggregateOutput {
  readonly serviceName: string
}

type AlertMetricsParams = { orgId: string; metricName: string; startTime: string; endTime: string }

const VALUE_TABLES = {
  sum: MetricsSum,
  gauge: MetricsGauge,
} as const

const HISTOGRAM_TABLES = {
  histogram: MetricsHistogram,
  exponential_histogram: MetricsExpHistogram,
} as const

function buildValueMetricsAggregate(
  opts: AlertMetricsOpts,
): CHQuery<any, AlertMetricsAggregateOutput, AlertMetricsParams> {
  const tbl = VALUE_TABLES[opts.metricType as keyof typeof VALUE_TABLES]

  return from(tbl as typeof MetricsSum)
    .select(($) => ({
      avgValue: CH.avg($.Value),
      minValue: CH.min_($.Value),
      maxValue: CH.max_($.Value),
      sumValue: CH.sum($.Value),
      dataPointCount: CH.count(),
    }))
    .where(($) => [
      $.MetricName.eq(param.string("metricName")),
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
    ])
    .format("JSON")
    .withParams<AlertMetricsParams>()
}

function buildHistogramMetricsAggregate(
  opts: AlertMetricsOpts,
): CHQuery<any, AlertMetricsAggregateOutput, AlertMetricsParams> {
  const tbl = HISTOGRAM_TABLES[opts.metricType as keyof typeof HISTOGRAM_TABLES]

  return from(tbl as typeof MetricsHistogram)
    .select(($) => ({
      avgValue: CH.if_(CH.sum($.Count).gt(0), CH.sum($.Sum).div(CH.sum($.Count)), CH.lit(0)),
      minValue: CH.min_($.Min) as unknown as CH.Expr<number>,
      maxValue: CH.max_($.Max) as unknown as CH.Expr<number>,
      sumValue: CH.sum($.Sum),
      dataPointCount: CH.sum($.Count),
    }))
    .where(($) => [
      $.MetricName.eq(param.string("metricName")),
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
    ])
    .format("JSON")
    .withParams<AlertMetricsParams>()
}

function buildValueMetricsAggregateByService(
  opts: AlertMetricsOpts,
): CHQuery<any, AlertMetricsAggregateByServiceOutput, AlertMetricsParams> {
  const tbl = VALUE_TABLES[opts.metricType as keyof typeof VALUE_TABLES]

  return from(tbl as typeof MetricsSum)
    .select(($) => ({
      serviceName: $.ServiceName,
      avgValue: CH.avg($.Value),
      minValue: CH.min_($.Value),
      maxValue: CH.max_($.Value),
      sumValue: CH.sum($.Value),
      dataPointCount: CH.count(),
    }))
    .where(($) => [
      $.MetricName.eq(param.string("metricName")),
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
    ])
    .groupBy("serviceName")
    .orderBy(["dataPointCount", "desc"])
    .format("JSON")
    .withParams<AlertMetricsParams>()
}

function buildHistogramMetricsAggregateByService(
  opts: AlertMetricsOpts,
): CHQuery<any, AlertMetricsAggregateByServiceOutput, AlertMetricsParams> {
  const tbl = HISTOGRAM_TABLES[opts.metricType as keyof typeof HISTOGRAM_TABLES]

  return from(tbl as typeof MetricsHistogram)
    .select(($) => ({
      serviceName: $.ServiceName,
      avgValue: CH.if_(CH.sum($.Count).gt(0), CH.sum($.Sum).div(CH.sum($.Count)), CH.lit(0)),
      minValue: CH.min_($.Min) as unknown as CH.Expr<number>,
      maxValue: CH.max_($.Max) as unknown as CH.Expr<number>,
      sumValue: CH.sum($.Sum),
      dataPointCount: CH.sum($.Count),
    }))
    .where(($) => [
      $.MetricName.eq(param.string("metricName")),
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
    ])
    .groupBy("serviceName")
    .orderBy(["dataPointCount", "desc"])
    .format("JSON")
    .withParams<AlertMetricsParams>()
}

export function alertMetricsAggregateQuery(
  opts: AlertMetricsOpts,
): CHQuery<any, AlertMetricsAggregateOutput, AlertMetricsParams> {
  const isHistogram = opts.metricType === "histogram" || opts.metricType === "exponential_histogram"
  return isHistogram ? buildHistogramMetricsAggregate(opts) : buildValueMetricsAggregate(opts)
}

export function alertMetricsAggregateByServiceQuery(
  opts: AlertMetricsOpts,
): CHQuery<any, AlertMetricsAggregateByServiceOutput, AlertMetricsParams> {
  const isHistogram = opts.metricType === "histogram" || opts.metricType === "exponential_histogram"
  return isHistogram ? buildHistogramMetricsAggregateByService(opts) : buildValueMetricsAggregateByService(opts)
}

// ---------------------------------------------------------------------------
// Logs alert aggregate
// ---------------------------------------------------------------------------

export interface AlertLogsOpts {
  serviceName?: string
  severity?: string
}

export interface AlertLogsAggregateOutput {
  readonly count: number
}

export interface AlertLogsAggregateByServiceOutput extends AlertLogsAggregateOutput {
  readonly serviceName: string
}

export function alertLogsAggregateQuery(
  opts: AlertLogsOpts,
): CHQuery<any, AlertLogsAggregateOutput, { orgId: string; startTime: string; endTime: string }> {
  return from(Logs)
    .select(() => ({
      count: CH.count(),
    }))
    .where(({ OrgId, Timestamp, ServiceName, SeverityText }) => [
      OrgId.eq(param.string("orgId")),
      Timestamp.gte(param.dateTime("startTime")),
      Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => ServiceName.eq(v)),
      CH.when(opts.severity, (v: string) => SeverityText.eq(v)),
    ])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}

export function alertLogsAggregateByServiceQuery(
  opts: AlertLogsOpts,
): CHQuery<any, AlertLogsAggregateByServiceOutput, { orgId: string; startTime: string; endTime: string }> {
  return from(Logs)
    .select(({ ServiceName }) => ({
      serviceName: ServiceName,
      count: CH.count(),
    }))
    .where(({ OrgId, Timestamp, SeverityText }) => [
      OrgId.eq(param.string("orgId")),
      Timestamp.gte(param.dateTime("startTime")),
      Timestamp.lte(param.dateTime("endTime")),
      CH.when(opts.severity, (v: string) => SeverityText.eq(v)),
    ])
    .groupBy("serviceName")
    .orderBy(["count", "desc"])
    .format("JSON")
    .withParams<{ orgId: string; startTime: string; endTime: string }>()
}
