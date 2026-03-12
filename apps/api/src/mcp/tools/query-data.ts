import {
  McpTenantError,
  optionalBooleanParam,
  optionalNumberParam,
  optionalStringParam,
  requiredStringParam,
  type McpToolRegistrar,
  type McpToolResult,
} from "./types"
import { defaultTimeRange } from "../lib/time"
import { formatDurationFromMs, formatNumber, formatPercent, formatTable } from "../lib/format"
import { HttpServerRequest } from "@effect/platform"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, ParseResult, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import { Env } from "@/services/Env"
import { QueryEngineService } from "@/services/QueryEngineService"
import {
  MetricType,
  MetricsMetric,
  QuerySpec,
  TracesMetric,
  type LogsFilters,
  type MetricsFilters,
  type QueryEngineExecuteResponse,
  type QuerySpec as QuerySpecType,
  type TracesFilters,
} from "@maple/domain"

const QueryEngineRuntime = ManagedRuntime.make(
  QueryEngineService.Default.pipe(Layer.provide(Env.Default)),
)

const commonTimeRangeFields = {
  start_time: optionalStringParam("Start time (YYYY-MM-DD HH:mm:ss). Defaults to 1 hour ago"),
  end_time: optionalStringParam("End time (YYYY-MM-DD HH:mm:ss). Defaults to now"),
}

const commonTraceFilterFields = {
  service_name: optionalStringParam("Filter by service name"),
  span_name: optionalStringParam("Filter by span name"),
  root_spans_only: optionalBooleanParam("Only root spans"),
  environments: optionalStringParam("Comma-separated environments"),
  commit_shas: optionalStringParam("Comma-separated commit SHAs"),
  attribute_key: optionalStringParam("Attribute key for filtering or grouping"),
  attribute_value: optionalStringParam("Attribute value filter; requires attribute_key"),
}

const tracesTimeseriesArgsSchema = Schema.Struct({
  source: Schema.Literal("traces").annotations({ description: "Data source: traces" }),
  kind: Schema.Literal("timeseries").annotations({ description: "Query type: timeseries" }),
  metric: Schema.optional(TracesMetric).annotations({
    description:
      "Metric: count, avg_duration, p50_duration, p95_duration, p99_duration, or error_rate. Defaults to count.",
  }),
  group_by: Schema.optional(
    Schema.Literal("service", "span_name", "status_code", "http_method", "attribute", "none"),
  ).annotations({
    description:
      "Grouping: service, span_name, status_code, http_method, attribute, or none. Defaults to none.",
  }),
  bucket_seconds: optionalNumberParam("Bucket size in seconds (auto-computed if omitted)"),
  ...commonTimeRangeFields,
  ...commonTraceFilterFields,
})

const tracesBreakdownArgsSchema = Schema.Struct({
  source: Schema.Literal("traces").annotations({ description: "Data source: traces" }),
  kind: Schema.Literal("breakdown").annotations({ description: "Query type: breakdown" }),
  metric: Schema.optional(TracesMetric).annotations({
    description:
      "Metric: count, avg_duration, p50_duration, p95_duration, p99_duration, or error_rate. Defaults to count.",
  }),
  group_by: Schema.optional(
    Schema.Literal("service", "span_name", "status_code", "http_method", "attribute"),
  ).annotations({
    description:
      "Grouping: service, span_name, status_code, http_method, or attribute. Defaults to service.",
  }),
  limit: optionalNumberParam("Max breakdown rows (default 10, max 100)"),
  ...commonTimeRangeFields,
  ...commonTraceFilterFields,
})

const logsTimeseriesArgsSchema = Schema.Struct({
  source: Schema.Literal("logs").annotations({ description: "Data source: logs" }),
  kind: Schema.Literal("timeseries").annotations({ description: "Query type: timeseries" }),
  metric: Schema.optional(Schema.Literal("count")).annotations({
    description: "Metric: count. Defaults to count.",
  }),
  group_by: Schema.optional(Schema.Literal("service", "severity", "none")).annotations({
    description: "Grouping: service, severity, or none. Defaults to none.",
  }),
  bucket_seconds: optionalNumberParam("Bucket size in seconds (auto-computed if omitted)"),
  ...commonTimeRangeFields,
  service_name: optionalStringParam("Filter by service name"),
  severity: optionalStringParam("Filter by severity (e.g. ERROR, WARN, INFO)"),
})

