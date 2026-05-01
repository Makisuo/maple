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
	readonly sampledSpanCount: number
	readonly unsampledSpanCount: number
	readonly dominantThreshold: string
}

export function serviceDependenciesSQL(
	opts: ServiceDependenciesOpts,
	params: { orgId: string; startTime: string; endTime: string },
): CompiledQuery<ServiceDependenciesOutput> {
	const esc = escapeClickHouseString
	const envFilter = opts.deploymentEnv ? `AND DeploymentEnv = '${esc(opts.deploymentEnv)}'` : ""

	// Node 1: Pre-aggregated hourly edges (peer.service path)
	const peerServiceEdges = `SELECT
      SourceService AS sourceService,
      TargetService AS targetService,
      sum(CallCount) AS callCount,
      sum(ErrorCount) AS errorCount,
      sum(DurationSumMs) / sum(CallCount) AS avgDurationMs,
      max(MaxDurationMs) AS p95DurationMs,
      sum(SampledSpanCount) AS sampledSpanCount,
      sum(UnsampledSpanCount) AS unsampledSpanCount,
      '' AS dominantThreshold
    FROM service_map_edges_hourly
    WHERE OrgId = '${esc(params.orgId)}'
      AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
      AND Hour <= '${esc(params.endTime)}'
      ${envFilter}
    GROUP BY sourceService, targetService`

	// Node 2: Join-based edges (Client/Producer spans without peer.service)
	const joinEdges = `SELECT
      p.ServiceName AS sourceService,
      c.ServiceName AS targetService,
      count() AS callCount,
      countIf(c.StatusCode = 'Error') AS errorCount,
      avg(c.Duration / 1000000) AS avgDurationMs,
      quantile(0.95)(c.Duration / 1000000) AS p95DurationMs,
      countIf(c.TraceState LIKE '%th:%') AS sampledSpanCount,
      countIf(c.TraceState = '' OR c.TraceState NOT LIKE '%th:%') AS unsampledSpanCount,
      anyIf(extract(c.TraceState, 'th:([0-9a-f]+)'), c.TraceState LIKE '%th:%') AS dominantThreshold
    FROM (
      SELECT TraceId, SpanId, ServiceName
      FROM service_map_spans
      WHERE OrgId = '${esc(params.orgId)}'
        AND SpanKind IN ('Client', 'Producer')
        AND PeerService = ''
        AND Timestamp >= addHours(toDateTime('${esc(params.endTime)}'), -1)
        AND Timestamp <= '${esc(params.endTime)}'
        ${envFilter}
    ) AS p
    INNER JOIN (
      SELECT TraceId, ParentSpanId, ServiceName, Duration, StatusCode, TraceState
      FROM service_map_children
      WHERE OrgId = '${esc(params.orgId)}'
        AND Timestamp >= addHours(toDateTime('${esc(params.endTime)}'), -1)
        AND Timestamp <= '${esc(params.endTime)}'
        ${envFilter}
    ) AS c
    ON p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId
    WHERE p.ServiceName != c.ServiceName
    GROUP BY sourceService, targetService`

	// Node 3: Merge both edge sources
	const sql = `SELECT
  sourceService,
  targetService,
  sum(callCount) AS callCount,
  sum(errorCount) AS errorCount,
  avg(avgDurationMs) AS avgDurationMs,
  max(p95DurationMs) AS p95DurationMs,
  sum(sampledSpanCount) AS sampledSpanCount,
  sum(unsampledSpanCount) AS unsampledSpanCount,
  any(dominantThreshold) AS dominantThreshold
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
	readonly sampledSpanCount: number
	readonly unsampledSpanCount: number
	readonly dominantThreshold: string
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

	// Hourly pre-aggregated buckets — covers everything except the in-flight hour.
	const hourlyEdges = `SELECT
      ServiceName AS sourceService,
      DbSystem AS dbSystem,
      sum(CallCount) AS callCount,
      sum(ErrorCount) AS errorCount,
      sum(DurationSumMs) / sum(CallCount) AS avgDurationMs,
      max(MaxDurationMs) AS p95DurationMs,
      sum(SampledSpanCount) AS sampledSpanCount,
      sum(UnsampledSpanCount) AS unsampledSpanCount,
      '' AS dominantThreshold
    FROM service_map_db_edges_hourly
    WHERE OrgId = '${esc(params.orgId)}'
      AND Hour >= toStartOfHour(toDateTime('${esc(params.startTime)}'))
      AND Hour <= '${esc(params.endTime)}'
      AND DbSystem != ''
      ${envFilterMv}
    GROUP BY sourceService, dbSystem`

	// Trailing-hour raw fallback so the current incomplete bucket is included.
	const recentEdges = `SELECT
      ServiceName AS sourceService,
      SpanAttributes['db.system'] AS dbSystem,
      count() AS callCount,
      countIf(StatusCode = 'Error') AS errorCount,
      avg(Duration / 1000000) AS avgDurationMs,
      quantile(0.95)(Duration / 1000000) AS p95DurationMs,
      countIf(TraceState LIKE '%th:%') AS sampledSpanCount,
      countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS unsampledSpanCount,
      anyIf(extract(TraceState, 'th:([0-9a-f]+)'), TraceState LIKE '%th:%') AS dominantThreshold
    FROM traces
    WHERE OrgId = '${esc(params.orgId)}'
      AND Timestamp >= addHours(toDateTime('${esc(params.endTime)}'), -1)
      AND Timestamp <= '${esc(params.endTime)}'
      AND SpanKind IN ('Client', 'Producer')
      AND SpanAttributes['db.system'] != ''
      AND ServiceName != ''
      ${envFilterRaw}
    GROUP BY sourceService, dbSystem`

	const sql = `SELECT
  sourceService,
  dbSystem,
  sum(callCount) AS callCount,
  sum(errorCount) AS errorCount,
  avg(avgDurationMs) AS avgDurationMs,
  max(p95DurationMs) AS p95DurationMs,
  sum(sampledSpanCount) AS sampledSpanCount,
  sum(unsampledSpanCount) AS unsampledSpanCount,
  any(dominantThreshold) AS dominantThreshold
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
  max(FaasName) AS faasName
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
