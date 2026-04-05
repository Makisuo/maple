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

// ---------------------------------------------------------------------------
// List metrics (raw SQL — 4 UNION ALL across metric tables)
// ---------------------------------------------------------------------------

export interface ListMetricsOpts {
  serviceName?: string
  metricType?: string
  search?: string
  limit?: number
  offset?: number
}

export interface ListMetricsOutput {
  readonly metricName: string
  readonly metricType: string
  readonly serviceName: string
  readonly metricDescription: string
  readonly metricUnit: string
  readonly dataPointCount: number
  readonly firstSeen: string
  readonly lastSeen: string
  readonly isMonotonic: boolean | number
}

export function listMetricsSQL(
  opts: ListMetricsOpts,
  params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ListMetricsOutput> {
  const esc = escapeClickHouseString
  const limit = Math.round(opts.limit ?? 100)
  const offset = Math.round(opts.offset ?? 0)

  function buildMetricSubquery(
    table: string,
    metricType: string,
    hasIsMonotonic: boolean,
  ): string {
    const conditions = [
      `OrgId = '${esc(params.orgId)}'`,
      `TimeUnix >= '${esc(params.startTime)}'`,
      `TimeUnix <= '${esc(params.endTime)}'`,
    ]
    if (opts.serviceName) conditions.push(`ServiceName = '${esc(opts.serviceName)}'`)
    if (opts.search) conditions.push(`MetricName ILIKE '%${esc(opts.search)}%'`)

    return `SELECT
      MetricName AS metricName,
      '${metricType}' AS metricType,
      ServiceName AS serviceName,
      any(MetricDescription) AS metricDescription,
      any(MetricUnit) AS metricUnit,
      count() AS dataPointCount,
      min(TimeUnix) AS firstSeen,
      max(TimeUnix) AS lastSeen,
      ${hasIsMonotonic ? "any(IsMonotonic)" : "0"} AS isMonotonic
    FROM ${table}
    WHERE ${conditions.join(" AND ")}
    GROUP BY metricName, serviceName`
  }

  const showSum = !opts.metricType || opts.metricType === "sum"
  const showGauge = !opts.metricType || opts.metricType === "gauge"
  const showHist = !opts.metricType || opts.metricType === "histogram"
  const showExpHist = !opts.metricType || opts.metricType === "exponential_histogram"

  const subqueries: string[] = []
  if (showSum) subqueries.push(buildMetricSubquery("metrics_sum", "sum", true))
  if (showGauge) subqueries.push(buildMetricSubquery("metrics_gauge", "gauge", false))
  if (showHist) subqueries.push(buildMetricSubquery("metrics_histogram", "histogram", false))
  if (showExpHist) subqueries.push(buildMetricSubquery("metrics_exponential_histogram", "exponential_histogram", false))

  const sql = `SELECT *
FROM (
${subqueries.join("\nUNION ALL\n")}
)
ORDER BY lastSeen DESC
LIMIT ${limit}
OFFSET ${offset}
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<ListMetricsOutput>,
  }
}

// ---------------------------------------------------------------------------
// Metrics summary (raw SQL — 4 UNION ALL across metric tables)
// ---------------------------------------------------------------------------

export interface MetricsSummaryOutput {
  readonly metricType: string
  readonly metricCount: number
  readonly dataPointCount: number
}

export function metricsSummarySQL(
  params: { orgId: string; startTime: string; endTime: string; serviceName?: string },
): CompiledQuery<MetricsSummaryOutput> {
  const esc = escapeClickHouseString
  const serviceFilter = params.serviceName
    ? `AND ServiceName = '${esc(params.serviceName)}'`
    : ""

  function buildCountSubquery(table: string, metricType: string): string {
    return `SELECT
      '${metricType}' AS metricType,
      uniq(MetricName) AS metricCount,
      count() AS dataPointCount
    FROM ${table}
    WHERE OrgId = '${esc(params.orgId)}'
      AND TimeUnix >= '${esc(params.startTime)}'
      AND TimeUnix <= '${esc(params.endTime)}'
      ${serviceFilter}`
  }

  const sql = `${buildCountSubquery("metrics_sum", "sum")}
UNION ALL
${buildCountSubquery("metrics_gauge", "gauge")}
UNION ALL
${buildCountSubquery("metrics_histogram", "histogram")}
UNION ALL
${buildCountSubquery("metrics_exponential_histogram", "exponential_histogram")}
FORMAT JSON`

  return {
    sql,
    castRows: (rows) => rows as unknown as ReadonlyArray<MetricsSummaryOutput>,
  }
}
