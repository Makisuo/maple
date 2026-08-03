// The single definition of the cross-SDK session sink contract. Both
// `@maple-dev/browser` (publisher) and `@maple-dev/effect-sdk` (consumer)
// bundle this module, so the key literal and shape can no longer drift apart.
const SESSION_SINK_KEY = "__MAPLE_BROWSER_SESSION__"

export interface MapleBrowserSessionSink {
	readonly sessionId: string
	readonly recordTraceId: (traceId: string) => void
}

// Trace ids observed during the active session. Read when the session
// metadata is finalized so the session row links to its traces. Ids can be
// contributed by two sources: the replay engine's own event capture and an
// external tracer (notably the Effect client SDK) pushing ids in via the
// published global sink.
const observedTraceIdsBySession = new Map<string, Set<string>>()

/** Record a trace id seen during the session. Idempotent per id. */
export function recordTraceId(traceId: string, sessionId = readSessionSink()?.sessionId): void {
	if (!sessionId) return
	let ids = observedTraceIdsBySession.get(sessionId)
	if (!ids) {
		ids = new Set()
		observedTraceIdsBySession.set(sessionId, ids)
	}
	ids.add(traceId)
}

export function getObservedTraceIds(sessionId = readSessionSink()?.sessionId): string[] {
	return sessionId ? Array.from(observedTraceIdsBySession.get(sessionId) ?? []) : []
}

/**
 * Drop the trace ids of every session but `sessionId`. Called when the sink is
 * republished under a rotated id — the outgoing session's `ended` row, the only
 * reader of its ids, has already been built by then. Without this a tab left
 * open for a day accumulates one id Set per 30-minute rotation, forever.
 */
function forgetOtherSessions(sessionId: string): void {
	for (const key of observedTraceIdsBySession.keys()) {
		if (key !== sessionId) observedTraceIdsBySession.delete(key)
	}
}

/**
 * Publish the session sink on `globalThis` so other tracers in the page can
 * attach their trace ids to the active replay session without a direct
 * dependency on the publishing SDK. Reads are lazy/per-span on the consumer
 * side, so init ordering between SDKs does not matter.
 */
export function publishSessionSink(sessionId: string): void {
	const sink: MapleBrowserSessionSink = {
		sessionId,
		recordTraceId: (traceId) => recordTraceId(traceId, sessionId),
	}
	;(globalThis as Record<string, unknown>)[SESSION_SINK_KEY] = sink
	forgetOtherSessions(sessionId)
}

/** Remove a sink published by this SDK runtime without clobbering a newer one. */
export function clearSessionSink(sessionId?: string): void {
	const owner = globalThis as Record<string, unknown>
	const current = owner[SESSION_SINK_KEY] as MapleBrowserSessionSink | undefined
	if (!current || (sessionId !== undefined && current.sessionId !== sessionId)) return
	delete owner[SESSION_SINK_KEY]
	observedTraceIdsBySession.delete(current.sessionId)
}

/** Look up the published sink, if any page-level replay session is active. */
export function readSessionSink(): MapleBrowserSessionSink | undefined {
	return (globalThis as Record<string, unknown>)[SESSION_SINK_KEY] as MapleBrowserSessionSink | undefined
}
