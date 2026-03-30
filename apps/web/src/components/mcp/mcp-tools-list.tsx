import { Badge } from "@maple/ui/components/ui/badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@maple/ui/components/ui/card"

const MCP_TOOLS = [
  {
    name: "system_health",
    description:
      "Get system health: error rate, latency, top errors, and per-service breakdown. Pass service_name to scope to one service.",
  },
  {
    name: "diagnose_service",
    description:
      "Deep investigation of a single service: health metrics, top errors, recent logs, slow traces, and Apdex score.",
  },
  {
    name: "find_errors",
    description:
      "Find and categorize errors by type, with counts, affected services, and timestamps.",
  },
  {
    name: "error_detail",
    description:
      "Investigate a specific error type: shows sample traces with metadata and correlated logs.",
  },
  {
    name: "search_traces",
    description:
      "Search and filter traces by service, duration, error status, HTTP method, and more.",
  },
  {
    name: "find_slow_traces",
    description:
      "Find the slowest traces with percentile context (P50, P95 benchmarks).",
  },
  {
    name: "inspect_trace",
    description:
      "Deep-dive into a trace: full span tree with durations and status, plus correlated logs.",
  },
  {
    name: "search_logs",
    description:
      "Search and filter logs by service, severity, time range, or body text.",
  },
  {
    name: "list_metrics",
    description:
      "Discover available metrics with type, service, description, and data point counts.",
  },
  {
    name: "chart_traces",
    description:
      "Generate timeseries or breakdown charts from trace data. Metrics: count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate. Group by: service, span_name, status_code, http_method, attribute, or none.",
  },
  {
    name: "chart_logs",
    description:
      "Generate timeseries or breakdown charts from log data. Metric is always count. Group by: service, severity, or none.",
  },
  {
    name: "chart_metrics",
    description:
      "Generate timeseries or breakdown charts from custom metrics. Requires metric_name and metric_type. Aggregations: avg, sum, min, max, count. Group by: service, attribute, or none.",
  },
  {
    name: "compare_periods",
    description:
      "Compare system health between two time periods to detect regressions. Defaults to comparing the last hour against the previous hour.",
  },
  {
    name: "explore_attributes",
    description:
      "Discover available attribute keys and values for filtering traces and metrics.",
  },
  {
    name: "list_alert_rules",
    description:
      "List configured alert rules with their severity, signal type, and condition.",
  },
  {
    name: "list_alert_incidents",
    description:
      "List triggered alert incidents with their status, severity, and observed values.",
  },
  {
    name: "create_alert_rule",
    description:
      "Create an alert rule from a template (high_error_rate, slow_p95, slow_p99, low_apdex, throughput_drop) or with custom parameters.",
  },
  {
    name: "list_dashboards",
    description:
      "List all dashboards with widget counts and timestamps.",
  },
  {
    name: "get_dashboard",
    description:
      "Retrieve full dashboard configuration with all widgets.",
  },
  {
    name: "create_dashboard",
    description:
      "Create a dashboard from a template (service_health, error_tracking, blank) or custom JSON.",
  },
] as const

export function McpToolsList() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Available Tools</CardTitle>
          <Badge variant="secondary">{MCP_TOOLS.length}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {MCP_TOOLS.map((tool) => (
            <div key={tool.name} className="flex gap-3">
              <code className="text-xs font-medium shrink-0 pt-0.5">
                {tool.name}
              </code>
              <p className="text-muted-foreground text-xs">
                {tool.description}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
