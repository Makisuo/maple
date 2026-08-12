import { requiredStringParam, optionalNumberParam, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "@/mcp/lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { clampLimit } from "@/mcp/lib/limits"
import { formatTable, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { getSessionTraces } from "@maple/query-engine/observability"

export function registerGetSessionTracesTool(server: McpToolRegistrar) {
	server.tool(
		"get_session_traces",
		"Given a browser session id, return the session's browser metadata (browser, OS, device, country, entry URL, user, error count, duration) and the backend traces it observed — each summarized with root span name, service, duration, error status, and span count. Use after `search_sessions` to jump from a user session to the backend requests behind it; drill into any trace with `inspect_trace`.",
		Schema.Struct({
			session_id: requiredStringParam("The session id to read (from search_sessions)"),
			limit: optionalNumberParam("Max traces to summarize (default 50, max 100)"),
		}),
		Effect.fn("McpTool.getSessionTraces")(function* ({ session_id, limit }) {
			const lim = clampLimit(limit, { defaultValue: 50, max: 100 })

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				sessionId: session_id,
				limit: lim,
			})

			const { session, traces, totalTraceCount } = yield* withTenantExecutor(
				getSessionTraces({ sessionId: session_id, limit: lim }),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("get_session_traces")))

			if (!session) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No browser session ${session_id} found (it may predate replay capture or be outside retention).`,
						},
					],
				}
			}

			yield* Effect.annotateCurrentSpan("traceCount", traces.length)

			// Header — one-line session identity, then the correlated trace table.
			const device = [session.browserName, session.osName, session.deviceType]
				.filter(Boolean)
				.join(" / ")
			// ClickHouse serializes integer aggregates as JSON strings while the
			// Tinybird path returns numbers (see the facets handler in
			// session-replay.http.ts); coerce every numeric at the edge.
			const errorCount = Number(session.errorCount)
			const activeTimeMs = session.activeTimeMs != null ? Number(session.activeTimeMs) : null
			const idleTimeMs = session.idleTimeMs != null ? Number(session.idleTimeMs) : null
			const metaParts = [
				device || "unknown client",
				session.country || null,
				errorCount > 0 ? `${errorCount} errors` : "no errors",
				session.durationMs != null ? `${Math.round(Number(session.durationMs))}ms total` : null,
				activeTimeMs != null ? `${Math.round(activeTimeMs)}ms active` : null,
				idleTimeMs != null ? `${Math.round(idleTimeMs)}ms idle` : null,
			].filter((p): p is string => Boolean(p))

			const lines: string[] = [`## Session ${session.sessionId}`, metaParts.join(" · ")]
			if (session.urlInitial) lines.push(`Entry URL: ${truncate(session.urlInitial, 120)}`)
			if (session.userId) lines.push(`User: ${session.userId}`)
			lines.push(``)

			if (traces.length === 0) {
				lines.push("This session observed no backend traces.")
			} else {
				const shownNote =
					totalTraceCount > traces.length ? ` (showing ${traces.length} of ${totalTraceCount})` : ""
				lines.push(`### Backend traces${shownNote}`)
				lines.push(
					formatTable(
						["Trace ID", "Root span", "Service", "Duration", "Error", "Spans"],
						traces.map((t) => [
							t.traceId,
							truncate(t.rootSpanName || "—", 40),
							truncate(t.rootServiceName || "—", 30),
							`${Math.round(Number(t.durationMs))}ms`,
							Number(t.hasError) === 1 ? "✕" : "",
							String(t.spanCount),
						]),
					),
				)

				// Drill-down hints: errored traces first, then the rest.
				const ranked = [...traces].sort((a, b) => Number(b.hasError) - Number(a.hasError))
				const nextSteps = pipe(
					ranked,
					Arr.take(3),
					Arr.map(
						(t) =>
							`\`inspect_trace trace_id="${t.traceId}"\` — ${
								Number(t.hasError) === 1 ? "errored " : ""
							}${t.rootSpanName || "trace"} in ${t.rootServiceName || "?"}`,
					),
				)
				lines.push(formatNextSteps(nextSteps))
			}

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_session_traces",
					data: {
						session: {
							sessionId: session.sessionId,
							startTime: session.startTime,
							endTime: session.endTime,
							durationMs: session.durationMs != null ? Number(session.durationMs) : null,
							status: session.status,
							userId: session.userId,
							urlInitial: truncate(session.urlInitial, 256),
							browserName: session.browserName,
							osName: session.osName,
							deviceType: session.deviceType,
							country: session.country,
							serviceName: session.serviceName,
							pageViews: Number(session.pageViews),
							clickCount: Number(session.clickCount),
							errorCount,
							activeTimeMs,
							idleTimeMs,
						},
						totalTraceCount,
						traces: pipe(
							traces,
							Arr.map((t) => ({
								traceId: t.traceId,
								startTime: t.startTime,
								durationMs: Number(t.durationMs),
								rootSpanName: t.rootSpanName,
								rootServiceName: t.rootServiceName,
								spanCount: Number(t.spanCount),
								hasError: Number(t.hasError) === 1,
							})),
						),
					},
				}),
			}
		}),
	)
}
