// ---------------------------------------------------------------------------
// Typed Metrics Queries
//
// DSL-based query definitions for metrics timeseries, breakdown, and
// a raw-SQL builder for counter rate/increase (which requires CTEs).
// ---------------------------------------------------------------------------

import type { MetricType } from "../../query-engine"
import * as CH from "../expr"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import {
  MetricsSum,
  MetricsGauge,
  MetricsHistogram,
  MetricsExpHistogram,
} from "../tables"
import { escapeClickHouseString } from "../../sql/sql-fragment"
import type { CompiledQuery } from "../compile"

// ---------------------------------------------------------------------------
// Table lookup
// ---------------------------------------------------------------------------

const VALUE_TABLES = {
  sum: MetricsSum,
  gauge: MetricsGauge,
} as const

const HISTOGRAM_TABLES = {
  histogram: MetricsHistogram,
  exponential_histogram: MetricsExpHistogram,
} as const

// ---------------------------------------------------------------------------
// Shared options & output types
// ---------------------------------------------------------------------------

interface MetricsQueryOpts {
  metricType: MetricType
  serviceName?: string
  groupByAttributeKey?: string
  attributeKey?: string
  attributeValue?: string
}

export interface MetricsTimeseriesOpts extends MetricsQueryOpts {}

export interface MetricsTimeseriesOutput {
  readonly bucket: string
  readonly serviceName: string
  readonly attributeValue: string
  readonly avgValue: number
  readonly minValue: number
  readonly maxValue: number
  readonly sumValue: number
  readonly dataPointCount: number
}

type MetricsTimeseriesParams = {
  orgId: string
  metricName: string
  startTime: string
  endTime: string
  bucketSeconds: number
}

// ---------------------------------------------------------------------------
// Timeseries query — handles all 4 metric types
// ---------------------------------------------------------------------------

export function metricsTimeseriesQuery(
  opts: MetricsTimeseriesOpts,
): CHQuery<any, MetricsTimeseriesOutput, MetricsTimeseriesParams> {
  const isHistogram = opts.metricType === "histogram" || opts.metricType === "exponential_histogram"

  if (isHistogram) {
    return buildHistogramTimeseries(opts)
  }
  return buildValueTimeseries(opts)
}

function buildValueTimeseries(
  opts: MetricsTimeseriesOpts,
): CHQuery<any, MetricsTimeseriesOutput, MetricsTimeseriesParams> {
  const tbl = VALUE_TABLES[opts.metricType as keyof typeof VALUE_TABLES]

  const q = from(tbl as typeof MetricsSum)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
      serviceName: $.ServiceName,
      attributeValue: opts.groupByAttributeKey
        ? $.Attributes.get(opts.groupByAttributeKey)
        : CH.lit(""),
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
      CH.when(opts.attributeKey, (k: string) =>
        CH.rawCond(`Attributes['${escapeClickHouseString(k)}'] = '${escapeClickHouseString(opts.attributeValue ?? '')}'`),
      ),
    ])

  return (opts.groupByAttributeKey
    ? q.groupBy("bucket", "serviceName", "attributeValue")
    : q.groupBy("bucket", "serviceName")
  )
    .orderBy(["bucket", "asc"])
    .format("JSON")
    .withParams<MetricsTimeseriesParams>()
}

function buildHistogramTimeseries(
  opts: MetricsTimeseriesOpts,
): CHQuery<any, MetricsTimeseriesOutput, MetricsTimeseriesParams> {
  const tbl = HISTOGRAM_TABLES[opts.metricType as keyof typeof HISTOGRAM_TABLES]

  const q = from(tbl as typeof MetricsHistogram)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
      serviceName: $.ServiceName,
      attributeValue: opts.groupByAttributeKey
        ? $.Attributes.get(opts.groupByAttributeKey)
        : CH.lit(""),
      avgValue: CH.rawExpr<number>("if(sum(Count) > 0, sum(Sum) / sum(Count), 0)"),
      minValue: CH.rawExpr<number>("min(Min)"),
      maxValue: CH.rawExpr<number>("max(Max)"),
      sumValue: CH.rawExpr<number>("sum(Sum)"),
      dataPointCount: CH.rawExpr<number>("sum(Count)"),
    }))
    .where(($) => [
      $.MetricName.eq(param.string("metricName")),
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
      CH.when(opts.attributeKey, (k: string) =>
        CH.rawCond(`Attributes['${escapeClickHouseString(k)}'] = '${escapeClickHouseString(opts.attributeValue ?? '')}'`),
      ),
    ])

  return (opts.groupByAttributeKey
    ? q.groupBy("bucket", "serviceName", "attributeValue")
    : q.groupBy("bucket", "serviceName")
  )
    .orderBy(["bucket", "asc"])
    .format("JSON")
    .withParams<MetricsTimeseriesParams>()
}

// ---------------------------------------------------------------------------
// Rate/increase timeseries — raw SQL (requires CTE)
// ---------------------------------------------------------------------------

export interface MetricsRateTimeseriesOpts {
  serviceName?: string
  groupByAttributeKey?: string
  attributeKey?: string
  attributeValue?: string
}

export interface MetricsRateTimeseriesOutput {
  readonly bucket: string
  readonly serviceName: string
  readonly attributeValue: string
  readonly rateValue: number
  readonly increaseValue: number
  readonly dataPointCount: number
}

type MetricsRateTimeseriesParams = {
  orgId: string
  metricName: string
  startTime: string
  endTime: string
  bucketSeconds: number
}

