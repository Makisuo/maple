// ---------------------------------------------------------------------------
// Cloudflare service-map stats
//
// Per-CF-service rollups (one row per zone / Worker script) that let the
// service map render the Cloudflare edge as first-class nodes. The direct
// integration (`CloudflareAnalyticsService` poller) writes its GraphQL edge /
// Workers analytics into the normal OTel metrics pipeline under two synthetic
// service names — `cloudflare/{zoneName}` and `cloudflare-worker/{scriptName}`
// — but those pseudo-services never emit spans, so they are absent from the
// trace-derived map. These two aggregations recover them.
//
// Split by table because the counters live in `metrics_sum` (delta sums) and
// the pre-computed percentiles live in `metrics_gauge` (one row per quantile).
// The caller (the `serviceCloudflareStats` handler) merges both by ServiceName.
// A given ServiceName is exclusively a zone OR a worker (by name prefix), so
// the zone-only / worker-only conditional aggregates below are naturally zero
// for the non-applicable kind — one column per concern serves both.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, param, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { CHNumber } from "../schema"
import { MetricsGauge, MetricsSum } from "../tables"

/** Counter metrics the poller emits (all in `metrics_sum`). */
const COUNTER_METRIC_NAMES = [
	"cloudflare.http.requests",
	"cloudflare.worker.requests",
	"cloudflare.worker.errors",
] as const

/** Percentile metrics the poller emits (all in `metrics_gauge`, keyed by `quantile`). */
const GAUGE_METRIC_NAMES = [
	"cloudflare.http.edge.ttfb",
	"cloudflare.http.origin.duration",
	"cloudflare.worker.duration",
	"cloudflare.worker.cpu_time",
] as const

export interface CloudflareServiceCountersOutput {
	readonly serviceName: string
	/** Total requests (zone edge HTTP or Worker invocations). */
	readonly requests: number
	/** Zones: 5xx edge responses. Workers: invocation errors. */
	readonly errorCount: number
	/** Zones only: cache-hit requests (0 for workers). */
	readonly cacheHitCount: number
}

export interface CloudflareServiceLatencyOutput {
	readonly serviceName: string
	/** Zones: edge TTFB p95. Workers: wall-time duration p99. */
	readonly latencyP95Ms: number
	/** Zones only: origin response duration p95 (0 for workers). */
	readonly originP95Ms: number
	/** Workers only: CPU time p99 (0 for zones). */
	readonly cpuP99Ms: number
}

/**
 * Row schema for {@link cloudflareServiceCountersSQL}. The `sumIf` aggregates
 * use {@link CHNumber} so a BYO-ClickHouse org's string-encoded numeric
 * aggregates decode identically to Tinybird's numbers — pass it as the
 * `rowSchema` to `CH.compile` so `decodeRows` coerces centrally instead of a
 * `ParseError` (or a string leaking over the wire) surfacing downstream. Mirror
 * of `cloudflareUsageRowSchema`.
 */
export const cloudflareServiceCountersRowSchema: CompiledQueryRowSchema<CloudflareServiceCountersOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		requests: CHNumber,
		errorCount: CHNumber,
		cacheHitCount: CHNumber,
	})

/**
 * Row schema for {@link cloudflareServiceLatencySQL}. Same {@link CHNumber}
 * coercion as the counters schema for the percentile columns.
 */
export const cloudflareServiceLatencyRowSchema: CompiledQueryRowSchema<CloudflareServiceLatencyOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		latencyP95Ms: CHNumber,
		originP95Ms: CHNumber,
		cpuP99Ms: CHNumber,
	})

/**
 * Counter rollup over `metrics_sum`, one row per Cloudflare pseudo-service.
 * `errorCount` sums 5xx edge responses (zones) OR `cloudflare.worker.errors`
 * (workers); exactly one branch has rows per service.
 */
export function cloudflareServiceCountersSQL() {
	return from(MetricsSum)
		.select(($) => ({
			serviceName: $.ServiceName,
			requests: CH.sumIf(
				$.Value,
				$.MetricName.eq("cloudflare.http.requests").or($.MetricName.eq("cloudflare.worker.requests")),
			),
			// AND binds tighter than OR in ClickHouse, so this is
			// (http.requests AND 5xx) OR worker.errors — no extra parens needed.
			errorCount: CH.sumIf(
				$.Value,
				$.MetricName
					.eq("cloudflare.http.requests")
					.and($.Attributes.get("http.status_class").eq("5xx"))
					.or($.MetricName.eq("cloudflare.worker.errors")),
			),
			cacheHitCount: CH.sumIf(
				$.Value,
				$.MetricName.eq("cloudflare.http.requests").and($.Attributes.get("cache.status").eq("hit")),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...COUNTER_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.orderBy(["requests", "desc"])
		.limit(500)
		.format("JSON")
}

/**
 * Percentile rollup over `metrics_gauge`, one row per Cloudflare pseudo-service.
 * Percentiles are pre-computed gauges (one row per `quantile`); averaging them
 * across 5-min buckets is approximate but matches the Cloudflare dashboard
 * template's own treatment and is fine for a node-level KPI.
 */
export function cloudflareServiceLatencySQL() {
	// `avgIf` over a metric with no matching rows (e.g. origin duration for a
	// Worker service) is NaN, which serializes to JSON `null` and would break
	// row decoding — so guard each with `if(countIf > 0, avgIf, 0)`.
	const avgWhere = (value: CH.Expr<number>, cond: CH.Condition) =>
		CH.if_(CH.countIf(cond).gt(0), CH.avgIf(value, cond), CH.lit(0))
	return from(MetricsGauge)
		.select(($) => ({
			serviceName: $.ServiceName,
			// zones: edge TTFB p95 ; workers: duration p99 — disjoint metric sets.
			latencyP95Ms: avgWhere(
				$.Value,
				$.MetricName
					.eq("cloudflare.http.edge.ttfb")
					.and($.Attributes.get("quantile").eq("0.95"))
					.or(
						$.MetricName
							.eq("cloudflare.worker.duration")
							.and($.Attributes.get("quantile").eq("0.99")),
					),
			),
			originP95Ms: avgWhere(
				$.Value,
				$.MetricName
					.eq("cloudflare.http.origin.duration")
					.and($.Attributes.get("quantile").eq("0.95")),
			),
			cpuP99Ms: avgWhere(
				$.Value,
				$.MetricName
					.eq("cloudflare.worker.cpu_time")
					.and($.Attributes.get("quantile").eq("0.99")),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...GAUGE_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName")
		.limit(500)
		.format("JSON")
}
