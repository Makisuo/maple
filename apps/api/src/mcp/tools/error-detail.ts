import {
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	optionalTimeParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { resolveTimeRange } from "@/mcp/lib/time"
import { formatDurationFromMs, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { toMcpQueryError } from "@/mcp/lib/map-warehouse-error"
import { Array as Arr, Effect, Schema } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { errorDetail } from "@maple/query-engine/observability"
import { provideWarehouseExecutorFromTenant } from "@/services/warehouse/WarehouseQueryService"

/**
 * A FingerprintHash is a ClickHouse UInt64 rendered as a decimal string. It is NOT
 * the id of an error ISSUE — that is a Postgres UUID, a different identity space —
 * and it is not hex.
 *
 * The distinction is load-bearing: `list_error_issues` renders issue ids, and agents
 * were pasting those (and `alert:<uuid>:<scope>` incident ids) straight into this
 * tool. The value reached `toUInt64()` inside the SQL and came back as a raw
 * ClickHouse parse error, which is unactionable — every `error_detail` failure in
 * production had this one cause. Reject it here, where we can name the right tool.
 */
const isFingerprintHash = (value: string): boolean => /^\d{1,20}$/.test(value)

const rejectNonFingerprint = (rawFingerprint: string) => {
	if (rawFingerprint.startsWith("alert:")) {
		return validationError(
			`'${rawFingerprint}' is an alert incident id, not an error fingerprint. error_detail only covers fingerprint-grouped errors.`,
			`list_alert_incidents  — find the incident\n  get_incident_timeline incident_id="${rawFingerprint}"  — its timeline`,
		)
	}
	return validationError(
		`Invalid fingerprint: '${rawFingerprint}'. A fingerprint is a decimal number (a UInt64 hash), e.g. "11640295108927840024" — not hex and not a UUID. ` +
			`Issue ids from list_error_issues are UUIDs in a different identity space and cannot be used here.`,
		`find_errors  — lists errors with their fingerprint\n  error_detail fingerprint="11640295108927840024"`,
	)
}

export function registerErrorDetailTool(server: McpToolRegistrar) {
	server.tool(
		"error_detail",
		"Get sample traces and correlated logs for a specific error, identified by its `fingerprint` (a decimal UInt64 from find_errors). Optionally include a timeseries to see if the error is getting worse. Use inspect_trace on a trace_id for the full span tree.",
		Schema.Struct({
			fingerprint: requiredStringParam(
				'The error FingerprintHash from find_errors — a decimal UInt64 string, e.g. "11640295108927840024". Not a list_error_issues issue id (those are UUIDs).',
			),
			start_time: optionalTimeParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalTimeParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			service: optionalStringParam("Filter by service name"),
			include_timeseries: optionalBooleanParam(
				"Include error count over time to see if the error is trending up or down",
			),
			limit: optionalNumberParam("Max sample traces (default 5)"),
		}),
		Effect.fn("McpTool.errorDetail")(function* ({
			fingerprint,
			start_time,
			end_time,
			service,
			include_timeseries,
			limit,
		}) {
			if (!isFingerprintHash(fingerprint)) return rejectNonFingerprint(fingerprint)

			const { st, et } = resolveTimeRange(start_time, end_time)
			const tenant = yield* CurrentMcpTenant

			const result = yield* errorDetail({
				fingerprintHash: fingerprint,
				timeRange: { startTime: st, endTime: et },
				service: service ?? undefined,
				includeTimeseries: include_timeseries ?? false,
				limit: limit ?? 5,
			}).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("error_detail_traces")),
			)

			if (result.traces.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No traces found for error fingerprint "${fingerprint}" in ${st} — ${et}`,
						},
					],
				}
			}

			const lines: string[] = [
				`## Error Detail: fingerprint ${fingerprint}`,
				`Time range: ${st} — ${et}`,
				`Sample traces: ${result.traces.length}`,
				``,
			]

			for (let i = 0; i < result.traces.length; i++) {
				const t = result.traces[i]!
				lines.push(
					`### Trace ${i + 1}: ${t.traceId.slice(0, 16)}...`,
					`  Root span: ${t.rootSpanName}`,
					`  Duration: ${formatDurationFromMs(t.durationMs)}`,
					`  Spans: ${t.spanCount}`,
					`  Services: ${t.services.join(", ")}`,
					`  Time: ${t.startTime}`,
				)
				// The failing span first: name, service, status and the attributes that say what it
				// was doing. That is the line an investigator needs; the logs below are context.
				if (t.errorSpan) {
					lines.push(
						`  Error span: ${t.errorSpan.name} — ${t.errorSpan.serviceName}  span=${t.errorSpan.spanId}`,
					)
					if (t.errorSpan.statusMessage) {
						lines.push(`    Status: "${truncate(t.errorSpan.statusMessage, 160)}"`)
					}
					const attrs = Object.entries(t.errorSpan.attributes)
					if (attrs.length > 0) {
						lines.push(`    {${attrs.map(([k, v]) => `${k}=${truncate(v, 60)}`).join(", ")}}`)
					}
				} else if (t.errorMessage) {
					lines.push(`  Error: ${truncate(t.errorMessage, 120)}`)
				}
				if (t.logs.length > 0) {
					lines.push(`  Logs (${t.logs.length}):`)
					for (const log of t.logs) {
						const time = log.timestamp.split(" ")[1] ?? log.timestamp
						const sev = log.severityText.padEnd(5)
						lines.push(`    ${time} [${sev}] ${truncate(log.body, 90)}`)
					}
				}
				lines.push(``)
			}

			if (result.timeseries && result.timeseries.length > 0) {
				lines.push(`### Error Trend`)
				for (const point of result.timeseries) {
					const time = point.bucket.includes("T")
						? point.bucket.slice(11, 19)
						: (point.bucket.split(" ")[1] ?? point.bucket)
					lines.push(`  ${time}: ${point.count} errors`)
				}
				lines.push(``)
			}

			const nextSteps = Arr.map(Arr.take(result.traces, 3), (t) =>
				t.errorSpan
					? `\`inspect_span trace_id="${t.traceId}" span_id="${t.errorSpan.spanId}"\` — the failing span's full attributes`
					: `\`inspect_trace trace_id="${t.traceId}" errors_only=true\` — the failing spans only`,
			)
			nextSteps.push(
				`\`search_logs service="${service ?? ""}" severity="ERROR"\` — search for related error logs`,
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "error_detail",
					data: {
						timeRange: { start: st, end: et },
						fingerprintHash: fingerprint,
						traces: Arr.map(result.traces, (t) => ({
							traceId: t.traceId,
							rootSpanName: t.rootSpanName,
							durationMs: t.durationMs,
							spanCount: t.spanCount,
							services: [...t.services],
							startTime: t.startTime,
							errorMessage: t.errorMessage || undefined,
							errorSpan: t.errorSpan
								? { ...t.errorSpan, attributes: { ...t.errorSpan.attributes } }
								: undefined,
							logs: Arr.map(t.logs, (l) => ({ ...l })),
						})),
					},
				}),
			}
		}),
	)
}
