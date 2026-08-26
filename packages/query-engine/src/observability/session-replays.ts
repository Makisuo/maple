import { Effect, Option } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"

export type { SessionReplayDetailOutput, SessionTraceSummaryOutput } from "../ch/queries/session-replays"

import type { SessionReplayDetailOutput, SessionTraceSummaryOutput } from "../ch/queries/session-replays"

const DEFAULT_TRACE_LIMIT = 50
const MAX_TRACE_LIMIT = 100

/**
 * Bound the number of correlated trace ids summarized in one call. A long
 * session can observe many traces, and each id widens the `TraceId IN (...)`
 * scan over `trace_detail_spans`, so we cap the fan-out (matching the
 * list-query guardrail applied throughout the MCP layer).
 */
function clampTraceLimit(value: number | undefined): number {
	if (value == null || !Number.isFinite(value) || value <= 0) return DEFAULT_TRACE_LIMIT
	return Math.min(Math.floor(value), MAX_TRACE_LIMIT)
}

export interface SessionTracesInput {
	readonly sessionId: string
	/** Max correlated traces to summarize (default 50, max 100). */
	readonly limit?: number
}

/** Session metadata plus the active/idle breakdown merged in from a second
 *  pass over `session_events` (null when the session has no distilled events). */
export interface SessionWithActivity extends SessionReplayDetailOutput {
	/** Engaged time (ms): Σ gaps ≤ idle threshold between distilled events. */
	readonly activeTimeMs: number | null
	/** Idle time (ms): Σ gaps > idle threshold between distilled events. */
	readonly idleTimeMs: number | null
}

export interface SessionTracesOutput {
	/** The browser session's metadata, or null when no such session exists. */
	readonly session: SessionWithActivity | null
	/** Per-trace summaries for the (clamped) correlated trace ids. */
	readonly traces: ReadonlyArray<SessionTraceSummaryOutput>
	/** Full count of trace ids on the session, before the `limit` clamp. */
	readonly totalTraceCount: number
}

/**
 * Given a browser session id, fetch the session's metadata (which also
 * confirms it *is* a browser session) plus a summary of each backend trace it
 * observed. Two warehouse reads: the session row (O(log N) by the
 * `(OrgId, SessionId)` sort-key prefix), then one grouped pass over
 * `trace_detail_spans` for the correlated trace ids.
 *
 * This is the session→traces counterpart to `searchSessions(traceId=...)`
 * (which goes trace→session). Mirrors the web replay route's `getReplay` +
 * `traceSummaries` handlers.
 */
export const getSessionTraces = Effect.fn("Observability.getSessionTraces")(function* (
	input: SessionTracesInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({ orgId: executor.orgId, sessionId: input.sessionId })

	// 1) Session metadata (+ full TraceIds array) and the active/idle breakdown
	// from a second pass over session_events. Both are single-session sort-key
	// seeks (`(OrgId, SessionId)` prefix) and independent, so run them
	// concurrently — one round-trip of latency, not two.
	const detailCompiled = CH.compile(CH.getSessionReplayQuery(), {
		orgId: executor.orgId,
		sessionId: input.sessionId,
	})
	const activityCompiled = CH.compile(CH.sessionActivityQuery(), {
		orgId: executor.orgId,
		sessionId: input.sessionId,
	})
	const [maybeSession, maybeActivity] = yield* Effect.all(
		[
			executor.compiledQueryFirst(detailCompiled, {
				profile: "discovery",
				context: "sessionReplayDetail",
			}),
			executor.compiledQueryFirst(activityCompiled, {
				profile: "discovery",
				context: "sessionActivity",
			}),
		],
		{ concurrency: 2 },
	)
	const sessionRow = Option.getOrNull(maybeSession)
	if (!sessionRow) {
		return { session: null, traces: [], totalTraceCount: 0 } satisfies SessionTracesOutput
	}

	// `null` active/idle if the session has no distilled events (e.g. rrweb-only).
	const activity = Option.getOrNull(maybeActivity)
	const session: SessionWithActivity = {
		...sessionRow,
		activeTimeMs: activity ? Number(activity.activeTimeMs) : null,
		idleTimeMs: activity ? Number(activity.idleTimeMs) : null,
	}

	const totalTraceCount = session.traceIds.length
	const traceIds = session.traceIds.slice(0, clampTraceLimit(input.limit))

	// `TraceId IN ()` is invalid SQL — a session with no correlated traces
	// short-circuits without touching the warehouse a second time.
	if (traceIds.length === 0) {
		return { session, traces: [], totalTraceCount } satisfies SessionTracesOutput
	}

	// 2) Per-trace summaries (root span name/service, duration, error, span count).
	const summariesCompiled = CH.compile(CH.sessionTraceSummariesQuery({ traceIds }), {
		orgId: executor.orgId,
	})
	const traces = yield* executor.compiledQuery(summariesCompiled, {
		profile: "list",
		context: "sessionTraceSummaries",
	})

	return { session, traces, totalTraceCount } satisfies SessionTracesOutput
})
