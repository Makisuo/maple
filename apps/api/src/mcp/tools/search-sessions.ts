import {
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	type McpToolRegistrar,
} from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, resolveTenant } from "../lib/query-warehouse"
import { resolveTimeRange, formatClampNote } from "../lib/time"
import { clampLimit, clampOffset } from "../lib/limits"
import { formatTable, truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { createDualContent } from "../lib/structured-output"
import { searchSessions } from "@maple/query-engine/observability"

export function registerSearchSessionsTool(server: McpToolRegistrar) {
	server.tool(
		"search_sessions",
		"List and filter browser session replays. Filter by WHO (user_id — the app's end-user id), by client (browser, country, device_type), by whether the session errored (has_errors), by how long it lasted (duration/active bounds), and/or by WHAT HAPPENED inside it (event_type, level, http_status_min, url_contains, message_contains, trace_id). Returns each session's metadata including the end-user id. All filters are ANDed. Follow up with `get_session_transcript` to read a session's events or `get_session_traces` to see the backend traces it produced.",
		Schema.Struct({
			start_time: optionalStringParam("Start of time range (YYYY-MM-DD HH:mm:ss)"),
			end_time: optionalStringParam("End of time range (YYYY-MM-DD HH:mm:ss)"),
			// Session metadata filters (who / where / how long)
			user_id: optionalStringParam("Exact match on the session's end-user id (e.g. 4632)"),
			service: optionalStringParam("Exact match on the session's service name"),
			browser: optionalStringParam("Exact match on browser name (e.g. Chrome)"),
			country: optionalStringParam("Exact match on country"),
			device_type: optionalStringParam("Exact match on device type (e.g. desktop, mobile)"),
			has_errors: optionalBooleanParam("Only sessions with at least one recorded error"),
			duration_min_ms: optionalNumberParam("Only sessions at least this long (ms)"),
			duration_max_ms: optionalNumberParam("Only sessions at most this long (ms)"),
			active_min_ms: optionalNumberParam("Only sessions with at least this much active (non-idle) time (ms)"),
			active_max_ms: optionalNumberParam("Only sessions with at most this much active time (ms)"),
			// In-session event refinement (what happened)
			event_type: optionalStringParam(
				"Match sessions that contain this event type: navigation, click, input, console, network, or error",
			),
			level: optionalStringParam("Console/error level to match (e.g. error, warn)"),
			http_status_min: optionalNumberParam("Match sessions with a network request status >= this (e.g. 500)"),
			url_contains: optionalStringParam("Substring match on an in-session event/page URL"),
			message_contains: optionalStringParam("Substring match on an in-session console/error message"),
			trace_id: optionalStringParam("Only sessions that observed this trace id"),
			offset: optionalNumberParam("Offset for pagination (default 0)"),
			limit: optionalNumberParam("Max results (default 25)"),
		}),
		Effect.fn("McpTool.searchSessions")(function* (params) {
			const range = resolveTimeRange(params.start_time, params.end_time, { maxHours: 24 * 7 })
			const { st, et } = range
			const lim = clampLimit(params.limit, { defaultValue: 25, max: 200 })
			const off = clampOffset(params.offset, { max: 10_000 })

			// Whether any in-session event predicate is active — drives the Matches
			// column and the "narrowed by event" note. Uses `!= null` (not truthiness)
			// to match the query layer's `needsEventFilter` in session-replays.ts:
			// otherwise a zero-valued predicate like `http_status_min=0` would apply the
			// INNER JOIN in SQL while the display silently dropped the Matches column.
			const hasEventFilter =
				params.event_type != null ||
				params.level != null ||
				params.http_status_min != null ||
				params.url_contains != null ||
				params.message_contains != null ||
				params.trace_id != null

			const tenant = yield* resolveTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				userId: params.user_id ?? "any",
				eventType: params.event_type ?? "any",
				limit: lim,
				offset: off,
			})

			const sessions = yield* withTenantExecutor(
				searchSessions({
					startTime: st,
					endTime: et,
					userId: params.user_id ?? undefined,
					serviceName: params.service ?? undefined,
					browser: params.browser ?? undefined,
					country: params.country ?? undefined,
					deviceType: params.device_type ?? undefined,
					hasErrors: params.has_errors ?? undefined,
					durationMinMs: params.duration_min_ms ?? undefined,
					durationMaxMs: params.duration_max_ms ?? undefined,
					activeTimeMinMs: params.active_min_ms ?? undefined,
					activeTimeMaxMs: params.active_max_ms ?? undefined,
					eventType: params.event_type ?? undefined,
					eventLevel: params.level ?? undefined,
					eventMinStatus: params.http_status_min ?? undefined,
					eventUrlSearch: params.url_contains ?? undefined,
					eventMessageSearch: params.message_contains ?? undefined,
					eventTraceId: params.trace_id ?? undefined,
					limit: lim,
					offset: off,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("search_sessions")))

			yield* Effect.annotateCurrentSpan("resultCount", sessions.length)
			if (sessions.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: `No sessions matched the filters (${st} — ${et}).` },
					],
				}
			}

			// ClickHouse serializes 64-bit integer aggregates (`length()`, `count()`)
			// as JSON strings while the Tinybird path returns numbers; coerce every
			// numeric at the edge (same as get_session_traces / the http handler).
			const headers = ["User", "Started", "Duration", "Browser", "Device", "Country", "Errors", "Entry URL"]
			if (hasEventFilter) headers.push("Matches")

			const rows = sessions.map((s) => {
				const errorCount = Number(s.errorCount)
				const device = [s.osName, s.deviceType].filter(Boolean).join(" / ")
				const row = [
					s.userId || "Anonymous",
					s.startTime,
					s.durationMs != null ? `${Math.round(Number(s.durationMs))}ms` : "—",
					s.browserName || "—",
					device || "—",
					s.country || "—",
					errorCount > 0 ? String(errorCount) : "",
					truncate(s.urlInitial, 60),
				]
				if (hasEventFilter) row.push(String(Number(s.matchCount ?? 0)))
				return row
			})

			const lines: string[] = [
				`## Sessions (showing ${off + 1}–${off + sessions.length})`,
				`Time range: ${st} — ${et}${formatClampNote(range)}`,
				``,
				formatTable(headers, rows),
			]

			const nextSteps = pipe(
				sessions,
				Arr.take(3),
				Arr.map(
					(s) =>
						`\`get_session_transcript session_id="${s.sessionId}"\` — read ${
							s.userId ? `${s.userId}'s` : "the"
						} session`,
				),
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "search_sessions",
					data: {
						timeRange: { start: st, end: et },
						sessions: pipe(
							sessions,
							Arr.map((s) => ({
								sessionId: s.sessionId,
								userId: s.userId,
								startTime: s.startTime,
								durationMs: s.durationMs != null ? Number(s.durationMs) : null,
								status: s.status,
								browserName: s.browserName,
								osName: s.osName,
								deviceType: s.deviceType,
								country: s.country,
								serviceName: s.serviceName,
								pageViews: Number(s.pageViews),
								clickCount: Number(s.clickCount),
								errorCount: Number(s.errorCount),
								traceCount: Number(s.traceCount),
								urlInitial: truncate(s.urlInitial, 256),
								...(hasEventFilter ? { matchCount: Number(s.matchCount ?? 0) } : {}),
							})),
						),
					},
				}),
			}
		}),
	)
}
