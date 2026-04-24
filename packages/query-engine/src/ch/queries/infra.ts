// ---------------------------------------------------------------------------
// Typed Infrastructure Queries
//
// Host-centric aggregations built on top of OTel hostmetrics data that lands
// in metrics_gauge. Conventions (OTel semantic-conventions for hostmetrics):
//
//   - system.cpu.utilization           gauge, 0..1, attributes: cpu, state
//   - system.memory.utilization        gauge, 0..1, attributes: state
//   - system.filesystem.utilization    gauge, 0..1, attributes: device, mountpoint, state
//   - system.cpu.load_average.1m|5m|15m  gauge, absolute, no attributes
//   - system.network.io                sum,   bytes, attributes: device, direction
//
// Host identity is carried on the ResourceAttributes map under `host.name`.
// ---------------------------------------------------------------------------

import * as CH from "../expr"
import { param } from "../param"
import { from } from "../query"
import { MetricsGauge, MetricsSum } from "../tables"

const HOSTMETRIC_NAMES = [
  "system.cpu.utilization",
  "system.memory.utilization",
  "system.filesystem.utilization",
  "system.cpu.load_average.15m",
] as const

// ---------------------------------------------------------------------------
// List hosts — one row per host.name with latest-window headline gauges
// ---------------------------------------------------------------------------

export interface ListHostsOpts {
  search?: string
  limit?: number
  offset?: number
}

export interface ListHostsOutput {
  readonly hostName: string
  readonly osType: string
  readonly hostArch: string
  readonly cloudProvider: string
  readonly lastSeen: string
  readonly cpuPct: number
  readonly memoryPct: number
  readonly diskPct: number
  readonly load15: number
}

