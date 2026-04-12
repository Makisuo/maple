import {
  McpQueryError,
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
  validationError,
  type McpToolRegistrar,
  type McpToolResult,
} from "./types"
import { resolveTimeRange } from "../lib/time"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { resolveTenant } from "@/mcp/lib/query-tinybird"
import { QueryEngineService } from "@/services/QueryEngineService"
import {
  QuerySpec,
  type TracesFilters,
  type LogsFilters,
  type MetricsFilters,
  type QuerySpec as QuerySpecType,
} from "@maple/query-engine"
import { formatQueryResult } from "../lib/format-query-result"
import type { QueryDataQueryContext } from "@maple/domain"

const queryDataSchema = Schema.Struct({
  source: Schema.Literals(["traces", "logs", "metrics"]).annotate({
    description:
      "Data source. Use 'traces' for request/span analysis (latency, errors, throughput). " +
      "Use 'logs' for log volume analysis. " +
      "Use 'metrics' for custom metric aggregation (requires metric_name and metric_type — call list_metrics first).",
  }),
  kind: Schema.Literals(["timeseries", "breakdown"]).annotate({
    description:
      "Query shape. Use 'timeseries' when the user asks about trends, patterns, or 'how has X changed over time'. " +
      "Use 'breakdown' when asking about top-N, distribution, or 'which services have the most errors'. " +
      "Pick the right kind first — do not call this tool twice for the same question.",
  }),
  metric: optionalStringParam(
    "Metric to compute. Traces: count (request volume), avg_duration, p50_duration, p95_duration, p99_duration (latency), " +
    "error_rate (0-1 ratio), apdex (user satisfaction, requires apdex_threshold_ms). Logs: count only. " +
    "Metrics: avg, sum, min, max, count, rate, increase. For monotonic counters (typically metric_type=sum with isMonotonic=true from list_metrics), prefer rate or increase over raw sum. Default: 'count' for traces/logs, 'avg' for metrics.",
  ),
  group_by: optionalStringParam(
    "Grouping dimension. Traces: service, span_name, status_code, http_method, attribute, none. " +
    "Logs: service, severity, none. Metrics: service, attribute, none. " +
    "Default: 'none' for timeseries, 'service' for breakdown.",
  ),
  start_time: optionalStringParam("Start time (YYYY-MM-DD HH:mm:ss UTC). Defaults to 1 hour ago"),
  end_time: optionalStringParam("End time (YYYY-MM-DD HH:mm:ss UTC). Defaults to now"),
  service_name: optionalStringParam("Filter by service name (use list_services to discover)"),
  // Traces-specific
  span_name: optionalStringParam("Filter by span name (traces only)"),
  root_spans_only: optionalBooleanParam("Only include root spans (traces only)"),
  environments: optionalStringParam("Comma-separated environments to filter (traces only, use explore_attributes source=services to discover)"),
  commit_shas: optionalStringParam("Comma-separated commit SHAs to filter (traces only)"),
  apdex_threshold_ms: optionalNumberParam("Apdex threshold in milliseconds (traces only, required for apdex metric)"),
  // Logs-specific
  severity: optionalStringParam("Filter by log severity: TRACE, DEBUG, INFO, WARN, ERROR, FATAL (logs only)"),
  // Metrics-specific
  metric_name: optionalStringParam("Metric name — required for source=metrics. Use list_metrics to discover available metrics."),
  metric_type: optionalStringParam("Metric type — required for source=metrics. Values: sum, gauge, histogram, exponential_histogram"),
  // Shared attribute filtering
  attribute_key: optionalStringParam("Attribute key for filtering or group_by=attribute. Use explore_attributes to discover keys."),
  attribute_value: optionalStringParam("Attribute value filter (requires attribute_key)"),
  bucket_seconds: optionalNumberParam("Bucket size in seconds (timeseries only, auto-computed if omitted)"),
  limit: optionalNumberParam("Max breakdown rows (breakdown only, default 10, max 100)"),
})

const queryDataDescription =
  "Query timeseries or breakdown data from traces, logs, or metrics. " +
  "Start here for trend analysis, comparisons, and top-N queries. " +
  "For error investigation, prefer find_errors and error_detail. " +
  "For attribute discovery, call explore_attributes first. " +
  "Defaults are applied automatically and shown in the response."

const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)

const splitCsv = (value: string): Array<string> =>
  value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)

