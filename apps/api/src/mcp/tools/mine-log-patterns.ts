import { optionalNumberParam, optionalStringParam, McpQueryError, type McpToolRegistrar } from "./types"
import { resolveTenant } from "../lib/query-tinybird"
import { resolveTimeRange, formatClampNote } from "../lib/time"
import { truncate, formatNumber } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { mineLogPatterns } from "@maple/query-engine/observability"
import { makeTinybirdExecutorFromTenant } from "@/services/TinybirdExecutorLive"

export function registerMineLogPatternsTool(server: McpToolRegistrar) {
	server.tool(
		"mine_log_patterns",
		"Cluster log messages into templates (e.g. 'GET /api/users/<*> 200 in <*>ms') with counts. Use this when search_logs would return too many rows to be useful — pattern mining collapses N matched logs into K distinct templates plus a per-template severity/service breakdown. Pair with a tight time range and selective filters: this samples up to 10 000 recent logs from the matched set, so a wide range with no filters will scan a lot of data.",
		Schema.Struct({
			start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			service: optionalStringParam("Filter by service name"),
			severity: optionalStringParam(
				"Filter by severity (TRACE/DEBUG/INFO/WARN/ERROR/FATAL — case-insensitive)",
			),
			search: optionalStringParam("Search substring in log body before clustering"),
			trace_id: optionalStringParam("Filter by trace ID"),
			sample_size: optionalNumberParam(
				"Max logs to sample for clustering (default 10000, max 50000). Larger samples find rarer templates but cost more.",
			),
			limit: optionalNumberParam("Max patterns to return (default 50)"),
		}),
		Effect.fn("McpTool.mineLogPatterns")(function* ({
			start_time,
			end_time,
			service,
			severity,
			search,
			trace_id,
			sample_size,
			limit,
		}) {
			const range = resolveTimeRange(start_time, end_time, { maxHours: 24 })
			const { st, et } = range
			const sampleSize = Math.min(Math.max(Number(sample_size) || 10_000, 1), 50_000)
			const lim = Math.min(Math.max(Number(limit) || 50, 1), 200)
			const tenant = yield* resolveTenant

			const result = yield* mineLogPatterns({
				timeRange: { startTime: st, endTime: et },
				service: service ?? undefined,
				severity: severity ?? undefined,
				search: search ?? undefined,
				traceId: trace_id ?? undefined,
				sampleSize,
				limit: lim,
			}).pipe(
				Effect.provide(makeTinybirdExecutorFromTenant(tenant)),
				Effect.mapError((e) => new McpQueryError({ message: e.message, pipe: "list_logs" })),
			)

			if (result.patterns.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No logs found to cluster in ${st} — ${et}${formatClampNote(range)}`,
						},
					],
				}
			}

			const lines: string[] = [
				`## Log Patterns (${result.patterns.length} templates from ${formatNumber(result.totalSampled)} sampled logs)`,
				`Time range: ${st} — ${et}${formatClampNote(range)}`,
			]

			const filters: string[] = []
			if (service) filters.push(`service=${service}`)
			if (severity) filters.push(`severity=${severity}`)
			if (search) filters.push(`search="${search}"`)
			if (trace_id) filters.push(`trace_id=${trace_id}`)
			if (filters.length > 0) lines.push(`Filters: ${filters.join(", ")}`)
			lines.push(``)

			for (const p of result.patterns) {
				const sev = topKey(p.severityCounts)
				const svc = topKey(p.serviceCounts)
				lines.push(
					`${String(p.count).padStart(6)} ${sev.padEnd(5)} ${svc}: ${truncate(p.template, 140)}`,
				)
			}

			const nextSteps: string[] = []
			const errorPattern = result.patterns.find(
				(p) => Object.keys(p.severityCounts).some((k) => k.toUpperCase() === "ERROR" || k.toUpperCase() === "FATAL"),
			)
			if (errorPattern) {
				nextSteps.push(
					`\`search_logs severity="ERROR" service="${topKey(errorPattern.serviceCounts)}"\` — drill into matching error logs`,
				)
			}
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "mine_log_patterns",
					data: {
						timeRange: { start: st, end: et },
						totalSampled: result.totalSampled,
						sampleSize: result.sampleSize,
						patterns: result.patterns.map((p) => ({ ...p })),
					},
				}),
			}
		}),
	)
}

const topKey = (counts: Record<string, number>): string => {
	let best = ""
	let bestN = -1
	for (const [k, v] of Object.entries(counts)) {
		if (v > bestN) {
			best = k
			bestN = v
		}
	}
	return best || "unknown"
}
