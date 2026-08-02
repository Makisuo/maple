import { optionalNumberParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { queryWarehouse, resolveTenant } from "../lib/query-warehouse"
import { resolveTimeRange, rangeExceededResult, MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { clampLimit, clampOffset } from "../lib/limits"
import { formatNumber, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"

export function registerListMetricsTool(server: McpToolRegistrar) {
	server.tool(
		"list_metrics",
		"Discover available custom metrics with their types, units, monotonicity, and data volume. Supports pagination — check hasMore in the response. Use query_data source=metrics with a discovered metric_name and metric_type. For monotonic sum metrics, prefer metric=rate or metric=increase instead of raw sum.",
		Schema.Struct({
			start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			service: optionalStringParam("Filter by service name"),
			search: optionalStringParam("Search in metric name"),
			metric_type: optionalStringParam("Filter by type: sum, gauge, histogram, exponential_histogram"),
			offset: optionalNumberParam(
				"Offset for pagination (default 0). Use nextOffset from previous response.",
			),
			limit: optionalNumberParam("Max results (default 50)"),
		}),
		Effect.fn("McpTool.listMetrics")(function* ({
			start_time,
			end_time,
			service,
			search,
			metric_type,
			offset,
			limit,
		}) {
			const range = resolveTimeRange(start_time, end_time, { maxHours: MCP_DISCOVERY_MAX_HOURS })
			const { st, et } = range
			if (range.exceeded) return rangeExceededResult(range, "list_metrics")
			const lim = clampLimit(limit, { defaultValue: 50, max: 500 })
			const off = clampOffset(offset, { max: 10_000 })
			const tenant = yield* resolveTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: service ?? "all",
				metricType: metric_type ?? "all",
				limit: lim,
				offset: off,
			})

			const [metricsResult, summaryResult] = yield* Effect.all(
				[
					queryWarehouse("list_metrics", {
						start_time: st,
						end_time: et,
						service,
						search,
						metric_type,
						offset: off,
						limit: lim,
					}),
					queryWarehouse("metrics_summary", {
						start_time: st,
						end_time: et,
						service,
					}),
				],
				{ concurrency: "unbounded" },
			)

			const metrics = metricsResult.data
			const summary = summaryResult.data

			yield* Effect.annotateCurrentSpan("result.rowCount", metrics.length)

			const lines: string[] = [`## Available Metrics`, `Time range: ${st} — ${et}`]

			// `metrics_summary` is scoped only by service, NOT by search/metric_type.
			// Printing those totals next to an empty filtered result reads as a
			// contradiction ("47 sum metrics … No metrics found"), so suppress them
			// whenever a narrowing filter matched nothing.
			const hasNarrowingFilter = Boolean(search) || Boolean(metric_type)
			if (summary.length > 0 && (metrics.length > 0 || !hasNarrowingFilter)) {
				lines.push(``)
				for (const s of summary) {
					lines.push(
						`  ${s.metricType}: ${formatNumber(s.metricCount)} metrics, ${formatNumber(s.dataPointCount)} data points`,
					)
				}
			}

			if (metrics.length === 0) {
				const filterDesc = [
					search ? `name contains "${search}"` : null,
					metric_type ? `type=${metric_type}` : null,
					service ? `service=${service}` : null,
				]
					.filter(Boolean)
					.join(", ")
				lines.push(
					``,
					filterDesc
						? `No metrics found matching ${filterDesc} in this time range.`
						: `No metrics found in this time range.`,
				)
				return { content: [{ type: "text", text: lines.join("\n") }] }
			}

			lines.push(``, `Metrics (${metrics.length}):`, ``)

			const headers = ["Name", "Type", "Monotonic", "Service", "Unit", "Data Points"]
			const rows = Arr.map(metrics, (m) => [
				m.metricName.length > 40 ? m.metricName.slice(0, 37) + "..." : m.metricName,
				m.metricType,
				m.isMonotonic ? "yes" : "-",
				m.serviceName,
				m.metricUnit || "-",
				formatNumber(m.dataPointCount),
			])

			lines.push(formatTable(headers, rows))

			const hasMore = metrics.length === lim
			if (hasMore) {
				const nextOffset = off + metrics.length
				lines.push(
					``,
					`More metrics available. Call again with offset=${nextOffset} for the next page.`,
				)
			}

			const nextSteps = Arr.map(Arr.take(metrics, 3), (m) => {
				const suggestedMetric = m.metricType === "sum" && Boolean(m.isMonotonic) ? "rate" : "avg"
				return `\`query_data source="metrics" kind="timeseries" metric_name="${m.metricName}" metric_type="${m.metricType}" metric="${suggestedMetric}"\` — chart this metric`
			})
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "list_metrics",
					data: {
						timeRange: { start: st, end: et },
						pagination: {
							offset: off,
							limit: lim,
							hasMore,
							...(hasMore && { nextOffset: off + metrics.length }),
						},
						summary: Arr.map(summary, (s) => ({
							metricType: s.metricType,
							metricCount: Number(s.metricCount),
							dataPointCount: Number(s.dataPointCount),
						})),
						metrics: Arr.map(metrics, (m) => ({
							metricName: m.metricName,
							metricType: m.metricType,
							serviceName: m.serviceName,
							metricUnit: m.metricUnit || "",
							isMonotonic: Boolean(m.isMonotonic),
							dataPointCount: Number(m.dataPointCount),
						})),
					},
				}),
			}
		}),
	)
}
