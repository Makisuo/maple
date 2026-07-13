// ---------------------------------------------------------------------------
// PlanetScale infrastructure page (/infra/planetscale)
//
// Bucketed per-database timeseries over the scraped PlanetScale metrics for
// the database detail charts. The fleet table reuses the service-map rollups
// (`planetscaleGaugesSQL` / `planetscaleConnectionsSQL`) plus the polled
// inventory — no separate fleet query needed.
// ---------------------------------------------------------------------------

import { Schema } from "effect"
import * as CH from "@maple-dev/clickhouse-builder/expr"
import { from, fromQuery, param, type CompiledQueryRowSchema } from "@maple-dev/clickhouse-builder"
import { CHNumber } from "../schema"
import { MetricsGauge } from "../tables"
import {
	CONNECTION_METRIC_NAMES,
	CPU_METRIC_NAMES,
	MEMORY_METRIC_NAMES,
	REPLICA_LAG_METRIC_NAMES,
} from "./planetscale-map"

const ALL_METRIC_NAMES = [
	...CONNECTION_METRIC_NAMES,
	...CPU_METRIC_NAMES,
	...MEMORY_METRIC_NAMES,
	...REPLICA_LAG_METRIC_NAMES,
] as const

export interface PlanetScaleInfraTimeseriesOutput {
	readonly bucket: string
	readonly connectionsAvg: number
	readonly cpuMaxPercent: number
	readonly memMaxPercent: number
	readonly replicaLagMaxSeconds: number
}

export const planetscaleInfraTimeseriesRowSchema: CompiledQueryRowSchema<PlanetScaleInfraTimeseriesOutput> =
	Schema.Struct({
		bucket: Schema.String,
		connectionsAvg: CHNumber,
		cpuMaxPercent: CHNumber,
		memMaxPercent: CHNumber,
		replicaLagMaxSeconds: CHNumber,
	})

/**
 * Bucketed health timeseries for ONE database: connections are summed across
 * series per raw timestamp (inner grouping) then averaged per bucket, while
 * CPU/memory/lag take the bucket max — same shapes as the service-map rollups.
 */
export function planetscaleInfraTimeseriesSQL() {
	const inner = from(MetricsGauge)
		.select(($) => ({
			t: $.TimeUnix,
			totalConnections: CH.sumIf($.Value, $.MetricName.in_(...CONNECTION_METRIC_NAMES)),
			cpuMax: CH.maxIf($.Value, $.MetricName.in_(...CPU_METRIC_NAMES)),
			memMax: CH.maxIf($.Value, $.MetricName.in_(...MEMORY_METRIC_NAMES)),
			lagMax: CH.maxIf($.Value, $.MetricName.in_(...REPLICA_LAG_METRIC_NAMES)),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...ALL_METRIC_NAMES),
			$.Attributes.get("planetscale_database").eq(param.string("database")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("t")

	return fromQuery(inner, "points")
		.select(($) => ({
			bucket: CH.toStartOfInterval($.t, param.int("bucketSeconds")),
			connectionsAvg: CH.avg($.totalConnections),
			cpuMaxPercent: CH.max_($.cpuMax),
			memMaxPercent: CH.max_($.memMax),
			replicaLagMaxSeconds: CH.max_($.lagMax),
		}))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}
