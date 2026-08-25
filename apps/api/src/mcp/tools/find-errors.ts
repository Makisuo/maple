import { optionalNumberParam, optionalStringParam, optionalTimeParam, type McpToolRegistrar } from "./types"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange } from "@/mcp/lib/time"
import { formatNumber, formatTable } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { findErrors } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@/services/warehouse/WarehouseQueryService"

export function registerFindErrorsTool(server: McpToolRegistrar) {
	server.tool(
		"find_errors",
		// Do not reinstate the old claim that a fingerprint is the "same identity as
		// list_error_issues" — it is not. A fingerprint is a decimal UInt64 hash; an
		// issue id is a UUID. Conflating them was the sole cause of every production
		// error_detail failure.
		"Find and categorize errors by type with counts and affected services. Each error has a stable `fingerprint` (a decimal UInt64) — pass it to error_detail for sample traces. The error-issue tools take an `issue_id` UUID from list_error_issues instead, which is a separate identity.",
		Schema.Struct({
			start_time: optionalTimeParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalTimeParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			service: optionalStringParam("Filter to a specific service"),
			environment: optionalStringParam("Filter by deployment environment (e.g. production, staging)"),
			limit: optionalNumberParam("Max results (default 20)"),
		}),
		Effect.fn("McpTool.findErrors")(function* ({ start_time, end_time, service, environment, limit }) {
			const { st, et } = resolveTimeRange(start_time, end_time)
			const tenant = yield* CurrentMcpTenant

			const errors = yield* findErrors({
				timeRange: { startTime: st, endTime: et },
				service: service ?? undefined,
				environment: environment ?? undefined,
				limit: limit ?? 20,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
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
