// ---------------------------------------------------------------------------
// Typed Services Queries
//
// DSL-based query definitions for service overview, releases, apdex, and usage.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from, type ColumnAccessor } from "../query"
import { unionAll, type CHUnionQuery } from "../union"
import { ServiceOverviewSpans, ServiceUsage, Traces } from "../tables"
import { apdexExprs } from "./query-helpers"

// ---------------------------------------------------------------------------
// Service overview
// ---------------------------------------------------------------------------

export interface ServiceOverviewOpts {
  environments?: readonly string[]
  commitShas?: readonly string[]
}

export interface ServiceOverviewOutput {
  readonly serviceName: string
  readonly environment: string
  readonly commitSha: string
  readonly throughput: number
  readonly errorCount: number
  readonly spanCount: number
  readonly p50LatencyMs: number
  readonly p95LatencyMs: number
  readonly p99LatencyMs: number
  readonly sampledSpanCount: number
  readonly unsampledSpanCount: number
  readonly dominantThreshold: string
}

export function serviceOverviewQuery(
  opts: ServiceOverviewOpts,
) {
  return from(ServiceOverviewSpans)
    .select(($) => ({
      serviceName: $.ServiceName,
      environment: $.DeploymentEnv,
      commitSha: $.CommitSha,
      throughput: CH.count(),
      errorCount: CH.countIf($.StatusCode.eq("Error")),
      spanCount: CH.count(),
      p50LatencyMs: CH.quantile(0.5)($.Duration).div(1000000),
      p95LatencyMs: CH.quantile(0.95)($.Duration).div(1000000),
      p99LatencyMs: CH.quantile(0.99)($.Duration).div(1000000),
      sampledSpanCount: CH.countIf($.TraceState.like("%th:%")),
      unsampledSpanCount: CH.countIf($.TraceState.eq("").or($.TraceState.notLike("%th:%"))),
      dominantThreshold: CH.anyIf(CH.extract_($.TraceState, "th:([0-9a-f]+)"), $.TraceState.like("%th:%")),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
      opts.environments?.length
        ? CH.inList($.DeploymentEnv, opts.environments)
        : undefined,
      opts.commitShas?.length
        ? CH.inList($.CommitSha, opts.commitShas)
        : undefined,
    ])
    .groupBy("serviceName", "environment", "commitSha")
    .orderBy(["throughput", "desc"])
    .limit(100)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Service releases timeline
// ---------------------------------------------------------------------------

export interface ServiceReleasesTimelineOpts {
  serviceName: string
}

export interface ServiceReleasesTimelineOutput {
  readonly bucket: string
  readonly commitSha: string
  readonly count: number
}

export function serviceReleasesTimelineQuery(
  opts: ServiceReleasesTimelineOpts,
) {
  return from(ServiceOverviewSpans)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      commitSha: $.CommitSha,
      count: CH.count(),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.ServiceName.eq(opts.serviceName),
      $.CommitSha.neq(""),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
    ])
    .groupBy("bucket", "commitSha")
    .orderBy(["bucket", "asc"])
    .limit(1000)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Service Apdex time series
// ---------------------------------------------------------------------------

export interface ServiceApdexTimeseriesOpts {
  serviceName: string
  apdexThresholdMs?: number
}

export interface ServiceApdexTimeseriesOutput {
  readonly bucket: string
  readonly totalCount: number
  readonly satisfiedCount: number
  readonly toleratingCount: number
  readonly apdexScore: number
}

export function serviceApdexTimeseriesQuery(
  opts: ServiceApdexTimeseriesOpts,
) {
  const thresholdMs = opts.apdexThresholdMs ?? 500

  return from(Traces)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
      totalCount: CH.count(),
      ...apdexExprs($.Duration.div(1000000), thresholdMs),
    }))
    .where(($) => [
      $.SpanKind.in_("Server", "Consumer").or($.ParentSpanId.eq("")),
      $.OrgId.eq(param.string("orgId")),
      $.ServiceName.eq(opts.serviceName),
      $.Timestamp.gte(param.dateTime("startTime")),
      $.Timestamp.lte(param.dateTime("endTime")),
    ])
    .groupBy("bucket")
    .orderBy(["bucket", "asc"])
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Service usage
// ---------------------------------------------------------------------------

