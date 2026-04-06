// ---------------------------------------------------------------------------
// Typed Metrics Queries
//
// DSL-based query definitions for metrics timeseries, breakdown, and
// a raw-SQL builder for counter rate/increase (which requires CTEs).
// ---------------------------------------------------------------------------

import type { MetricType } from "../../query-engine"
import * as CH from "../expr"
import * as T from "../types"
import { param } from "../param"
import { from, type CHQuery } from "../query"
import { table } from "../table"
import { unionAll, type CHUnionQuery } from "../union"
import {
  MetricsSum,
  MetricsGauge,
  MetricsHistogram,
  MetricsExpHistogram,
} from "../tables"
import { compileCH } from "../compile"
import { resolveMetricTable, metricsSelectExprs } from "./query-helpers"

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


// ---------------------------------------------------------------------------
// Timeseries query — handles all 4 metric types
// ---------------------------------------------------------------------------

export function metricsTimeseriesQuery(
  opts: MetricsTimeseriesOpts,
) {
  const { tbl, isHistogram } = resolveMetricTable(opts.metricType)

  const q = from(tbl as typeof MetricsSum)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
      serviceName: $.ServiceName,
      attributeValue: opts.groupByAttributeKey
        ? $.Attributes.get(opts.groupByAttributeKey)
        : CH.lit(""),
      ...metricsSelectExprs($, isHistogram),
    }))
    .where(($) => [
      $.MetricName.eq(param.string("metricName")),
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
      CH.when(opts.attributeKey, (k: string) =>
        $.Attributes.get(k).eq(opts.attributeValue ?? ""),
      ),
    ])

  return (opts.groupByAttributeKey
    ? q.groupBy("bucket", "serviceName", "attributeValue")
    : q.groupBy("bucket", "serviceName")
  )
    .orderBy(["bucket", "asc"])
    .format("JSON")
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

export function metricsTimeseriesRateQuery(
  opts: MetricsRateTimeseriesOpts,
) {
  // CTE: compute deltas using window functions
  const cteSql = compileCH(
    from(MetricsSum)
      .select(($) => ({
        TimeUnix: $.TimeUnix,
        ServiceName: $.ServiceName,
        Attributes: $.Attributes,
        Value: $.Value,
        delta: CH.rawExpr<number>(
          "Value - lagInFrame(Value, 1, Value) OVER (PARTITION BY ServiceName, MetricName, Attributes ORDER BY TimeUnix ASC)",
        ),
        time_delta: CH.rawExpr<number>(
          "toFloat64(toUnixTimestamp64Nano(TimeUnix) - toUnixTimestamp64Nano(lagInFrame(TimeUnix, 1, TimeUnix) OVER (PARTITION BY ServiceName, MetricName, Attributes ORDER BY TimeUnix ASC))) / 1000000000.0",
        ),
      }))
      .where(($) => [
        $.MetricName.eq(param.string("metricName")),
        $.OrgId.eq(param.string("orgId")),
        CH.dynamicColumn<number>("IsMonotonic").eq(1),
        $.TimeUnix.gte(CH.intervalSub(param.dateTime("startTime"), param.int("bucketSeconds"))),
        $.TimeUnix.lte(param.dateTime("endTime")),
        CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
        CH.when(opts.attributeKey, (k: string) =>
          $.Attributes.get(k).eq(opts.attributeValue ?? ""),
        ),
      ]),
    {},
    { skipFormat: true },
  )

  // Outer query: aggregate deltas into rate/increase per bucket
  const cteTable = table("with_deltas", {
    TimeUnix: T.dateTime64,
    ServiceName: T.string,
    Attributes: T.map(T.string, T.string),
    Value: T.float64,
    delta: T.float64,
    time_delta: T.float64,
  })

  const q = from(cteTable)
    .withCTE("with_deltas", cteSql.sql)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
      serviceName: $.ServiceName,
      attributeValue: opts.groupByAttributeKey
        ? $.Attributes.get(opts.groupByAttributeKey)
        : CH.lit(""),
      rateValue: CH.sumIf(
        $.delta.div($.time_delta),
        $.delta.gte(0).and($.time_delta.gt(0)),
      ),
      increaseValue: CH.sumIf($.delta, $.delta.gte(0)),
      dataPointCount: CH.count(),
    }))
    .where(($) => [
      $.TimeUnix.gte(param.dateTime("startTime")),
    ])

  return (opts.groupByAttributeKey
    ? q.groupBy("bucket", "serviceName", "attributeValue")
    : q.groupBy("bucket", "serviceName")
  )
    .orderBy(["bucket", "asc"])
    .format("JSON")
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