const logsBreakdownArgsSchema = Schema.Struct({
  source: Schema.Literal("logs").annotations({ description: "Data source: logs" }),
  kind: Schema.Literal("breakdown").annotations({ description: "Query type: breakdown" }),
  metric: Schema.optional(Schema.Literal("count")).annotations({
    description: "Metric: count. Defaults to count.",
  }),
  group_by: Schema.optional(Schema.Literal("service", "severity")).annotations({
    description: "Grouping: service or severity. Defaults to service.",
  }),
  limit: optionalNumberParam("Max breakdown rows (default 10, max 100)"),
  ...commonTimeRangeFields,
  service_name: optionalStringParam("Filter by service name"),
  severity: optionalStringParam("Filter by severity (e.g. ERROR, WARN, INFO)"),
})

const metricsTimeseriesArgsSchema = Schema.Struct({
  source: Schema.Literal("metrics").annotations({ description: "Data source: metrics" }),
  kind: Schema.Literal("timeseries").annotations({ description: "Query type: timeseries" }),
  metric: Schema.optional(MetricsMetric).annotations({
    description: "Metric: avg, sum, min, max, or count. Defaults to avg.",
  }),
  group_by: Schema.optional(Schema.Literal("service", "none")).annotations({
    description: "Grouping: service or none. Defaults to none.",
  }),
  bucket_seconds: optionalNumberParam("Bucket size in seconds (auto-computed if omitted)"),
  ...commonTimeRangeFields,
  service_name: optionalStringParam("Filter by service name"),
  metric_name: requiredStringParam("Metric name. Use list_metrics first to discover it."),
  metric_type: MetricType.annotations({
    description: "Metric type: sum, gauge, histogram, or exponential_histogram.",
  }),
})

const metricsBreakdownArgsSchema = Schema.Struct({
  source: Schema.Literal("metrics").annotations({ description: "Data source: metrics" }),
  kind: Schema.Literal("breakdown").annotations({ description: "Query type: breakdown" }),
  metric: Schema.optional(Schema.Literal("avg", "sum", "count")).annotations({
    description: "Metric: avg, sum, or count. Defaults to avg.",
  }),
  group_by: Schema.optional(Schema.Literal("service")).annotations({
    description: "Grouping: service. Defaults to service.",
  }),
  limit: optionalNumberParam("Max breakdown rows (default 10, max 100)"),
  ...commonTimeRangeFields,
  service_name: optionalStringParam("Filter by service name"),
  metric_name: requiredStringParam("Metric name. Use list_metrics first to discover it."),
  metric_type: MetricType.annotations({
    description: "Metric type: sum, gauge, histogram, or exponential_histogram.",
  }),
})

export const queryDataArgsSchema = Schema.Union(
  tracesTimeseriesArgsSchema,
  tracesBreakdownArgsSchema,
  logsTimeseriesArgsSchema,
  logsBreakdownArgsSchema,
  metricsTimeseriesArgsSchema,
  metricsBreakdownArgsSchema,
)

export type QueryDataArgs = Schema.Schema.Type<typeof queryDataArgsSchema>

const queryDataToolDescription =
  "Execute a structured observability query with only supported combinations. " +
  "Supported queries: traces timeseries, traces breakdown, logs timeseries, logs breakdown, metrics timeseries, and metrics breakdown. " +
  "Metrics breakdown only supports metric=avg|sum|count grouped by service. " +
  "Example: traces timeseries grouped by service to compare traffic over time. " +
  "Example: call list_metrics first, then query a specific metric timeseries with metric_name and metric_type."

const querySpecDecoder = Schema.validateEither(QuerySpec)

const splitCsv = (value: string): Array<string> =>
  value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)