export interface ServiceUsageOpts {
  serviceName?: string
}

export interface ServiceUsageOutput {
  readonly serviceName: string
  readonly totalLogCount: number
  readonly totalLogSizeBytes: number
  readonly totalTraceCount: number
  readonly totalTraceSizeBytes: number
  readonly totalSumMetricCount: number
  readonly totalSumMetricSizeBytes: number
  readonly totalGaugeMetricCount: number
  readonly totalGaugeMetricSizeBytes: number
  readonly totalHistogramMetricCount: number
  readonly totalHistogramMetricSizeBytes: number
  readonly totalExpHistogramMetricCount: number
  readonly totalExpHistogramMetricSizeBytes: number
  readonly totalSizeBytes: number
}

export function serviceUsageQuery(
  opts: ServiceUsageOpts,
) {
  return from(ServiceUsage)
    .select(($) => ({
      serviceName: $.ServiceName,
      totalLogCount: CH.sum($.LogCount),
      totalLogSizeBytes: CH.sum($.LogSizeBytes),
      totalTraceCount: CH.sum($.TraceCount),
      totalTraceSizeBytes: CH.sum($.TraceSizeBytes),
      totalSumMetricCount: CH.sum($.SumMetricCount),
      totalSumMetricSizeBytes: CH.sum($.SumMetricSizeBytes),
      totalGaugeMetricCount: CH.sum($.GaugeMetricCount),
      totalGaugeMetricSizeBytes: CH.sum($.GaugeMetricSizeBytes),
      totalHistogramMetricCount: CH.sum($.HistogramMetricCount),
      totalHistogramMetricSizeBytes: CH.sum($.HistogramMetricSizeBytes),
      totalExpHistogramMetricCount: CH.sum($.ExpHistogramMetricCount),
      totalExpHistogramMetricSizeBytes: CH.sum($.ExpHistogramMetricSizeBytes),
      totalSizeBytes: CH.sum($.LogSizeBytes)
        .add(CH.sum($.TraceSizeBytes))
        .add(CH.sum($.SumMetricSizeBytes))
        .add(CH.sum($.GaugeMetricSizeBytes))
        .add(CH.sum($.HistogramMetricSizeBytes))
        .add(CH.sum($.ExpHistogramMetricSizeBytes)),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.Hour.gte(param.dateTime("startTime")),
      $.Hour.lte(param.dateTime("endTime")),
      CH.when(opts.serviceName, (v: string) => $.ServiceName.eq(v)),
    ])
    .groupBy("serviceName")
    .orderBy(["totalSizeBytes", "desc"])
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Services facets (UNION ALL — environment + commit_sha facets)
// ---------------------------------------------------------------------------

export interface ServicesFacetsOutput {
  readonly name: string
  readonly count: number
  readonly facetType: string
}

export function servicesFacetsQuery(
): CHUnionQuery<ServicesFacetsOutput> {
  const baseWhere = ($: ColumnAccessor<typeof ServiceOverviewSpans.columns>): Array<CH.Condition | undefined> => [
    $.OrgId.eq(param.string("orgId")),
    $.Timestamp.gte(param.dateTime("startTime")),
    $.Timestamp.lte(param.dateTime("endTime")),
  ]

  const envQuery = from(ServiceOverviewSpans)
    .select(($) => ({
      name: $.DeploymentEnv,
      count: CH.count(),
      facetType: CH.lit("environment"),
    }))
    .where(($) => [...baseWhere($), $.DeploymentEnv.neq("")])
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(50)

  const commitQuery = from(ServiceOverviewSpans)
    .select(($) => ({
      name: $.CommitSha,
      count: CH.count(),
      facetType: CH.lit("commit_sha"),
    }))
    .where(($) => [...baseWhere($), $.CommitSha.neq("")])
    .groupBy("name")
    .orderBy(["count", "desc"])
    .limit(50)

  return unionAll(envQuery, commitQuery)
    .format("JSON")
}
