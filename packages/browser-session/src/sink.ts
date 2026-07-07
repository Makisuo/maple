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
const observedTraceIds = new Set<string>()

/** Record a trace id seen during the session. Idempotent per id. */
export function recordTraceId(traceId: string): void {
	observedTraceIds.add(traceId)
}

export function getObservedTraceIds(): string[] {
	return Array.from(observedTraceIds)
}

/**
 * Publish the session sink on `globalThis` so other tracers in the page can
 * attach their trace ids to the active replay session without a direct
 * dependency on the publishing SDK. Reads are lazy/per-span on the consumer
 * side, so init ordering between SDKs does not matter.
 */
export function publishSessionSink(sessionId: string): void {
	const sink: MapleBrowserSessionSink = { sessionId, recordTraceId }
	;(globalThis as Record<string, unknown>)[SESSION_SINK_KEY] = sink
}

/** Look up the published sink, if any page-level replay session is active. */
export function readSessionSink(): MapleBrowserSessionSink | undefined {
	return (globalThis as Record<string, unknown>)[SESSION_SINK_KEY] as
		| MapleBrowserSessionSink
		| undefined
}
