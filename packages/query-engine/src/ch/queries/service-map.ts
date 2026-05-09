// ---------------------------------------------------------------------------
// Typed Service Map Queries
//
// Raw SQL builder for service dependency edges (multi-table JOIN + UNION ALL).
// ---------------------------------------------------------------------------

import { escapeClickHouseString } from "../../sql/sql-fragment"
import type { CompiledQuery } from "../compile"

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface ServiceDependenciesOpts {
	deploymentEnv?: string
}

export interface ServiceDependenciesOutput {
	readonly sourceService: string
	readonly targetService: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	readonly p95DurationMs: number
	readonly estimatedSpanCount: number
}

export function serviceDependenciesSQL(
	opts: ServiceDependenciesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServiceDependenciesOutput> {
	const esc = escapeClickHouseString
	const envFilter = opts.deploymentEnv ? `AND DeploymentEnv = '${esc(opts.deploymentEnv)}'` : ""

	// Inner branches expose distinct alias names (`bucket*`) so the outer
	// SELECT's `sum(...) AS callCount` doesn't collide with an inner
	// `sum(CallCount) AS callCount`. ClickHouse's UNION-ALL+GROUP-BY
	// optimizer otherwise rewrites the outer as `sum(sum(CallCount))` and
	// rejects the query with "found inside another aggregate function".
	//
	// We also carry `bucketDurationSumMs` separately from `bucketCallCount`
	// so the outer can compute a properly-weighted average:
	//   sum(bucketDurationSumMs) / sum(bucketCallCount)
	// instead of `avg(avgDurationMs)` (averaging averages, which ignores
	// the relative call counts of each branch).
	//
	// Time ranges are split so the two branches don't double-count the
	// in-progress hour: the MV covers complete hourly buckets strictly
	// before `toStartOfHour(endTime)`, the raw join scans only from there
	// to `endTime`. (Previously the MV included the in-progress hour AND
	// the raw join read the trailing hour, so spans inside the current
	// hour got counted twice.)
	//
	// `bucketEstimatedSpanCount` per-row fallback
	// `if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))`: the
	// SampleRateSum column was added after this MV existed, so historical
	// buckets have SampleRateSum=0. For those buckets we treat them as
	// unsampled — accurate for new buckets, degraded but non-zero for old
	// ones. Safe across mixed time ranges.
	const peerServiceEdges = `SELECT
      SourceService AS sourceService,
      TargetService AS targetService,
      sum(CallCount) AS bucketCallCount,
      sum(ErrorCount) AS bucketErrorCount,
      sum(DurationSumMs) AS bucketDurationSumMs,
      max(MaxDurationMs) AS bucketMaxDurationMs,
      sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
    FROM service_map_edges_hourly
    WHERE OrgId = '${esc(params.orgId)}'
      AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
      AND Hour < toStartOfHour(toDateTime('${esc(params.endTime)}'))
      ${envFilter}
    GROUP BY sourceService, targetService`

	// Join-based edges for the in-progress hour only (Client/Producer spans
	// without peer.service). `service_map_children` doesn't carry SampleRate
	// yet — it's a TraceState-only projection — so we compute the per-row
	// weight inline from `c.TraceState`. Duration math stays consistent with
	// the MV branch by exposing sum/max separately.
	const joinEdges = `SELECT
      p.ServiceName AS sourceService,
      c.ServiceName AS targetService,
      count() AS bucketCallCount,
      countIf(c.StatusCode = 'Error') AS bucketErrorCount,
      sum(c.Duration / 1000000) AS bucketDurationSumMs,
      max(c.Duration / 1000000) AS bucketMaxDurationMs,
      sum(multiIf(
        match(c.TraceState, 'th:[0-9a-f]+'),
        1.0 / greatest(1.0 - reinterpretAsUInt64(reverse(unhex(rightPad(extract(c.TraceState, 'th:([0-9a-f]+)'), 16, '0')))) / pow(2.0, 64), 0.0001),
        1.0
      )) AS bucketEstimatedSpanCount
    FROM (
      SELECT TraceId, SpanId, ServiceName
      FROM service_map_spans
      WHERE OrgId = '${esc(params.orgId)}'
        AND SpanKind IN ('Client', 'Producer')
        AND PeerService = ''
        AND Timestamp >= toStartOfHour(toDateTime('${esc(params.endTime)}'))
        AND Timestamp <= '${esc(params.endTime)}'
        ${envFilter}
    ) AS p
    INNER JOIN (
      SELECT TraceId, ParentSpanId, ServiceName, Duration, StatusCode, TraceState
      FROM service_map_children
      WHERE OrgId = '${esc(params.orgId)}'
        AND Timestamp >= toStartOfHour(toDateTime('${esc(params.endTime)}'))
        AND Timestamp <= '${esc(params.endTime)}'
        ${envFilter}
    ) AS c
    ON p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId
    WHERE p.ServiceName != c.ServiceName
    GROUP BY sourceService, targetService`

	const sql = `SELECT
  sourceService,
  targetService,
  sum(bucketCallCount) AS callCount,
  sum(bucketErrorCount) AS errorCount,
  sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
  max(bucketMaxDurationMs) AS p95DurationMs,
  sum(bucketEstimatedSpanCount) AS estimatedSpanCount
FROM (
  ${peerServiceEdges}
  UNION ALL
  ${joinEdges}
)
GROUP BY sourceService, targetService
ORDER BY callCount DESC
LIMIT 200
FORMAT JSON`

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServiceDependenciesOutput>,
	}
}

