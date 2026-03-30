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
      "Get system health snapshot: error rate, latency percentiles (P50/P95), top errors, per-service breakdown, and data volume. Best starting point for any investigation.",
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
      "Search traces by service, duration, error status, HTTP method, span name, or custom attributes (e.g. user.id).",
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
    name: "query_data",
    description:
      "Query timeseries or breakdown data from traces, logs, or metrics. Supports attribute filtering, environment/commit comparison, and apdex.",
  },
  {
    name: "service_map",
    description:
      "Show service-to-service dependencies with call counts, error rates, and latency per edge.",
  },
  {
    name: "compare_periods",
    description:
      "Compare system health between two time periods to detect regressions. Flags error_rate_up, latency_up, throughput_drop automatically.",
  },
  {
    name: "explore_attributes",
    description:
      "Discover attribute keys/values for traces and metrics. Also discover environments and commit SHAs (source=services).",
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
