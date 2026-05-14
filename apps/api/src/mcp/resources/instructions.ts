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

### \`groupBy\` only accepts a literal allowlist + \`attr.<key>\` (silent drop trap)
The query-builder does NOT accept arbitrary attribute names directly. Each data source has a small allowlist of named groupings; for anything outside that list you MUST use \`attr.<key>\`. Tokens that aren't recognized are **silently dropped with a warning that never reaches you** — the widget renders as if no groupBy was set (one "all" series), but the legend may still look plausible. This is the single most common reason a "grouped" widget shows a single aggregate bar.

- **traces** — recognized literals: \`service\` / \`service.name\`, \`span\` / \`span.name\`, \`status\` / \`status.code\`, \`http.method\`, \`none\` / \`all\`. Everything else (\`maple.signal\`, \`http.response.status_code\`, \`http.route\`, \`server.address\`, \`error.type\`, \`maple.org_id\`, \`maple.ingest.*\`, etc.) MUST be prefixed: \`attr.maple.signal\`, \`attr.http.response.status_code\`, \`attr.http.route\`, \`attr.server.address\`, \`attr.error.type\`, \`attr.maple.org_id\`, \`attr.maple.ingest.upstream_pool\`, etc.
- **logs** — recognized literals: \`service\` / \`service.name\`, \`severity\`, \`none\` / \`all\`. **No \`attr.*\` support yet** — grouping by arbitrary log attributes is not supported, the token will be silently dropped.
- **metrics** — recognized literals: \`service\` / \`service.name\`, \`none\` / \`all\`. Everything else MUST be prefixed: \`attr.signal\`, \`attr.org_id\`, etc.

Verify groupBy actually applied by running \`inspect_chart_data\` after writing the widget: \`seriesCount > 1\` (and names that look like attribute values, not the literal string \`"all"\`) confirms the breakdown landed. If you see \`seriesCount: 1\` with name \`"all"\`, the groupBy was silently dropped — add the \`attr.\` prefix.

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
After submitting widget JSON, do NOT trust the success response — verify by calling \`inspect_chart_data\` against the widget, or by loading the dashboard URL and watching for \`Invalid input for getQueryBuilderTimeseries\`. Note: the schema validates structure (\`metricName\`/\`metricType\`) but \`whereClause\` is treated as opaque \`Schema.String\` and unsupported clauses (e.g. SQL \`IS NOT NULL\`) silently degrade to "no filter" at query time without any visible error. Check both traps in the same pass.

## Raw SQL Widgets (\`raw_sql_chart\` endpoint)

When you pass \`sql\` to \`add_dashboard_widget\` (or build a widget with \`dataSource.endpoint: "raw_sql_chart"\`), you author ClickHouse SQL directly. The server expands macros and runs the SQL through the warehouse. Use this path when the structured query builder can't express what you need (window functions, multi-step CTEs, unusual aggregations, joins).

### Macros — what gets substituted
- \`$__orgFilter\` → \`OrgId = '<your org>'\` — **REQUIRED**; without it the request is rejected before execution. Org isolation depends on this macro appearing in the SQL.
- \`$__timeFilter(Column)\` → \`Column >= toDateTime('<start>') AND Column <= toDateTime('<end>')\`. \`Column\` must be a bare identifier (letters/digits/underscores/dots) — no expressions. **Prefer this over \`$__startTime\`/\`$__endTime\`** for WHERE clauses.
- \`$__startTime\` / \`$__endTime\` → \`toDateTime('…')\` literals. Use when you need the bound inline somewhere other than a WHERE comparison.
- \`$__interval_s\` → integer bucket size in seconds. Resolved from \`granularity_seconds\` (or auto-derived from the dashboard time range when omitted). **Only interpolate this if your SQL actually buckets time** — otherwise \`granularity_seconds\` is a no-op.

### Safety rules (server-enforced)
- One statement only. Multiple statements separated by \`;\` are rejected.
- Deny-listed keywords (INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, RENAME, ATTACH, DETACH, CREATE, GRANT, REVOKE, OPTIMIZE, SYSTEM, KILL) trigger a \`DisallowedStatement\` error. Comments and string literals are masked first so a SELECT containing the word "drop" in a string is fine.
- \`LIMIT 10000\` is auto-appended when no LIMIT clause is present.

### Tables — discover at call time

Call \`describe_warehouse_tables\` to enumerate every available table; pass \`table: "<name>"\` to get the full column list (with ClickHouse types and jsonPaths), the sorting-key prefix, and curated notes (enum casing, unit warnings, when to use a pre-aggregated table). The tool reads from the live datasource definitions, so it never goes stale.

**Universal conventions that apply to every table**:
- Column names are PascalCase (\`ServiceName\`, \`Timestamp\`, \`StatusCode\`) — never snake_case.
- \`StatusCode\` (spans) and \`SeverityText\` (logs) values are **Title Case** (\`'Error'\`, \`'Ok'\`, \`'Unset'\`, \`'Info'\`, \`'Warn'\`, etc.) — uppercase / lowercase strings silently match zero rows.
- Span \`Duration\` is **nanoseconds** (UInt64). Divide by \`1e6\` for ms, \`1e9\` for seconds.
- Attribute access on Map columns: \`SpanAttributes['http.method']\` — square brackets, string key. Missing keys return \`''\`, not NULL.
- Tables are sorted by some prefix of \`(OrgId, ServiceName, Timestamp)\`. Filter on \`ServiceName\` early to keep queries on the sort-key prefix.

### Result shape per \`display_type\` (what to SELECT)

The renderer is opinionated about column names. Get these wrong and the chart shows empty / \`[object Object]\` / mislabeled axes.

- **line / area / bar (timeseries)** — SELECT a time bucket as the first DateTime column (alias \`bucket\` is conventional but any DateTime-typed first column works) plus one or more **numeric** series columns. The column name becomes the legend label. **String columns are silently dropped**, so for multi-series breakdowns (e.g., one line per service) you must pivot in SQL — the renderer does NOT auto-pivot tall form.
  Single series:
  \`\`\`sql
  SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
         count() AS logs
  FROM logs
  WHERE $__orgFilter AND $__timeFilter(Timestamp)
  GROUP BY bucket
  ORDER BY bucket
  \`\`\`
  Multi-series (wide form via \`countIf\` / \`sumIf\`):
  \`\`\`sql
  SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
         countIf(SeverityText = 'Info')  AS Info,
         countIf(SeverityText = 'Warn')  AS Warn,
         countIf(SeverityText = 'Error') AS Error
  FROM logs
  WHERE $__orgFilter AND $__timeFilter(Timestamp)
  GROUP BY bucket
  ORDER BY bucket
  \`\`\`
  **Wrong** (tall form, collapses to a single aggregate line — the \`ServiceName\` string column is dropped):
  \`\`\`sql
  SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
         ServiceName,
         count() AS requests
  FROM service_overview_spans
  WHERE $__orgFilter AND $__timeFilter(Timestamp)
  GROUP BY bucket, ServiceName
  \`\`\`
  For dynamic series labels (when you don't know the values up-front), discover them first via a separate query — e.g., \`SELECT DISTINCT ServiceName FROM service_overview_spans WHERE $__orgFilter AND $__timeFilter(Timestamp) ORDER BY count() DESC LIMIT 10\` — then build the \`countIf\` columns.

- **stat** — SELECT a single scalar aliased \`value\`. The auto-injected \`reduceToValue\` transform reads \`data[0].value\`; any other alias renders \`[object Object]\`.
  \`\`\`sql
  SELECT count() AS value
  FROM error_spans
  WHERE $__orgFilter AND $__timeFilter(Timestamp)
  \`\`\`

- **pie** — SELECT a \`name\` (string label) column plus at least one numeric column (first numeric wins as the value). Cap to ≤ ~10 slices for readability.
  \`\`\`sql
  SELECT ServiceName AS name, count() AS value
  FROM service_overview_spans
  WHERE $__orgFilter AND $__timeFilter(Timestamp)
  GROUP BY name
  ORDER BY value DESC
  LIMIT 8
  \`\`\`

- **heatmap** — SELECT three columns aliased \`x\`, \`y\`, \`value\`. Cast \`x\`/\`y\` to strings if they're numeric (the renderer treats them as labels).
  \`\`\`sql
  SELECT ServiceName AS x,
         toString(toHour(Timestamp)) AS y,
         count() AS value
  FROM service_overview_spans
  WHERE $__orgFilter AND $__timeFilter(Timestamp)
  GROUP BY x, y
  ORDER BY x, y
  \`\`\`

- **table** — any rows; columns render as-is in the order returned. Use explicit \`AS\` aliases for nice headers.

- **histogram** — SELECT one numeric column aliased \`value\` (one row per observation; the renderer buckets client-side). Cap with a sensible LIMIT.
  \`\`\`sql
  SELECT Duration / 1000000 AS value
  FROM service_overview_spans
  WHERE $__orgFilter AND $__timeFilter(Timestamp)
  LIMIT 5000
  \`\`\`

### \`granularity_seconds\` vs manual bucketing
\`granularity_seconds\` only matters if your SQL references \`$__interval_s\` somewhere (typically inside \`toStartOfInterval\`). Setting it without using the macro is harmless but pointless. Conversely, manual bucketing like \`toStartOfMinute(Timestamp)\` ignores \`granularity_seconds\` entirely. **Pick one**: either \`toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND)\` + \`granularity_seconds\`, or a fixed \`toStartOf*\` and omit \`granularity_seconds\`.

### Common failure modes
- **Wrong case on enum values** (\`'ERROR'\` vs \`'Error'\`, \`'Server'\` vs \`'SERVER'\`) → query runs, returns zero rows, widget renders empty. Always Title Case for \`StatusCode\` / \`SpanKind\` / \`SeverityText\`.
- **Wrong duration unit** → numbers look reasonable but are 1000× off. Span \`Duration\` is **nanoseconds** — divide before showing as ms.
- **Stat alias wrong** → \`SELECT count()\` without \`AS value\` produces \`[object Object]\`.
- **Pie missing \`name\` column** → renderer can't label slices.
- **Timeseries with no DateTime in the first row** → reshape skips and you get raw rows; the chart looks empty. Put the bucket column first OR alias it \`bucket\`.
- **\`Map\` lookup on missing key** returns empty string, not NULL — use \`SpanAttributes['k'] != ''\` not \`IS NOT NULL\`.
- **High-cardinality groupBy** without LIMIT → server appends \`LIMIT 10000\` but the chart still struggles. Always add an explicit \`LIMIT\` for pie/table/heatmap.`,
	),
})