// ---------------------------------------------------------------------------
// Service ↔ database edges
//
// Surfaces DB calls (Client/Producer spans with `db.system` set) as a separate
// dependency relation so the service map can reify databases as nodes.
// One row per (sourceService, dbSystem).
//
// Reads pre-aggregated hourly buckets from `service_map_db_edges_hourly`
// (populated by `service_map_db_edges_hourly_mv`), and unions in the trailing
// hour from raw `traces` so the most recent in-flight bucket is included even
// before the MV finalizes it. Mirrors the dual-source pattern used by
// `serviceDependenciesSQL` for `service_map_edges_hourly`.
// ---------------------------------------------------------------------------

export interface ServiceDbEdgesOpts {
	deploymentEnv?: string
}

export interface ServiceDbEdgesOutput {
	readonly sourceService: string
	readonly dbSystem: string
	readonly callCount: number
	readonly errorCount: number
	readonly avgDurationMs: number
	readonly p95DurationMs: number
	readonly estimatedSpanCount: number
}

export function serviceDbEdgesSQL(
	opts: ServiceDbEdgesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServiceDbEdgesOutput> {
	const esc = escapeClickHouseString
	const envFilterMv = opts.deploymentEnv
		? `AND DeploymentEnv = '${esc(opts.deploymentEnv)}'`
		: ""
	const envFilterRaw = opts.deploymentEnv
		? `AND ResourceAttributes['deployment.environment'] = '${esc(opts.deploymentEnv)}'`
		: ""

	// Inner branches expose `bucket*` aliases so the outer `sum(...) AS callCount`
	// can't collide with an inner `sum(CallCount) AS callCount` — same fix as
	// `serviceDependenciesSQL` for the same nested-aggregate optimizer error.
	// Historical buckets that pre-date the SampleRateSum column have it set to
	// 0, so we fall back to CallCount per-row (treats those buckets as
	// unsampled — degraded but safe).
	const hourlyEdges = `SELECT
      ServiceName AS sourceService,
      DbSystem AS dbSystem,
      sum(CallCount) AS bucketCallCount,
      sum(ErrorCount) AS bucketErrorCount,
      sum(DurationSumMs) AS bucketDurationSumMs,
      max(MaxDurationMs) AS bucketMaxDurationMs,
      sum(if(SampleRateSum > 0, SampleRateSum, toFloat64(CallCount))) AS bucketEstimatedSpanCount
    FROM service_map_db_edges_hourly
    WHERE OrgId = '${esc(params.orgId)}'
      AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
      AND Hour < toStartOfHour(toDateTime('${esc(params.endTime)}'))
      AND DbSystem != ''
      ${envFilterMv}
    GROUP BY sourceService, dbSystem`

	// Raw fallback for the in-progress hour only (the MV branch stops at
	// `toStartOfHour(endTime)`). Reads per-row `SampleRate` directly so no
	// inline weight math is needed. Carries `bucketDurationSumMs` separately
	// so the outer can do a properly-weighted average.
	const recentEdges = `SELECT
      ServiceName AS sourceService,
      SpanAttributes['db.system'] AS dbSystem,
      count() AS bucketCallCount,
      countIf(StatusCode = 'Error') AS bucketErrorCount,
      sum(Duration / 1000000) AS bucketDurationSumMs,
      max(Duration / 1000000) AS bucketMaxDurationMs,
      sum(SampleRate) AS bucketEstimatedSpanCount
    FROM traces
    WHERE OrgId = '${esc(params.orgId)}'
      AND Timestamp >= toStartOfHour(toDateTime('${esc(params.endTime)}'))
      AND Timestamp <= '${esc(params.endTime)}'
      AND SpanKind IN ('Client', 'Producer')
      AND SpanAttributes['db.system'] != ''
      AND ServiceName != ''
      ${envFilterRaw}
    GROUP BY sourceService, dbSystem`

	const sql = `SELECT
  sourceService,
  dbSystem,
  sum(bucketCallCount) AS callCount,
  sum(bucketErrorCount) AS errorCount,
  sum(bucketDurationSumMs) / nullIf(sum(bucketCallCount), 0) AS avgDurationMs,
  max(bucketMaxDurationMs) AS p95DurationMs,
  sum(bucketEstimatedSpanCount) AS estimatedSpanCount
FROM (
  ${hourlyEdges}
  UNION ALL
  ${recentEdges}
)
GROUP BY sourceService, dbSystem
ORDER BY callCount DESC
LIMIT 200
FORMAT JSON`

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServiceDbEdgesOutput>,
	}
}

