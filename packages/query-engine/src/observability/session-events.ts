import { Effect } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"

export type { SessionTranscriptOutput } from "../ch/queries/session-events"
export type { SessionReplaysListOutput } from "../ch/queries/session-replays"

/**
 * List browser session replays, filtered by session metadata (end-user id,
 * service, browser, country, device, errors, duration, active time) and/or by
 * what happened inside them (event predicates: type / console-error level /
 * network status / url / message / trace id). Reads `session_replays` — the
 * table that carries the end-user id and client metadata — and INNER JOINs the
 * distilled `session_events` stream only when an event predicate is set. Returns
 * one row per session with its full metadata (and `matchCount` when filtered by
 * event). Mirrors the web dashboard's replays list.
 */
export interface SearchSessionsInput {
	readonly startTime: string
	readonly endTime: string
	// Session metadata filters (session_replays)
	readonly userId?: string
	readonly serviceName?: string
	readonly browser?: string
	readonly country?: string
	readonly deviceType?: string
	readonly hasErrors?: boolean
	readonly durationMinMs?: number
	readonly durationMaxMs?: number
	readonly activeTimeMinMs?: number
	readonly activeTimeMaxMs?: number
	// In-session event refinement (session_events)
	readonly eventType?: string
	readonly eventLevel?: string
	readonly eventMinStatus?: number
	readonly eventUrlSearch?: string
	readonly eventMessageSearch?: string
	readonly eventTraceId?: string
	readonly limit?: number
	readonly offset?: number
}

export const searchSessions = Effect.fn("Observability.searchSessions")(function* (
	input: SearchSessionsInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compile(
		CH.sessionReplaysListQuery({
			userId: input.userId,
			serviceName: input.serviceName,
			browser: input.browser,
			country: input.country,
			deviceType: input.deviceType,
			hasErrors: input.hasErrors,
			durationMinMs: input.durationMinMs,
			durationMaxMs: input.durationMaxMs,
			activeTimeMinMs: input.activeTimeMinMs,
			activeTimeMaxMs: input.activeTimeMaxMs,
			eventType: input.eventType,
			eventLevel: input.eventLevel,
			eventMinStatus: input.eventMinStatus,
			eventUrlSearch: input.eventUrlSearch,
			eventMessageSearch: input.eventMessageSearch,
			eventTraceId: input.eventTraceId,
			limit: input.limit,
			offset: input.offset,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, { profile: "list" })
})

/**
 * Return a page of the distilled-event transcript for a single session, in order.
 * Bounded by `limit`/`offset` and optionally narrowed by event type / trace / errors-only,
 * so a long session can't blow an agent's context window.
 */
export interface SessionTranscriptInput {
	readonly sessionId: string
	readonly types?: readonly string[]
	readonly traceId?: string
	readonly errorsOnly?: boolean
	readonly limit?: number
	readonly offset?: number
}

export const getSessionTranscript = Effect.fn("Observability.getSessionTranscript")(function* (
	input: SessionTranscriptInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({ orgId: executor.orgId, sessionId: input.sessionId })
	const compiled = CH.compile(
		CH.sessionTranscriptQuery({
			types: input.types,
			traceId: input.traceId,
			errorsOnly: input.errorsOnly,
			limit: input.limit,
			offset: input.offset,
		}),
		{
			orgId: executor.orgId,
			sessionId: input.sessionId,
		},
	)
	return yield* executor.compiledQuery(compiled, { profile: "list" })
})
