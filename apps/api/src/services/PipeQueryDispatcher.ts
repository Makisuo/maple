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
      return eraseType(CH.compile(
        CH.spanHierarchyQuery({ traceId: String(params.trace_id), spanId: str("span_id") }),
        { orgId },
      ))

    case "traces_duration_stats":
      return eraseType(CH.compile(
        CH.tracesDurationStatsQuery({
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
        }),
        { orgId, startTime, endTime },
      ))

    case "traces_facets":
      return eraseType(CH.compileUnion(
        CH.tracesFacetsQuery({
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
        }),
        { orgId, startTime, endTime },
      ))

    // ----- Logs -----
    case "list_logs":
      return eraseType(CH.compile(
        CH.logsListQuery({
          serviceName: str("service"),
          severity: str("severity"),
          minSeverity: int("min_severity"),
          traceId: str("trace_id"),
          spanId: str("span_id"),
          cursor: str("cursor"),
          search: str("search"),
          limit: int("limit", 50),
        }),
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
      return eraseType(CH.compileUnion(
        CH.logsFacetsQuery({ serviceName: str("service"), severity: str("severity") }),
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
      return eraseType(CH.compileUnion(
        CH.servicesFacetsQuery(),
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
      return eraseType(CH.compileUnion(
        CH.errorsFacetsQuery({
          rootOnly: bool("root_only"),
          services: str("services")?.split(",").filter(Boolean),
          deploymentEnvs: str("deployment_envs")?.split(",").filter(Boolean),
          errorTypes: str("error_types")?.split(",").filter(Boolean),
        }),
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
      return eraseType(CH.compileUnion(
        CH.listMetricsQuery({
          serviceName: str("service"),
          metricType: str("metric_type"),
          search: str("search"),
          limit: int("limit", 100),
          offset: int("offset", 0),
        }),
        { orgId, startTime, endTime },
      ))

    case "metrics_summary":
      return eraseType(CH.compileUnion(
        CH.metricsSummaryQuery({ serviceName: str("service") }),
        { orgId, startTime, endTime },
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
      return eraseType(CH.compile(
        CH.spanAttributeValuesQuery({ attributeKey: String(params.attribute_key), limit: int("limit", 50) }),
        { orgId, startTime, endTime },
      ))

    case "resource_attribute_values":
      return eraseType(CH.compile(
        CH.resourceAttributeValuesQuery({ attributeKey: String(params.attribute_key), limit: int("limit", 50) }),
        { orgId, startTime, endTime },
      ))

    // ----- Custom charts -----
    case "custom_traces_timeseries": {
      const tsOpts = pipeParamsToTracesTimeseriesOpts(params)
      const compiled = CH.compile(
        CH.tracesTimeseriesQuery(tsOpts),
        { orgId, startTime, endTime, bucketSeconds: int("bucket_seconds", 60)! },
      )
      return eraseType(compiled)
    }

    case "custom_traces_breakdown": {
      const bdOpts = pipeParamsToTracesBreakdownOpts(params)
      const compiled = CH.compile(
        CH.tracesBreakdownQuery(bdOpts),
        { orgId, startTime, endTime },
      )
      return eraseType(compiled)
    }

    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Attribute filter param helpers (numbered suffix pattern from Tinybird pipes)
// ---------------------------------------------------------------------------

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
// Parameter adapters — translate pipe-style params to typed query opts
// ---------------------------------------------------------------------------

function pipeParamsToTracesTimeseriesOpts(params: PipeParams): CH.TracesTimeseriesOpts {
  const str = (key: string) => params[key] != null ? String(params[key]) : undefined
  const int = (key: string, def: number) => params[key] != null ? Number(params[key]) : def

  const groupBy: string[] = []
  if (str("group_by_service")) groupBy.push("service")
  if (str("group_by_span_name")) groupBy.push("span_name")
  if (str("group_by_status_code")) groupBy.push("status_code")
  if (str("group_by_http_method")) groupBy.push("http_method")
  if (str("group_by_attributes")) groupBy.push("attribute")

  return {
    metric: "count" as TracesMetric,
    allMetrics: true,
    needsSampling: true,
    groupBy,
    groupByAttributeKeys: str("group_by_attributes")?.split(",").filter(Boolean),
    apdexThresholdMs: int("apdex_threshold_ms", 500),
    serviceName: str("service_name"),
    spanName: str("span_name"),
    rootOnly: !!str("root_only"),
    errorsOnly: !!str("errors_only"),
    environments: str("environments")?.split(",").filter(Boolean),
    commitShas: str("commit_shas")?.split(",").filter(Boolean),
    attributeFilters: buildAttributeFiltersFromParams(params),
    resourceAttributeFilters: buildResourceFiltersFromParams(params),
  }
}

function pipeParamsToTracesBreakdownOpts(params: PipeParams): CH.TracesBreakdownOpts {
  const str = (key: string) => params[key] != null ? String(params[key]) : undefined
  const int = (key: string, def: number) => params[key] != null ? Number(params[key]) : def

  let groupBy = "service"
  let groupByAttributeKey: string | undefined
  if (str("group_by_service")) groupBy = "service"
  else if (str("group_by_span_name")) groupBy = "span_name"
  else if (str("group_by_status_code")) groupBy = "status_code"
  else if (str("group_by_http_method")) groupBy = "http_method"
  else if (str("group_by_attribute")) {
    groupBy = "attribute"
    groupByAttributeKey = str("group_by_attribute")
  }

  return {
    metric: "count" as TracesMetric,
    allMetrics: true,
    groupBy,
    groupByAttributeKey,
    limit: int("limit", 10),
    apdexThresholdMs: int("apdex_threshold_ms", 500),
    serviceName: str("service_name"),
    spanName: str("span_name"),
    rootOnly: !!str("root_only"),
    errorsOnly: !!str("errors_only"),
    environments: str("environments")?.split(",").filter(Boolean),
    commitShas: str("commit_shas")?.split(",").filter(Boolean),
    attributeFilters: buildAttributeFiltersFromParams(params),
    resourceAttributeFilters: buildResourceFiltersFromParams(params),
  }
}
