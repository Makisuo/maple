import { publishSessionSink as publishShared } from "@maple/browser-session"

// Trace ids observed during the active replay session. Read when the session
// metadata is finalized so the session row links to its traces. Lives outside
// `tracing.ts` because the ids can be contributed by two sources: this SDK's own
// instrumentation (via the BatchSpanProcessor sibling collector) and an external
// tracer — notably the Effect client SDK, which exports through its own pipeline
// and pushes ids in via the published global sink.
const observedTraceIds = new Set<string>()

/** Record a trace id seen during the session. Idempotent per id. */
export function recordTraceId(traceId: string): void {
	observedTraceIds.add(traceId)
}

export function getObservedTraceIds(): string[] {
	return Array.from(observedTraceIds)
}

/**
 * Publish the session sink on `globalThis` so other tracers in the page (e.g. the
 * Effect client SDK) can attach their trace ids to this replay session without a
 * direct dependency on `@maple-dev/browser`. The key and shape live in
 * `@maple/browser-session`, which both SDKs bundle — one definition, no drift.
 */
export function publishSessionSink(sessionId: string): void {
	publishShared({ sessionId, recordTraceId })
}