export function registerQueryDataTool(server: McpToolRegistrar) {
  server.tool(
    "query_data",
    queryDataDescription,
    queryDataSchema,
    Effect.fn("McpTool.queryData")(function* (params) {
        const { st, et } = resolveTimeRange(params.start_time, params.end_time)

        // Validate attribute params
        if (params.attribute_value && !params.attribute_key) {
          return validationError(
            "`attribute_value` requires `attribute_key`. Use explore_attributes to discover available keys.",
            'attribute_key="http.method" attribute_value="GET"',
          )
        }

        if (params.group_by === "attribute" && !params.attribute_key) {
          return validationError(
            "`group_by=attribute` requires `attribute_key`. Use explore_attributes to discover available keys.",
            'group_by="attribute" attribute_key="http.method"',
          )
        }

        // Validate metrics-specific required params
        if (params.source === "metrics") {
          if (!params.metric_name || !params.metric_type) {
            return validationError(
              "`source=metrics` requires `metric_name` and `metric_type`. Use list_metrics to discover available metrics.",
              'source="metrics" metric_name="http.server.duration" metric_type="histogram" metric="avg"',
            )
          }
        }

        // Track defaults applied for transparency
        const decisions: string[] = []

        if (!params.start_time) decisions.push(`start_time: defaulted to 1 hour ago (${st})`)
        if (!params.end_time) decisions.push(`end_time: defaulted to now (${et})`)

        type AnySpec = Record<string, unknown>
        let rawSpec: QuerySpecType

        if (params.source === "traces") {
          const attributeFilters: Array<{ key: string; value?: string; mode: "equals" | "exists" }> = []
          if (params.attribute_key) {
            attributeFilters.push({
              key: params.attribute_key,
              ...(params.attribute_value ? { value: params.attribute_value, mode: "equals" as const } : { mode: "exists" as const }),
            })
          }

          const filters: TracesFilters = {
            ...(params.service_name && { serviceName: params.service_name }),
            ...(params.span_name && { spanName: params.span_name }),
            ...(params.root_spans_only && { rootSpansOnly: params.root_spans_only }),
            ...(params.environments && { environments: splitCsv(params.environments) }),
            ...(params.commit_shas && { commitShas: splitCsv(params.commit_shas) }),
            ...(params.group_by === "attribute" && params.attribute_key && { groupByAttributeKeys: [params.attribute_key] }),
            ...(attributeFilters.length > 0 && { attributeFilters }),
            ...(params.apdex_threshold_ms && { apdexThresholdMs: params.apdex_threshold_ms }),
          }
          const hasFilters = Object.keys(filters).length > 0

          const tracesMetric = params.metric ?? "count"
          if (!params.metric) decisions.push(`metric: defaulted to "count" (available: count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate, apdex)`)

          if (params.kind === "timeseries") {
            const groupBy = params.group_by ? [params.group_by] : ["none"]
            if (!params.group_by) decisions.push(`group_by: defaulted to "none" (available: service, span_name, status_code, http_method, attribute, none)`)
            rawSpec = {
              kind: "timeseries",
              source: "traces",
              metric: tracesMetric,
              groupBy,
              ...(hasFilters && { filters }),
              ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
            } as AnySpec as QuerySpecType
          } else {
            const groupBy = params.group_by ?? "service"
            if (!params.group_by) decisions.push(`group_by: defaulted to "service" (available: service, span_name, status_code, http_method, attribute)`)
            rawSpec = {
              kind: "breakdown",
              source: "traces",
              metric: tracesMetric,
              groupBy,
              ...(hasFilters && { filters }),
              ...(params.limit && { limit: params.limit }),
            } as AnySpec as QuerySpecType
          }
        } else if (params.source === "logs") {
          if (!params.metric) decisions.push(`metric: fixed to "count" (only option for logs)`)

          const filters: LogsFilters = {
            ...(params.service_name && { serviceName: params.service_name }),
            ...(params.severity && { severity: params.severity }),
          }
          const hasFilters = Object.keys(filters).length > 0

          if (params.kind === "timeseries") {
            const groupBy = params.group_by ? [params.group_by] : ["none"]
            if (!params.group_by) decisions.push(`group_by: defaulted to "none" (available: service, severity, none)`)
            rawSpec = {
              kind: "timeseries",
              source: "logs",
              metric: "count",
              groupBy,
              ...(hasFilters && { filters }),
              ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
            } as AnySpec as QuerySpecType
          } else {
            const groupBy = params.group_by ?? "service"
            if (!params.group_by) decisions.push(`group_by: defaulted to "service" (available: service, severity)`)
            rawSpec = {
              kind: "breakdown",
              source: "logs",
              metric: "count",
              groupBy,
              ...(hasFilters && { filters }),
              ...(params.limit && { limit: params.limit }),
            } as AnySpec as QuerySpecType
          }
        } else {
          // metrics
          const metricsAttributeFilters: Array<{ key: string; value?: string; mode: "equals" | "exists" }> = []
          if (params.group_by !== "attribute" && params.attribute_key) {
            metricsAttributeFilters.push({
              key: params.attribute_key,
              ...(params.attribute_value ? { value: params.attribute_value, mode: "equals" as const } : { mode: "exists" as const }),
            })
          }

          const filters: MetricsFilters = {
            metricName: params.metric_name!,
            metricType: params.metric_type as MetricsFilters["metricType"],
            ...(params.service_name && { serviceName: params.service_name }),
            ...(params.group_by === "attribute" && params.attribute_key && { groupByAttributeKey: params.attribute_key }),
            ...(metricsAttributeFilters.length > 0 && { attributeFilters: metricsAttributeFilters }),
          }

          const metricsMetric = params.metric ?? "avg"
          if (!params.metric) decisions.push(`metric: defaulted to "avg" (available: avg, sum, min, max, count, rate, increase)`)

          if (params.kind === "timeseries") {
            const groupBy = params.group_by ? [params.group_by] : ["none"]
            if (!params.group_by) decisions.push(`group_by: defaulted to "none" (available: service, attribute, none)`)
            rawSpec = {
              kind: "timeseries",
              source: "metrics",
              metric: metricsMetric,
              groupBy,
              filters,
              ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
            } as AnySpec as QuerySpecType
          } else {
            if (!params.group_by) decisions.push(`group_by: defaulted to "service"`)
            rawSpec = {
              kind: "breakdown",
              source: "metrics",
              metric: metricsMetric,
              groupBy: "service",
              filters,
              ...(params.limit && { limit: params.limit }),
            } as AnySpec as QuerySpecType
          }
        }

        const decodedQuery = yield* Effect.try({
          try: () => decodeQuerySpecSync(rawSpec) as QuerySpecType,
          catch: (error) => new McpQueryError({ message: `Invalid query specification:\n${String(error)}`, pipe: "query_data" }),
        })

        const tenant = yield* resolveTenant
        const queryEngine = yield* QueryEngineService
        const exit = yield* queryEngine.execute(tenant, {
          startTime: st,
          endTime: et,
          query: decodedQuery,
        }).pipe(Effect.exit)

        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
          if (failure && typeof failure === "object" && "_tag" in failure) {
            const tagged = failure as { _tag: string; message: string; details?: string[] }
            const details = tagged.details ? `\n${tagged.details.join("\n")}` : ""
            return {
              isError: true,
              content: [{ type: "text", text: `${tagged._tag}: ${tagged.message}${details}` }],
            }
          }

          return {
            isError: true,
            content: [{ type: "text", text: Cause.pretty(exit.cause) }],
          }
        }

        const queryContext: QueryDataQueryContext = {
          source: params.source,
          ...(params.service_name && { serviceName: params.service_name }),
          ...(params.span_name && { spanName: params.span_name }),
          ...(params.root_spans_only && { rootSpansOnly: params.root_spans_only }),
          ...(params.environments && { environments: splitCsv(params.environments) }),
          ...(params.commit_shas && { commitShas: splitCsv(params.commit_shas) }),
          ...(params.severity && { severity: params.severity }),
          ...(params.metric_name && { metricName: params.metric_name }),
          ...(params.metric_type && { metricType: params.metric_type }),
          ...(params.apdex_threshold_ms && { apdexThresholdMs: params.apdex_threshold_ms }),
          ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
          ...(params.limit && { limit: params.limit }),
          ...(params.attribute_key && {
            attributeFilters: [{
              key: params.attribute_key,
              ...(params.attribute_value
                ? { value: params.attribute_value, mode: "equals" as const }
                : { mode: "exists" as const }),
            }],
          }),
        }

        return formatQueryResult(
          "query_data",
          exit.value,
          params.source,
          params.kind,
          params.metric,
          st,
          et,
          params.group_by,
          decisions,
          queryContext,
        )
      }),
  )
}