const resolveTenant = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const nativeReq = yield* HttpServerRequest.toWeb(req)
  return yield* Effect.tryPromise({
    try: () => resolveMcpTenantContext(nativeReq),
    catch: (error) =>
      new McpTenantError({
        message: error instanceof Error ? error.message : String(error),
      }),
  })
}).pipe(
  Effect.catchTag("RequestError", (error) =>
    Effect.fail(new McpTenantError({ message: error.message })),
  ),
)

export function buildQuerySpec(args: QueryDataArgs): { spec: QuerySpecType } | { error: string } {
  const attributeKey = "attribute_key" in args ? args.attribute_key : undefined
  const attributeValue = "attribute_value" in args ? args.attribute_value : undefined

  if (attributeValue && !attributeKey) {
    return { error: "`attribute_value` requires `attribute_key`." }
  }

  if ("group_by" in args && args.group_by === "attribute" && !attributeKey) {
    return { error: "`group_by=attribute` requires `attribute_key`." }
  }

  if (args.source === "traces") {
    const filters: TracesFilters = {
      ...(args.service_name && { serviceName: args.service_name }),
      ...(args.span_name && { spanName: args.span_name }),
      ...(args.root_spans_only && { rootSpansOnly: args.root_spans_only }),
      ...(args.environments && { environments: splitCsv(args.environments) }),
      ...(args.commit_shas && { commitShas: splitCsv(args.commit_shas) }),
      ...(attributeKey && { attributeKey }),
      ...(attributeValue && { attributeValue }),
    }
    const hasFilters = Object.keys(filters).length > 0

    if (args.kind === "timeseries") {
      return {
        spec: {
          kind: "timeseries",
          source: "traces",
          metric: args.metric ?? "count",
          groupBy: args.group_by ?? "none",
          ...(hasFilters && { filters }),
          ...(args.bucket_seconds && { bucketSeconds: args.bucket_seconds }),
        },
      }
    }

    return {
      spec: {
        kind: "breakdown",
        source: "traces",
        metric: args.metric ?? "count",
        groupBy: args.group_by ?? "service",
        ...(hasFilters && { filters }),
        ...(args.limit && { limit: args.limit }),
      },
    }
  }

  if (args.source === "logs") {
    const filters: LogsFilters = {
      ...(args.service_name && { serviceName: args.service_name }),
      ...(args.severity && { severity: args.severity }),
    }
    const hasFilters = Object.keys(filters).length > 0

    if (args.kind === "timeseries") {
      return {
        spec: {
          kind: "timeseries",
          source: "logs",
          metric: "count",
          groupBy: args.group_by ?? "none",
          ...(hasFilters && { filters }),
          ...(args.bucket_seconds && { bucketSeconds: args.bucket_seconds }),
        },
      }
    }

    return {
      spec: {
        kind: "breakdown",
        source: "logs",
        metric: "count",
        groupBy: args.group_by ?? "service",
        ...(hasFilters && { filters }),
        ...(args.limit && { limit: args.limit }),
      },
    }
  }

  const filters: MetricsFilters = {
    metricName: args.metric_name,
    metricType: args.metric_type,
    ...(args.service_name && { serviceName: args.service_name }),
  }

  if (args.kind === "timeseries") {
    return {
      spec: {
        kind: "timeseries",
        source: "metrics",
        metric: args.metric ?? "avg",
        groupBy: args.group_by ?? "none",
        filters,
        ...(args.bucket_seconds && { bucketSeconds: args.bucket_seconds }),
      },
    }
  }

  return {
    spec: {
      kind: "breakdown",
      source: "metrics",
      metric: args.metric ?? "avg",
      groupBy: "service",
      filters,
      ...(args.limit && { limit: args.limit }),
    },
  }
}

function formatBucket(bucket: string): string {
  const match = bucket.match(/T(\d{2}:\d{2}:\d{2})/)
  return match ? match[1] : bucket.slice(11, 19)
}

