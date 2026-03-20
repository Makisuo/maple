import {
  DiagnoseServiceToolInput,
  type DiagnoseServiceToolOutput,
  ErrorDetailToolInput,
  type ErrorDetailToolOutput,
  FindErrorsToolInput,
  type FindErrorsToolOutput,
  FindSlowTracesToolInput,
  type FindSlowTracesToolOutput,
  type InspectTraceData as InspectTraceDataOutput,
  InspectTraceToolInput,
  type InspectTraceToolOutput,
  ListMetricsToolInput,
  type ListMetricsToolOutput,
  type QueryDataToolOutput,
  QueryDataToolInput,
  SearchLogsToolInput,
  type SearchLogsToolOutput,
  SearchTracesToolInput,
  type SearchTracesToolOutput,
  ServiceOverviewToolInput,
  type ServiceOverviewToolOutput,
  type SpanNodeData,
  SystemHealthToolInput,
  type SystemHealthToolOutput,
} from "@maple/domain"
import type { TenantContext } from "@/services/AuthService"
import {
  QueryEngineService,
} from "@/services/QueryEngineService"
import { TinybirdService } from "@/services/TinybirdService"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import { getSpamPatternsParam } from "@/lib/spam-patterns"
import { queryTinybird } from "@/mcp/lib/query-tinybird"
import { defaultTimeRange } from "@/mcp/lib/time"
import {
  formatDurationFromMs,
  formatDurationMs,
  formatNumber,
  formatPercent,
  formatTable,
  truncate,
} from "@/mcp/lib/format"
import {
  CurrentTenantContext,
  resolveToolTenantContext,
} from "@/mcp/lib/current-tenant-context"
import { McpQueryError, type McpToolError } from "@/mcp/tools/types"
import { ApiKeysService } from "@/services/ApiKeysService"
import { AuthService } from "@/services/AuthService"
import { Env } from "@/services/Env"
import { buildQuerySpec, decodeQuerySpecSync } from "@/mcp/tools/query-data-shared"
import type { QueryEngineExecuteResponse, QuerySpec as QuerySpecType } from "@maple/domain"

const SYSTEM_SPAN_PATTERNS = ["ClusterCron"]

export type TinybirdToolExecutorEnvironment =
  | Env
  | ApiKeysService
  | AuthService
  | CurrentTenantContext
  | TinybirdService

export type QueryDataToolExecutorEnvironment =
  | Env
  | ApiKeysService
  | AuthService
  | CurrentTenantContext
  | QueryEngineService

export type ChatToolExecutionEnvironment =
  | TinybirdToolExecutorEnvironment
  | QueryDataToolExecutorEnvironment

const summaryText = (lines: Array<string>): string => lines.join("\n")

const toQueryError = (message: string) =>
  new McpQueryError({ message, pipe: "query_data" })

const formatBucket = (bucket: string): string => {
  const match = bucket.match(/T(\d{2}:\d{2}:\d{2})/)
  return match ? match[1] : bucket.slice(11, 19)
}

const formatMetricValue = (metric: string, value: number): string => {
  if (metric.includes("duration")) return formatDurationFromMs(value)
  if (metric === "error_rate") return formatPercent(value)
  return formatNumber(value)
}

const capitalize = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1)

const isSystemTrace = (rootSpanName: string): boolean =>
  SYSTEM_SPAN_PATTERNS.some((pattern) => rootSpanName.includes(pattern))

type MutableSpanNode = Omit<SpanNodeData, "children"> & {
  children: Array<MutableSpanNode>
}

function formatQueryDataOutput(
  response: QueryEngineExecuteResponse,
  source: string,
  kind: string,
  metric: string | undefined,
  startTime: string,
  endTime: string,
  groupBy: string | undefined,
): QueryDataToolOutput {
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

  const lines: string[] = [
    `=== ${capitalize(source)} ${capitalize(kind)}: ${metricLabel} ===`,
    `Time range: ${startTime} — ${endTime}`,
  ]

  if (result.kind === "timeseries") {
    if (result.data.length === 0) {
      lines.push("", "No data points found.")
      return {
        tool: "query_data",
        summaryText: summaryText(lines),
        data: {
          timeRange: { start: startTime, end: endTime },
          source,
          kind,
          metric: metricLabel,
          groupBy,
          result: structuredResult,
        },
      }
    }

    const seriesKeys = [...new Set(result.data.flatMap((point) => Object.keys(point.series)))]
    if (seriesKeys.length === 0) {
      seriesKeys.push("value")
    }

    lines.push(`Data points: ${result.data.length}`, "")

    const headers = ["Bucket", ...seriesKeys]
    const rows = result.data.map((point) => [
      formatBucket(point.bucket),
      ...seriesKeys.map((key) => formatMetricValue(metricLabel, point.series[key] ?? 0)),
    ])

    lines.push(formatTable(headers, rows))
    return {
      tool: "query_data",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: startTime, end: endTime },
        source,
        kind,
        metric: metricLabel,
        groupBy,
        result: structuredResult,
      },
    }
  }

  if (result.data.length === 0) {
    lines.push("", "No data found.")
    return {
      tool: "query_data",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: startTime, end: endTime },
        source,
        kind,
        metric: metricLabel,
        groupBy,
        result: structuredResult,
      },
    }
  }

  if (groupBy) {
    lines.push(`Grouped by: ${groupBy}`)
  }
  lines.push("")

  const headers = ["Name", metricLabel]
  const rows = result.data.map((item) => [
    item.name,
    formatMetricValue(metricLabel, item.value),
  ])

  lines.push(formatTable(headers, rows))

  return {
    tool: "query_data",
    summaryText: summaryText(lines),
    data: {
      timeRange: { start: startTime, end: endTime },
      source,
      kind,
      metric: metricLabel,
      groupBy,
      result: structuredResult,
    },
  }
}

