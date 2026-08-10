// Cloudflare infrastructure page
//
// Rollups and timeseries backing the /infra/cloudflare page: per-zone HTTP
// edge analytics (`cloudflare/{zoneName}` pseudo-services) and per-Worker
// invocation analytics (`cloudflare-worker/{scriptName}`), all written by the
// `CloudflareAnalyticsService` poller into the normal OTel metrics pipeline.
// The `cloudflare.*` metric names are fully selective — nothing else writes
// them — so filtering by MetricName alone scopes each query to the right
// pseudo-service family without a ServiceName predicate.
//
// Split by table because counters live in `metrics_sum` (5-min delta sums)
// and pre-computed percentiles live in `metrics_gauge` (one row per
// `quantile`). The API handlers merge the two by ServiceName.

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, param, type ColumnAccessor, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { CHNumber } from "@maple/query-engine/ch/schema"
import { MetricsGauge, MetricsSum } from "@maple/query-engine/ch/tables"
import { avgWhere, isoBucket } from "@maple/query-engine/ch/format"
import {
	CF_FILTERABLE,
	CF_METRIC,
	cloudflareFilterConditions,
	type CloudflareFilterOpts,
} from "./cloudflare-infra-filters"

/** Counter metrics the poller emits for zone HTTP analytics (all in `metrics_sum`). */
const ZONE_COUNTER_METRIC_NAMES = [
	"cloudflare.http.requests",
	"cloudflare.http.bytes",
	"cloudflare.http.visits",
] as const

/** Percentile metrics the poller emits for zones (all in `metrics_gauge`, keyed by `quantile`). */
const ZONE_GAUGE_METRIC_NAMES = ["cloudflare.http.edge.ttfb", "cloudflare.http.origin.duration"] as const

/** Counter metrics the poller emits for Workers (all in `metrics_sum`). */
const WORKER_COUNTER_METRIC_NAMES = [
	"cloudflare.worker.requests",
	"cloudflare.worker.errors",
	"cloudflare.worker.subrequests",
] as const

/** Percentile metrics the poller emits for Workers (quantiles "0.5" and "0.99" only). */
const WORKER_GAUGE_METRIC_NAMES = ["cloudflare.worker.duration", "cloudflare.worker.cpu_time"] as const

/**
 * Cloudflare cache statuses that count as "served by the edge cache" — the
 * cache-hit-rate numerator. The poller passes Cloudflare's raw `cacheStatus`
 * dimension through verbatim, so unexpected values simply fall into the miss
 * bucket.
 */
const CACHE_SERVED_STATUSES = ["hit", "stale", "revalidated", "updating"] as const

// `avgIf` over a metric with no matching rows is NaN, which serializes to
// JSON `null` and would break row decoding — so guard each with
// `if(countIf > 0, avgIf, 0)`. (Same guard as cloudflare-map.ts.)

// Zones

export interface CloudflareZoneCountersOutput {
	readonly serviceName: string
	/** Edge HTTP requests (ABR-adjusted estimate). */
	readonly requests: number
	/** Requests with a 5xx edge response status. */
	readonly errors5xx: number
	/** Requests served by the edge cache (hit/stale/revalidated/updating). */
	readonly cacheHits: number
	/** Edge response bytes served. */
	readonly bytes: number
	/** Visits (initial page loads). */
	readonly visits: number
}

export interface CloudflareZoneLatencyOutput {
	readonly serviceName: string
	readonly ttfbP50Ms: number
	readonly ttfbP95Ms: number
	readonly ttfbP99Ms: number
	readonly originP50Ms: number
	readonly originP95Ms: number
	readonly originP99Ms: number
}

export interface CloudflareZoneTimeseriesOutput {
	readonly serviceName: string
	/** Bucket start, ISO-8601 UTC. */
	readonly bucket: string
	readonly requests: number
	readonly errors5xx: number
	readonly cacheHits: number
	readonly bytes: number
	readonly visits: number
}

/**
 * Row schema for {@link cloudflareZoneCountersSQL}. The `sumIf` aggregates use
 * {@link CHNumber} so a BYO-ClickHouse org's string-encoded numeric aggregates
 * decode identically to Tinybird's numbers — pass it as the `rowSchema` to
 * `CH.compile` so `decodeRows` coerces centrally instead of a `ParseError`
 * surfacing downstream. Mirror of `cloudflareUsageRowSchema`.
 */