export function metricsBreakdownQuery(
  opts: MetricsBreakdownOpts,
) {
  const { tbl, isHistogram } = resolveMetricTable(opts.metricType)
  const limit = opts.limit ?? 10

  return from(tbl as typeof MetricsSum)
    .select(($) => {
      const exprs = metricsSelectExprs($, isHistogram)
      return {
        name: $.ServiceName,
        avgValue: exprs.avgValue,
        sumValue: exprs.sumValue,
        count: exprs.dataPointCount,
      }
    })
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
}

// ---------------------------------------------------------------------------
// List metrics (UNION ALL — 4 metric tables)
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

export function listMetricsQuery(
  opts: ListMetricsOpts,
): CHUnionQuery<ListMetricsOutput> {
  function buildSubquery(
    tbl: typeof MetricsSum | typeof MetricsGauge | typeof MetricsHistogram | typeof MetricsExpHistogram,
    metricType: string,
    hasIsMonotonic: boolean,
  ) {
    return from(tbl as typeof MetricsSum)
      .select(($) => ({
        metricName: $.MetricName,
        metricType: CH.lit(metricType),
        serviceName: $.ServiceName,
        metricDescription: CH.any_($.MetricDescription),
        metricUnit: CH.any_($.MetricUnit),
        dataPointCount: CH.count(),
        firstSeen: CH.min_($.TimeUnix),
        lastSeen: CH.max_($.TimeUnix),
        isMonotonic: hasIsMonotonic
          ? CH.any_(CH.dynamicColumn<number>("IsMonotonic"))
          : CH.lit(0),
      }))
      .where(($) => [
        $.OrgId.eq(param.string("orgId")),
        $.TimeUnix.gte(param.dateTime("startTime")),
        $.TimeUnix.lte(param.dateTime("endTime")),
        CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
        CH.when(opts.search, (v: string) => $.MetricName.ilike(`%${v}%`)),
      ])
      .groupBy("metricName", "serviceName")
  }

  const queries: Array<CHQuery<any, ListMetricsOutput>> = []
  const showSum = !opts.metricType || opts.metricType === "sum"
  const showGauge = !opts.metricType || opts.metricType === "gauge"
  const showHist = !opts.metricType || opts.metricType === "histogram"
  const showExpHist = !opts.metricType || opts.metricType === "exponential_histogram"

  if (showSum) queries.push(buildSubquery(MetricsSum, "sum", true))
  if (showGauge) queries.push(buildSubquery(MetricsGauge, "gauge", false))
  if (showHist) queries.push(buildSubquery(MetricsHistogram, "histogram", false))
  if (showExpHist) queries.push(buildSubquery(MetricsExpHistogram, "exponential_histogram", false))

  return unionAll(...queries)
    .orderBy(["lastSeen", "desc"])
    .limit(opts.limit ?? 100)
    .offset(opts.offset ?? 0)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Metrics summary (UNION ALL — 4 metric tables)
// ---------------------------------------------------------------------------

export interface MetricsSummaryOutput {
  readonly metricType: string
  readonly metricCount: number
  readonly dataPointCount: number
}

export interface MetricsSummaryOpts {
  serviceName?: string
}

export function metricsSummaryQuery(
  opts?: MetricsSummaryOpts,
): CHUnionQuery<MetricsSummaryOutput> {
  function buildSubquery(
    tbl: typeof MetricsSum | typeof MetricsGauge | typeof MetricsHistogram | typeof MetricsExpHistogram,
    metricType: string,
  ) {
    return from(tbl as typeof MetricsSum)
      .select(($) => ({
        metricType: CH.lit(metricType),
        metricCount: CH.uniq($.MetricName),
        dataPointCount: CH.count(),
      }))
      .where(($) => [
        $.OrgId.eq(param.string("orgId")),
        $.TimeUnix.gte(param.dateTime("startTime")),
        $.TimeUnix.lte(param.dateTime("endTime")),
        CH.when(opts?.serviceName, (v: string) => $.ServiceName.eq(v)),
      ])
  }

  return unionAll(
    buildSubquery(MetricsSum, "sum"),
    buildSubquery(MetricsGauge, "gauge"),
    buildSubquery(MetricsHistogram, "histogram"),
    buildSubquery(MetricsExpHistogram, "exponential_histogram"),
  ).format("JSON")
}