const toInvalidQuerySpecMessage = (error: unknown): string =>
  `Invalid query specification:\n${String(error)}`

export const executeSystemHealthTool = (
  { start_time, end_time }: Schema.Schema.Type<typeof SystemHealthToolInput>,
): Effect.Effect<SystemHealthToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = start_time ?? startTime
    const et = end_time ?? endTime

    const [summaryResult, servicesResult, errorsResult] = yield* Effect.all(
      [
        queryTinybird("errors_summary", {
          start_time: st,
          end_time: et,
          exclude_spam_patterns: getSpamPatternsParam(),
        }),
        queryTinybird("service_overview", {
          start_time: st,
          end_time: et,
        }),
        queryTinybird("errors_by_type", {
          start_time: st,
          end_time: et,
          limit: 5,
          exclude_spam_patterns: getSpamPatternsParam(),
        }),
      ],
      { concurrency: "unbounded" },
    )

    const summary = summaryResult.data[0]
    const services = servicesResult.data
    const errors = errorsResult.data

    const serviceCount = new Set(services.map((service) => service.serviceName)).size

    let totalThroughput = 0
    let weightedP50 = 0
    let weightedP95 = 0
    for (const service of services) {
      const throughput = Number(service.throughput)
      totalThroughput += throughput
      weightedP50 += service.p50LatencyMs * throughput
      weightedP95 += service.p95LatencyMs * throughput
    }

    const avgP50 = totalThroughput > 0 ? weightedP50 / totalThroughput : 0
    const avgP95 = totalThroughput > 0 ? weightedP95 / totalThroughput : 0

    const lines: string[] = [
      "=== System Health Snapshot ===",
      `Time range: ${st} — ${et}`,
      "",
      `Services active: ${serviceCount}`,
      `Total spans: ${summary ? formatNumber(summary.totalSpans) : "0"}`,
      `Total errors: ${summary ? formatNumber(summary.totalErrors) : "0"}`,
      `Error rate: ${summary ? formatPercent(summary.errorRate) : "0.00%"}`,
      `Affected services: ${summary ? Number(summary.affectedServicesCount) : 0}`,
      `Affected traces: ${summary ? Number(summary.affectedTracesCount) : 0}`,
      "",
      "Latency (weighted avg):",
      `  P50: ${formatDurationFromMs(avgP50)}`,
      `  P95: ${formatDurationFromMs(avgP95)}`,
    ]

    if (errors.length > 0) {
      lines.push("", "Top Errors:")
      for (const error of errors) {
        lines.push(
          `  - ${error.errorType} (${formatNumber(error.count)}x, ${Number(error.affectedServicesCount)} services)`,
        )
      }
    }

    return {
      tool: "system_health",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: st, end: et },
        serviceCount,
        totalSpans: summary ? Number(summary.totalSpans) : 0,
        totalErrors: summary ? Number(summary.totalErrors) : 0,
        errorRate: summary ? summary.errorRate : 0,
        affectedServicesCount: summary ? Number(summary.affectedServicesCount) : 0,
        affectedTracesCount: summary ? Number(summary.affectedTracesCount) : 0,
        latency: { p50Ms: avgP50, p95Ms: avgP95 },
        topErrors: errors.map((error) => ({
          errorType: error.errorType,
          count: Number(error.count),
          affectedServicesCount: Number(error.affectedServicesCount),
        })),
      },
    }
  })