export const cloudflareZoneCountersRowSchema: CompiledQueryRowSchema<CloudflareZoneCountersOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		requests: CHNumber,
		errors5xx: CHNumber,
		cacheHits: CHNumber,
		bytes: CHNumber,
		visits: CHNumber,
	})

/** Row schema for {@link cloudflareZoneLatencySQL}. Same {@link CHNumber} coercion. */
export const cloudflareZoneLatencyRowSchema: CompiledQueryRowSchema<CloudflareZoneLatencyOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		ttfbP50Ms: CHNumber,
		ttfbP95Ms: CHNumber,
		ttfbP99Ms: CHNumber,
		originP50Ms: CHNumber,
		originP95Ms: CHNumber,
		originP99Ms: CHNumber,
	})

/** Row schema for {@link cloudflareZoneTimeseriesSQL}. Same {@link CHNumber} coercion. */
export const cloudflareZoneTimeseriesRowSchema: CompiledQueryRowSchema<CloudflareZoneTimeseriesOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		bucket: Schema.String,
		requests: CHNumber,
		errors5xx: CHNumber,
		cacheHits: CHNumber,
		bytes: CHNumber,
		visits: CHNumber,
	})

const zoneCounterColumns = ($: ColumnAccessor<typeof MetricsSum.columns>) => ({
	requests: CH.sumIf($.Value, $.MetricName.eq("cloudflare.http.requests")),
	errors5xx: CH.sumIf(
		$.Value,
		$.MetricName.eq("cloudflare.http.requests").and($.Attributes.get("http.status_class").eq("5xx")),
	),
	cacheHits: CH.sumIf(
		$.Value,
		$.MetricName.eq("cloudflare.http.requests").and(
			$.Attributes.get("cache.status").in_(...CACHE_SERVED_STATUSES),
		),
	),
	bytes: CH.sumIf($.Value, $.MetricName.eq("cloudflare.http.bytes")),
	visits: CH.sumIf($.Value, $.MetricName.eq("cloudflare.http.visits")),
})

/**
 * Filters applicable to the main HTTP cube (`host`, `cacheStatus`, `statusClass`). All three
 * counter metrics share the same attribute set, so one row of {@link CF_FILTERABLE} covers them.
 */
const httpCubeFilters = ($: ColumnAccessor<typeof MetricsSum.columns>, opts: CloudflareFilterOpts) =>
	cloudflareFilterConditions($, opts, CF_FILTERABLE[CF_METRIC.requests] ?? [])