export function listHostsQuery(opts: ListHostsOpts = {}) {
  return from(MetricsGauge)
    .select(($) => ({
      hostName: $.ResourceAttributes.get("host.name"),
      osType: CH.any_($.ResourceAttributes.get("os.type")),
      hostArch: CH.any_($.ResourceAttributes.get("host.arch")),
      cloudProvider: CH.any_($.ResourceAttributes.get("cloud.provider")),
      lastSeen: CH.max_($.TimeUnix),
      cpuPct: CH.avgIf(
        $.Value,
        $.MetricName.eq("system.cpu.utilization").and(
          $.Attributes.get("state").neq("idle"),
        ),
      ),
      memoryPct: CH.avgIf(
        $.Value,
        $.MetricName.eq("system.memory.utilization").and(
          $.Attributes.get("state").eq("used"),
        ),
      ),
      diskPct: CH.maxIf(
        $.Value,
        $.MetricName.eq("system.filesystem.utilization").and(
          $.Attributes.get("state").eq("used"),
        ),
      ),
      load15: CH.avgIf(
        $.Value,
        $.MetricName.eq("system.cpu.load_average.15m"),
      ),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      $.ResourceAttributes.get("host.name").neq(""),
      $.MetricName.in_(...HOSTMETRIC_NAMES),
      CH.when(opts.search, (v: string) =>
        CH.positionCaseInsensitive($.ResourceAttributes.get("host.name"), CH.lit(v)).gt(0),
      ),
    ])
    .groupBy("hostName")
    .orderBy(["lastSeen", "desc"])
    .limit(opts.limit ?? 200)
    .offset(opts.offset ?? 0)
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Host detail summary — single host, latest-window headline gauges + uptime
// ---------------------------------------------------------------------------

export interface HostDetailSummaryOpts {
  hostName: string
}

export interface HostDetailSummaryOutput {
  readonly hostName: string
  readonly osType: string
  readonly hostArch: string
  readonly cloudProvider: string
  readonly cloudRegion: string
  readonly firstSeen: string
  readonly lastSeen: string
  readonly cpuPct: number
  readonly memoryPct: number
  readonly diskPct: number
  readonly load15: number
}

export function hostDetailSummaryQuery(opts: HostDetailSummaryOpts) {
  return from(MetricsGauge)
    .select(($) => ({
      hostName: $.ResourceAttributes.get("host.name"),
      osType: CH.any_($.ResourceAttributes.get("os.type")),
      hostArch: CH.any_($.ResourceAttributes.get("host.arch")),
      cloudProvider: CH.any_($.ResourceAttributes.get("cloud.provider")),
      cloudRegion: CH.any_($.ResourceAttributes.get("cloud.region")),
      firstSeen: CH.min_($.TimeUnix),
      lastSeen: CH.max_($.TimeUnix),
      cpuPct: CH.avgIf(
        $.Value,
        $.MetricName.eq("system.cpu.utilization").and(
          $.Attributes.get("state").neq("idle"),
        ),
      ),
      memoryPct: CH.avgIf(
        $.Value,
        $.MetricName.eq("system.memory.utilization").and(
          $.Attributes.get("state").eq("used"),
        ),
      ),
      diskPct: CH.maxIf(
        $.Value,
        $.MetricName.eq("system.filesystem.utilization").and(
          $.Attributes.get("state").eq("used"),
        ),
      ),
      load15: CH.avgIf(
        $.Value,
        $.MetricName.eq("system.cpu.load_average.15m"),
      ),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      $.ResourceAttributes.get("host.name").eq(opts.hostName),
      $.MetricName.in_(...HOSTMETRIC_NAMES),
    ])
    .groupBy("hostName")
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Host infra time-series — gauge metric broken down by a single attribute key
// (e.g. CPU by state, filesystem by mountpoint). Always filtered to one host.
// ---------------------------------------------------------------------------

export interface HostGaugeTimeseriesOpts {
  hostName: string
  metricName: string
  groupByAttributeKey?: string
}

export interface HostGaugeTimeseriesOutput {
  readonly bucket: string
  readonly attributeValue: string
  readonly avgValue: number
}

export function hostGaugeTimeseriesQuery(opts: HostGaugeTimeseriesOpts) {
  const q = from(MetricsGauge)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
      attributeValue: opts.groupByAttributeKey
        ? $.Attributes.get(opts.groupByAttributeKey)
        : CH.lit(""),
      avgValue: CH.avg($.Value),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      $.ResourceAttributes.get("host.name").eq(opts.hostName),
      $.MetricName.eq(opts.metricName),
    ])

  return (opts.groupByAttributeKey
    ? q.groupBy("bucket", "attributeValue")
    : q.groupBy("bucket")
  )
    .orderBy(["bucket", "asc"])
    .format("JSON")
}

// ---------------------------------------------------------------------------
// Host network time-series — sum metric broken down by direction.
// Reports bytes/sec computed from the latest sample in each bucket divided by
// the bucket size. `system.network.io` is a cumulative counter; the UI layer
// is expected to render the derivative, but for the first cut we surface
// average bytes/sec using the gauge-style aggregation.
// ---------------------------------------------------------------------------

export interface HostNetworkTimeseriesOpts {
  hostName: string
}

export interface HostNetworkTimeseriesOutput {
  readonly bucket: string
  readonly attributeValue: string
  readonly sumValue: number
}

// ---------------------------------------------------------------------------
// Fleet utilization time-series — bucketed averages of CPU + memory across all
// hosts in the org, plus an active-host count per bucket. Powers the small
// sparklines on the overview KPI cards.
// ---------------------------------------------------------------------------

export interface FleetUtilizationTimeseriesOutput {
  readonly bucket: string
  readonly avgCpu: number
  readonly avgMemory: number
  readonly activeHosts: number
}

export function fleetUtilizationTimeseriesQuery() {
  return from(MetricsGauge)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
      avgCpu: CH.avgIf(
        $.Value,
        $.MetricName.eq("system.cpu.utilization").and(
          $.Attributes.get("state").neq("idle"),
        ),
      ),
      avgMemory: CH.avgIf(
        $.Value,
        $.MetricName.eq("system.memory.utilization").and(
          $.Attributes.get("state").eq("used"),
        ),
      ),
      activeHosts: CH.uniq($.ResourceAttributes.get("host.name")),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      $.ResourceAttributes.get("host.name").neq(""),
      $.MetricName.in_(
        "system.cpu.utilization",
        "system.memory.utilization",
      ),
    ])
    .groupBy("bucket")
    .orderBy(["bucket", "asc"])
    .format("JSON")
}

export function hostNetworkTimeseriesQuery(opts: HostNetworkTimeseriesOpts) {
  return from(MetricsSum)
    .select(($) => ({
      bucket: CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
      attributeValue: $.Attributes.get("direction"),
      sumValue: CH.sum($.Value),
    }))
    .where(($) => [
      $.OrgId.eq(param.string("orgId")),
      $.TimeUnix.gte(param.dateTime("startTime")),
      $.TimeUnix.lte(param.dateTime("endTime")),
      $.ResourceAttributes.get("host.name").eq(opts.hostName),
      $.MetricName.eq("system.network.io"),
    ])
    .groupBy("bucket", "attributeValue")
    .orderBy(["bucket", "asc"])
    .format("JSON")
}
