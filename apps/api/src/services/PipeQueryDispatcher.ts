// ---------------------------------------------------------------------------
// Pipe Query Dispatcher
//
// Maps Tinybird pipe names + params to compiled CH SQL queries.
// This replaces the Tinybird SDK's named pipe execution with the CH query engine.
// ---------------------------------------------------------------------------

import { CH } from "@maple/query-engine"
import type { TracesMetric } from "@maple/query-engine"
import type { OrgId } from "@maple/domain"

export interface PipeCompiledQuery {
  readonly sql: string
  readonly castRows: (rows: ReadonlyArray<Record<string, unknown>>) => ReadonlyArray<unknown>
}

type PipeParams = Record<string, unknown> & { org_id: OrgId }

/** Erase the specific output type for the generic pipe dispatcher. */
function eraseType<T>(compiled: { sql: string; castRows: (rows: ReadonlyArray<Record<string, unknown>>) => ReadonlyArray<T> }): PipeCompiledQuery {
  return compiled
}

/**
 * Compiles a named pipe + params into a SQL string.
 * Returns undefined for unknown pipes (caller should handle gracefully).
 */
export function compilePipeQuery(
  pipe: string,
  params: PipeParams,
): PipeCompiledQuery | undefined {
  const orgId = String(params.org_id)
  const startTime = String(params.start_time ?? "2023-01-01 00:00:00")
  const endTime = String(params.end_time ?? "2099-12-31 23:59:59")
  const str = (key: string) => params[key] != null ? String(params[key]) : undefined
  const int = (key: string, def?: number) => params[key] != null ? Number(params[key]) : def
  const bool = (key: string) => params[key] === true || params[key] === "1" || params[key] === "true"

  switch (pipe) {
    // ----- Traces -----
    case "list_traces": {
      const compiled = CH.compile(
        CH.tracesRootListQuery({
          limit: int("limit", 100),
          offset: int("offset", 0),
          serviceName: str("service"),
          spanName: str("span_name"),
          errorsOnly: bool("has_error"),
          minDurationMs: int("min_duration_ms"),
          maxDurationMs: int("max_duration_ms"),
          environments: str("deployment_env") ? [str("deployment_env")!] : undefined,
          matchModes: {
            serviceName: str("service_match_mode") === "contains" ? "contains" : undefined,
            spanName: str("span_name_match_mode") === "contains" ? "contains" : undefined,
            deploymentEnv: str("deployment_env_match_mode") === "contains" ? "contains" : undefined,
          },
          attributeFilters: str("attribute_filter_key")
            ? [{ key: str("attribute_filter_key")!, value: str("attribute_filter_value"), mode: "equals" as const }]
            : undefined,
          resourceAttributeFilters: str("resource_filter_key")
            ? [{ key: str("resource_filter_key")!, value: str("resource_filter_value"), mode: "equals" as const }]
            : undefined,
        }),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    case "span_hierarchy":
      return eraseType(CH.spanHierarchySQL(
        { traceId: String(params.trace_id), spanId: str("span_id") },
        { orgId },
      ))

    case "traces_duration_stats":
      return eraseType(CH.tracesDurationStatsSQL(
        {
          serviceName: str("service"),
          spanName: str("span_name"),
          hasError: bool("has_error"),
          minDurationMs: int("min_duration_ms"),
          maxDurationMs: int("max_duration_ms"),
          httpMethod: str("http_method"),
          httpStatusCode: str("http_status_code"),
          deploymentEnv: str("deployment_env"),
          matchModes: {
            serviceName: str("service_match_mode") === "contains" ? "contains" : undefined,
            spanName: str("span_name_match_mode") === "contains" ? "contains" : undefined,
            deploymentEnv: str("deployment_env_match_mode") === "contains" ? "contains" : undefined,
          },
        },
        { orgId, startTime, endTime },
      ))

    case "traces_facets":
      return eraseType(CH.tracesFacetsSQL(
        {
          serviceName: str("service"),
          spanName: str("span_name"),
          hasError: bool("has_error"),
          minDurationMs: int("min_duration_ms"),
          maxDurationMs: int("max_duration_ms"),
          httpMethod: str("http_method"),
          httpStatusCode: str("http_status_code"),
          deploymentEnv: str("deployment_env"),
          matchModes: {
            serviceName: str("service_match_mode") === "contains" ? "contains" : undefined,
            spanName: str("span_name_match_mode") === "contains" ? "contains" : undefined,
            deploymentEnv: str("deployment_env_match_mode") === "contains" ? "contains" : undefined,
          },
          attributeFilterKey: str("attribute_filter_key"),
          attributeFilterValue: str("attribute_filter_value"),
          attributeFilterValueMatchMode: str("attribute_filter_value_match_mode") === "contains" ? "contains" : undefined,
          resourceFilterKey: str("resource_filter_key"),
          resourceFilterValue: str("resource_filter_value"),
          resourceFilterValueMatchMode: str("resource_filter_value_match_mode") === "contains" ? "contains" : undefined,
        },
        { orgId, startTime, endTime },
      ))

    // ----- Logs -----
    case "list_logs":
      return eraseType(CH.logsListSQL(
        {
          serviceName: str("service"),
          severity: str("severity"),
          minSeverity: int("min_severity"),
          traceId: str("trace_id"),
          spanId: str("span_id"),
          cursor: str("cursor"),
          search: str("search"),
          limit: int("limit", 50),
        },
        { orgId, startTime, endTime },
      ))

    case "logs_count": {
      const compiled = CH.compile(
        CH.logsCountQuery({
          serviceName: str("service"),
          severity: str("severity"),
          traceId: str("trace_id"),
          search: str("search"),
        }),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    case "logs_facets":
      return eraseType(CH.logsFacetsSQL(
        { serviceName: str("service"), severity: str("severity") },
        { orgId, startTime, endTime },
      ))

    case "error_rate_by_service": {
      const compiled = CH.compile(
        CH.errorRateByServiceQuery(),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    // ----- Services -----
    case "service_overview": {
      const compiled = CH.compile(
        CH.serviceOverviewQuery({
          environments: str("environments")?.split(",").filter(Boolean),
          commitShas: str("commit_shas")?.split(",").filter(Boolean),
        }),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    case "services_facets":
      return eraseType(CH.servicesFacetsSQL(
        { orgId, startTime, endTime },
      ))

    case "service_releases_timeline": {
      const compiled = CH.compile(
        CH.serviceReleasesTimelineQuery({
          serviceName: String(params.service_name),
        }),
        { orgId, startTime, endTime, bucketSeconds: int("bucket_seconds", 300)! },
      )
      return eraseType(compiled)
    }

    case "service_apdex_time_series": {
      const compiled = CH.compile(
        CH.serviceApdexTimeseriesQuery({
          serviceName: String(params.service_name),
          apdexThresholdMs: int("apdex_threshold_ms", 500),
        }),
        { orgId, startTime, endTime, bucketSeconds: int("bucket_seconds", 60)! },
      )
      return eraseType(compiled)
    }

    case "get_service_usage": {
      const compiled = CH.compile(
        CH.serviceUsageQuery({
          serviceName: str("service"),
        }),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    case "service_dependencies":
      return eraseType(CH.serviceDependenciesSQL(
        { deploymentEnv: str("deployment_env") },
        { orgId, startTime, endTime },
      ))

    // ----- Errors -----
    case "errors_by_type": {
      const compiled = CH.compile(
        CH.errorsByTypeQuery({
          rootOnly: bool("root_only"),
          services: str("services")?.split(",").filter(Boolean),
          deploymentEnvs: str("deployment_envs")?.split(",").filter(Boolean),
          errorTypes: str("error_types")?.split(",").filter(Boolean),
          limit: int("limit", 50),
        }),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    case "errors_timeseries": {
      const compiled = CH.compile(
        CH.errorsTimeseriesQuery({
          errorType: String(params.error_type),
          services: str("services")?.split(",").filter(Boolean),
        }),
        { orgId, startTime, endTime, bucketSeconds: int("bucket_seconds", 3600)! },
      )
      return eraseType(compiled)
    }

    case "errors_facets":
      return eraseType(CH.errorsFacetsSQL(
        {
          rootOnly: bool("root_only"),
          services: str("services")?.split(",").filter(Boolean),
          deploymentEnvs: str("deployment_envs")?.split(",").filter(Boolean),
          errorTypes: str("error_types")?.split(",").filter(Boolean),
        },
        { orgId, startTime, endTime },
      ))

    case "errors_summary":
      return eraseType(CH.errorsSummarySQL(
        {
          rootOnly: bool("root_only"),
          services: str("services")?.split(",").filter(Boolean),
          deploymentEnvs: str("deployment_envs")?.split(",").filter(Boolean),
          errorTypes: str("error_types")?.split(",").filter(Boolean),
        },
        { orgId, startTime, endTime },
      ))

    case "error_detail_traces":
      return eraseType(CH.errorDetailTracesSQL(
        {
          errorType: String(params.error_type),
          rootOnly: bool("root_only"),
          services: str("services")?.split(",").filter(Boolean),
          limit: int("limit", 10),
        },
        { orgId, startTime, endTime },
      ))

    // ----- Metrics -----
    case "list_metrics":
      return eraseType(CH.listMetricsSQL(
        {
          serviceName: str("service"),
          metricType: str("metric_type"),
          search: str("search"),
          limit: int("limit", 100),
          offset: int("offset", 0),
        },
        { orgId, startTime, endTime },
      ))

    case "metrics_summary":
      return eraseType(CH.metricsSummarySQL(
        { orgId, startTime, endTime, serviceName: str("service") },
      ))

    // ----- Attributes -----
    case "span_attribute_keys": {
      const compiled = CH.compile(
        CH.attributeKeysQuery({ scope: "span", limit: int("limit", 200) }),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    case "resource_attribute_keys": {
      const compiled = CH.compile(
        CH.attributeKeysQuery({ scope: "resource", limit: int("limit", 200) }),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    case "metric_attribute_keys": {
      const compiled = CH.compile(
        CH.attributeKeysQuery({ scope: "metric", limit: int("limit", 200) }),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    case "span_attribute_values":
      return eraseType(CH.spanAttributeValuesSQL(
        { attributeKey: String(params.attribute_key), limit: int("limit", 50) },
        { orgId, startTime, endTime },
      ))

    case "resource_attribute_values":
      return eraseType(CH.resourceAttributeValuesSQL(
        { attributeKey: String(params.attribute_key), limit: int("limit", 50) },
        { orgId, startTime, endTime },
      ))

    // ----- Custom charts (already handled by traces queries) -----
    case "custom_traces_timeseries":
      return eraseType(buildCustomTracesTimeseriesSQL(params, { orgId, startTime, endTime }))

    case "custom_traces_breakdown":
      return eraseType(buildCustomTracesBreakdownSQL(params, { orgId, startTime, endTime }))

    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Attribute filter param helpers (numbered suffix pattern from Tinybird pipes)
// ---------------------------------------------------------------------------

import { escapeClickHouseString } from "@maple/query-engine/sql"

const SUFFIXES = ["", "_2", "_3", "_4", "_5"] as const

function buildAttributeFiltersFromParams(params: PipeParams): Array<{ key: string; value?: string; mode: "equals" | "exists" }> | undefined {
  const filters: Array<{ key: string; value?: string; mode: "equals" | "exists" }> = []
  for (const suffix of SUFFIXES) {
    const key = params[`attribute_filter_key${suffix}`]
    if (key == null) continue
    const exists = params[`attribute_filter_exists${suffix}`] === "1"
    filters.push({
      key: String(key),
      value: exists ? undefined : (params[`attribute_filter_value${suffix}`] != null ? String(params[`attribute_filter_value${suffix}`]) : undefined),
      mode: exists ? "exists" : "equals",
    })
  }
  return filters.length > 0 ? filters : undefined
}

function buildResourceFiltersFromParams(params: PipeParams): Array<{ key: string; value?: string; mode: "equals" | "exists" }> | undefined {
  const filters: Array<{ key: string; value?: string; mode: "equals" | "exists" }> = []
  for (const suffix of SUFFIXES) {
    const key = params[`resource_filter_key${suffix}`]
    if (key == null) continue
    const exists = params[`resource_filter_exists${suffix}`] === "1"
    filters.push({
      key: String(key),
      value: exists ? undefined : (params[`resource_filter_value${suffix}`] != null ? String(params[`resource_filter_value${suffix}`]) : undefined),
      mode: exists ? "exists" : "equals",
    })
  }
  return filters.length > 0 ? filters : undefined
}

// ---------------------------------------------------------------------------
// Custom traces timeseries — raw SQL (returns ALL metrics, no selective omission)
// ---------------------------------------------------------------------------

function buildCustomTracesTimeseriesSQL(
  params: PipeParams,
  ctx: { orgId: string; startTime: string; endTime: string },
): PipeCompiledQuery {
  const esc = escapeClickHouseString
  const str = (key: string) => params[key] != null ? String(params[key]) : undefined
  const int = (key: string, def: number) => params[key] != null ? Number(params[key]) : def
  const t = String(int("apdex_threshold_ms", 500))
  const bucketSeconds = int("bucket_seconds", 60)

  // Build groupName expression from individual group_by_* boolean params
  const groupParts: string[] = []
  if (str("group_by_service")) groupParts.push("toString(ServiceName)")
  if (str("group_by_span_name")) groupParts.push("toString(SpanName)")
  if (str("group_by_status_code")) groupParts.push("toString(StatusCode)")
  if (str("group_by_http_method")) groupParts.push("toString(SpanAttributes['http.method'])")
  const groupByAttrs = str("group_by_attributes")
  if (groupByAttrs) {
    const keys = groupByAttrs.split(",").filter(Boolean)
    const attrParts = keys.map((k) => `toString(SpanAttributes['${esc(k)}'])`)
    groupParts.push(`arrayStringConcat([${attrParts.join(", ")}], ' \u00b7 ')`)
  }

  const groupNameExpr = groupParts.length === 0
    ? "'all'"
    : groupParts.length === 1
      ? `coalesce(nullIf(${groupParts[0]}, ''), 'all')`
      : `coalesce(nullIf(arrayStringConcat(arrayFilter(x -> x != '', [${groupParts.join(", ")}]), ' \u00b7 '), ''), 'all')`

  // WHERE conditions
  const conditions: string[] = [
    `OrgId = '${esc(ctx.orgId)}'`,
    `Timestamp >= '${esc(ctx.startTime)}'`,
    `Timestamp <= '${esc(ctx.endTime)}'`,
  ]
  if (str("service_name")) conditions.push(`ServiceName = '${esc(str("service_name")!)}'`)
  if (str("span_name")) conditions.push(`SpanName = '${esc(str("span_name")!)}'`)
  if (str("root_only")) conditions.push("(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')")
  if (str("errors_only")) conditions.push("StatusCode = 'Error'")
  if (str("environments")) conditions.push(`ResourceAttributes['deployment.environment'] IN splitByChar(',', '${esc(str("environments")!)}')`)
  if (str("commit_shas")) conditions.push(`ResourceAttributes['deployment.commit_sha'] IN splitByChar(',', '${esc(str("commit_shas")!)}')`)

  // Attribute filters
  const attrFilters = buildAttributeFiltersFromParams(params)
  if (attrFilters) {
    for (const af of attrFilters) {
      if (af.mode === "exists") {
        conditions.push(`mapContains(SpanAttributes, '${esc(af.key)}')`)
      } else {
        conditions.push(`SpanAttributes['${esc(af.key)}'] = '${esc(af.value ?? "")}'`)
      }
    }
  }
  const resFilters = buildResourceFiltersFromParams(params)
  if (resFilters) {
    for (const rf of resFilters) {
      if (rf.mode === "exists") {
        conditions.push(`mapContains(ResourceAttributes, '${esc(rf.key)}')`)
      } else {
        conditions.push(`ResourceAttributes['${esc(rf.key)}'] = '${esc(rf.value ?? "")}'`)
      }
    }
  }

  const sql = `SELECT
  toStartOfInterval(Timestamp, INTERVAL ${bucketSeconds} SECOND) AS bucket,
  ${groupNameExpr} AS groupName,
  count() AS count,
  avg(Duration) / 1000000 AS avgDuration,
  quantile(0.5)(Duration) / 1000000 AS p50Duration,
  quantile(0.95)(Duration) / 1000000 AS p95Duration,
  quantile(0.99)(Duration) / 1000000 AS p99Duration,
  if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0) AS errorRate,
  countIf(Duration / 1000000 < ${t}) AS satisfiedCount,
  countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) AS toleratingCount,
  if(count() > 0, round((countIf(Duration / 1000000 < ${t}) + countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) * 0.5) / count(), 4), 0) AS apdexScore,
  countIf(TraceState LIKE '%th:%') AS sampledSpanCount,
  countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS unsampledSpanCount,
  anyIf(extract(TraceState, 'th:([0-9a-f]+)'), TraceState LIKE '%th:%') AS dominantThreshold
FROM traces
WHERE ${conditions.join("\n  AND ")}
GROUP BY bucket, groupName
ORDER BY bucket ASC, groupName ASC
FORMAT JSON`

  return { sql, castRows: (rows) => rows }
}

// ---------------------------------------------------------------------------
// Custom traces breakdown — raw SQL (returns ALL metrics)
// ---------------------------------------------------------------------------

function buildCustomTracesBreakdownSQL(
  params: PipeParams,
  ctx: { orgId: string; startTime: string; endTime: string },
): PipeCompiledQuery {
  const esc = escapeClickHouseString
  const str = (key: string) => params[key] != null ? String(params[key]) : undefined
  const int = (key: string, def: number) => params[key] != null ? Number(params[key]) : def
  const t = String(int("apdex_threshold_ms", 500))
  const limit = int("limit", 10)

  // Determine groupBy column
  let nameExpr = "ServiceName"
  if (str("group_by_service")) nameExpr = "ServiceName"
  else if (str("group_by_span_name")) nameExpr = "SpanName"
  else if (str("group_by_status_code")) nameExpr = "StatusCode"
  else if (str("group_by_http_method")) nameExpr = "SpanAttributes['http.method']"
  else if (str("group_by_attribute")) nameExpr = `SpanAttributes['${esc(str("group_by_attribute")!)}']`

  // WHERE conditions
  const conditions: string[] = [
    `OrgId = '${esc(ctx.orgId)}'`,
    `Timestamp >= '${esc(ctx.startTime)}'`,
    `Timestamp <= '${esc(ctx.endTime)}'`,
  ]
  if (str("service_name")) conditions.push(`ServiceName = '${esc(str("service_name")!)}'`)
  if (str("span_name")) conditions.push(`SpanName = '${esc(str("span_name")!)}'`)
  if (str("root_only")) conditions.push("(SpanKind IN ('Server', 'Consumer') OR ParentSpanId = '')")
  if (str("errors_only")) conditions.push("StatusCode = 'Error'")
  if (str("environments")) conditions.push(`ResourceAttributes['deployment.environment'] IN splitByChar(',', '${esc(str("environments")!)}')`)
  if (str("commit_shas")) conditions.push(`ResourceAttributes['deployment.commit_sha'] IN splitByChar(',', '${esc(str("commit_shas")!)}')`)

  const attrFilters = buildAttributeFiltersFromParams(params)
  if (attrFilters) {
    for (const af of attrFilters) {
      conditions.push(af.mode === "exists"
        ? `mapContains(SpanAttributes, '${esc(af.key)}')`
        : `SpanAttributes['${esc(af.key)}'] = '${esc(af.value ?? "")}'`)
    }
  }
  const resFilters = buildResourceFiltersFromParams(params)
  if (resFilters) {
    for (const rf of resFilters) {
      conditions.push(rf.mode === "exists"
        ? `mapContains(ResourceAttributes, '${esc(rf.key)}')`
        : `ResourceAttributes['${esc(rf.key)}'] = '${esc(rf.value ?? "")}'`)
    }
  }

  const sql = `SELECT
  ${nameExpr} AS name,
  count() AS count,
  avg(Duration) / 1000000 AS avgDuration,
  quantile(0.5)(Duration) / 1000000 AS p50Duration,
  quantile(0.95)(Duration) / 1000000 AS p95Duration,
  quantile(0.99)(Duration) / 1000000 AS p99Duration,
  if(count() > 0, countIf(StatusCode = 'Error') * 100.0 / count(), 0) AS errorRate,
  countIf(Duration / 1000000 < ${t}) AS satisfiedCount,
  countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) AS toleratingCount,
  if(count() > 0, round((countIf(Duration / 1000000 < ${t}) + countIf(Duration / 1000000 >= ${t} AND Duration / 1000000 < ${t} * 4) * 0.5) / count(), 4), 0) AS apdexScore
FROM traces
WHERE ${conditions.join("\n  AND ")}
GROUP BY name
ORDER BY count DESC
LIMIT ${limit}
FORMAT JSON`

  return { sql, castRows: (rows) => rows }
}