// ---------------------------------------------------------------------------
// Service hosting platform
//
// Per-service rollup of the OTel resource attributes that identify where a
// service runs. The caller derives a single `Platform` label from these raw
// values (see apps/web/src/api/tinybird/service-map.ts).
//
// Reads from `service_platforms_hourly` (populated by
// `service_platforms_hourly_mv`). The MV uses SimpleAggregateFunction("max")
// on each attribute string, so empty strings sort first and any non-empty
// value wins on merge — exactly the "did any span in this window carry this
// attribute" semantics the platform classifier needs. `k8s.pod.name` /
// `k8s.deployment.name` are required for the kubernetes signal because
// `k8s.cluster.name` can leak onto in-transit spans via the otel-gateway.
// ---------------------------------------------------------------------------

export interface ServicePlatformsOpts {
	deploymentEnv?: string
}

export interface ServicePlatformsOutput {
	readonly serviceName: string
	readonly k8sCluster: string
	readonly k8sPodName: string
	readonly k8sDeploymentName: string
	readonly cloudPlatform: string
	readonly cloudProvider: string
	readonly faasName: string
	readonly mapleSdkType: string
	readonly processRuntimeName: string
}

export function servicePlatformsSQL(
	opts: ServicePlatformsOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServicePlatformsOutput> {
	const esc = escapeClickHouseString
	const envFilter = opts.deploymentEnv
		? `AND DeploymentEnv = '${esc(opts.deploymentEnv)}'`
		: ""

	const sql = `SELECT
  ServiceName AS serviceName,
  max(K8sCluster) AS k8sCluster,
  max(K8sPodName) AS k8sPodName,
  max(K8sDeploymentName) AS k8sDeploymentName,
  max(CloudPlatform) AS cloudPlatform,
  max(CloudProvider) AS cloudProvider,
  max(FaasName) AS faasName,
  max(MapleSdkType) AS mapleSdkType,
  max(ProcessRuntimeName) AS processRuntimeName
FROM service_platforms_hourly
WHERE OrgId = '${esc(params.orgId)}'
  AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
  AND Hour <= '${esc(params.endTime)}'
  AND ServiceName != ''
  ${envFilter}
GROUP BY serviceName
LIMIT 500
FORMAT JSON`

	return {
		sql,
		castRows: (rows) => rows as unknown as ReadonlyArray<ServicePlatformsOutput>,
	}
}