export const executeFindErrorsTool = (
  { start_time, end_time, service, limit }: Schema.Schema.Type<typeof FindErrorsToolInput>,
): Effect.Effect<FindErrorsToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = start_time ?? startTime
    const et = end_time ?? endTime

    const result = yield* queryTinybird("errors_by_type", {
      start_time: st,
      end_time: et,
      services: service,
      limit: limit ?? 20,
      exclude_spam_patterns: getSpamPatternsParam(),
    })

    const lines: string[] = result.data.length === 0
      ? [`No errors found in ${st} — ${et}`]
      : [
          `=== Errors by Type (${st} — ${et}) ===`,
          "",
          formatTable(
            ["Error Type", "Count", "Services", "Last Seen"],
            result.data.map((error) => [
              error.errorType.length > 60 ? error.errorType.slice(0, 57) + "..." : error.errorType,
              formatNumber(error.count),
              error.affectedServices.join(", "),
              String(error.lastSeen),
            ]),
          ),
          "",
          `Total: ${result.data.length} error types`,
        ]

    return {
      tool: "find_errors",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: st, end: et },
        errors: result.data.map((error) => ({
          errorType: error.errorType,
          count: Number(error.count),
          affectedServices: error.affectedServices,
          lastSeen: String(error.lastSeen),
        })),
      },
    }
  })

export const executeInspectTraceTool = (
  { trace_id }: Schema.Schema.Type<typeof InspectTraceToolInput>,
): Effect.Effect<InspectTraceToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const [spansResult, logsResult] = yield* Effect.all(
      [
        queryTinybird("span_hierarchy", { trace_id }),
        queryTinybird("list_logs", { trace_id, limit: 50 }),
      ],
      { concurrency: "unbounded" },
    )

    const spans = spansResult.data
    if (spans.length === 0) {
      return {
        tool: "inspect_trace",
        summaryText: `No spans found for trace ${trace_id}`,
        data: {
          traceId: trace_id,
          serviceCount: 0,
          spanCount: 0,
          rootDurationMs: 0,
          spans: [],
          logs: [],
        },
      }
    }

    const nodeMap = new Map<string, MutableSpanNode>()
    const roots: Array<MutableSpanNode> = []

    for (const span of spans) {
      nodeMap.set(span.spanId, {
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        spanName: span.spanName,
        serviceName: span.serviceName,
        durationMs: span.durationMs,
        statusCode: span.statusCode,
        statusMessage: span.statusMessage,
        children: [],
      })
    }

    for (const node of nodeMap.values()) {
      if (node.parentSpanId && nodeMap.has(node.parentSpanId)) {
        nodeMap.get(node.parentSpanId)?.children.push(node)
      } else {
        roots.push(node)
      }
    }

    const serviceSet = new Set(spans.map((span) => span.serviceName))
    const rootDuration = roots[0]?.durationMs ?? 0

    const lines: string[] = [
      `=== Trace ${trace_id} (${serviceSet.size} services, ${spans.length} spans, ${formatDurationFromMs(rootDuration)}) ===`,
      "",
    ]

    const renderNode = (node: MutableSpanNode, prefix: string, isLast: boolean) => {
      const connector = prefix === "" ? "" : isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 "
      const status = node.statusCode === "Error"
        ? " [Error]"
        : node.statusCode === "Ok"
        ? " [Ok]"
        : ""
      lines.push(
        `${prefix}${connector}${node.spanName} — ${node.serviceName} (${formatDurationFromMs(node.durationMs)})${status}`,
      )

      if (node.statusCode === "Error" && node.statusMessage) {
        const childPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "\u2502   ")
        lines.push(`${childPrefix}    Status: "${truncate(node.statusMessage, 100)}"`)
      }

      const childPrefix = prefix + (prefix === "" ? "" : isLast ? "    " : "\u2502   ")
      node.children.forEach((child, index) => {
        renderNode(child, childPrefix, index === node.children.length - 1)
      })
    }

    for (const root of roots) {
      renderNode(root, "", true)
    }

    const logs = logsResult.data
    if (logs.length > 0) {
      lines.push("", `Related Logs (${logs.length}):`)
      for (const log of logs.slice(0, 20)) {
        const timestamp = String(log.timestamp)
        const time = timestamp.split(" ")[1] ?? timestamp
        const severity = (log.severityText || "INFO").padEnd(5)
        lines.push(`  ${time} [${severity}] ${log.serviceName}: ${truncate(log.body, 100)}`)
      }
      if (logs.length > 20) {
        lines.push(`  ... and ${logs.length - 20} more logs`)
      }
    }

    const data: InspectTraceDataOutput = {
      traceId: trace_id,
      serviceCount: serviceSet.size,
      spanCount: spans.length,
      rootDurationMs: rootDuration,
      spans: roots,
      logs: logs.slice(0, 20).map((log) => ({
        timestamp: String(log.timestamp),
        severityText: log.severityText || "INFO",
        serviceName: log.serviceName,
        body: log.body,
        traceId: log.traceId || undefined,
        spanId: log.spanId || undefined,
      })),
    }

    return {
      tool: "inspect_trace",
      summaryText: summaryText(lines),
      data,
    }
  })

