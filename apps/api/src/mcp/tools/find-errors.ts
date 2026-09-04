import {
	optionalNumberParam,
	optionalStringParam,
	optionalTimeParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange } from "@/mcp/lib/time"
import { formatNumber, formatTable, truncate } from "@/mcp/lib/format"
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
			identity: optionalStringParam(
				'Pass "unexpected" to keep only identities that break a no-unknown-errors policy: labels outside `namespace_prefix` (library tags such as `AI.Error`, bare `Error`) plus the 5xx and unexpected-error-envelope markers. Omit for all errors.',
			),
			namespace_prefix: optionalStringParam(
				'The prefix every deliberate, namespaced error tag starts with (default "@maple/"). Only used with identity="unexpected".',
			),
			limit: optionalNumberParam("Max results (default 20)"),
		}),
		Effect.fn("McpTool.findErrors")(function* ({
			start_time,
			end_time,
			service,
			environment,
			identity,
			namespace_prefix,
			limit,
		}) {
			if (identity !== undefined && identity !== "unexpected") {
				return validationError(`Invalid identity: '${identity}'. Pass "unexpected" or omit it.`)
			}
			const { st, et } = resolveTimeRange(start_time, end_time)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				service: service ?? "all",
				identity: identity ?? "all",
			})

			const errors = yield* findErrors({
				timeRange: { startTime: st, endTime: et },
				service: service ?? undefined,
				environment: environment ?? undefined,
				identity: identity ?? undefined,
				namespacePrefix: namespace_prefix ?? undefined,
				limit: limit ?? 20,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("errors_by_type")),
			)

			if (errors.length === 0) {
				const scope = identity === "unexpected" ? "unexpected-identity errors" : "errors"
				return { content: [{ type: "text", text: `No ${scope} found in ${st} — ${et}` }] }
			}

			const lines: string[] = [
				identity === "unexpected" ? `## Unexpected Error Identities` : `## Errors by Type`,
				``,
			]

			// One occurrence's message per row: the same tag can own a dozen fingerprints, and the
			// label alone gave no way to tell them apart short of an error_detail call each.
			const headers = ["Error", "Message", "Fingerprint", "Count", "Affected Services", "Last Seen"]
			const rows = Arr.map(errors, (e) => [
				truncate(e.label, 60),
				truncate(e.sampleMessage.replace(/\s+/g, " ").replace(/\|/g, "\\|"), 80),
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
						identity: identity ?? "all",
						errors: Arr.map(errors, (e) => ({
							fingerprintHash: e.fingerprintHash,
							label: e.label,
							sampleMessage: e.sampleMessage,
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
