import {
	McpQueryError,
	optionalStringParam,
	requiredStringParam,
	type McpToolRegistrar,
	type McpToolResult,
} from "./types"
import { Effect, Schema } from "effect"
import { resolveTenant } from "@/mcp/lib/query-warehouse"
import { DashboardPersistenceService } from "@/services/DashboardPersistenceService"
import { createDualContent } from "@/mcp/lib/structured-output"
import { inspectWidget, type InspectWidgetTimeRange, type RawSqlInspectionData } from "@/mcp/lib/inspect-widget"
import { formatTable, truncate } from "@/mcp/lib/format"
import { resolveDashboardTimeRange, type DashboardTimeRangeInput } from "@/mcp/lib/resolve-dashboard-time-range"
import { resolveTimeRange } from "@/mcp/lib/time"
import type { InspectChartDataData, InspectChartQueryResult } from "@maple/domain"

function formatNumber(value: number | null): string {
	if (value === null) return "null"
	if (!Number.isFinite(value)) return String(value)
	if (Math.abs(value) >= 1000) return value.toFixed(0)
	if (Math.abs(value) >= 1) return value.toFixed(2)
	return value.toFixed(4)
}

function formatQueryBlock(query: InspectChartQueryResult): string {
	const lines: string[] = []
	lines.push(`### Query ${query.queryName} (${query.queryId})`)
	lines.push(`Status: ${query.status}`)
	if (query.builderWarnings && query.builderWarnings.length > 0) {
		lines.push(`Warnings: ${query.builderWarnings.join("; ")}`)
	}
	if (query.status === "error" && query.error) {
		lines.push(`Error: ${query.error}`)
		return lines.join("\n")
	}
	lines.push(`Rows: ${query.stats.rowCount}, Series: ${query.stats.seriesCount}`)
	if (query.stats.firstBucket && query.stats.lastBucket) {
		lines.push(`Time span: ${query.stats.firstBucket} → ${query.stats.lastBucket}`)
	}
	if (query.reducedValue !== undefined) {
		lines.push(`Reduced value: ${formatNumber(query.reducedValue ?? null)}`)
	}
	if (query.stats.seriesStats.length > 0) {
		lines.push(`Series stats:`)
		for (const series of query.stats.seriesStats.slice(0, 10)) {
			lines.push(
				`  - ${series.name}: min=${formatNumber(series.min)} max=${formatNumber(series.max)} avg=${formatNumber(series.avg)} (valid=${series.validCount}, null=${series.nullCount}, zero=${series.zeroCount})`,
			)
		}
		if (query.stats.seriesStats.length > 10) {
			lines.push(`  … +${query.stats.seriesStats.length - 10} more series`)
		}
	}
	if (query.flags.length > 0) {
		lines.push(`Flags: ${query.flags.join(", ")}`)
	}
	return lines.join("\n")
}

function unsupportedEndpointResult(
	widget: {
		id: string
		visualization: string
		dataSource: {
			endpoint: string
			params?: Record<string, unknown>
			transform?: Record<string, unknown>
		}
		display: { title?: string; unit?: string }
	},
	dashboardName: string,
): McpToolResult {
	const text = [
		`## Widget inspection: ${widget.display.title ?? widget.id}`,
		`Dashboard: ${dashboardName}`,
		`Visualization: ${widget.visualization}`,
		`Endpoint: ${widget.dataSource.endpoint}`,
		``,
		`This endpoint is not yet supported by inspect_chart_data.`,
		`Use the \`query_data\` tool directly to verify, with the params shown below.`,
		``,
		`Widget definition:`,
		JSON.stringify(
			{
				endpoint: widget.dataSource.endpoint,
				params: widget.dataSource.params,
				transform: widget.dataSource.transform,
			},
			null,
			2,
		),
	].join("\n")

	return { content: [{ type: "text" as const, text }] }
}

function rawSqlCell(value: unknown): string {
	if (value === null || value === undefined) return "null"
	if (typeof value === "object") return truncate(JSON.stringify(value), 60)
	return truncate(String(value), 60)
}

