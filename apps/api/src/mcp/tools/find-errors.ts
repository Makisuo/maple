import { optionalNumberParam, optionalStringParam, type McpToolRegistrar } from "./types"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { resolveTenant } from "../lib/query-warehouse"
import { resolveTimeRange } from "../lib/time"
import { formatNumber, formatTable } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "../lib/structured-output"
import { findErrors } from "@maple/query-engine/observability"
import { makeWarehouseExecutorFromTenant } from "@/lib/WarehouseQueryService"

export function registerFindErrorsTool(server: McpToolRegistrar) {
	server.tool(
		"find_errors",
		"Find and categorize errors by type with counts and affected services. Each error has a stable `fingerprint` id — pass it to error_detail for sample traces, or to the error-issue tools (same identity as list_error_issues).",
		Schema.Struct({
			start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			service: optionalStringParam("Filter to a specific service"),
			environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
			limit: optionalNumberParam("Max results (default 20)"),
		}),
		Effect.fn("McpTool.findErrors")(function* ({ start_time, end_time, service, environment, limit }) {
			const { st, et } = yield* resolveTimeRange(start_time, end_time)
			const tenant = yield* resolveTenant

			const errors = yield* findErrors({
				timeRange: { startTime: st, endTime: et },
				service: service ?? undefined,
				environment: environment ?? undefined,
				limit: limit ?? 20,
			}).pipe(
				Effect.provide(makeWarehouseExecutorFromTenant(tenant)),
				Effect.mapError(toMcpQueryError("errors_by_type")),
			)

			if (errors.length === 0) {
				return { content: [{ type: "text", text: `No errors found in ${st} — ${et}` }] }
			}

			const lines: string[] = [`## Errors by Type`, ``]

			const headers = ["Error", "Fingerprint", "Count", "Affected Services", "Last Seen"]
			const rows = Arr.map(errors, (e) => [
				e.label.length > 60 ? e.label.slice(0, 57) + "..." : e.label,
				e.fingerprintHash,
				formatNumber(e.count),
				String(e.affectedServicesCount),
				e.lastSeen,
			])

			lines.push(formatTable(headers, rows))
			lines.push(``, `Total: ${errors.length} error types`)

			const nextSteps: string[] = []
			for (const e of Arr.take(errors, 3)) {
				nextSteps.push(
					`\`error_detail fingerprint="${e.fingerprintHash}"\` — see sample traces and logs for "${e.label}"`,
				)
			}
			nextSteps.push(
				'`query_data source="traces" kind="timeseries" metric="error_rate"` — chart error rate trend',
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "find_errors",
					data: {
						timeRange: { start: st, end: et },
						errors: Arr.map(errors, (e) => ({
							fingerprintHash: e.fingerprintHash,
							label: e.label,
							count: e.count,
							affectedServicesCount: e.affectedServicesCount,
							lastSeen: e.lastSeen,
						})),
					},
				}),
			}
		}),
	)
}
