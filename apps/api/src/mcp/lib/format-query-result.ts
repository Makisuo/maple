import { formatDurationFromMs, formatNumber, formatPercent, formatTable } from "./format"
import { formatNextSteps } from "./next-steps"
import { createDualContent } from "./structured-output"
import type { McpToolResult } from "../tools/types"
import type { QueryEngineExecuteResponse } from "@maple/query-engine"

export function formatBucket(bucket: string): string {
  const match = bucket.match(/T(\d{2}:\d{2}:\d{2})/)
  return match ? match[1] : bucket.slice(11, 19)
}

export function formatMetricValue(metric: string, value: number): string {
  if (metric.includes("duration")) return formatDurationFromMs(value)
  if (metric === "error_rate") return formatPercent(value)
  return formatNumber(value)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function getNextSteps(
  source: string,
  kind: string,
): string[] {

  if (source === "traces") {
    if (kind === "timeseries") {
      return ["Use `inspect_trace` to drill into a specific trace"]
    }
    return ["Use `search_traces` to find specific traces matching a breakdown entry"]
  }
  if (source === "logs") {
    return ["Use `search_logs` to see individual log entries"]
  }
  // metrics
  return ["Use `explore_attributes` to discover attribute keys for filtering"]
}

export function formatQueryResult(
  toolName: "query_data",
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
    `## ${capitalize(source)} ${capitalize(kind)}: ${metricLabel}`,
    `Time range: ${startTime} — ${endTime}`,
  ]

  if (result.kind === "timeseries") {
    const structuredData = {
      tool: toolName,
      data: {
        timeRange: { start: startTime, end: endTime },
        kind,
        metric: metricLabel,
        groupBy,
        result: {
          kind: "timeseries" as const,
          data: result.data.map((point) => ({
            bucket: point.bucket,
            series: { ...point.series },
          })),
        },
      },
    }

    if (result.data.length === 0) {
      lines.push("", "No data points found.")
      lines.push(formatNextSteps(getNextSteps(source, kind)))
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
    lines.push(formatNextSteps(getNextSteps(source, kind)))
    return { content: createDualContent(lines.join("\n"), structuredData) }
  }

  if (result.kind === "breakdown") {
    const structuredData = {
      tool: toolName,
      data: {
        timeRange: { start: startTime, end: endTime },
        kind,
        metric: metricLabel,
        groupBy,
        result: {
          kind: "breakdown" as const,
          data: result.data.map((item) => ({
            name: item.name,
            value: item.value,
          })),
        },
      },
    }

    if (result.data.length === 0) {
      lines.push("", "No data found.")
      lines.push(formatNextSteps(getNextSteps(source, kind)))
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
    lines.push(formatNextSteps(getNextSteps(source, kind)))
    return { content: createDualContent(lines.join("\n"), structuredData) }
  }

  // list results
  lines.push(`Results: ${result.data.length}`)
  return { content: [{ type: "text", text: lines.join("\n") }] }
}
