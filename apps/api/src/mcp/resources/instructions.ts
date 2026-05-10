import { McpServer } from "effect/unstable/ai"
import { Effect } from "effect"

export const InstructionsResource = McpServer.resource({
	uri: "maple://instructions",
	name: "Maple MCP Usage Guide",
	description: "Cross-cutting rules for using Maple MCP tools effectively",
	audience: ["assistant"] as ReadonlyArray<"user" | "assistant">,
	priority: 1,
	content: Effect.succeed(
		`# Maple MCP Tool Usage Guide

## Time Format
- Always use YYYY-MM-DD HH:mm:ss in UTC
- Default window is 6 hours for most tools, 1 hour for query_data
- Specify explicit time ranges for targeted investigations

## Investigation Workflow
1. Start with \`list_services\` for the big picture (error rates, latency, throughput per service)
2. Use \`find_errors\` or \`find_slow_traces\` to identify issues
3. Drill down with \`error_detail\` or \`inspect_trace\` for root cause
4. Check \`service_map\` for dependency issues
5. Use \`compare_periods\` to detect regressions

## Attribute Filtering
- Call \`explore_attributes\` before filtering by custom attributes
- Prefer service_name filters to narrow results before free-text search
- Common span attributes: http.method, http.route, http.status_code, db.system
- Common resource attributes: service.name, deployment.environment, service.version

## Metrics Queries
- Always call \`list_metrics\` first to discover metric names and types
- For traces: available metrics are count, avg_duration, p50/p95/p99_duration, error_rate, apdex
- For logs: only count is available
- For custom metrics: specify both metric_name and metric_type

## Pagination
- Tools that return lists support pagination via offset parameter
- Check the hasMore field in responses to know if more results exist
- Use nextOffset value to fetch the next page

## Tool Selection Guide
- Error investigation: find_errors -> error_detail -> inspect_trace
- Performance analysis: find_slow_traces -> inspect_trace -> get_service_top_operations
- Trend analysis: query_data (timeseries or breakdown)
- Service discovery: list_services -> diagnose_service
- Alert management: list_alert_rules -> get_alert_rule -> list_alert_incidents

## Dashboard Widget JSON

Read this before submitting raw widget JSON to \`create_dashboard\` (with \`dashboard_json\`), \`add_dashboard_widget\`, or \`update_dashboard_widget\`. The MCP call returns success even when the stored shape will fail at query time — it produces \`Invalid input for getQueryBuilderTimeseries\` only when the widget is rendered. Prefer the simplified \`widgets\` array on \`create_dashboard\` (\`{ title, source, metric, group_by?, service_name?, unit? }\`) when possible — it fills these traps for you.

### Trace queries: required-but-vestigial fields
Every trace query inside \`params.queries[]\` MUST include:
\`\`\`
"metricName": "", "metricType": "gauge", "isMonotonic": false
\`\`\`
They're meaningless for \`dataSource: "traces"\` but the schema requires them.

### whereClause is a custom grammar (NOT SQL)
Operators (the only ones): \`=\`, \`>\`, \`<\`, \`>=\`, \`<=\`, \`contains\`, \`exists\`. Clauses joined by \` AND \` (case-insensitive). Quoted values use double quotes. Keys are lowercased. **There is no \`IS NULL\` / \`IS NOT NULL\`** — use \`<key> exists\` to require an attribute be present.
- Wrong: \`service.name = "ingest" AND maple.signal IS NOT NULL\`
- Right: \`service.name = "ingest" AND maple.signal exists\`

### Valid \`aggregation\` per \`dataSource\`
- traces: \`count\`, \`avg_duration\`, \`p50_duration\`, \`p95_duration\`, \`p99_duration\`, \`error_rate\`
- metrics: \`rate\`, \`increase\`, \`avg\`, \`sum\`, \`count\`, \`min\`, \`max\`, \`p50\`, \`p95\`, \`p99\`
- logs: \`count\`

\`rate\`/\`sum\`/\`increase\` are invalid for traces.

### \`groupBy\` prefix conventions
- traces: unprefixed (\`maple.signal\`, \`service.name\`, \`http.response.status_code\`)
- logs: unprefixed (\`service.name\`, \`severity\`)
- metrics: \`attr.\` prefix (\`attr.signal\`, \`attr.org_id\`)

### \`display.unit\` is mandatory
Always set on chart and stat widgets. Default \`"number"\`. Pick \`duration_ms\` for \`*_duration\`, \`percent\` for \`error_rate\`, \`bytes\`/\`GB\` for sizes.

### Stat widgets need \`reduceToValue\`
For \`visualization: "stat"\`, add to dataSource:
\`\`\`
"transform": { "reduceToValue": { "field": "value", "aggregate": "sum" } }
\`\`\`
Valid aggregates: \`sum | first | count | avg | max | min\`. **No \`last\`.** Without it the stat shows \`[object Object]\`.

### Hiding auxiliary queries on formula charts
\`query.hidden: true\` alone is UI-only. For raw JSON, also add:
\`\`\`
"transform": { "hideSeries": { "baseNames": ["A", "B"] } }
\`\`\`
\`baseNames\` matches each hidden query's \`legend || name\`. Otherwise the auxiliary series render at full scale and skew percent-axis charts.

### Verification
After submitting widget JSON, do NOT trust the success response — verify by calling \`inspect_chart_data\` against the widget, or by loading the dashboard URL and watching for \`Invalid input for getQueryBuilderTimeseries\`. Note: the schema validates structure (\`metricName\`/\`metricType\`) but \`whereClause\` is treated as opaque \`Schema.String\` and unsupported clauses (e.g. SQL \`IS NOT NULL\`) silently degrade to "no filter" at query time without any visible error. Check both traps in the same pass.`,
	),
})
