// ---------------------------------------------------------------------------
// Cloudflare integration usage
//
// Hourly ingest volume per Cloudflare-derived service (zone or Worker script)
// from `metrics_sum`, backing the integrations-page "is data flowing?" readout.
// The request-count metrics are 5-min delta sums written by the analytics
// poller, so sum(Value) per bucket is the true request count.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, param } from "@maple-dev/clickhouse-builder"
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