export const executeSearchLogsTool = (
  {
    start_time,
    end_time,
    service,
    severity,
    search,
    trace_id,
    limit,
  }: Schema.Schema.Type<typeof SearchLogsToolInput>,
): Effect.Effect<SearchLogsToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = start_time ?? startTime
    const et = end_time ?? endTime
    const lim = limit ?? 30

    const [logsResult, countResult] = yield* Effect.all(
      [
        queryTinybird("list_logs", {
          start_time: st,
          end_time: et,
          service,
          severity,
          search,
          trace_id,
          limit: lim,
        }),
        queryTinybird("logs_count", {
          start_time: st,
          end_time: et,
          service,
          severity,
          search,
          trace_id,
        }),
      ],
      { concurrency: "unbounded" },
    )

    const total = countResult.data[0] ? Number(countResult.data[0].total) : 0
    const logs = logsResult.data

    const lines: string[] = logs.length === 0
      ? [`No logs found matching filters (${st} — ${et})`]
      : [
          `=== Logs (${formatNumber(total)} total, showing ${logs.length}) ===`,
          `Time range: ${st} — ${et}`,
        ]

    if (logs.length > 0) {
      const filters: string[] = []
      if (service) filters.push(`service=${service}`)
      if (severity) filters.push(`severity=${severity}`)
      if (search) filters.push(`search="${search}"`)
      if (trace_id) filters.push(`trace_id=${trace_id}`)
      if (filters.length > 0) {
        lines.push(`Filters: ${filters.join(", ")}`)
      }

      lines.push("")

      for (const log of logs) {
        const timestamp = String(log.timestamp)
        const time = timestamp.split(" ")[1] ?? timestamp
        const sev = (log.severityText || "INFO").padEnd(5)
        const traceRef = log.traceId ? ` [trace:${log.traceId.slice(0, 8)}]` : ""
        lines.push(`${time} [${sev}] ${log.serviceName}: ${truncate(log.body, 120)}${traceRef}`)
      }

      if (total > logs.length) {
        lines.push("", `... ${formatNumber(total - logs.length)} more logs not shown`)
      }
    }

    return {
      tool: "search_logs",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: st, end: et },
        totalCount: total,
        logs: logs.map((log) => ({
          timestamp: String(log.timestamp),
          severityText: log.severityText || "INFO",
          serviceName: log.serviceName,
          body: log.body,
          traceId: log.traceId || undefined,
          spanId: log.spanId || undefined,
        })),
        filters: Object.keys({
          ...(service && { service }),
          ...(severity && { severity }),
          ...(search && { search }),
          ...(trace_id && { traceId: trace_id }),
        }).length > 0
          ? {
              ...(service && { service }),
              ...(severity && { severity }),
              ...(search && { search }),
              ...(trace_id && { traceId: trace_id }),
            }
          : undefined,
      },
    }
  })

export const executeSearchTracesTool = (
  params: Schema.Schema.Type<typeof SearchTracesToolInput>,
): Effect.Effect<SearchTracesToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = params.start_time ?? startTime
    const et = params.end_time ?? endTime

    const result = yield* queryTinybird("list_traces", {
      start_time: st,
      end_time: et,
      service: params.service,
      has_error: params.has_error,
      min_duration_ms: params.min_duration_ms,
      max_duration_ms: params.max_duration_ms,
      http_method: params.http_method,
      span_name: params.span_name,
      limit: params.limit ?? 20,
    })

    const traces = result.data
    const lines: string[] = traces.length === 0
      ? [`No traces found matching filters (${st} — ${et})`]
      : [
          `=== Traces (showing ${traces.length}) ===`,
          `Time range: ${st} — ${et}`,
          "",
          formatTable(
            ["Trace ID", "Root Span", "Duration", "Spans", "Services", "Error"],
            traces.map((trace) => [
              trace.traceId.slice(0, 12) + "...",
              trace.rootSpanName.length > 30
                ? trace.rootSpanName.slice(0, 27) + "..."
                : trace.rootSpanName,
              formatDurationMs(trace.durationMicros),
              String(Number(trace.spanCount)),
              trace.services.join(", "),
              Number(trace.hasError) ? "Yes" : "",
            ]),
          ),
        ]

    return {
      tool: "search_traces",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: st, end: et },
        traces: traces.map((trace) => ({
          traceId: trace.traceId,
          rootSpanName: trace.rootSpanName,
          durationMs: Number(trace.durationMicros) / 1000,
          spanCount: Number(trace.spanCount),
          services: trace.services,
          hasError: Boolean(Number(trace.hasError)),
        })),
      },
    }
  })