function renderRawSqlInspection(
	data: RawSqlInspectionData,
	widget: { id: string; visualization: string; display: { title?: string } },
	dashboardName: string,
): string {
	const lines: string[] = [
		`## Widget inspection: ${widget.display.title ?? widget.id}`,
		`Dashboard: ${dashboardName}`,
		`Visualization: ${widget.visualization} | Endpoint: ${data.endpoint}`,
		`Time range: ${data.timeRange.startTime} → ${data.timeRange.endTime} (source: ${data.timeRange.source})`,
		``,
	]

	if (data.status === "error") {
		lines.push(`### Verdict: BROKEN`)
		lines.push(`Error: ${data.error ?? "unknown error"}`)
		lines.push(``)
		lines.push(`Fix the SQL via update_dashboard_widget and re-run inspect_chart_data to verify.`)
		return lines.join("\n")
	}

	lines.push(`### Verdict: ${data.rowCount === 0 ? "SUSPICIOUS (no rows)" : "OK"}`)
	lines.push(
		`Rows: ${data.rowCount}${data.truncated ? ` (showing first ${data.rows.length})` : ""} | Columns: ${data.columns.length}`,
	)
	lines.push(``)

	if (data.rowCount === 0) {
		lines.push("Query executed successfully but returned no rows. Check filters and the time range.")
	} else {
		lines.push(
			formatTable(
				[...data.columns],
				data.rows.map((row) => data.columns.map((col) => rawSqlCell(row[col]))),
			),
		)
		if (data.truncated) lines.push(``, `… +${data.rowCount - data.rows.length} more rows`)
	}
	return lines.join("\n")
}

function renderInspectionMarkdown(data: InspectChartDataData, dashboardName: string): string {
	const lines: string[] = []
	lines.push(`## Widget inspection: ${data.widget.title ?? data.widget.id}`)
	lines.push(`Dashboard: ${dashboardName}`)
	lines.push(`Visualization: ${data.widget.visualization} | Endpoint: ${data.widget.endpoint}`)
	if (data.widget.displayUnit) lines.push(`Display unit: ${data.widget.displayUnit}`)
	lines.push(
		`Time range: ${data.timeRange.startTime} → ${data.timeRange.endTime} (source: ${data.timeRange.source})`,
	)
	lines.push(``)
	lines.push(`### Verdict: ${data.verdict.toUpperCase()}`)
	if (data.flags.length > 0) {
		lines.push(`Flags: ${data.flags.join(", ")}`)
	} else {
		lines.push(`No issues detected.`)
	}
	lines.push(``)
	for (const query of data.queries) {
		lines.push(formatQueryBlock(query))
		lines.push(``)
	}
	if (data.notes.length > 0) {
		lines.push(`### Notes`)
		for (const note of data.notes) lines.push(`- ${note}`)
	}
	if (data.verdict !== "looks_healthy") {
		lines.push(``)
		lines.push(
			`### Next step\nVerdict is '${data.verdict}'. Refine the widget via update_dashboard_widget and re-run inspect_chart_data to verify.`,
		)
	}
	return lines.join("\n")
}

const inspectChartDataDescription =
	"Inspect the actual data a dashboard chart will render. " +
	"The mutation tools (`create_dashboard`, `add_dashboard_widget`, `update_dashboard_widget`) now run this validation automatically. " +
	"Use this tool to re-verify a widget after fixing it, or to inspect any existing widget on demand. " +
	"Returns row counts, series statistics, sample data points, and sanity flags (EMPTY, ALL_ZEROS, FLAT_LINE, UNIT_MISMATCH, NEGATIVE_VALUES, UNREALISTIC_MAGNITUDE, SINGLE_SERIES_DOMINATES, CARDINALITY_EXPLOSION, SUSPICIOUS_GAP, BROKEN_BREAKDOWN, SINGLE_POINT, ALL_NULLS, BUILDER_WARNINGS). " +
	"The verdict is one of `looks_healthy`, `suspicious`, or `broken`. **If the verdict is not `looks_healthy`, fix the widget via update_dashboard_widget and re-inspect.** " +
	"Supports custom_query_builder_timeseries, custom_query_builder_breakdown, and raw_sql_chart widgets (raw SQL is executed and its rows returned). " +
	"Limitations: formula expressions in `formulas[]` are NOT evaluated server-side — only the base queries are inspected; " +
	"checks only the requested window without the dashboard UI's auto-fallback. For other predefined-endpoint widgets (service_overview, errors_summary, etc.), this tool returns guidance to use `query_data` directly with the widget's params."

