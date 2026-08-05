import {
	requiredStringParam,
	optionalStringParam,
	optionalNumberParam,
	optionalBooleanParam,
	type McpToolRegistrar,
} from "./types"
import { warehouseToMcpHandlers } from "@/mcp/lib/map-warehouse-error"
import { withTenantExecutor, resolveTenant } from "@/mcp/lib/query-warehouse"
import { truncate } from "@/mcp/lib/format"
import { clampLimit, clampOffset } from "@/mcp/lib/limits"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { createDualContent } from "@/mcp/lib/structured-output"
import { getSessionTranscript, type SessionTranscriptOutput } from "@maple/query-engine/observability"

const KNOWN_EVENT_TYPES = ["navigation", "click", "input", "console", "network", "error"] as const

/** Parse a comma-separated `event_types` arg into a validated, de-duped list. */
function parseEventTypes(raw: string | null | undefined): readonly string[] {
	if (!raw) return []
	const known = new Set<string>(KNOWN_EVENT_TYPES)
	return [
		...new Set(
			raw
				.split(",")
				.map((t) => t.trim().toLowerCase())
				.filter((t) => known.has(t)),
		),
	]
}

export function registerGetSessionTranscriptTool(server: McpToolRegistrar) {
	server.tool(
		"get_session_transcript",
		"Read a browser session replay as a compact text transcript: navigation, clicks, console logs, network requests, and errors in order, each with the trace id it occurred under. Use after `search_sessions` to analyze what a user did and what went wrong. Returns one page (default 100 events) — narrow with `only_errors`, `event_types`, or `around_trace_id`, or page through with `offset`. Drill into any referenced trace with `inspect_trace`.",
		Schema.Struct({
			session_id: requiredStringParam("The session id to read (from search_sessions)"),
			event_types: optionalStringParam(
				"Comma-separated event types to include: navigation, click, input, console, network, error. Omit for all.",
			),
			only_errors: optionalBooleanParam(
				"If true, only show what went wrong: error events, console errors, and failed (status >= 400) requests.",
			),
			around_trace_id: optionalStringParam(
				"Only events that occurred under this trace id (focus on one backend request).",
			),
			offset: optionalNumberParam("Offset for paging through a long transcript (default 0)"),
			limit: optionalNumberParam("Max events to return (default 100, max 250)"),
		}),
		Effect.fn("McpTool.getSessionTranscript")(function* ({
			session_id,
			event_types,
			only_errors,
			around_trace_id,
			offset,
			limit,
		}) {
			const types = parseEventTypes(event_types)
			const errorsOnly = only_errors ?? false
			const traceId = around_trace_id ?? undefined
			const lim = clampLimit(limit, { defaultValue: 100, max: 250 })
			const off = clampOffset(offset, { max: 10_000 })

			const tenant = yield* resolveTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				sessionId: session_id,
				limit: lim,
				offset: off,
				errorsOnly,
			})

			// Fetch one extra row to detect whether more events remain past this page.
			const rows = yield* withTenantExecutor(
				getSessionTranscript({
					sessionId: session_id,
					types: types.length > 0 ? types : undefined,
					traceId,
					errorsOnly,
					limit: lim + 1,
					offset: off,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("get_session_transcript")))

			const hasMore = rows.length > lim
			const events = hasMore ? rows.slice(0, lim) : rows

			yield* Effect.annotateCurrentSpan("eventCount", events.length)

			const filterNote = describeFilters({ types, errorsOnly, traceId })
			if (events.length === 0) {
				const reason = filterNote
					? ` matching ${filterNote}`
					: ". The session may predate event capture, or only have a visual (rrweb) recording"
				return {
					content: [
						{
							type: "text" as const,
							text: `No distilled events for session ${session_id}${reason}.`,
						},
					],
				}
			}

			const header = `## Session ${session_id} — events ${off + 1}–${off + events.length}${
				hasMore ? " (more available)" : ""
			}${filterNote ? ` · filter: ${filterNote}` : ""}`
			const lines: string[] = [header, ``]
			for (const ev of events) {
				lines.push(formatLine(ev))
			}

			// Surface a few distinct trace ids for drill-down, plus a pagination hint.
			const distinctTraces = [...new Set(events.map((e) => e.traceId).filter(Boolean))].slice(0, 3)
			const nextSteps = distinctTraces.map(
				(id) => `\`inspect_trace trace_id="${id}"\` — backend trace for a request in this session`,
			)
			if (hasMore) {
				nextSteps.push(
					`\`get_session_transcript session_id="${session_id}" offset=${off + lim}\` — next page`,
				)
			}
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_session_transcript",
					data: {
						sessionId: session_id,
						events: pipe(
							events,
							Arr.map((e) => ({
								timestamp: e.timestamp,
								type: e.type,
								url: truncate(e.url, 256),
								traceId: e.traceId,
								level: e.level,
								message: truncate(e.message, 500),
								targetSelector: e.targetSelector,
								netMethod: e.netMethod,
								netUrl: truncate(e.netUrl, 256),
								netStatus: e.netStatus,
								netDurationMs: e.netDurationMs,
							})),
						),
					},
				}),
			}
		}),
	)
}

/** Human-readable summary of the active filters, for headers and empty-result messages. */
function describeFilters(opts: {
	types: readonly string[]
	errorsOnly: boolean
	traceId: string | undefined
}): string {
	const parts: string[] = []
	if (opts.errorsOnly) parts.push("errors only")
	if (opts.types.length > 0) parts.push(`types=${opts.types.join("/")}`)
	if (opts.traceId) parts.push(`trace=${opts.traceId.slice(0, 12)}…`)
	return parts.join(", ")
}

/** Render one transcript row as `time · TYPE detail (trace)`. */
function formatLine(ev: SessionTranscriptOutput): string {
	const time = ev.timestamp.split(" ")[1] ?? ev.timestamp
	const trace = ev.traceId ? ` ⟶ ${ev.traceId.slice(0, 12)}…` : ""
	let detail: string
	switch (ev.type) {
		case "navigation":
			detail = `NAV   → ${ev.url}`
			break
		case "click":
			detail = `CLICK ${ev.targetSelector}${ev.targetText ? ` "${truncate(ev.targetText, 60)}"` : ""}`
			break
		case "input":
			detail = `INPUT ${ev.targetSelector}`
			break
		case "console":
			detail = `LOG   [${ev.level || "log"}] ${truncate(ev.message, 200)}`
			break
		case "network":
			detail = `NET   ${ev.netMethod} ${ev.netStatus} ${truncate(ev.netUrl, 100)} (${ev.netDurationMs}ms)`
			break
		case "error":
			detail = `ERROR ${truncate(ev.message, 200)}`
			break
		default:
			detail = `${ev.type} ${truncate(ev.message, 120)}`
	}
	return `${time}  ${detail}${trace}`
}