export const executeServiceOverviewTool = (
  { start_time, end_time }: Schema.Schema.Type<typeof ServiceOverviewToolInput>,
): Effect.Effect<ServiceOverviewToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = start_time ?? startTime
    const et = end_time ?? endTime

    const [servicesResult, usageResult] = yield* Effect.all(
      [
        queryTinybird("service_overview", {
          start_time: st,
          end_time: et,
        }),
        queryTinybird("get_service_usage", {
          start_time: st,
          end_time: et,
        }),
      ],
      { concurrency: "unbounded" },
    )

    const serviceMap = new Map<string, {
      throughput: number
      errorCount: number
      p50: number
      p95: number
      p99: number
      totalWeight: number
    }>()

    for (const row of servicesResult.data) {
      const throughput = Number(row.throughput)
      const existing = serviceMap.get(row.serviceName)
      if (existing) {
        existing.throughput += throughput
        existing.errorCount += Number(row.errorCount)
        existing.p50 += row.p50LatencyMs * throughput
        existing.p95 += row.p95LatencyMs * throughput
        existing.p99 += row.p99LatencyMs * throughput
        existing.totalWeight += throughput
      } else {
        serviceMap.set(row.serviceName, {
          throughput,
          errorCount: Number(row.errorCount),
          p50: row.p50LatencyMs * throughput,
          p95: row.p95LatencyMs * throughput,
          p99: row.p99LatencyMs * throughput,
          totalWeight: throughput,
        })
      }
    }

    const usageMap = new Map<string, { logs: number; traces: number; metrics: number }>()
    for (const usage of usageResult.data) {
      usageMap.set(usage.serviceName, {
        logs: Number(usage.totalLogCount),
        traces: Number(usage.totalTraceCount),
        metrics: Number(usage.totalSumMetricCount) + Number(usage.totalGaugeMetricCount) +
          Number(usage.totalHistogramMetricCount) + Number(usage.totalExpHistogramMetricCount),
      })
    }

    const lines: string[] = serviceMap.size === 0
      ? [`No services found in ${st} — ${et}`]
      : [
          `=== Service Overview (${serviceMap.size} services) ===`,
          `Time range: ${st} — ${et}`,
          "",
          formatTable(
            ["Service", "Throughput", "Error Rate", "P50", "P95", "P99"],
            Array.from(serviceMap.entries()).map(([name, service]) => {
              const errorRate = service.throughput > 0 ? (service.errorCount / service.throughput) * 100 : 0
              const p50 = service.totalWeight > 0 ? service.p50 / service.totalWeight : 0
              const p95 = service.totalWeight > 0 ? service.p95 / service.totalWeight : 0
              const p99 = service.totalWeight > 0 ? service.p99 / service.totalWeight : 0
              return [
                name,
                formatNumber(service.throughput),
                formatPercent(errorRate),
                formatDurationFromMs(p50),
                formatDurationFromMs(p95),
                formatDurationFromMs(p99),
              ]
            }),
          ),
        ]

    if (serviceMap.size > 0 && usageResult.data.length > 0) {
      lines.push("", "Data Volume:")
      for (const [name] of serviceMap) {
        const usage = usageMap.get(name)
        if (usage) {
          lines.push(
            `  ${name}: ${formatNumber(usage.traces)} traces, ${formatNumber(usage.logs)} logs, ${formatNumber(usage.metrics)} metrics`,
          )
        }
      }
    }

    return {
      tool: "service_overview",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: st, end: et },
        services: Array.from(serviceMap.entries()).map(([name, service]) => ({
          name,
          throughput: service.throughput,
          errorRate: service.throughput > 0 ? (service.errorCount / service.throughput) * 100 : 0,
          p50Ms: service.totalWeight > 0 ? service.p50 / service.totalWeight : 0,
          p95Ms: service.totalWeight > 0 ? service.p95 / service.totalWeight : 0,
          p99Ms: service.totalWeight > 0 ? service.p99 / service.totalWeight : 0,
        })),
        dataVolume: usageResult.data.length > 0
          ? Array.from(serviceMap.keys()).map((name) => {
              const usage = usageMap.get(name)
              return {
                name,
                traces: usage?.traces ?? 0,
                logs: usage?.logs ?? 0,
                metrics: usage?.metrics ?? 0,
              }
            })
          : undefined,
      },
    }
  })

