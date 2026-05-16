// ---------------------------------------------------------------------------
// Service Map — hourly edge rollup
//
// `service_map_edges_hourly` cannot be filled by a materialized view: the
// downstream service of an edge is only known by joining a Client/Producer
// span to its child Server/Consumer span, a cross-span join no MV can express.
// Instead, `ServiceMapRollupService` runs this query once per completed hour
// and ingests the result into `service_map_edges_hourly`.
//
// The query is `serviceMapEdgeJoinSQL` (shared verbatim with the in-progress
// branch of `serviceDependenciesSQL`) bounded to a single hour. Its output
// columns match the `service_map_edges_hourly` table exactly, so rows flow
// straight from `sqlQuery` into `ingest` with no reshaping.
// ---------------------------------------------------------------------------

import type { CompiledQuery } from "../compile"
import { escapeClickHouseString } from "../../sql/sql-fragment"
import { serviceMapEdgeJoinSQL } from "./service-map"

/** One pre-aggregated service-to-service edge bucket — mirrors the columns of
 * the `service_map_edges_hourly` ClickHouse table. */
export interface ServiceMapEdgesHourlyOutput {
	readonly OrgId: string
	readonly Hour: string
	readonly SourceService: string
	readonly TargetService: string
	readonly DeploymentEnv: string
	readonly CallCount: number
	readonly ErrorCount: number
	readonly DurationSumMs: number
	readonly MaxDurationMs: number
	readonly SampledSpanCount: number
	readonly UnsampledSpanCount: number
	readonly SampleRateSum: number
}

export interface ServiceMapEdgesRollupParams {
	readonly orgId: string
	/** Tinybird datetime string — start of the completed hour (inclusive). */
	readonly hourStart: string
	/** Tinybird datetime string — `hourStart` + 1 hour (exclusive). */
	readonly hourEnd: string
}

/** One already-rolled-up hour bucket — the Unix-second start of the hour. */
export interface ServiceMapEdgesExistingHour {
	readonly hourTs: number
}

/**
 * SQL listing the distinct hours already present in `service_map_edges_hourly`
 * for an org within `[startTime, endTime)`. The rollup uses this to skip hours
 * it has already sealed — re-rolling an hour would double-count it because the
 * target is an AggregatingMergeTree.
 */
export function serviceMapEdgesExistingHoursSQL(params: {
	orgId: string
	startTime: string
	endTime: string
}): CompiledQuery<ServiceMapEdgesExistingHour> {
	const esc = escapeClickHouseString
	const sql = `SELECT DISTINCT toUnixTimestamp(Hour) AS hourTs
FROM service_map_edges_hourly
WHERE OrgId = '${esc(params.orgId)}'
  AND Hour >= toDateTime('${esc(params.startTime)}')
  AND Hour < toDateTime('${esc(params.endTime)}')
FORMAT JSON`

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServiceMapEdgesExistingHour>,
	}
}

/**
 * SQL that computes the service-to-service edges for one completed hour
 * `[hourStart, hourEnd)`. Output rows are ready to `ingest` into
 * `service_map_edges_hourly` unchanged.
 */
export function serviceMapEdgesRollupSQL(
	params: ServiceMapEdgesRollupParams,
): CompiledQuery<ServiceMapEdgesHourlyOutput> {
	const esc = escapeClickHouseString
	const sql = `${serviceMapEdgeJoinSQL({
		orgId: params.orgId,
		startExpr: `toDateTime('${esc(params.hourStart)}')`,
		endExpr: `toDateTime('${esc(params.hourEnd)}')`,
	})}
FORMAT JSON`

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServiceMapEdgesHourlyOutput>,
	}
}
