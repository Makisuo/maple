import {
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
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

const queryDataSchema = Schema.Struct({
  source: Schema.Literals(["traces", "logs", "metrics"]).annotate({
    description:
      "Data source to query: traces, logs, or metrics",
  }),
  kind: Schema.Literals(["timeseries", "breakdown"]).annotate({
    description: "Query type: timeseries for trends over time, breakdown for top-N ranking",
  }),
  metric: optionalStringParam(
    "Metric to compute. Traces: count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate, apdex. Logs: count. Metrics: avg, sum, min, max, count.",
  ),
  group_by: optionalStringParam(
    "Grouping dimension. Traces: service, span_name, status_code, http_method, attribute, none. Logs: service, severity, none. Metrics: service, attribute, none.",
  ),
  start_time: optionalStringParam("Start time (YYYY-MM-DD HH:mm:ss). Defaults to 1 hour ago"),
  end_time: optionalStringParam("End time (YYYY-MM-DD HH:mm:ss). Defaults to now"),
  service_name: optionalStringParam("Filter by service name"),
  // Traces-specific
  span_name: optionalStringParam("Filter by span name (traces only)"),
  root_spans_only: optionalBooleanParam("Only include root spans (traces only)"),
  environments: optionalStringParam("Comma-separated environments to filter (traces only)"),
  commit_shas: optionalStringParam("Comma-separated commit SHAs to filter (traces only)"),
  apdex_threshold_ms: optionalNumberParam("Apdex threshold in milliseconds (traces only, for apdex metric)"),
  // Logs-specific
  severity: optionalStringParam("Filter by severity e.g. ERROR, WARN, INFO (logs only)"),
  // Metrics-specific
  metric_name: optionalStringParam("Metric name - required for source=metrics (use list_metrics to discover)"),
  metric_type: optionalStringParam("Metric type - required for source=metrics: sum, gauge, histogram, exponential_histogram"),
  // Shared attribute filtering
  attribute_key: optionalStringParam("Attribute key for filtering or group_by=attribute"),
  attribute_value: optionalStringParam("Attribute value filter (requires attribute_key)"),
  bucket_seconds: optionalNumberParam("Bucket size in seconds (timeseries only, auto-computed if omitted)"),
  limit: optionalNumberParam("Max breakdown rows (breakdown only, default 10, max 100)"),
})

const queryDataDescription =
  "Query timeseries or breakdown data from traces, logs, or metrics. " +
  "Traces metrics: count, avg_duration, p50/p95/p99_duration, error_rate, apdex. " +
  "Logs metric: count. Metrics aggregations: avg, sum, min, max, count. " +
  "Supports attribute filtering, environment/commit comparison. " +
  "Use explore_attributes to discover attribute keys for filtering."

const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec)

const splitCsv = (value: string): Array<string> =>
  value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)

export function registerQueryDataTool(server: McpToolRegistrar) {
  server.tool(
    "query_data",
    queryDataDescription,
    queryDataSchema,
    (params) =>
      Effect.gen(function* () {
        const { st, et } = resolveTimeRange(params.start_time, params.end_time)

        // Validate attribute params
        if (params.attribute_value && !params.attribute_key) {
          return {
            isError: true,
            content: [{ type: "text", text: "`attribute_value` requires `attribute_key`." }],
          }
        }

        if (params.group_by === "attribute" && !params.attribute_key) {
          return {
            isError: true,
            content: [{ type: "text", text: "`group_by=attribute` requires `attribute_key`." }],
          }
        }

        // Validate metrics-specific required params
        if (params.source === "metrics") {
          if (!params.metric_name || !params.metric_type) {
            return {
              isError: true,
              content: [{ type: "text", text: "`source=metrics` requires `metric_name` and `metric_type`. Use `list_metrics` to discover available metrics." }],
            }
          }
        }

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
            ...(attributeFilters.length > 0 && { attributeFilters }),
            ...(params.apdex_threshold_ms && { apdexThresholdMs: params.apdex_threshold_ms }),
          }
          const hasFilters = Object.keys(filters).length > 0

          if (params.kind === "timeseries") {
            rawSpec = {
              kind: "timeseries",
              source: "traces",
              metric: params.metric ?? "count",
              groupBy: params.group_by ? [params.group_by] : ["none"],
              ...(hasFilters && { filters }),
              ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
            } as AnySpec as QuerySpecType
          } else {
            rawSpec = {
              kind: "breakdown",
              source: "traces",
              metric: params.metric ?? "count",
              groupBy: params.group_by ?? "service",
              ...(hasFilters && { filters }),
              ...(params.limit && { limit: params.limit }),
            } as AnySpec as QuerySpecType
          }
        } else if (params.source === "logs") {
          const filters: LogsFilters = {
            ...(params.service_name && { serviceName: params.service_name }),
            ...(params.severity && { severity: params.severity }),
          }
          const hasFilters = Object.keys(filters).length > 0

          if (params.kind === "timeseries") {
            rawSpec = {
              kind: "timeseries",
              source: "logs",
              metric: "count",
              groupBy: params.group_by ? [params.group_by] : ["none"],
              ...(hasFilters && { filters }),
              ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
            } as AnySpec as QuerySpecType
          } else {
            rawSpec = {
              kind: "breakdown",
              source: "logs",
              metric: "count",
              groupBy: params.group_by ?? "service",
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

          if (params.kind === "timeseries") {
            rawSpec = {
              kind: "timeseries",
              source: "metrics",
              metric: params.metric ?? "avg",
              groupBy: params.group_by ? [params.group_by] : ["none"],
              filters,
              ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
            } as AnySpec as QuerySpecType
          } else {
            rawSpec = {
              kind: "breakdown",
              source: "metrics",
              metric: params.metric ?? "avg",
              groupBy: "service",
              filters,
              ...(params.limit && { limit: params.limit }),
            } as AnySpec as QuerySpecType
          }
        }

        let decodedQuery: QuerySpecType
        try {
          decodedQuery = decodeQuerySpecSync(rawSpec)
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid query specification:\n${String(error)}` }],
          }
        }

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

        return formatQueryResult(
          "query_data",
          exit.value,
          params.source,
          params.kind,
          params.metric,
          st,
          et,
          params.group_by,
        )
      }),
  )
}