function formatMetricValue(metric: string, value: number): string {
  if (metric.includes("duration")) return formatDurationFromMs(value)
  if (metric === "error_rate") return formatPercent(value)
  return formatNumber(value)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatQueryResult(
  response: QueryEngineExecuteResponse,
  source: string,
  kind: string,
  metric: string | undefined,
  startTime: string,
  endTime: string,
  groupBy: string | undefined,
): McpToolResult {
  const result = response.result
  const metricLabel = metric ?? (source === "metrics" ? "avg" : "count")
  const structuredResult = result.kind === "timeseries"
    ? {
        kind: "timeseries" as const,
        data: result.data.map((point) => ({
          bucket: point.bucket,
          series: { ...point.series },
        })),
      }
    : {
        kind: "breakdown" as const,
        data: result.data.map((item) => ({
          name: item.name,
          value: item.value,
        })),
      }

  const structuredData = {
    tool: "query_data" as const,
    data: {
      timeRange: { start: startTime, end: endTime },
      source,
      kind,
      metric: metricLabel,
      groupBy,
      result: structuredResult,
    },
  }

  const lines: string[] = [
    `=== ${capitalize(source)} ${capitalize(kind)}: ${metricLabel} ===`,
    `Time range: ${startTime} — ${endTime}`,
  ]

  if (result.kind === "timeseries") {
    if (result.data.length === 0) {
      lines.push("", "No data points found.")
      return { content: createDualContent(lines.join("\n"), structuredData) }
    }

    const seriesKeys = [...new Set(result.data.flatMap((point) => Object.keys(point.series)))]
    if (seriesKeys.length === 0) seriesKeys.push("value")

    lines.push(`Data points: ${result.data.length}`, "")

    const headers = ["Bucket", ...seriesKeys]
    const rows = result.data.map((point) => [
      formatBucket(point.bucket),
      ...seriesKeys.map((key) =>
        formatMetricValue(metricLabel, point.series[key] ?? 0),
      ),
    ])

    lines.push(formatTable(headers, rows))
    return { content: createDualContent(lines.join("\n"), structuredData) }
  }

  if (result.data.length === 0) {
    lines.push("", "No data found.")
    return { content: createDualContent(lines.join("\n"), structuredData) }
  }

  if (groupBy) lines.push(`Grouped by: ${groupBy}`)
  lines.push("")

  const headers = ["Name", metricLabel]
  const rows = result.data.map((item) => [
    item.name,
    formatMetricValue(metricLabel, item.value),
  ])

  lines.push(formatTable(headers, rows))
  return { content: createDualContent(lines.join("\n"), structuredData) }
}

function toInvalidQuerySpecMessage(error: ParseResult.ParseError): string {
  return `Invalid query specification:\n${ParseResult.TreeFormatter.formatErrorSync(error)}`
}

export function registerQueryDataTool(server: McpToolRegistrar) {
  server.tool(
    "query_data",
    queryDataToolDescription,
    queryDataArgsSchema,
    (params) =>
      Effect.gen(function* () {
        const { startTime, endTime } = defaultTimeRange(1)
        const st = params.start_time ?? startTime
        const et = params.end_time ?? endTime

        const query = buildQuerySpec(params)
        if ("error" in query) {
          return {
            isError: true,
            content: [{ type: "text", text: query.error }],
          }
        }

        const decodedQuery = querySpecDecoder(query.spec)
        if (decodedQuery._tag === "Left") {
          return {
            isError: true,
            content: [{ type: "text", text: toInvalidQuerySpecMessage(decodedQuery.left) }],
          }
        }

        const tenant = yield* resolveTenant
        const exit = yield* Effect.promise(() =>
          QueryEngineRuntime.runPromiseExit(
            QueryEngineService.execute(tenant, {
              startTime: st,
              endTime: et,
              query: decodedQuery.right,
            }),
          ),
        )

        if (Exit.isFailure(exit)) {
          const failure = Option.getOrUndefined(Cause.failureOption(exit.cause))
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
            content: [{ type: "text", text: "Query execution failed unexpectedly." }],
          }
        }

        return formatQueryResult(
          exit.value,
          params.source,
          params.kind,
          params.metric,
          st,
          et,
          "group_by" in params ? params.group_by : undefined,
        )
      }),
  )
}
