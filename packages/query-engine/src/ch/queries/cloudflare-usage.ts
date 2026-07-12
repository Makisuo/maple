// ---------------------------------------------------------------------------
// Cloudflare integration usage
//
// Hourly ingest volume per Cloudflare-derived service (zone or Worker script)
// from `metrics_sum`, backing the integrations-page "is data flowing?" readout.
// The request-count metrics are 5-min delta sums written by the analytics
// poller, so sum(Value) per bucket is the true request count.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, param, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { CHNumber } from "../schema"
import { MetricsSum } from "../tables"

const ISO_Z_FORMAT = "%Y-%m-%dT%H:%i:%S.%fZ"

/**
 * The only metric names the poller emits as monotonic request counters — the
 * selective predicate for usage rows (nothing else writes `cloudflare.*.requests`).
 */
export const CLOUDFLARE_USAGE_METRIC_NAMES = [
	"cloudflare.http.requests",
	"cloudflare.worker.requests",
] as const

export interface CloudflareUsageOutput {
	readonly serviceName: string
	/** Bucket start, ISO-8601 UTC. */
	readonly bucket: string
	readonly requests: number
	readonly datapoints: number
	/** Most recent datapoint timestamp within the bucket, ISO-8601 UTC. */
	readonly lastTimeUnix: string
}

/**
 * Row schema for {@link cloudflareUsageQuery}. `requests` (`sum`) and
 * `datapoints` (`count`, a `UInt64`) use {@link CHNumber} so a BYO-ClickHouse
 * org's string-encoded aggregates decode identically to Tinybird's numbers —
 * pass it as the `rowSchema` to `CH.compile` so `decodeRows` coerces centrally
 * instead of a `ParseError` surfacing downstream.
 */
export const cloudflareUsageRowSchema: CompiledQueryRowSchema<CloudflareUsageOutput> = Schema.Struct({
	serviceName: Schema.String,
	bucket: Schema.String,
	requests: CHNumber,
	datapoints: CHNumber,
	lastTimeUnix: Schema.String,
})

export function cloudflareUsageQuery() {
	return from(MetricsSum)
		.select(($) => ({
			serviceName: $.ServiceName,
			bucket: CH.formatDateTime(
				CH.toStartOfInterval($.TimeUnix, param.int("bucketSeconds")),
				ISO_Z_FORMAT,
			),
			requests: CH.sum($.Value),
			datapoints: CH.count(),
			lastTimeUnix: CH.formatDateTime(CH.max_($.TimeUnix), ISO_Z_FORMAT),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...CLOUDFLARE_USAGE_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("serviceName", "bucket")
		.orderBy(["serviceName", "asc"], ["bucket", "asc"])
		.format("JSON")
}
