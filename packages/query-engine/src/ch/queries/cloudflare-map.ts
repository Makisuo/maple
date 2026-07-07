// ---------------------------------------------------------------------------
// Cloudflare service-map stats
//
// Per-Worker rollups (one row per script) that let the service map overlay
// Cloudflare edge analytics onto instrumented Worker nodes. The direct
// integration (`CloudflareAnalyticsService` poller) writes its Workers
// analytics into the normal OTel metrics pipeline under the synthetic service
// name `cloudflare-worker/{scriptName}`; the map matches that script to a real
// trace-emitting service (by service name or `faas.name`) and attaches these
// numbers to its node. Scripts without a matching instrumented service — and
// zone analytics entirely — are intentionally NOT surfaced: Cloudflare data
// never creates nodes of its own.
//
// Split by table because the counters live in `metrics_sum` (delta sums) and
// the pre-computed percentiles live in `metrics_gauge` (one row per quantile).
// The caller (the `serviceCloudflareStats` handler) merges both by ServiceName.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, param, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { CHNumber } from "../schema"
import { MetricsGauge, MetricsSum } from "../tables"

/** Counter metrics the poller emits for Workers (all in `metrics_sum`). */
const COUNTER_METRIC_NAMES = ["cloudflare.worker.requests", "cloudflare.worker.errors"] as const

/** Percentile metrics the poller emits for Workers (all in `metrics_gauge`, keyed by `quantile`). */
const GAUGE_METRIC_NAMES = ["cloudflare.worker.duration", "cloudflare.worker.cpu_time"] as const

export interface CloudflareServiceCountersOutput {
	readonly serviceName: string
	/** Worker invocations. */
	readonly requests: number
	/** Worker invocation errors. */
	readonly errorCount: number
}

export interface CloudflareServiceLatencyOutput {
	readonly serviceName: string
	/** Wall-time duration p99. */
	readonly latencyP99Ms: number
	/** CPU time p99. */
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
	})

/**
 * Row schema for {@link cloudflareServiceLatencySQL}. Same {@link CHNumber}
 * coercion as the counters schema for the percentile columns.
 */
export const cloudflareServiceLatencyRowSchema: CompiledQueryRowSchema<CloudflareServiceLatencyOutput> =
	Schema.Struct({
		serviceName: Schema.String,
		latencyP99Ms: CHNumber,
		cpuP99Ms: CHNumber,
	})

/** Counter rollup over `metrics_sum`, one row per Worker pseudo-service. */
export function cloudflareServiceCountersSQL() {
	return from(MetricsSum)
		.select(($) => ({
			serviceName: $.ServiceName,
			requests: CH.sumIf($.Value, $.MetricName.eq("cloudflare.worker.requests")),
			errorCount: CH.sumIf($.Value, $.MetricName.eq("cloudflare.worker.errors")),
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
 * Percentile rollup over `metrics_gauge`, one row per Worker pseudo-service.
 * Percentiles are pre-computed gauges (one row per `quantile`); averaging them
 * across 5-min buckets is approximate but matches the Cloudflare dashboard
 * template's own treatment and is fine for a node-level KPI.
 */
export function cloudflareServiceLatencySQL() {
	// `avgIf` over a metric with no matching rows is NaN, which serializes to
	// JSON `null` and would break row decoding — so guard each with
	// `if(countIf > 0, avgIf, 0)`.
	const avgWhere = (value: CH.Expr<number>, cond: CH.Condition) =>
		CH.if_(CH.countIf(cond).gt(0), CH.avgIf(value, cond), CH.lit(0))
	return from(MetricsGauge)
		.select(($) => ({
			serviceName: $.ServiceName,
			latencyP99Ms: avgWhere(
				$.Value,
				$.MetricName.eq("cloudflare.worker.duration").and($.Attributes.get("quantile").eq("0.99")),
			),
			cpuP99Ms: avgWhere(
				$.Value,
				$.MetricName.eq("cloudflare.worker.cpu_time").and($.Attributes.get("quantile").eq("0.99")),
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
