// ---------------------------------------------------------------------------
// Typed Alert Aggregate Queries
//
// DSL-based query definitions for alert evaluation. These replace the
// legacy Tinybird named pipes: alert_traces_aggregate, alert_metrics_aggregate,
// alert_logs_aggregate, and their *_by_service variants.
// ---------------------------------------------------------------------------

import type { MetricType } from "../../query-engine"
import * as CH from "../expr"
import { param } from "../param"
import { from, type ColumnAccessor } from "../query"
import { Traces, Logs, MetricsSum } from "../tables"
import {
  apdexExprs,
  tracesBaseWhereConditions,
  type TracesBaseWhereOpts,
  resolveMetricTable,
  metricsSelectExprs,
} from "./query-helpers"

// ---------------------------------------------------------------------------
// Traces alert aggregate
// ---------------------------------------------------------------------------

export interface AlertTracesOpts extends TracesBaseWhereOpts {
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


function alertTracesSelectExprs($: ColumnAccessor<typeof Traces.columns>, apdexThresholdMs: number) {
  return {
    count: CH.count(),
    avgDuration: CH.avg($.Duration).div(1000000),
    p50Duration: CH.quantile(0.5)($.Duration).div(1000000),
    p95Duration: CH.quantile(0.95)($.Duration).div(1000000),
    p99Duration: CH.quantile(0.99)($.Duration).div(1000000),
    errorRate: CH.if_(CH.count().gt(0), CH.countIf($.StatusCode.eq("Error")).mul(100.0).div(CH.count()), CH.lit(0)),
    ...apdexExprs($.Duration.div(1000000), apdexThresholdMs),
  }
}

function alertTracesWhereConditions(
  $: ColumnAccessor<typeof Traces.columns>,
  opts: AlertTracesOpts,
): Array<CH.Condition | undefined> {
  return tracesBaseWhereConditions($, opts)
}

export function alertTracesAggregateQuery(
  opts: AlertTracesOpts,
) {
  const threshold = opts.apdexThresholdMs ?? 500

  return from(Traces)
    .select(($) => alertTracesSelectExprs($, threshold))
    .where(($) => alertTracesWhereConditions($, opts))
    .format("JSON")
}

export function alertTracesAggregateByServiceQuery(
  opts: AlertTracesOpts,
) {
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


function metricsAlertWhere(opts: AlertMetricsOpts) {
  return ($: ColumnAccessor<typeof MetricsSum.columns>) => [
    $.MetricName.eq(param.string("metricName")),
    $.OrgId.eq(param.string("orgId")),
    $.TimeUnix.gte(param.dateTime("startTime")),
    $.TimeUnix.lte(param.dateTime("endTime")),
    CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
  ] as Array<CH.Condition | undefined>
}

export function alertMetricsAggregateQuery(
  opts: AlertMetricsOpts,
) {
  const { tbl, isHistogram } = resolveMetricTable(opts.metricType)

  return from(tbl as typeof MetricsSum)
    .select(($) => metricsSelectExprs($, isHistogram))
    .where(metricsAlertWhere(opts))
    .format("JSON")
}

export function alertMetricsAggregateByServiceQuery(
  opts: AlertMetricsOpts,
) {
  const { tbl, isHistogram } = resolveMetricTable(opts.metricType)

  return from(tbl as typeof MetricsSum)
    .select(($) => ({
      serviceName: $.ServiceName,
      ...metricsSelectExprs($, isHistogram),
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
) {
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
}

export function alertLogsAggregateByServiceQuery(
  opts: AlertLogsOpts,
) {
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
}
