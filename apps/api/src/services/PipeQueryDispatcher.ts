// ---------------------------------------------------------------------------
// Pipe Query Dispatcher
//
// Maps Tinybird pipe names + params to compiled CH SQL queries.
// This replaces the Tinybird SDK's named pipe execution with the CH query engine.
// ---------------------------------------------------------------------------

import { CH } from "@maple/query-engine"
import type { TracesMetric } from "@maple/query-engine"
import type { OrgId } from "@maple/domain"
import { Array as A, Match, Result } from "effect"

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const compileCompare = (query: any, ranges: {
    currentStart: string
    currentEnd: string
    previousStart: string
    previousEnd: string
  }): PipeCompiledQuery => {
    const currentSql = CH.compile(
      query,
      { orgId, startTime: ranges.currentStart, endTime: ranges.currentEnd },
      { skipFormat: true },
    ).sql
    const previousSql = CH.compile(
      query,
      { orgId, startTime: ranges.previousStart, endTime: ranges.previousEnd },
      { skipFormat: true },
    ).sql
    return {
      sql:
        `SELECT 'current' AS period, * FROM (\n${currentSql}\n)\n` +
        `UNION ALL\n` +
        `SELECT 'previous' AS period, * FROM (\n${previousSql}\n)\n` +
        `FORMAT JSON`,
      castRows: (rows) => rows as ReadonlyArray<unknown>,
    }
  }

  return Match.value(pipe).pipe(
    // ----- Traces -----
    Match.when("list_traces", () =>
      eraseType(CH.compile(
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
      )),
    ),
    Match.when("span_hierarchy", () =>
      eraseType(CH.compile(
        CH.spanHierarchyQuery({ traceId: String(params.trace_id), spanId: str("span_id") }),
        { orgId },
      )),
    ),
    Match.when("traces_duration_stats", () =>
      eraseType(CH.compile(
        CH.tracesDurationStatsQuery({
          serviceName: str("service"), spanName: str("span_name"), hasError: bool("has_error"),
          minDurationMs: int("min_duration_ms"), maxDurationMs: int("max_duration_ms"),
          httpMethod: str("http_method"), httpStatusCode: str("http_status_code"), deploymentEnv: str("deployment_env"),
          matchModes: {
            serviceName: str("service_match_mode") === "contains" ? "contains" : undefined,
            spanName: str("span_name_match_mode") === "contains" ? "contains" : undefined,
            deploymentEnv: str("deployment_env_match_mode") === "contains" ? "contains" : undefined,
          },
        }),
        { orgId, startTime, endTime },
      )),
    ),
    Match.when("traces_facets", () =>
      eraseType(CH.compileUnion(
        CH.tracesFacetsQuery({
          serviceName: str("service"), spanName: str("span_name"), hasError: bool("has_error"),
          minDurationMs: int("min_duration_ms"), maxDurationMs: int("max_duration_ms"),
          httpMethod: str("http_method"), httpStatusCode: str("http_status_code"), deploymentEnv: str("deployment_env"),
          matchModes: {
            serviceName: str("service_match_mode") === "contains" ? "contains" : undefined,
            spanName: str("span_name_match_mode") === "contains" ? "contains" : undefined,
            deploymentEnv: str("deployment_env_match_mode") === "contains" ? "contains" : undefined,
          },
          attributeFilterKey: str("attribute_filter_key"), attributeFilterValue: str("attribute_filter_value"),
          attributeFilterValueMatchMode: str("attribute_filter_value_match_mode") === "contains" ? "contains" : undefined,
          resourceFilterKey: str("resource_filter_key"), resourceFilterValue: str("resource_filter_value"),
          resourceFilterValueMatchMode: str("resource_filter_value_match_mode") === "contains" ? "contains" : undefined,
        }),
        { orgId, startTime, endTime },
      )),
    ),
    Match.when("list_logs", () =>
      eraseType(CH.compile(CH.logsListQuery({
        serviceName: str("service"), severity: str("severity"), minSeverity: int("min_severity"),
        traceId: str("trace_id"), spanId: str("span_id"), cursor: str("cursor"), search: str("search"), limit: int("limit", 50),
        environments: str("deployment_env") ? [str("deployment_env")!] : undefined,
        matchModes: str("deployment_env_match_mode") === "contains" ? { deploymentEnv: "contains" } : undefined,
      }), { orgId, startTime, endTime })),
    ),
    Match.when("logs_count", () =>
      eraseType(CH.compile(CH.logsCountQuery({
        serviceName: str("service"), severity: str("severity"), traceId: str("trace_id"), search: str("search"),
        environments: str("deployment_env") ? [str("deployment_env")!] : undefined,
        matchModes: str("deployment_env_match_mode") === "contains" ? { deploymentEnv: "contains" } : undefined,
      }), { orgId, startTime, endTime })),
    ),
    Match.when("logs_facets", () =>
      eraseType(CH.compileUnion(CH.logsFacetsQuery({
        serviceName: str("service"), severity: str("severity"),
        environments: str("deployment_env") ? [str("deployment_env")!] : undefined,
        matchModes: str("deployment_env_match_mode") === "contains" ? { deploymentEnv: "contains" } : undefined,
      }), { orgId, startTime, endTime })),
    ),
    Match.when("error_rate_by_service", () =>
      eraseType(CH.compile(CH.errorRateByServiceQuery(), { orgId, startTime, endTime })),
    ),
    Match.when("service_overview", () =>
      eraseType(CH.compile(CH.serviceOverviewQuery({
        environments: str("environments")?.split(",").filter(Boolean),
        commitShas: str("commit_shas")?.split(",").filter(Boolean),
      }), { orgId, startTime, endTime })),
    ),
    Match.when("service_overview_compare", () =>
      compileCompare(
        CH.serviceOverviewQuery({
          environments: str("environments")?.split(",").filter(Boolean),
          commitShas: str("commit_shas")?.split(",").filter(Boolean),
        }),
        {
          currentStart: str("current_start_time") ?? startTime,
          currentEnd: str("current_end_time") ?? endTime,
          previousStart: str("previous_start_time") ?? startTime,
          previousEnd: str("previous_end_time") ?? endTime,
        },
      ),
    ),
    Match.when("services_facets", () =>
      eraseType(CH.compileUnion(CH.servicesFacetsQuery(), { orgId, startTime, endTime })),
    ),
    Match.when("service_releases_timeline", () =>
      eraseType(CH.compile(CH.serviceReleasesTimelineQuery({ serviceName: String(params.service_name) }),
        { orgId, startTime, endTime, bucketSeconds: int("bucket_seconds", 300)! })),
    ),
    Match.when("service_apdex_time_series", () =>
      eraseType(CH.compile(CH.serviceApdexTimeseriesQuery({
        serviceName: String(params.service_name), apdexThresholdMs: int("apdex_threshold_ms", 500),
      }), { orgId, startTime, endTime, bucketSeconds: int("bucket_seconds", 60)! })),
    ),
    Match.when("get_service_usage", () =>
      eraseType(CH.compile(CH.serviceUsageQuery({ serviceName: str("service") }), { orgId, startTime, endTime })),
    ),
    Match.when("get_service_usage_compare", () =>
      compileCompare(
        CH.serviceUsageQuery({ serviceName: str("service") }),
        {
          currentStart: str("current_start_time") ?? startTime,
          currentEnd: str("current_end_time") ?? endTime,
          previousStart: str("previous_start_time") ?? startTime,
          previousEnd: str("previous_end_time") ?? endTime,
        },
      ),
    ),
    Match.when("service_dependencies", () =>
      eraseType(CH.serviceDependenciesSQL({ deploymentEnv: str("deployment_env") }, { orgId, startTime, endTime })),
    ),
  ).pipe(
    // ----- Errors -----
    Match.when("errors_by_type", () =>
      eraseType(CH.compile(CH.errorsByTypeQuery({
        rootOnly: bool("root_only"), services: str("services")?.split(",").filter(Boolean),
        deploymentEnvs: str("deployment_envs")?.split(",").filter(Boolean),
        errorTypes: str("error_types")?.split(",").filter(Boolean), limit: int("limit", 50),
      }), { orgId, startTime, endTime })),
    ),
    Match.when("errors_timeseries", () =>
      eraseType(CH.compile(CH.errorsTimeseriesQuery({
        errorType: String(params.error_type), services: str("services")?.split(",").filter(Boolean),
      }), { orgId, startTime, endTime, bucketSeconds: int("bucket_seconds", 3600)! })),
    ),
    Match.when("errors_facets", () =>
      eraseType(CH.compileUnion(CH.errorsFacetsQuery({
        rootOnly: bool("root_only"), services: str("services")?.split(",").filter(Boolean),
        deploymentEnvs: str("deployment_envs")?.split(",").filter(Boolean),
        errorTypes: str("error_types")?.split(",").filter(Boolean),
      }), { orgId, startTime, endTime })),
    ),
    Match.when("errors_summary", () =>
      eraseType(CH.compile(CH.errorsSummaryQuery({
        rootOnly: bool("root_only"), services: str("services")?.split(",").filter(Boolean),
        deploymentEnvs: str("deployment_envs")?.split(",").filter(Boolean),
        errorTypes: str("error_types")?.split(",").filter(Boolean),
      }), { orgId, startTime, endTime })),
    ),
    Match.when("error_detail_traces", () =>
      eraseType(CH.compile(CH.errorDetailTracesQuery({
        errorType: String(params.error_type), rootOnly: bool("root_only"),
        services: str("services")?.split(",").filter(Boolean), limit: int("limit", 10),
      }), { orgId, startTime, endTime })),
    ),
    // ----- Metrics -----
    Match.when("list_metrics", () =>
      eraseType(CH.compileUnion(CH.listMetricsQuery({
        serviceName: str("service"), metricType: str("metric_type"), search: str("search"),
        limit: int("limit", 100), offset: int("offset", 0),
      }), { orgId, startTime, endTime })),
    ),
    Match.when("metrics_summary", () =>
      eraseType(CH.compileUnion(CH.metricsSummaryQuery({ serviceName: str("service") }), { orgId, startTime, endTime })),
    ),
    // ----- Attributes -----
    Match.when("span_attribute_keys", () =>
      eraseType(CH.compile(CH.attributeKeysQuery({ scope: "span", limit: int("limit", 200) }), { orgId, startTime, endTime })),
    ),
    Match.when("resource_attribute_keys", () =>
      eraseType(CH.compile(CH.attributeKeysQuery({ scope: "resource", limit: int("limit", 200) }), { orgId, startTime, endTime })),
    ),
    Match.when("metric_attribute_keys", () =>
      eraseType(CH.compile(CH.attributeKeysQuery({ scope: "metric", limit: int("limit", 200) }), { orgId, startTime, endTime })),
    ),
    Match.when("span_attribute_values", () =>
      eraseType(CH.compile(CH.spanAttributeValuesQuery({ attributeKey: String(params.attribute_key), limit: int("limit", 50) }), { orgId, startTime, endTime })),
    ),
    Match.when("resource_attribute_values", () =>
      eraseType(CH.compile(CH.resourceAttributeValuesQuery({ attributeKey: String(params.attribute_key), limit: int("limit", 50) }), { orgId, startTime, endTime })),
    ),
    // ----- Custom charts -----
    Match.when("custom_traces_timeseries", () => {
      const tsOpts = pipeParamsToTracesTimeseriesOpts(params)
      return eraseType(CH.compile(CH.tracesTimeseriesQuery(tsOpts), { orgId, startTime, endTime, bucketSeconds: int("bucket_seconds", 60)! }))
    }),
    Match.when("custom_traces_breakdown", () => {
      const bdOpts = pipeParamsToTracesBreakdownOpts(params)
      return eraseType(CH.compile(CH.tracesBreakdownQuery(bdOpts), { orgId, startTime, endTime }))
    }),
    Match.orElse(() => undefined),
  )
}