export function metricsTimeseriesRateSQL(
  opts: MetricsRateTimeseriesOpts,
  params: MetricsRateTimeseriesParams,
): CompiledQuery<MetricsRateTimeseriesOutput> {
  const esc = escapeClickHouseString
  const bucketSeconds = Math.round(params.bucketSeconds)

  // CTE WHERE clauses
  const cteWhereFragments = [
    `MetricName = '${esc(params.metricName)}'`,
    `OrgId = '${esc(params.orgId)}'`,
    `IsMonotonic = 1`,
    `TimeUnix >= '${esc(params.startTime)}' - INTERVAL ${bucketSeconds} SECOND`,
    `TimeUnix <= '${esc(params.endTime)}'`,
  ]
  if (opts.serviceName) {
    cteWhereFragments.push(`ServiceName = '${esc(opts.serviceName)}'`)
  }
  if (opts.attributeKey) {
    cteWhereFragments.push(
      `Attributes['${esc(opts.attributeKey)}'] = '${esc(opts.attributeValue ?? '')}'`,
    )
  }

  // Outer SELECT attribute column
  const attributeSelect = opts.groupByAttributeKey
    ? `Attributes['${esc(opts.groupByAttributeKey)}'] AS attributeValue`
    : `'' AS attributeValue`

  // Outer GROUP BY
  const groupByParts = ["bucket", "ServiceName"]
  if (opts.groupByAttributeKey) {
    groupByParts.push(`Attributes['${esc(opts.groupByAttributeKey)}']`)
  }

  const sql = `
WITH with_deltas AS (
  SELECT
    TimeUnix,
    ServiceName,
    Attributes,
    Value,
    Value - lagInFrame(Value, 1, Value) OVER (
      PARTITION BY ServiceName, MetricName, Attributes
      ORDER BY TimeUnix ASC
    ) AS delta,
    toFloat64(
      toUnixTimestamp64Nano(TimeUnix) - toUnixTimestamp64Nano(
        lagInFrame(TimeUnix, 1, TimeUnix) OVER (
          PARTITION BY ServiceName, MetricName, Attributes
          ORDER BY TimeUnix ASC
        )
      )
    ) / 1000000000.0 AS time_delta
  FROM metrics_sum
  WHERE ${cteWhereFragments.join("\n    AND ")}
)
SELECT
  toStartOfInterval(TimeUnix, INTERVAL ${bucketSeconds} SECOND) AS bucket,
  ServiceName AS serviceName,
  ${attributeSelect},
  sumIf(delta / time_delta, delta >= 0 AND time_delta > 0) AS rateValue,
  sumIf(delta, delta >= 0) AS increaseValue,
  count() AS dataPointCount
FROM with_deltas
WHERE TimeUnix >= '${esc(params.startTime)}'
GROUP BY ${groupByParts.join(", ")}
ORDER BY bucket ASC
FORMAT JSON
`.trim()

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<MetricsRateTimeseriesOutput>,
  }
}

// ---------------------------------------------------------------------------
// Breakdown query
// ---------------------------------------------------------------------------

export interface MetricsBreakdownOpts {
  metricType: MetricType
  limit?: number
}

export interface MetricsBreakdownOutput {
  readonly name: string
  readonly avgValue: number
  readonly sumValue: number
  readonly count: number
}

type MetricsBreakdownParams = {
  orgId: string
  metricName: string
  startTime: string
  endTime: string
}

export function metricsBreakdownQuery(
  opts: MetricsBreakdownOpts,
): CHQuery<any, MetricsBreakdownOutput, MetricsBreakdownParams> {
  const isHistogram = opts.metricType === "histogram" || opts.metricType === "exponential_histogram"
  const limit = opts.limit ?? 10

  if (isHistogram) {
    return buildHistogramBreakdown(opts, limit)
  }
  return buildValueBreakdown(opts, limit)
}

function buildValueBreakdown(
  opts: MetricsBreakdownOpts,
  limit: number,
): CHQuery<any, MetricsBreakdownOutput, MetricsBreakdownParams> {
  const tbl = VALUE_TABLES[opts.metricType as keyof typeof VALUE_TABLES]

  return from(tbl as typeof MetricsSum)
    .select(($) => ({
      name: $.ServiceName,
      avgValue: CH.avg($.Value),
      sumValue: CH.sum($.Value),
      count: CH.count(),
    }))
    .where(($) => [
      $.MetricName.eq(param.string("metricName")),
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
    ])
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(limit)
    .format("JSON")
    .withParams<MetricsBreakdownParams>()
}

function buildHistogramBreakdown(
  opts: MetricsBreakdownOpts,
  limit: number,
): CHQuery<any, MetricsBreakdownOutput, MetricsBreakdownParams> {
  const tbl = HISTOGRAM_TABLES[opts.metricType as keyof typeof HISTOGRAM_TABLES]

  return from(tbl as typeof MetricsHistogram)
    .select(($) => ({
      name: $.ServiceName,
      avgValue: CH.rawExpr<number>("if(sum(Count) > 0, sum(Sum) / sum(Count), 0)"),
      sumValue: CH.rawExpr<number>("sum(Sum)"),
      count: CH.rawExpr<number>("sum(Count)"),
    }))
    .where(($) => [
      $.MetricName.eq(param.string("metricName")),
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
    ])
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(limit)
    .format("JSON")
    .withParams<MetricsBreakdownParams>()
}