/** Counter rollup over `metrics_sum`, one row per zone pseudo-service. */
export function cloudflareZoneCountersSQL(opts: CloudflareFilterOpts = {}) {
	return from(MetricsSum)
		.select(($) => ({
			serviceName: $.ServiceName,
			...zoneCounterColumns($),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...ZONE_COUNTER_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			...httpCubeFilters($, opts),
		])
		.groupBy("serviceName")
		.orderBy(["requests", "desc"])
		.limit(500)
		.format("JSON")
}

/**
 * Percentile rollup over `metrics_gauge`, one row per zone pseudo-service.
 * Percentiles are pre-computed gauges (one row per `quantile`); averaging them
 * across 5-min buckets is approximate but matches the Cloudflare dashboard
 * template's own treatment and is fine for a zone-level KPI.
 *
 * Deliberately takes no filters: these rows carry only `quantile`, because
 * per-(host, status) percentiles cannot be honestly re-aggregated. Callers
 * report this back as `ignoredFilters` so the panel can label itself zone-wide.
 */
export function cloudflareZoneLatencySQL() {
	const quantileAvg =
		(metricName: string, quantile: string) => ($: ColumnAccessor<typeof MetricsGauge.columns>) =>
			avgWhere($.Value, $.MetricName.eq(metricName).and($.Attributes.get("quantile").eq(quantile)))
	return from(MetricsGauge)
		.select(($) => ({
			serviceName: $.ServiceName,
			ttfbP50Ms: quantileAvg("cloudflare.http.edge.ttfb", "0.5")($),
			ttfbP95Ms: quantileAvg("cloudflare.http.edge.ttfb", "0.95")($),
			ttfbP99Ms: quantileAvg("cloudflare.http.edge.ttfb", "0.99")($),
			originP50Ms: quantileAvg("cloudflare.http.origin.duration", "0.5")($),
			originP95Ms: quantileAvg("cloudflare.http.origin.duration", "0.95")($),
			originP99Ms: quantileAvg("cloudflare.http.origin.duration", "0.99")($),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...ZONE_GAUGE_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.limit(500)
		.format("JSON")
}

/** Bucketed counter timeseries over `metrics_sum`, one row per zone × bucket. */
export function cloudflareZoneTimeseriesSQL(opts: CloudflareFilterOpts = {}) {
	return from(MetricsSum)
		.select(($) => ({
			serviceName: $.ServiceName,
			bucket: isoBucket($.TimeUnix),
			...zoneCounterColumns($),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...ZONE_COUNTER_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			...httpCubeFilters($, opts),
		])
		.groupBy("serviceName", "bucket")
		.orderBy(["serviceName", "asc"], ["bucket", "asc"])
		.format("JSON")
}

// Zone detail (single zone, scoped by ServiceName)
//
// The poller stores `http.status_class` and `cache.status` on every
// `cloudflare.http.requests` row, so a single zone supports bucketed
// breakdowns by either dimension plus a latency-percentile timeseries.

export interface CloudflareZoneStatusTimeseriesOutput {
	/** Bucket start, ISO-8601 UTC. */
	readonly bucket: string
	/** `"2xx"`-style class, `"unknown"` for out-of-range statuses. */
	readonly statusClass: string
	readonly requests: number
}

export interface CloudflareZoneCacheTimeseriesOutput {
	readonly bucket: string
	/** Cloudflare's raw lowercase cacheStatus (`hit`, `miss`, `dynamic`, …). */
	readonly cacheStatus: string
	readonly requests: number
}

export interface CloudflareZoneLatencyTimeseriesOutput {
	readonly bucket: string
	readonly ttfbP50Ms: number
	readonly ttfbP95Ms: number
	readonly ttfbP99Ms: number
	readonly originP50Ms: number
	readonly originP95Ms: number
	readonly originP99Ms: number
}

/** Row schema for {@link cloudflareZoneStatusTimeseriesSQL}. Same {@link CHNumber} coercion. */
export const cloudflareZoneStatusTimeseriesRowSchema: CompiledQueryRowSchema<CloudflareZoneStatusTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		statusClass: Schema.String,
		requests: CHNumber,
	})

/** Row schema for {@link cloudflareZoneCacheTimeseriesSQL}. Same {@link CHNumber} coercion. */
export const cloudflareZoneCacheTimeseriesRowSchema: CompiledQueryRowSchema<CloudflareZoneCacheTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		cacheStatus: Schema.String,
		requests: CHNumber,
	})

/** Row schema for {@link cloudflareZoneLatencyTimeseriesSQL}. Same {@link CHNumber} coercion. */
export const cloudflareZoneLatencyTimeseriesRowSchema: CompiledQueryRowSchema<CloudflareZoneLatencyTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		ttfbP50Ms: CHNumber,
		ttfbP95Ms: CHNumber,
		ttfbP99Ms: CHNumber,
		originP50Ms: CHNumber,
		originP95Ms: CHNumber,
		originP99Ms: CHNumber,
	})

