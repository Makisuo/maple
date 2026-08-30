// PlanetScale infrastructure page (/infra/planetscale)
//
// Bucketed timeseries over the scraped PlanetScale metrics for the database
// detail charts. The fleet table reuses the service-map rollups
// (`planetscaleGaugesSQL` / `planetscaleConnectionsSQL` / `planetscaleStorageSQL`)
// plus the polled inventory — no separate fleet query needed.
//
// Two variants: database-wide, and scoped to one branch. They exist as separate
// functions (like the `*Branch*` pairs in planetscale-map.ts) because a database
// on PlanetScale is routinely ~30 branches — mostly short-lived `pr-*` ones — so
// the database-wide `max()` is dominated by whichever ephemeral branch spiked.
// Scoping to a branch is what makes the chart mean anything.

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, fromQuery, param } from "@maple-dev/clickhouse-builder"
import { MetricsGauge } from "@maple/query-engine/ch/tables"
import {
	CONNECTION_METRIC_NAMES,
	CPU_METRIC_NAMES,
	MEMORY_METRIC_NAMES,
	REPLICA_LAG_METRIC_NAMES,
	STORAGE_AVAILABLE_METRIC_NAMES,
	STORAGE_CAPACITY_METRIC_NAMES,
	STORAGE_METRIC_NAMES,
} from "./planetscale-map"

const ALL_METRIC_NAMES = [
	...CONNECTION_METRIC_NAMES,
	...CPU_METRIC_NAMES,
	...MEMORY_METRIC_NAMES,
	...REPLICA_LAG_METRIC_NAMES,
	...STORAGE_METRIC_NAMES,
] as const

export interface PlanetScaleInfraTimeseriesOutput {
	readonly bucket: string
	readonly connectionsAvg: number
	readonly cpuMaxPercent: number
	readonly memMaxPercent: number
	readonly replicaLagMaxSeconds: number
	/** Disk used (0–100) at this bucket's worst moment. Read with `storageSamples`. */
	readonly storageUsedPercent: number
	/** Free-space samples behind this bucket; 0 means the series was absent, not full. */
	readonly storageSamples: number
}

/**
 * Per-raw-timestamp collapse shared by both variants: connections are summed
 * across series (one per edge region/branch), while utilization, lag, and the
 * volume gauges take their extreme. `availableSamples` rides along so the bucket
 * grouping can ignore timestamps where free space wasn't scraped — capacity is
 * sampled slightly more often, and treating a missing sample as zero free space
 * would paint every such bucket as a full disk.
 */
const timeseriesInner = () =>
	from(MetricsGauge).select(($) => ({
		t: $.TimeUnix,
		totalConnections: CH.sumIf($.Value, $.MetricName.in_(...CONNECTION_METRIC_NAMES)),
		cpuMax: CH.maxIf($.Value, $.MetricName.in_(...CPU_METRIC_NAMES)),
		memMax: CH.maxIf($.Value, $.MetricName.in_(...MEMORY_METRIC_NAMES)),
		lagMax: CH.maxIf($.Value, $.MetricName.in_(...REPLICA_LAG_METRIC_NAMES)),
		capacityBytes: CH.maxIf($.Value, $.MetricName.in_(...STORAGE_CAPACITY_METRIC_NAMES)),
		availableBytes: CH.minIf($.Value, $.MetricName.in_(...STORAGE_AVAILABLE_METRIC_NAMES)),
		availableSamples: CH.countIf($.MetricName.in_(...STORAGE_AVAILABLE_METRIC_NAMES)),
	}))

const bucketOuter = (inner: ReturnType<typeof timeseriesInner>) =>
	fromQuery(inner, "points")
		.select(($) => ({
			bucket: CH.toStartOfInterval($.t, param.int("bucketSeconds")),
			connectionsAvg: CH.avg($.totalConnections),
			cpuMaxPercent: CH.max_($.cpuMax),
			memMaxPercent: CH.max_($.memMax),
			replicaLagMaxSeconds: CH.max_($.lagMax),
			// Same phrasing as planetscaleStorageSQL — `100 - free/capacity*100`,
			// which is correct under plain SQL precedence where the intuitive
			// `(capacity - free) / capacity * 100` would not be (the builder's
			// arithmetic helpers don't parenthesize). The `availableSamples` guard
			// keeps buckets that never sampled free space out of the minimum, so a
			// gap in the series can't read as a full disk.
			storageUsedPercent: CH.maxIf(
				CH.lit(100).sub($.availableBytes.div($.capacityBytes).mul(100)),
				$.availableSamples.gt(0).and($.capacityBytes.gt(0)),
			),
			storageSamples: CH.sum($.availableSamples),
		}))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")

/** Bucketed health timeseries across every branch of ONE database. */
export function planetscaleInfraTimeseriesSQL() {
	const inner = timeseriesInner()
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...ALL_METRIC_NAMES),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			).eq(param.string("database")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
		])
		.groupBy("t")

	return bucketOuter(inner)
}

/** Bucketed health timeseries for ONE branch of one database. */
export function planetscaleBranchInfraTimeseriesSQL() {
	const inner = timeseriesInner()
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...ALL_METRIC_NAMES),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_database_name"), ""),
				$.Attributes.get("planetscale_database"),
			).eq(param.string("database")),
			CH.coalesce(
				CH.nullIf($.Attributes.get("planetscale_branch_name"), ""),
				$.Attributes.get("planetscale_branch"),
			).eq(param.string("branch")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
		])
		.groupBy("t")

	return bucketOuter(inner)
}