export const executeDiagnoseServiceTool = (
  { service_name, start_time, end_time }: Schema.Schema.Type<typeof DiagnoseServiceToolInput>,
): Effect.Effect<DiagnoseServiceToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = start_time ?? startTime
    const et = end_time ?? endTime

    const [overviewResult, errorsResult, logsResult, tracesResult, apdexResult] = yield* Effect.all(
      [
        queryTinybird("service_overview", { start_time: st, end_time: et }),
        queryTinybird("errors_by_type", {
          start_time: st,
          end_time: et,
          services: service_name,
          limit: 10,
          exclude_spam_patterns: getSpamPatternsParam(),
        }),
        queryTinybird("list_logs", {
          start_time: st,
          end_time: et,
          service: service_name,
          limit: 15,
        }),
        queryTinybird("list_traces", {
          start_time: st,
          end_time: et,
          service: service_name,
          limit: 5,
        }),
        queryTinybird("service_apdex_time_series", {
          service_name,
          start_time: st,
          end_time: et,
          bucket_seconds: 300,
        }),
      ],
      { concurrency: "unbounded" },
    )

    const serviceRows = overviewResult.data.filter((row) => row.serviceName === service_name)
    let throughput = 0
    let errorCount = 0
    let weightedP50 = 0
    let weightedP95 = 0
    let weightedP99 = 0
    for (const row of serviceRows) {
      const currentThroughput = Number(row.throughput)
      throughput += currentThroughput
      errorCount += Number(row.errorCount)
      weightedP50 += row.p50LatencyMs * currentThroughput
      weightedP95 += row.p95LatencyMs * currentThroughput
      weightedP99 += row.p99LatencyMs * currentThroughput
    }

    const errorRate = throughput > 0 ? (errorCount / throughput) * 100 : 0
    const p50 = throughput > 0 ? weightedP50 / throughput : 0
    const p95 = throughput > 0 ? weightedP95 / throughput : 0
    const p99 = throughput > 0 ? weightedP99 / throughput : 0

    const apdexValues = apdexResult.data.filter((value) => Number(value.totalCount) > 0)
    const avgApdex = apdexValues.length > 0
      ? apdexValues.reduce((sum, value) => sum + value.apdexScore, 0) / apdexValues.length
      : 0

    const lines: string[] = [
      `=== Diagnosis: ${service_name} ===`,
      `Time range: ${st} — ${et}`,
      "",
      "Health Metrics:",
      `  Throughput: ${formatNumber(throughput)} spans`,
      `  Error Rate: ${formatPercent(errorRate)} (${formatNumber(errorCount)} errors)`,
      `  P50 Latency: ${formatDurationFromMs(p50)}`,
      `  P95 Latency: ${formatDurationFromMs(p95)}`,
      `  P99 Latency: ${formatDurationFromMs(p99)}`,
      `  Apdex Score: ${avgApdex.toFixed(3)}`,
    ]

    if (errorsResult.data.length > 0) {
      lines.push("", "Top Errors:")
      for (const error of errorsResult.data) {
        lines.push(`  - ${truncate(error.errorType, 80)} (${formatNumber(error.count)}x)`)
      }
    } else {
      lines.push("", "No errors found for this service.")
    }

    if (tracesResult.data.length > 0) {
      lines.push("", "Recent Traces:")
      for (const trace of tracesResult.data) {
        const duration = Number(trace.durationMicros) / 1000
        const errorSuffix = Number(trace.hasError) ? " [Error]" : ""
        lines.push(
          `  ${trace.traceId.slice(0, 12)}... ${trace.rootSpanName} (${formatDurationFromMs(duration)})${errorSuffix}`,
        )
      }
    }

    if (logsResult.data.length > 0) {
      lines.push("", "Recent Logs:")
      for (const log of logsResult.data) {
        const timestamp = String(log.timestamp)
        const time = timestamp.split(" ")[1] ?? timestamp
        const sev = (log.severityText || "INFO").padEnd(5)
        lines.push(`  ${time} [${sev}] ${truncate(log.body, 100)}`)
      }
    }

    return {
      tool: "diagnose_service",
      summaryText: summaryText(lines),
      data: {
        serviceName: service_name,
        timeRange: { start: st, end: et },
        health: {
          throughput,
          errorRate,
          errorCount,
          p50Ms: p50,
          p95Ms: p95,
          p99Ms: p99,
          apdex: avgApdex,
        },
        topErrors: errorsResult.data.map((error) => ({
          errorType: error.errorType,
          count: Number(error.count),
        })),
        recentTraces: tracesResult.data.map((trace) => ({
          traceId: trace.traceId,
          rootSpanName: trace.rootSpanName,
          durationMs: Number(trace.durationMicros) / 1000,
          spanCount: Number(trace.spanCount),
          services: trace.services,
          hasError: Boolean(Number(trace.hasError)),
        })),
        recentLogs: logsResult.data.map((log) => ({
          timestamp: String(log.timestamp),
          severityText: log.severityText || "INFO",
          serviceName: log.serviceName,
          body: log.body,
          traceId: log.traceId || undefined,
          spanId: log.spanId || undefined,
        })),
      },
    }
  })