// ---------------------------------------------------------------------------
// Attribute filter param helpers (numbered suffix pattern from Tinybird pipes)
// ---------------------------------------------------------------------------

const SUFFIXES = ["", "_2", "_3", "_4", "_5"] as const

interface AttrFilter { key: string; value?: string; mode: "equals" | "exists" }

function buildAttributeFiltersFromParams(params: PipeParams, prefix: "attribute_filter" | "resource_filter"): AttrFilter[] | undefined {
  const filters = A.filterMap(SUFFIXES, (suffix) => {
    const key = params[`${prefix}_key${suffix}`]
    if (key == null) return Result.failVoid
    const exists = params[`${prefix}_exists${suffix}`] === "1"
    return Result.succeed({
      key: String(key),
      value: exists ? undefined : (params[`${prefix}_value${suffix}`] != null ? String(params[`${prefix}_value${suffix}`]) : undefined),
      mode: (exists ? "exists" : "equals") as "equals" | "exists",
    })
  })
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
    attributeFilters: buildAttributeFiltersFromParams(params, "attribute_filter"),
    resourceAttributeFilters: buildAttributeFiltersFromParams(params, "resource_filter"),
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
    attributeFilters: buildAttributeFiltersFromParams(params, "attribute_filter"),
    resourceAttributeFilters: buildAttributeFiltersFromParams(params, "resource_filter"),
  }
}