export function registerInspectChartDataTool(server: McpToolRegistrar) {
	server.tool(
		"inspect_chart_data",
		inspectChartDataDescription,
		Schema.Struct({
			dashboard_id: requiredStringParam("Dashboard ID containing the widget"),
			widget_id: requiredStringParam("Widget ID to inspect"),
			start_time: optionalStringParam(
				"Override start time (YYYY-MM-DD HH:mm:ss UTC or ISO 8601). Defaults to the dashboard's configured timeRange.",
			),
			end_time: optionalStringParam(
				"Override end time (YYYY-MM-DD HH:mm:ss UTC or ISO 8601). Defaults to the dashboard's configured timeRange.",
			),
		}),
		Effect.fn("McpTool.inspectChartData")(function* ({ dashboard_id, widget_id, start_time, end_time }) {
			const tenant = yield* resolveTenant
			const persistence = yield* DashboardPersistenceService

			const list = yield* persistence.list(tenant.orgId).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: error.message,
							pipeName: "inspect_chart_data",
							cause: error,
						}),
				),
			)

			const dashboard = list.dashboards.find((d) => d.id === dashboard_id)
			if (!dashboard) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Dashboard not found: ${dashboard_id}. Use list_dashboards to discover valid IDs.`,
						},
					],
				}
			}

			const widget = dashboard.widgets.find((w) => w.id === widget_id)
			if (!widget) {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Widget not found: ${widget_id} in dashboard ${dashboard_id}. Use get_dashboard to list widget IDs.`,
						},
					],
				}
			}

			let timeRange: InspectWidgetTimeRange
			if (start_time && end_time) {
				const range = resolveTimeRange(start_time, end_time)
				timeRange = { startTime: range.st, endTime: range.et, source: "override" }
			} else {
				// A widget pinned to its own window is inspected on that window —
				// otherwise the rows returned here aren't the rows the tile renders.
				const source = widget.timeRange ? ("widget" as const) : ("dashboard" as const)
				const resolved = resolveDashboardTimeRange(
					(widget.timeRange ?? dashboard.timeRange) as DashboardTimeRangeInput,
				)
				if (resolved) {
					timeRange = {
						startTime: resolved.startTime,
						endTime: resolved.endTime,
						source,
					}
				} else {
					const fallback = resolveTimeRange(undefined, undefined, 6)
					timeRange = { startTime: fallback.st, endTime: fallback.et, source: "fallback" }
				}
			}

			const outcome = yield* inspectWidget({
				tenant,
				dashboardName: dashboard.name,
				widget,
				timeRange,
			})

			if (outcome.kind === "unsupported") {
				return unsupportedEndpointResult(
					{
						id: widget.id,
						visualization: widget.visualization,
						dataSource: {
							endpoint: widget.dataSource.endpoint,
							...(widget.dataSource.params && {
								params: widget.dataSource.params as Record<string, unknown>,
							}),
							...(widget.dataSource.transform && {
								transform: widget.dataSource.transform as Record<string, unknown>,
							}),
						},
						display: {
							...(widget.display.title !== undefined && { title: widget.display.title }),
							...(widget.display.unit !== undefined && { unit: widget.display.unit }),
						},
					},
					dashboard.name,
				)
			}

			if (outcome.kind === "raw_sql") {
				return {
					content: createDualContent(
						renderRawSqlInspection(
							outcome.data,
							{
								id: widget.id,
								visualization: widget.visualization,
								display: {
									...(widget.display.title !== undefined && {
										title: widget.display.title,
									}),
								},
							},
							dashboard.name,
						),
						{
							tool: "run_sql",
							data: {
								expandedSql: outcome.data.expandedSql ?? outcome.data.sql,
								rowCount: outcome.data.rowCount,
								columns: outcome.data.columns,
								rows: outcome.data.rows,
								truncated: outcome.data.truncated,
								timeRange: {
									start: outcome.data.timeRange.startTime,
									end: outcome.data.timeRange.endTime,
								},
							},
						},
					),
				}
			}

			if (outcome.kind === "skipped") {
				return {
					isError: true,
					content: [{ type: "text" as const, text: outcome.detail }],
				}
			}

			if (outcome.kind === "inspection_error") {
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Inspection failed unexpectedly: ${outcome.message}`,
						},
					],
				}
			}

			return {
				content: createDualContent(renderInspectionMarkdown(outcome.data, dashboard.name), {
					tool: "inspect_chart_data",
					data: outcome.data,
				}),
			}
		}),
	)
}
