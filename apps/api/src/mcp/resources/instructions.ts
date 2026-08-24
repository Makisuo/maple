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

## Error Issue Lifecycle

\`find_errors\` reads the warehouse; **issues** are the durable, assignable records built on top of
it, and they are what you act on. One issue per error fingerprint, with a workflow state, a lease,
a severity, an append-only timeline, and — when a PR is attached — an automatic post-merge check.

The flow, end to end:

\`\`\`
first occurrences ──> (candidate) ──> issue in \`triage\`
                                          │
        AI investigation runs automatically (if the org enabled it): it writes a
        diagnosis and a severity onto the issue as an \`ai_triage\` timeline event
                                          │
   claim_error_issue ──> \`in_progress\`   (a lease, so two agents don't fix the same bug)
                                          │
   propose_fix (with pr_url) ──> \`in_review\`   (claims it too, if you skipped the step above)
                                          │
                    PR merges ──> \`verifying\`   (Maple watches; nobody acts)
                                          │
        ┌─────────────────────────────────┼──────────────────────────────┐
   fix holds                        still firing                   not enough traffic
   ──> \`done\`, or the verdict       ──> \`in_progress\`,             ──> one longer window,
   posted for a human to close       reopened for another go        then \`in_review\`
   (high/critical never auto-close)
\`\`\`

### The rules that matter

1. **Claiming is how two agents avoid fixing the same bug.** \`claim_error_issue\` takes a 30-minute
   lease and moves \`triage\`/\`todo\` to \`in_progress\`; any later action renews it, and
   \`release_error_issue\` hands it back. You do not have to call it first: \`propose_fix\` and a
   transition to \`in_progress\` both take the lease for you. What you cannot do is work an issue
   somebody else holds — those calls come back as a lease conflict naming the holder.
2. **Read the timeline first.** \`list_error_issue_events\` carries the AI diagnosis (\`ai_triage\`),
   past fix attempts (\`fix_proposed\`), regressions, and prior verdicts
   (\`verification_verdict\`). An issue that has been fixed and regressed is a different problem from
   one nobody has touched, and the timeline is the only place that distinction lives.
3. **Attach the PR.** \`propose_fix\` when you are proposing the work; \`link_pull_request\` when the
   PR already exists. Both link it; only \`propose_fix\` claims the issue and moves it to
   \`in_review\` — from wherever it is, including straight from \`triage\`. You never need to walk
   the state machine by hand to get there.
4. **Do not close an issue you linked a PR to.** The merge opens a verification window sized by the
   issue's severity and its own pre-merge rate, and the verdict moves the issue. Closing it yourself
   throws that check away.
5. **\`regressed\` and \`verifying\` are not yours to set** — \`transition_error_issue\` rejects them.
   Each records something Maple observed, not something you intend.
6. **Severity drives escalation.** \`set_issue_severity\` can page people, and it decides how long a
   verification window runs and whether a \`verified\` verdict may auto-close. Set it from evidence.

### Picking a tool

- \`list_error_issues\` — the work queue. Filter by \`workflow_state\` and \`severity\`.
- \`list_error_issue_events\` — one issue's history. Read before acting.
- \`claim_error_issue\` / \`release_error_issue\` — the lease.
- \`comment_on_error_issue\` — findings that are not yet a fix.
- \`set_issue_severity\` — how bad it is, with a reason.
- \`propose_fix\` / \`link_pull_request\` — attach the fix.
- \`transition_error_issue\` — everything else, e.g. \`wontfix\` with a \`snooze_until\`.

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
- Acting on an error (claiming, fixing, closing): see **Error Issue Lifecycle** above
- Performance analysis: find_slow_traces -> inspect_trace -> get_service_top_operations
- Trend analysis: query_data (timeseries or breakdown)
- Service discovery: list_services -> diagnose_service
- Alert management: list_alert_rules -> get_alert_rule -> create_alert_rule / update_alert_rule / delete_alert_rule -> list_alert_incidents
- Product analytics / conversion: list_product_events -> query_funnel (steps over page views, \`track()\` events and server events, stitched per person; \`breakdown_by\` a UTM/referrer dimension or an event attribute) -> add_dashboard_widget with \`panel_type: "funnel"\` and \`display_json.funnel.steps\` to pin it

## Dashboards

Authoring or editing a dashboard widget? **Call \`describe_dashboard_schema\` first.** It returns
the panel-type table, the four data-source kinds with worked examples, the unit vocabulary, valid
aggregations and group-by tokens per source, the display config, and the raw-SQL conventions —
all generated from the live schema, so unlike a remembered example they cannot be stale.

Three things worth knowing before you get there, because each one fails silently:

1. **A data source is a \`kind\`-discriminated union** (\`query\` | \`raw_sql\` | \`route\` | \`static\`).
   The old \`{ "endpoint": …, "params": … }\` shape is retired and will not decode. A \`query\`
   source spreads \`queries\`/\`formulas\` at the top level and requires \`resultShape\`.
2. **\`percent\` means a 0–1 fraction** (multiplied by 100 on render); \`percent_100\` means 0–100.
   This is inverted from Grafana. The traces \`error_rate\` aggregation returns 0–1, so it pairs
   with \`percent\`. Any other string — \`"ms"\`, \`"%"\`, \`"GB"\` — saves fine and renders as a bare
   number.
3. **\`groupBy\` is ignored unless \`addOns.groupBy\` is \`true\`.** The array being present is not
   enough; the chart quietly shows an ungrouped total.

### Picking a tool

- \`describe_dashboard_schema\` — what a widget can be. Read before writing.
- \`create_dashboard\` — a new board, from a template, a simplified \`widgets\` array, or full JSON.
- \`add_dashboard_widget\` / \`update_dashboard_widget\` / \`remove_dashboard_widget\` — one widget.
  Pass \`panel_type\` (\`line\`, \`bar\`, \`area\`, \`hbar\`, \`pie\`, \`stat\`, \`gauge\`, \`table\`, \`list\`,
  \`histogram\`, \`heatmap\`, \`funnel\`, \`markdown\`); the \`chartId\` and raw-SQL display type follow.
- \`replace_dashboard_widgets\` — rebuild the whole widget list atomically. Prefer it over many
  incremental calls or a full \`dashboard_json\` replace.
- \`reorder_dashboard_widgets\` — layout only.
- \`inspect_chart_data\` — what a widget actually returns. Use it after writing.

### Verification

The mutation tools reject a widget whose query has clauses the engine cannot honor, and one that
cannot render at all (a note wired to a query, a scalar with no \`reduceToValue\`, a list backed by
SQL) — nothing is saved in either case. Softer problems come back as render warnings alongside an
automatic \`inspect_chart_data\` summary. Read the summary; a \`suspicious\` or \`broken\` verdict means
the chart is not showing what you intended. Flags worth knowing: \`EMPTY_GROUPING\` (the group-by
found zero distinct values), \`METRIC_NOT_FOUND\` (the metric name is not in the warehouse, as
distinct from a real metric with no recent data), \`PERCENT_SCALE_MISMATCH\` (the unit and the data
disagree about 0–1 vs 0–100), \`UNIT_MISMATCH\`. \`SUSPICIOUS_GAP\` is informational and never
downgrades a verdict on its own.

Whole-document writes (\`create_dashboard\`/\`update_dashboard\` with \`dashboard_json\`) report the
same problems as warnings but never block — they are the restore path, and a board that predates
a rule still has to round-trip.
`,
	),
})