/** Bucketed request counts by HTTP status class for one zone pseudo-service. */
export function cloudflareZoneStatusTimeseriesSQL(opts: CloudflareFilterOpts = {}) {
	return from(MetricsSum)
		.select(($) => ({
			bucket: isoBucket($.TimeUnix),
			statusClass: $.Attributes.get("http.status_class"),
			requests: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq("cloudflare.http.requests"),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			...httpCubeFilters($, opts),
		])
		.groupBy("bucket", "statusClass")
		.orderBy(["bucket", "asc"], ["statusClass", "asc"])
		.format("JSON")
}

/** Bucketed request counts by raw Cloudflare cache status for one zone pseudo-service. */
export function cloudflareZoneCacheTimeseriesSQL(opts: CloudflareFilterOpts = {}) {
	return from(MetricsSum)
		.select(($) => ({
			bucket: isoBucket($.TimeUnix),
			cacheStatus: $.Attributes.get("cache.status"),
			requests: CH.sum($.Value),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.eq("cloudflare.http.requests"),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			...httpCubeFilters($, opts),
		])
		.groupBy("bucket", "cacheStatus")
		.orderBy(["bucket", "asc"], ["cacheStatus", "asc"])
		.format("JSON")
}

/**
 * Bucketed latency percentiles for one zone pseudo-service. Plan-dependent:
 * zones without quantiles return zero rows, and the detail page hides the
 * latency panel entirely. Unfiltered for the same reason as
 * {@link cloudflareZoneLatencySQL}.
 */
export function cloudflareZoneLatencyTimeseriesSQL() {
	const quantileAvg =
		(metricName: string, quantile: string) => ($: ColumnAccessor<typeof MetricsGauge.columns>) =>
			avgWhere($.Value, $.MetricName.eq(metricName).and($.Attributes.get("quantile").eq(quantile)))
	return from(MetricsGauge)
		.select(($) => ({
			bucket: isoBucket($.TimeUnix),
			ttfbP50Ms: quantileAvg("cloudflare.http.edge.ttfb", "0.5")($),
			ttfbP95Ms: quantileAvg("cloudflare.http.edge.ttfb", "0.95")($),
			ttfbP99Ms: quantileAvg("cloudflare.http.edge.ttfb", "0.99")($),
			originP50Ms: quantileAvg("cloudflare.http.origin.duration", "0.5")($),
			originP95Ms: quantileAvg("cloudflare.http.origin.duration", "0.95")($),
			originP99Ms: quantileAvg("cloudflare.http.origin.duration", "0.99")($),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.ServiceName.eq(param.string("serviceName")),
			$.MetricName.in_(...ZONE_GAUGE_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

// Workers

export interface CloudflareWorkerCountersOutput {
	readonly serviceName: string
	/** Worker invocations. */
	readonly requests: number
	/** Worker invocation errors. */
	readonly errors: number
	/** Worker subrequests. */
	readonly subrequests: number
}

export interface CloudflareWorkerLatencyOutput {
	readonly serviceName: string
	readonly cpuP50Ms: number
	readonly cpuP99Ms: number
	readonly durationP50Ms: number
	readonly durationP99Ms: number
}

/** Row schema for {@link cloudflareWorkerCountersSQL}. Same {@link CHNumber} coercion. */
export const cloudflareWorkerCountersRowSchema: CompiledQueryRowSchema<CloudflareWorkerCountersOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		requests: CHNumber,
		errors: CHNumber,
		subrequests: CHNumber,
	})

/** Row schema for {@link cloudflareWorkerLatencySQL}. Same {@link CHNumber} coercion. */
export const cloudflareWorkerLatencyRowSchema: CompiledQueryRowSchema<CloudflareWorkerLatencyOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		cpuP50Ms: CHNumber,
		cpuP99Ms: CHNumber,
		durationP50Ms: CHNumber,
		durationP99Ms: CHNumber,
	})

/** Counter rollup over `metrics_sum`, one row per Worker pseudo-service. */
export function cloudflareWorkerCountersSQL() {
	return from(MetricsSum)
		.select(($) => ({
			serviceName: $.ServiceName,
			requests: CH.sumIf($.Value, $.MetricName.eq("cloudflare.worker.requests")),
			errors: CH.sumIf($.Value, $.MetricName.eq("cloudflare.worker.errors")),
			subrequests: CH.sumIf($.Value, $.MetricName.eq("cloudflare.worker.subrequests")),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...WORKER_COUNTER_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["requests", "desc"])
		.limit(500)
		.format("JSON")
}

/**
 * Percentile rollup over `metrics_gauge`, one row per Worker pseudo-service.
 * Workers emit quantiles "0.5" and "0.99" only (no "0.95"). Same approximate
 * bucket-averaging caveat as {@link cloudflareZoneLatencySQL}.
 */
export function cloudflareWorkerLatencySQL() {
	return from(MetricsGauge)
		.select(($) => ({
			serviceName: $.ServiceName,
			cpuP50Ms: avgWhere(
				$.Value,
				$.MetricName.eq("cloudflare.worker.cpu_time").and($.Attributes.get("quantile").eq("0.5")),
			),
			cpuP99Ms: avgWhere(
				$.Value,
				$.MetricName.eq("cloudflare.worker.cpu_time").and($.Attributes.get("quantile").eq("0.99")),
			),
			durationP50Ms: avgWhere(
				$.Value,
				$.MetricName.eq("cloudflare.worker.duration").and($.Attributes.get("quantile").eq("0.5")),
			),
			durationP99Ms: avgWhere(
				$.Value,
				$.MetricName.eq("cloudflare.worker.duration").and($.Attributes.get("quantile").eq("0.99")),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...WORKER_GAUGE_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.limit(500)
		.format("JSON")
}
