import type { StructuredToolOutput } from "@maple/domain"
import type { ReactNode } from "react"
import { DataTable } from "./components/data-table"
import { ErrorList } from "./components/error-list"
import { LogList } from "./components/log-list"
import { MetricsList } from "./components/metrics-list"
import { QueryChart } from "./components/query-chart"
import { SpanTree } from "./components/span-tree"
import { StatCards } from "./components/stat-cards"
import { TraceList } from "./components/trace-list"

function Stack({ children }: { children: ReactNode }) {
	return <div className="space-y-2">{children}</div>
}

function DashboardMutationSummary({
	dashboardName,
	widgetCount,
	changeLabel,
	changeValue,
	changeFormat,
}: {
	dashboardName: string
	widgetCount: number
	changeLabel: string
	changeValue: string | number
	changeFormat: "text" | "number"
}) {
	return (
		<StatCards
			props={{
				cards: [
					{ label: "Dashboard", value: dashboardName, format: "text" },
					{ label: changeLabel, value: changeValue, format: changeFormat },
					{ label: "Widgets", value: widgetCount, format: "number" },
				],
			}}
		/>
	)
}

export function ToolRenderer({ data: output }: { data: StructuredToolOutput }) {
	switch (output.tool) {
		case "search_traces":
			return <TraceList props={{ traces: output.data.traces }} />

		case "find_slow_traces":
			return <TraceList props={{ traces: output.data.traces, stats: output.data.stats }} />

		case "find_errors":
			return (
				<ErrorList
					props={{
						errors: output.data.errors.map((error) => ({
							errorType: error.label,
							count: error.count,
							affectedServices: [],
							lastSeen: error.lastSeen,
						})),
					}}
				/>
			)

		case "error_detail": {
			const traces = output.data.traces ?? []
			const traceRows = traces.map((trace) => ({
				traceId: trace.traceId,
				rootSpanName: trace.rootSpanName,
				durationMs: trace.durationMs,
				spanCount: trace.spanCount,
				services: trace.services,
				hasError: true,
				startTime: trace.startTime,
				errorMessage: trace.errorMessage,
			}))
			const logs = traces.flatMap((trace) =>
				(trace.logs ?? []).map((log) => ({
					timestamp: log.timestamp,
					severityText: log.severityText,
					serviceName: "",
					body: log.body,
					traceId: trace.traceId,
				})),
			)
			return (
				<Stack>
					<TraceList props={{ traces: traceRows }} />
					{logs.length > 0 && <LogList props={{ logs }} />}
				</Stack>
			)
		}

		case "inspect_trace":
			return (
				<Stack>
					<SpanTree props={{ traceId: output.data.traceId, spans: output.data.spans ?? [] }} />
					{(output.data.logs ?? []).length > 0 && (
						<LogList props={{ logs: output.data.logs ?? [] }} />
					)}
				</Stack>
			)

		case "search_logs":
			return <LogList props={{ logs: output.data.logs, totalCount: output.data.totalCount }} />

		case "diagnose_service": {
			const data = output.data
			return (
				<Stack>
					<StatCards
						props={{
							cards: [
								{ label: "Throughput", value: data.health.throughput, format: "number" },
								{ label: "Error Rate", value: data.health.errorRate, format: "percent" },
								{ label: "Error Count", value: data.health.errorCount, format: "number" },
								{ label: "P50", value: data.health.p50Ms, format: "duration" },
								{ label: "P95", value: data.health.p95Ms, format: "duration" },
								{ label: "P99", value: data.health.p99Ms, format: "duration" },
								{ label: "Apdex", value: data.health.apdex, format: "decimal" },
							],
						}}
					/>
					{data.topErrors.length > 0 && (
						<ErrorList
							props={{
								errors: data.topErrors.map((error) => ({
									errorType: error.label,
									count: error.count,
									affectedServices: [data.serviceName],
									lastSeen: data.timeRange.end,
								})),
							}}
						/>
					)}
					{data.recentTraces.length > 0 && <TraceList props={{ traces: data.recentTraces }} />}
					{data.recentLogs.length > 0 && <LogList props={{ logs: data.recentLogs }} />}
				</Stack>
			)
		}

		case "list_metrics":
			return <MetricsList props={{ summary: output.data.summary, metrics: output.data.metrics }} />

		case "query_data": {
			const data = output.data
			const unit = data.unit ?? "number"
			if (data.result.kind === "timeseries") {
				return (
					<QueryChart
						props={{
							data: data.result.data,
							metric: data.metric,
							unit,
							source: data.queryContext?.source ?? "traces",
							groupBy: data.groupBy,
						}}
					/>
				)
			}
			return (
				<DataTable
					props={{
						headers: ["Name", data.metric],
						rows: data.result.data.map((row) => [row.name, String(row.value)]),
						title: `${data.metric} by ${data.groupBy ?? "group"}`,
					}}
				/>
			)
		}

		case "service_map":
			return (
				<DataTable
					props={{
						headers: ["Source", "Target", "Calls", "Errors", "Avg Duration", "Max Duration"],
						rows: output.data.edges.map((edge) => [
							edge.sourceService,
							edge.targetService,
							String(edge.callCount),
							String(edge.errorCount),
							`${edge.avgDurationMs.toFixed(1)}ms`,
							`${edge.maxDurationMs.toFixed(1)}ms`,
						]),
						title: `Service Map (${output.data.serviceCount} services, ${output.data.edges.length} edges)`,
					}}
				/>
			)

		case "list_alert_rules":
			return (
				<DataTable
					props={{
						headers: ["Name", "Severity", "Signal", "Threshold", "Enabled"],
						rows: output.data.rules.map((rule) => [
							rule.name,
							rule.severity,
							rule.signalType,
							`${rule.comparator} ${rule.threshold}`,
							rule.enabled ? "Yes" : "No",
						]),
						title: `Alert Rules (${output.data.total})`,
					}}
				/>
			)

		case "list_alert_incidents":
		case "get_incident_timeline":
			return (
				<DataTable
					props={{
						headers: ["Rule", "Severity", "Status", "Signal", "Value", "Triggered"],
						rows: output.data.incidents.map((incident) => [
							incident.ruleName,
							incident.severity,
							incident.status,
							incident.signalType,
							incident.lastObservedValue != null ? String(incident.lastObservedValue) : "—",
							incident.firstTriggeredAt.slice(0, 19),
						]),
						title:
							output.tool === "get_incident_timeline"
								? `Incident Timeline (${output.data.openCount} open, ${output.data.resolvedCount} resolved)`
								: `Alert Incidents (${output.data.openCount} open, ${output.data.resolvedCount} resolved)`,
					}}
				/>
			)

		case "create_alert_rule":
		case "get_alert_rule": {
			const rule = output.data.rule
			return (
				<StatCards
					props={{
						cards: [
							{ label: "Rule", value: rule.name, format: "text" },
							{ label: "Severity", value: rule.severity, format: "text" },
							{ label: "Signal", value: rule.signalType, format: "text" },
							{
								label: "Threshold",
								value: `${rule.comparator} ${rule.threshold}`,
								format: "text",
							},
							{ label: "Window", value: `${rule.windowMinutes}m`, format: "text" },
							...(output.tool === "get_alert_rule"
								? [
										{
											label: "Enabled",
											value: rule.enabled ? "Yes" : "No",
											format: "text" as const,
										},
									]
								: []),
						],
					}}
				/>
			)
		}

		case "list_dashboards":
			return (
				<DataTable
					props={{
						headers: ["ID", "Name", "Widgets", "Updated"],
						rows: output.data.dashboards.map((dashboard) => [
							dashboard.id,
							dashboard.name,
							String(dashboard.widgetCount),
							dashboard.updatedAt.slice(0, 19),
						]),
						title: `Dashboards (${output.data.total})`,
					}}
				/>
			)

		case "get_dashboard": {
			const name = output.data.dashboard.name
			const id = output.data.dashboard.id
			return (
				<StatCards
					props={{
						cards: [
							{ label: "Name", value: typeof name === "string" ? name : "—", format: "text" },
							{ label: "ID", value: typeof id === "string" ? id : "—", format: "text" },
							{
								label: "Widgets",
								value: Array.isArray(output.data.dashboard.widgets)
									? output.data.dashboard.widgets.length
									: 0,
								format: "number",
							},
						],
					}}
				/>
			)
		}

		case "create_dashboard":
		case "update_dashboard": {
			const dashboard = output.data.dashboard
			return (
				<StatCards
					props={{
						cards: [
							{ label: "Dashboard", value: dashboard.name, format: "text" },
							{ label: "ID", value: dashboard.id, format: "text" },
							{ label: "Widgets", value: dashboard.widgetCount, format: "number" },
						],
					}}
				/>
			)
		}

		case "add_dashboard_widget":
			return (
				<DashboardMutationSummary
					dashboardName={output.data.dashboard.name}
					widgetCount={output.data.dashboard.widgetCount}
					changeLabel="Added Widget"
					changeValue={output.data.widgetId}
					changeFormat="text"
				/>
			)

		case "update_dashboard_widget":
			return (
				<DashboardMutationSummary
					dashboardName={output.data.dashboard.name}
					widgetCount={output.data.dashboard.widgetCount}
					changeLabel="Updated Widget"
					changeValue={output.data.widgetId}
					changeFormat="text"
				/>
			)

		case "remove_dashboard_widget":
			return (
				<DashboardMutationSummary
					dashboardName={output.data.dashboard.name}
					widgetCount={output.data.dashboard.widgetCount}
					changeLabel="Removed Widget"
					changeValue={output.data.removedWidgetId}
					changeFormat="text"
				/>
			)

		case "reorder_dashboard_widgets":
			return (
				<DashboardMutationSummary
					dashboardName={output.data.dashboard.name}
					widgetCount={output.data.dashboard.widgetCount}
					changeLabel="Reordered"
					changeValue={output.data.updatedWidgetIds.length}
					changeFormat="number"
				/>
			)

		case "compare_periods":
			return (
				<Stack>
					<StatCards
						props={{
							cards: [
								{
									label: "Current Spans",
									value: output.data.overall.current.totalSpans,
									format: "number",
								},
								{
									label: "Previous Spans",
									value: output.data.overall.previous.totalSpans,
									format: "number",
								},
								{
									label: "Current Error Rate",
									value: output.data.overall.current.errorRate,
									format: "percent",
								},
								{
									label: "Previous Error Rate",
									value: output.data.overall.previous.errorRate,
									format: "percent",
								},
							],
						}}
					/>
					{output.data.services.length > 0 && (
						<DataTable
							props={{
								headers: [
									"Service",
									"Prev Throughput",
									"Curr Throughput",
									"Prev Error Rate",
									"Curr Error Rate",
								],
								rows: output.data.services.map((service) => [
									service.name,
									String(service.previous.throughput),
									String(service.current.throughput),
									`${(service.previous.errorRate * 100).toFixed(2)}%`,
									`${(service.current.errorRate * 100).toFixed(2)}%`,
								]),
								title: "Per-Service Comparison",
							}}
						/>
					)}
				</Stack>
			)

		case "explore_attributes":
			if (output.data.values && output.data.values.length > 0) {
				return (
					<DataTable
						props={{
							headers: ["Value", "Count"],
							rows: output.data.values.map((value) => [value.value, String(value.count)]),
							title: `Attribute Values: ${output.data.key ?? ""}`,
						}}
					/>
				)
			}
			if (output.data.keys && output.data.keys.length > 0) {
				return (
					<DataTable
						props={{
							headers: ["Key", "Count"],
							rows: output.data.keys.map((key) => [key.key, String(key.count)]),
							title: `Attribute Keys (${output.data.source})`,
						}}
					/>
				)
			}
			return (
				<StatCards
					props={{ cards: [{ label: "Source", value: output.data.source, format: "text" }] }}
				/>
			)

		case "list_services":
			return (
				<DataTable
					props={{
						headers: ["Service", "Throughput", "Error Rate", "P95"],
						rows: output.data.services.map((service) => [
							service.name,
							String(service.throughput),
							`${(service.errorRate * 100).toFixed(2)}%`,
							`${service.p95Ms.toFixed(1)}ms`,
						]),
						title: `Services (${output.data.total})`,
					}}
				/>
			)

		case "get_service_top_operations":
			return (
				<DataTable
					props={{
						headers: ["Operation", output.data.metric],
						rows: output.data.operations.map((operation) => [
							operation.name,
							String(operation.value),
						]),
						title: `Top Operations: ${output.data.serviceName} (${output.data.metric})`,
					}}
				/>
			)

		case "inspect_chart_data":
			return (
				<Stack>
					<StatCards
						props={{
							cards: [
								{ label: "Verdict", value: output.data.verdict, format: "text" },
								{ label: "Queries", value: output.data.queries.length, format: "number" },
								{ label: "Flags", value: output.data.flags.length, format: "number" },
							],
						}}
					/>
					<DataTable
						props={{
							headers: ["Query", "Status", "Rows", "Series", "Flags"],
							rows: output.data.queries.map((query) => [
								query.queryName,
								query.status,
								String(query.stats.rowCount),
								String(query.stats.seriesCount),
								query.flags.join(", ") || "—",
							]),
							title: `${output.data.widget.title ?? output.data.widget.id} — ${output.data.widget.endpoint}`,
						}}
					/>
				</Stack>
			)

		case "query_funnel": {
			const first = output.data.steps[0]?.count ?? 0
			const last = output.data.steps[output.data.steps.length - 1]?.count ?? 0
			return (
				<Stack>
					<StatCards
						props={{
							cards: [
								{
									label: "Conversion",
									value: output.data.conversion === null ? "—" : output.data.conversion,
									format: "percent",
								},
								{ label: "Entered", value: first, format: "number" },
								{ label: "Completed", value: last, format: "number" },
								{ label: "Counting", value: output.data.keyBy, format: "text" },
							],
						}}
					/>
					<DataTable
						props={{
							headers: ["#", "Step", "Count", "Of first", "Of previous", "Drop-off"],
							rows: output.data.steps.map((step) => [
								String(step.step),
								step.label,
								String(step.count),
								`${(step.ofFirst * 100).toFixed(1)}%`,
								step.ofPrevious === null ? "—" : `${(step.ofPrevious * 100).toFixed(1)}%`,
								step.step === 1 ? "—" : `-${step.dropOff}`,
							]),
							title: `Funnel · ${output.data.steps.length} steps · within ${output.data.windowSeconds}s`,
						}}
					/>
					{output.data.breakdown ? (
						<DataTable
							props={{
								headers: [
									output.data.breakdown.by,
									...output.data.steps.map((step) => `Step ${step.step}`),
									"Conv.",
								],
								rows: output.data.breakdown.groups.map((group) => [
									group.group === "" ? "(none)" : group.group,
									...group.counts.map((count) => String(count)),
									group.conversion === null
										? "—"
										: `${(group.conversion * 100).toFixed(1)}%`,
								]),
								title: `By ${output.data.breakdown.by}`,
							}}
						/>
					) : null}
				</Stack>
			)
		}

		case "list_product_events":
			return (
				<DataTable
					props={{
						headers: ["Event", "Kind", "Count", "Sessions", "Persons"],
						rows: output.data.events.map((event) => [
							event.eventName,
							event.kind,
							String(event.count),
							String(event.sessions),
							String(event.persons),
						]),
						title: `Product events · ${output.data.events.length}`,
					}}
				/>
			)
	}

	return (
		<StatCards
			props={{ cards: [{ label: "Tool", value: (output as { tool: string }).tool, format: "text" }] }}
		/>
	)
}