export const executeFindSlowTracesTool = (
  { start_time, end_time, service, limit }: Schema.Schema.Type<typeof FindSlowTracesToolInput>,
): Effect.Effect<FindSlowTracesToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = start_time ?? startTime
    const et = end_time ?? endTime
    const lim = limit ?? 10

    const [tracesResult, statsResult] = yield* Effect.all(
      [
        queryTinybird("list_traces", {
          start_time: st,
          end_time: et,
          service,
          limit: 500,
        }),
        queryTinybird("traces_duration_stats", {
          start_time: st,
          end_time: et,
          service,
        }),
      ],
      { concurrency: "unbounded" },
    )

    const stats = statsResult.data[0]
    const traces = [...tracesResult.data]
      .filter((trace) => !isSystemTrace(trace.rootSpanName))
      .sort((left, right) => Number(right.durationMicros) - Number(left.durationMicros))
      .slice(0, lim)

    const lines: string[] = traces.length === 0
      ? [`No traces found in ${st} — ${et}`]
      : [
          "=== Slowest Traces ===",
          `Time range: ${st} — ${et}`,
        ]

    if (traces.length > 0 && stats) {
      lines.push(
        "",
        "Duration Percentiles:",
        `  P50: ${formatDurationFromMs(stats.p50DurationMs)}`,
        `  P95: ${formatDurationFromMs(stats.p95DurationMs)}`,
        `  Min: ${formatDurationFromMs(stats.minDurationMs)}`,
        `  Max: ${formatDurationFromMs(stats.maxDurationMs)}`,
      )
    }

    if (traces.length > 0) {
      lines.push("")
      lines.push(
        formatTable(
          ["Trace ID", "Root Span", "Duration", "Spans", "Services", "Error"],
          traces.map((trace) => [
            trace.traceId.slice(0, 12) + "...",
            trace.rootSpanName.length > 30 ? trace.rootSpanName.slice(0, 27) + "..." : trace.rootSpanName,
            formatDurationMs(trace.durationMicros),
            String(Number(trace.spanCount)),
            trace.services.join(", "),
            Number(trace.hasError) ? "Yes" : "",
          ]),
        ),
      )
    }

    return {
      tool: "find_slow_traces",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: st, end: et },
        stats: stats
          ? {
              p50Ms: stats.p50DurationMs,
              p95Ms: stats.p95DurationMs,
              minMs: stats.minDurationMs,
              maxMs: stats.maxDurationMs,
            }
          : undefined,
        traces: traces.map((trace) => ({
          traceId: trace.traceId,
          rootSpanName: trace.rootSpanName,
          durationMs: Number(trace.durationMicros) / 1000,
          spanCount: Number(trace.spanCount),
          services: trace.services,
          hasError: Boolean(Number(trace.hasError)),
        })),
      },
    }
  })

export const executeErrorDetailTool = (
  { error_type, start_time, end_time, service, limit }: Schema.Schema.Type<typeof ErrorDetailToolInput>,
): Effect.Effect<ErrorDetailToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = start_time ?? startTime
    const et = end_time ?? endTime
    const lim = limit ?? 5

    const tracesResult = yield* queryTinybird("error_detail_traces", {
      error_type,
      start_time: st,
      end_time: et,
      services: service,
      limit: lim,
      exclude_spam_patterns: getSpamPatternsParam(),
    })

    const traces = tracesResult.data
    if (traces.length === 0) {
      return {
        tool: "error_detail",
        summaryText: `No traces found for error type "${error_type}" in ${st} — ${et}`,
        data: {
          timeRange: { start: st, end: et },
          errorType: error_type,
          traces: [],
        },
      }
    }

    const traceIds = traces.slice(0, 3).map((trace) => trace.traceId)
    const logsResults = yield* Effect.all(
      traceIds.map((traceId) => queryTinybird("list_logs", { trace_id: traceId, limit: 10 })),
      { concurrency: "unbounded" },
    )

    const lines: string[] = [
      `=== Error Detail: "${truncate(error_type, 80)}" ===`,
      `Time range: ${st} — ${et}`,
      `Sample traces: ${traces.length}`,
      "",
    ]

    for (let index = 0; index < traces.length; index++) {
      const trace = traces[index]!
      lines.push(
        `--- Trace ${index + 1}: ${trace.traceId.slice(0, 16)}... ---`,
        `  Root span: ${trace.rootSpanName}`,
        `  Duration: ${formatDurationMs(trace.durationMicros)}`,
        `  Spans: ${Number(trace.spanCount)}`,
        `  Services: ${trace.services.join(", ")}`,
        `  Time: ${trace.startTime}`,
      )

      if (trace.errorMessage) {
        lines.push(`  Error: ${truncate(trace.errorMessage, 120)}`)
      }

      if (index < logsResults.length) {
        const logs = logsResults[index]!.data
        if (logs.length > 0) {
          lines.push(`  Logs (${logs.length}):`)
          for (const log of logs.slice(0, 5)) {
            const timestamp = String(log.timestamp)
            const time = timestamp.split(" ")[1] ?? timestamp
            const severity = (log.severityText || "INFO").padEnd(5)
            lines.push(`    ${time} [${severity}] ${truncate(log.body, 90)}`)
          }
          if (logs.length > 5) {
            lines.push(`    ... and ${logs.length - 5} more`)
          }
        }
      }

      lines.push("")
    }

    return {
      tool: "error_detail",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: st, end: et },
        errorType: error_type,
        traces: traces.map((trace, index) => ({
          traceId: trace.traceId,
          rootSpanName: trace.rootSpanName,
          durationMs: Number(trace.durationMicros) / 1000,
          spanCount: Number(trace.spanCount),
          services: trace.services,
          startTime: String(trace.startTime),
          errorMessage: trace.errorMessage || undefined,
          logs: (index < logsResults.length ? logsResults[index]!.data.slice(0, 5) : []).map((log) => ({
            timestamp: String(log.timestamp),
            severityText: log.severityText || "INFO",
            body: log.body,
          })),
        })),
      },
    }
  })

