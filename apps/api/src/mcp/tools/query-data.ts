import {
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
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect"
import { resolveMcpTenantContext } from "@/mcp/lib/resolve-tenant"
import { QueryEngineService } from "@/services/QueryEngineService"
import type {
  LogsFilters,
  MetricsFilters,
  QueryEngineExecuteResponse,
  QuerySpec,
  TracesFilters,
} from "@maple/domain"

const QueryEngineRuntime = ManagedRuntime.make(QueryEngineService.Default)

type FlatParams = {
  source: string
  kind: string
  start_time?: string
  end_time?: string
  metric?: string
  group_by?: string
  bucket_seconds?: number
  limit?: number
  service_name?: string
  span_name?: string
  root_spans_only?: boolean
  environments?: string
  commit_shas?: string
  attribute_key?: string
  attribute_value?: string
  severity?: string
  metric_name?: string
  metric_type?: string
}

function buildQuerySpec(
  source: "traces" | "logs" | "metrics",
  kind: "timeseries" | "breakdown",
  params: FlatParams,
): { spec: QuerySpec } | { error: string } {
  if (source === "traces") {
    const filters: TracesFilters = {
      ...(params.service_name && { serviceName: params.service_name }),
      ...(params.span_name && { spanName: params.span_name }),
      ...(params.root_spans_only && { rootSpansOnly: params.root_spans_only }),
      ...(params.environments && {
        environments: params.environments.split(",").map((s) => s.trim()),
      }),
      ...(params.commit_shas && {
        commitShas: params.commit_shas.split(",").map((s) => s.trim()),
      }),
      ...(params.attribute_key && { attributeKey: params.attribute_key }),
      ...(params.attribute_value && { attributeValue: params.attribute_value }),
    }
    const metric = (params.metric ?? "count") as QuerySpec["metric"]
    const hasFilters = Object.keys(filters).length > 0

    if (kind === "timeseries") {
      return {
        spec: {
          kind: "timeseries",
          source: "traces",
          metric: metric as any,
          groupBy: (params.group_by ?? "none") as any,
          ...(hasFilters && { filters }),
          ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
        },
      }
    }
    const groupBy = params.group_by && params.group_by !== "none" ? params.group_by : "service"
    return {
      spec: {
        kind: "breakdown",
        source: "traces",
        metric: metric as any,
        groupBy: groupBy as any,
        ...(hasFilters && { filters }),
        ...(params.limit && { limit: params.limit }),
      },
    }
  }

  if (source === "logs") {
    const filters: LogsFilters = {
      ...(params.service_name && { serviceName: params.service_name }),
      ...(params.severity && { severity: params.severity }),
    }
    const hasFilters = Object.keys(filters).length > 0

    if (kind === "timeseries") {
      return {
        spec: {
          kind: "timeseries",
          source: "logs",
          metric: "count",
          groupBy: (params.group_by ?? "none") as any,
          ...(hasFilters && { filters }),
          ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
        },
      }
    }
    const groupBy = params.group_by && params.group_by !== "none" ? params.group_by : "service"
    return {
      spec: {
        kind: "breakdown",
        source: "logs",
        metric: "count",
        groupBy: groupBy as any,
        ...(hasFilters && { filters }),
        ...(params.limit && { limit: params.limit }),
      },
    }
  }

  // source === "metrics"
  if (!params.metric_name) return { error: "metric_name is required when source='metrics'" }
  if (!params.metric_type) return { error: "metric_type is required when source='metrics'" }

  const filters: MetricsFilters = {
    metricName: params.metric_name,
    metricType: params.metric_type as any,
    ...(params.service_name && { serviceName: params.service_name }),
  }
  const metric = params.metric ?? "avg"

  if (kind === "timeseries") {
    return {
      spec: {
        kind: "timeseries",
        source: "metrics",
        metric: metric as any,
        groupBy: (params.group_by ?? "none") as any,
        filters,
        ...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
      },
    }
  }
  return {
    spec: {
      kind: "breakdown",
      source: "metrics",
      metric: (["avg", "sum", "count"].includes(metric) ? metric : "avg") as any,
      groupBy: "service",
      filters,
      ...(params.limit && { limit: params.limit }),
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

  const lines: string[] = [
    `=== ${capitalize(source)} ${capitalize(kind)}: ${metricLabel} ===`,
    `Time range: ${startTime} — ${endTime}`,
  ]

  if (result.kind === "timeseries") {
    const data = result.data as Array<{ bucket: string; series: Record<string, number> }>
    if (data.length === 0) {
      lines.push("", "No data points found.")
      return { content: [{ type: "text", text: lines.join("\n") }] }
    }

    const seriesKeys = [...new Set(data.flatMap((d) => Object.keys(d.series)))]
    if (seriesKeys.length === 0) seriesKeys.push("value")

    lines.push(`Data points: ${data.length}`, "")

    const headers = ["Bucket", ...seriesKeys]
    const rows = data.map((point) => [
      formatBucket(point.bucket),
      ...seriesKeys.map((key) =>
        formatMetricValue(metricLabel, point.series[key] ?? 0),
      ),
    ])

    lines.push(formatTable(headers, rows))
    return { content: [{ type: "text", text: lines.join("\n") }] }
  }

  if (result.kind === "breakdown") {
    const data = result.data as Array<{ name: string; value: number }>
    if (data.length === 0) {
      lines.push("", "No data found.")
      return { content: [{ type: "text", text: lines.join("\n") }] }
    }

    if (groupBy) lines.push(`Grouped by: ${groupBy}`)
    lines.push("")

    const headers = ["Name", metricLabel]
    const rows = data.map((item) => [
      item.name,
      formatMetricValue(metricLabel, item.value),
    ])

    lines.push(formatTable(headers, rows))
    return { content: [{ type: "text", text: lines.join("\n") }] }
  }

  lines.push("", "Unexpected result format.")
  return { content: [{ type: "text", text: lines.join("\n") }] }
}

export function registerQueryDataTool(server: McpToolRegistrar) {
  server.tool(
    "query_data",
    "Execute a structured observability query against traces, logs, or metrics. " +
      "Supports timeseries (bucketed over time) and breakdown (grouped aggregations) queries. " +
      "For traces: metric can be count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate. " +
      "For logs: metric is always count. " +
      "For metrics: metric can be avg, sum, min, max, count (requires metric_name and metric_type). " +
      "Timeseries auto-computes bucket size targeting ~40 data points if bucket_seconds is omitted.",
    {
      source: requiredStringParam("Data source: 'traces', 'logs', or 'metrics'"),
      kind: requiredStringParam("Query type: 'timeseries' or 'breakdown'"),
      start_time: optionalStringParam("Start time (YYYY-MM-DD HH:mm:ss). Defaults to 1 hour ago"),
      end_time: optionalStringParam("End time (YYYY-MM-DD HH:mm:ss). Defaults to now"),
      metric: optionalStringParam(
        "Metric to compute. " +
          "Traces: count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate (default: count). " +
          "Logs: always count. " +
          "Metrics: avg, sum, min, max, count (default: avg)",
      ),
      group_by: optionalStringParam(
        "Grouping dimension. " +
          "Traces: service, span_name, status_code, http_method, attribute, none. " +
          "Logs: service, severity, none. " +
          "Metrics: service, none. " +
          "Breakdown queries default to 'service' if omitted",
      ),
      bucket_seconds: optionalNumberParam("Bucket size in seconds for timeseries (auto-computed if omitted)"),
      limit: optionalNumberParam("Max breakdown rows (default 10, max 100)"),
      service_name: optionalStringParam("Filter by service name"),
      span_name: optionalStringParam("Filter by span name (traces only)"),
      root_spans_only: optionalBooleanParam("Only root spans (traces only)"),
      environments: optionalStringParam("Comma-separated environments (traces only)"),
      commit_shas: optionalStringParam("Comma-separated commit SHAs (traces only)"),
      attribute_key: optionalStringParam("Attribute key for filtering/grouping (traces only)"),
      attribute_value: optionalStringParam("Attribute value filter (traces only, requires attribute_key)"),
      severity: optionalStringParam("Severity filter (logs only, e.g. ERROR, WARN)"),
      metric_name: optionalStringParam("Metric name (required when source='metrics')"),
      metric_type: optionalStringParam(
        "Metric type: sum, gauge, histogram, exponential_histogram (required when source='metrics')",
      ),
    },
    (params) =>
      Effect.gen(function* () {
        const source = params.source as "traces" | "logs" | "metrics"
        const kind = params.kind as "timeseries" | "breakdown"

        if (!["traces", "logs", "metrics"].includes(source)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Invalid source. Must be 'traces', 'logs', or 'metrics'." }],
          }
        }
        if (!["timeseries", "breakdown"].includes(kind)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Invalid kind. Must be 'timeseries' or 'breakdown'." }],
          }
        }

        const { startTime, endTime } = defaultTimeRange(1)
        const st = params.start_time ?? startTime
        const et = params.end_time ?? endTime

        const query = buildQuerySpec(source, kind, params as FlatParams)
        if ("error" in query) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: query.error }],
          }
        }

        const tenant = yield* Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest
          const nativeReq = yield* HttpServerRequest.toWeb(req)
          return yield* Effect.tryPromise(() => resolveMcpTenantContext(nativeReq))
        }).pipe(Effect.orDie)

        const exit = yield* Effect.promise(() =>
          QueryEngineRuntime.runPromiseExit(
            QueryEngineService.execute(tenant, {
              startTime: st,
              endTime: et,
              query: query.spec,
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
              content: [{ type: "text" as const, text: `${tagged._tag}: ${tagged.message}${details}` }],
            }
          }
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Query execution failed unexpectedly." }],
          }
        }

        return formatQueryResult(exit.value, source, kind, params.metric, st, et, params.group_by)
      }),
  )
}
