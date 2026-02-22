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
      "Get an overall health snapshot: error rate, active services, latency stats, and top errors.",
  },
  {
    name: "service_overview",
    description:
      "List all services with health metrics: latency (P50/P95/P99), error rate, and throughput.",
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
    name: "query_data",
    description:
      "Execute structured observability queries against traces, logs, or metrics with timeseries and breakdown support.",
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
