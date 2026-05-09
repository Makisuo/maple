import type { Spec } from "@json-render/react"
import type { StructuredToolOutput } from "@maple/domain"

let counter = 0
function id(): string {
	return `e${++counter}`
}

function resetCounter() {
	counter = 0
}

type ElementMap = Record<string, { type: string; props: Record<string, unknown>; children?: string[] }>

function addElement(
	elements: ElementMap,
	type: string,
	props: Record<string, unknown>,
	children?: string[],
): string {
	const key = id()
	elements[key] = { type, props, children: children ?? [] }
	return key
}

function buildStack(elements: ElementMap, childKeys: string[]): string {
	return addElement(elements, "Stack", {}, childKeys)
}

export function buildSpec(output: StructuredToolOutput): Spec {
	resetCounter()
	const elements: ElementMap = {}

	switch (output.tool) {
		case "search_traces": {
			const d = output.data
			const root = addElement(elements, "TraceList", {
				traces: d.traces,
			})
			return { root, elements }
		}

		case "find_slow_traces": {
			const d = output.data
			const root = addElement(elements, "TraceList", {
				traces: d.traces,
				stats: d.stats,
			})
			return { root, elements }
		}

		case "find_errors": {
			const d = output.data
			const root = addElement(elements, "ErrorList", {
				errors: d.errors.map((e) => ({
					errorType: e.errorType,
					count: e.count,
					affectedServices: [],
					lastSeen: e.lastSeen,
				})),
			})
			return { root, elements }
		}

		case "error_detail": {
			const d = output.data
			const children: string[] = []
			const traces = d.traces ?? []

			const traceRows = traces.map((t) => ({
				traceId: t.traceId,
				rootSpanName: t.rootSpanName,
				durationMs: t.durationMs,
				spanCount: t.spanCount,
				services: t.services,
				hasError: true,
				startTime: t.startTime,
				errorMessage: t.errorMessage,
			}))
			children.push(addElement(elements, "TraceList", { traces: traceRows }))

			const allLogs = traces.flatMap((t) =>
				(t.logs ?? []).map((l) => ({
					timestamp: l.timestamp,
					severityText: l.severityText,
					serviceName: "",
					body: l.body,
					traceId: t.traceId,
				})),
			)
			if (allLogs.length > 0) {
				children.push(addElement(elements, "LogList", { logs: allLogs }))
			}

			const root = buildStack(elements, children)
			return { root, elements }
		}

		case "inspect_trace": {
			const d = output.data
			const children: string[] = []

			children.push(
				addElement(elements, "SpanTree", {
					traceId: d.traceId,
					spans: d.spans ?? [],
				}),
			)

			if ((d.logs ?? []).length > 0) {
				children.push(addElement(elements, "LogList", { logs: d.logs ?? [] }))
			}

			const root = buildStack(elements, children)
			return { root, elements }
		}

		case "search_logs": {
			const d = output.data
			const root = addElement(elements, "LogList", {
				logs: d.logs,
				totalCount: d.totalCount,
			})
			return { root, elements }
		}

		case "diagnose_service": {
			const d = output.data
			const children: string[] = []

			children.push(
				addElement(elements, "StatCards", {
					cards: [
						{ label: "Throughput", value: d.health?.throughput, format: "number" },
						{ label: "Error Rate", value: d.health?.errorRate, format: "percent" },
						{ label: "Error Count", value: d.health?.errorCount, format: "number" },
						{ label: "P50", value: d.health?.p50Ms, format: "duration" },
						{ label: "P95", value: d.health?.p95Ms, format: "duration" },
						{ label: "P99", value: d.health?.p99Ms, format: "duration" },
						{ label: "Apdex", value: d.health?.apdex, format: "decimal" },
					],
				}),
			)

			if ((d.topErrors ?? []).length > 0) {
				children.push(
					addElement(elements, "ErrorList", {
						errors: (d.topErrors ?? []).map((e) => ({
							errorType: e.errorType,
							count: e.count,
							affectedServices: [d.serviceName],
							lastSeen: d.timeRange.end,
						})),
					}),
				)
			}

			if ((d.recentTraces ?? []).length > 0) {
				children.push(addElement(elements, "TraceList", { traces: d.recentTraces ?? [] }))
			}

			if ((d.recentLogs ?? []).length > 0) {
				children.push(addElement(elements, "LogList", { logs: d.recentLogs ?? [] }))
			}

			const root = buildStack(elements, children)
			return { root, elements }
		}

		case "list_metrics": {
			const d = output.data
			const root = addElement(elements, "MetricsList", {
				summary: d.summary,
				metrics: d.metrics,
			})
			return { root, elements }
		}

		case "query_data": {
			const d = output.data
			const result = d.result
			const unit = d.unit ?? "number"

			if (result.kind === "timeseries") {
				const root = addElement(elements, "QueryChart", {
					data: result.data,
					metric: d.metric,
					unit,
					source: d.queryContext?.source ?? "traces",
					groupBy: d.groupBy,
				})
				return { root, elements }
			}

			// breakdown — format values using unit
			const headers = ["Name", d.metric]
			const rows = result.data.map((row: { name: string; value: number }) => [
				row.name,
				String(row.value),
			])
			const root = addElement(elements, "DataTable", {
				headers,
				rows,
				title: `${d.metric} by ${d.groupBy ?? "group"}`,
			})
			return { root, elements }
		}

		case "service_map": {
			const d = output.data
			const headers = ["Source", "Target", "Calls", "Errors", "Avg Duration", "P95 Duration"]
			const rows = d.edges.map((e) => [
				e.sourceService,
				e.targetService,
				String(e.callCount),
				String(e.errorCount),
				`${e.avgDurationMs.toFixed(1)}ms`,
				`${e.p95DurationMs.toFixed(1)}ms`,
			])
			const root = addElement(elements, "DataTable", {
				headers,
				rows,
				title: `Service Map (${d.serviceCount} services, ${d.edges.length} edges)`,
			})
			return { root, elements }
		}

		case "list_alert_rules": {
			const d = output.data
			const headers = ["Name", "Severity", "Signal", "Threshold", "Enabled"]
			const rows = d.rules.map((r) => [
				r.name,
				r.severity,
				r.signalType,
				`${r.comparator} ${r.threshold}`,
				r.enabled ? "Yes" : "No",
			])
			const root = addElement(elements, "DataTable", {
				headers,
				rows,
				title: `Alert Rules (${d.total})`,
			})
			return { root, elements }
		}

		case "list_alert_incidents": {
			const d = output.data
			const headers = ["Rule", "Severity", "Status", "Signal", "Value", "Triggered"]
			const rows = d.incidents.map((i) => [
				i.ruleName,
				i.severity,
				i.status,
				i.signalType,
				i.lastObservedValue != null ? String(i.lastObservedValue) : "—",
				i.firstTriggeredAt.slice(0, 19),
			])
			const root = addElement(elements, "DataTable", {
				headers,
				rows,
				title: `Alert Incidents (${d.openCount} open, ${d.resolvedCount} resolved)`,
			})
			return { root, elements }
		}

		case "create_alert_rule": {
			const d = output.data
			const r = d.rule
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Rule", value: r.name, format: "text" },
					{ label: "Severity", value: r.severity, format: "text" },
					{ label: "Signal", value: r.signalType, format: "text" },
					{ label: "Threshold", value: `${r.comparator} ${r.threshold}`, format: "text" },
					{ label: "Window", value: `${r.windowMinutes}m`, format: "text" },
				],
			})
			return { root, elements }
		}

		case "list_dashboards": {
			const d = output.data
			const headers = ["ID", "Name", "Widgets", "Updated"]
			const rows = d.dashboards.map((db) => [
				db.id,
				db.name,
				String(db.widgetCount),
				db.updatedAt.slice(0, 19),
			])
			const root = addElement(elements, "DataTable", {
				headers,
				rows,
				title: `Dashboards (${d.total})`,
			})
			return { root, elements }
		}

		case "get_dashboard": {
			const d = output.data
			const db = d.dashboard
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Name", value: db.name ?? "—", format: "text" },
					{ label: "ID", value: db.id ?? "—", format: "text" },
					{
						label: "Widgets",
						value: Array.isArray(db.widgets) ? db.widgets.length : 0,
						format: "number",
					},
				],
			})
			return { root, elements }
		}

		case "create_dashboard": {
			const d = output.data
			const db = d.dashboard
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Dashboard", value: db.name, format: "text" },
					{ label: "ID", value: db.id, format: "text" },
					{ label: "Widgets", value: db.widgetCount, format: "number" },
				],
			})
			return { root, elements }
		}

		case "compare_periods": {
			const d = output.data
			const children: string[] = []

			children.push(
				addElement(elements, "StatCards", {
					cards: [
						{ label: "Current Spans", value: d.overall.current.totalSpans, format: "number" },
						{ label: "Previous Spans", value: d.overall.previous.totalSpans, format: "number" },
						{
							label: "Current Error Rate",
							value: d.overall.current.errorRate,
							format: "percent",
						},
						{
							label: "Previous Error Rate",
							value: d.overall.previous.errorRate,
							format: "percent",
						},
					],
				}),
			)

			if (d.services.length > 0) {
				const headers = [
					"Service",
					"Prev Throughput",
					"Curr Throughput",
					"Prev Error Rate",
					"Curr Error Rate",
				]
				const rows = d.services.map((s) => [
					s.name,
					String(s.previous.throughput),
					String(s.current.throughput),
					`${(s.previous.errorRate * 100).toFixed(2)}%`,
					`${(s.current.errorRate * 100).toFixed(2)}%`,
				])
				children.push(
					addElement(elements, "DataTable", { headers, rows, title: "Per-Service Comparison" }),
				)
			}

			const root = buildStack(elements, children)
			return { root, elements }
		}

		case "explore_attributes": {
			const d = output.data
			if (d.values && d.values.length > 0) {
				const headers = ["Value", "Count"]
				const rows = d.values.map((v) => [v.value, String(v.count)])
				const root = addElement(elements, "DataTable", {
					headers,
					rows,
					title: `Attribute Values: ${d.key ?? ""}`,
				})
				return { root, elements }
			}

			if (d.keys && d.keys.length > 0) {
				const headers = ["Key", "Count"]
				const rows = d.keys.map((k) => [k.key, String(k.count)])
				const root = addElement(elements, "DataTable", {
					headers,
					rows,
					title: `Attribute Keys (${d.source})`,
				})
				return { root, elements }
			}

			const root = addElement(elements, "StatCards", {
				cards: [{ label: "Source", value: d.source, format: "text" }],
			})
			return { root, elements }
		}

		case "list_services": {
			const d = output.data
			const headers = ["Service", "Throughput", "Error Rate", "P95"]
			const rows = d.services.map((s) => [
				s.name,
				String(s.throughput),
				`${(s.errorRate * 100).toFixed(2)}%`,
				`${s.p95Ms.toFixed(1)}ms`,
			])
			const root = addElement(elements, "DataTable", {
				headers,
				rows,
				title: `Services (${d.total})`,
			})
			return { root, elements }
		}

		case "get_service_top_operations": {
			const d = output.data
			const headers = ["Operation", d.metric]
			const rows = d.operations.map((op) => [op.name, String(op.value)])
			const root = addElement(elements, "DataTable", {
				headers,
				rows,
				title: `Top Operations: ${d.serviceName} (${d.metric})`,
			})
			return { root, elements }
		}

		case "get_alert_rule": {
			const d = output.data
			const r = d.rule
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Rule", value: r.name, format: "text" },
					{ label: "Severity", value: r.severity, format: "text" },
					{ label: "Signal", value: r.signalType, format: "text" },
					{ label: "Threshold", value: `${r.comparator} ${r.threshold}`, format: "text" },
					{ label: "Window", value: `${r.windowMinutes}m`, format: "text" },
					{ label: "Enabled", value: r.enabled ? "Yes" : "No", format: "text" },
				],
			})
			return { root, elements }
		}

		case "update_dashboard": {
			const d = output.data
			const db = d.dashboard
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Dashboard", value: db.name, format: "text" },
					{ label: "ID", value: db.id, format: "text" },
					{ label: "Widgets", value: db.widgetCount, format: "number" },
				],
			})
			return { root, elements }
		}

		case "add_dashboard_widget": {
			const d = output.data
			const db = d.dashboard
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Dashboard", value: db.name, format: "text" },
					{ label: "Added Widget", value: d.widgetId, format: "text" },
					{ label: "Widgets", value: db.widgetCount, format: "number" },
				],
			})
			return { root, elements }
		}

		case "update_dashboard_widget": {
			const d = output.data
			const db = d.dashboard
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Dashboard", value: db.name, format: "text" },
					{ label: "Updated Widget", value: d.widgetId, format: "text" },
					{ label: "Widgets", value: db.widgetCount, format: "number" },
				],
			})
			return { root, elements }
		}

		case "remove_dashboard_widget": {
			const d = output.data
			const db = d.dashboard
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Dashboard", value: db.name, format: "text" },
					{ label: "Removed Widget", value: d.removedWidgetId, format: "text" },
					{ label: "Widgets", value: db.widgetCount, format: "number" },
				],
			})
			return { root, elements }
		}

		case "reorder_dashboard_widgets": {
			const d = output.data
			const db = d.dashboard
			const root = addElement(elements, "StatCards", {
				cards: [
					{ label: "Dashboard", value: db.name, format: "text" },
					{ label: "Reordered", value: d.updatedWidgetIds.length, format: "number" },
					{ label: "Widgets", value: db.widgetCount, format: "number" },
				],
			})
			return { root, elements }
		}

		case "get_incident_timeline": {
			const d = output.data
			const headers = ["Rule", "Severity", "Status", "Signal", "Value", "Triggered"]
			const rows = d.incidents.map((i) => [
				i.ruleName,
				i.severity,
				i.status,
				i.signalType,
				i.lastObservedValue != null ? String(i.lastObservedValue) : "—",
				i.firstTriggeredAt.slice(0, 19),
			])
			const root = addElement(elements, "DataTable", {
				headers,
				rows,
				title: `Incident Timeline (${d.openCount} open, ${d.resolvedCount} resolved)`,
			})
			return { root, elements }
		}

		case "inspect_chart_data": {
			const d = output.data
			const children: string[] = []

			children.push(
				addElement(elements, "StatCards", {
					cards: [
						{ label: "Verdict", value: d.verdict, format: "text" },
						{ label: "Queries", value: d.queries.length, format: "number" },
						{ label: "Flags", value: d.flags.length, format: "number" },
					],
				}),
			)

			const headers = ["Query", "Status", "Rows", "Series", "Flags"]
			const rows = d.queries.map((q) => [
				q.queryName,
				q.status,
				String(q.stats.rowCount),
				String(q.stats.seriesCount),
				q.flags.join(", ") || "—",
			])
			children.push(
				addElement(elements, "DataTable", {
					headers,
					rows,
					title: `${d.widget.title ?? d.widget.id} — ${d.widget.endpoint}`,
				}),
			)

			const root = buildStack(elements, children)
			return { root, elements }
		}
	}

	const root = addElement(elements, "StatCards", {
		cards: [{ label: "Tool", value: (output as { tool: string }).tool, format: "text" }],
	})
	return { root, elements }
}