export const executeListMetricsTool = (
  { start_time, end_time, service, search, metric_type, limit }: Schema.Schema.Type<typeof ListMetricsToolInput>,
): Effect.Effect<ListMetricsToolOutput, McpToolError, TinybirdToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = start_time ?? startTime
    const et = end_time ?? endTime

    const [metricsResult, summaryResult] = yield* Effect.all(
      [
        queryTinybird("list_metrics", {
          start_time: st,
          end_time: et,
          service,
          search,
          metric_type,
          limit: limit ?? 50,
        }),
        queryTinybird("metrics_summary", {
          start_time: st,
          end_time: et,
          service,
        }),
      ],
      { concurrency: "unbounded" },
    )

    const metrics = metricsResult.data
    const summary = summaryResult.data

    const lines: string[] = [
      "=== Available Metrics ===",
      `Time range: ${st} — ${et}`,
    ]

    if (summary.length > 0) {
      lines.push("")
      for (const entry of summary) {
        lines.push(
          `  ${entry.metricType}: ${formatNumber(entry.metricCount)} metrics, ${formatNumber(entry.dataPointCount)} data points`,
        )
      }
    }

    if (metrics.length === 0) {
      lines.push("", "No metrics found matching filters.")
    } else {
      lines.push("", `Metrics (${metrics.length}):`, "")
      lines.push(
        formatTable(
          ["Name", "Type", "Service", "Unit", "Data Points"],
          metrics.map((metricRow) => [
            metricRow.metricName.length > 40 ? metricRow.metricName.slice(0, 37) + "..." : metricRow.metricName,
            metricRow.metricType,
            metricRow.serviceName,
            metricRow.metricUnit || "-",
            formatNumber(metricRow.dataPointCount),
          ]),
        ),
      )
    }

    return {
      tool: "list_metrics",
      summaryText: summaryText(lines),
      data: {
        timeRange: { start: st, end: et },
        summary: summary.map((entry) => ({
          metricType: entry.metricType,
          metricCount: Number(entry.metricCount),
          dataPointCount: Number(entry.dataPointCount),
        })),
        metrics: metrics.map((metricRow) => ({
          metricName: metricRow.metricName,
          metricType: metricRow.metricType,
          serviceName: metricRow.serviceName,
          metricUnit: metricRow.metricUnit || "",
          dataPointCount: Number(metricRow.dataPointCount),
        })),
      },
    }
  })

export const executeQueryDataTool = (
  params: Schema.Schema.Type<typeof QueryDataToolInput>,
): Effect.Effect<QueryDataToolOutput, McpToolError, QueryDataToolExecutorEnvironment> =>
  Effect.gen(function* () {
    const { startTime, endTime } = defaultTimeRange(1)
    const st = params.start_time ?? startTime
    const et = params.end_time ?? endTime

    const query = buildQuerySpec(params)
    if ("error" in query) {
      return yield* Effect.fail(toQueryError(query.error))
    }

    let decodedQuery: QuerySpecType
    try {
      decodedQuery = decodeQuerySpecSync(query.spec)
    } catch (error) {
      return yield* Effect.fail(toQueryError(toInvalidQuerySpecMessage(error)))
    }

    const tenant: TenantContext = yield* resolveToolTenantContext
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
        return yield* Effect.fail(toQueryError(`${tagged._tag}: ${tagged.message}${details}`))
      }

      return yield* Effect.fail(toQueryError(Cause.pretty(exit.cause)))
    }

    return formatQueryDataOutput(
      exit.value,
      params.source,
      params.kind,
      params.metric,
      st,
      et,
      params.group_by,
    )
  })

export const observabilityToolExecutors = {
  system_health: executeSystemHealthTool,
  find_errors: executeFindErrorsTool,
  inspect_trace: executeInspectTraceTool,
  search_logs: executeSearchLogsTool,
  search_traces: executeSearchTracesTool,
  service_overview: executeServiceOverviewTool,
  diagnose_service: executeDiagnoseServiceTool,
  find_slow_traces: executeFindSlowTracesTool,
  error_detail: executeErrorDetailTool,
  list_metrics: executeListMetricsTool,
  query_data: executeQueryDataTool,
} satisfies Record<
  string,
  (...args: never) => Effect.Effect<unknown, McpToolError, ChatToolExecutionEnvironment>
>
