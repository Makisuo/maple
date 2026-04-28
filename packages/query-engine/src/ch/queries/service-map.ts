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
