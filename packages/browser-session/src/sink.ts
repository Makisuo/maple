// The single definition of the cross-SDK session sink contract. Both
// `@maple-dev/browser` (publisher) and `@maple-dev/effect-sdk` (consumer)
// bundle this module, so the key literal and shape can no longer drift apart.
const SESSION_SINK_KEY = "__MAPLE_BROWSER_SESSION__"

export interface MapleBrowserSessionSink {
	readonly sessionId: string
	readonly recordTraceId: (traceId: string) => void
}

/**
 * Publish the session sink on `globalThis` so other tracers in the page (e.g.
 * the Effect client SDK) can attach their trace ids to the active replay
 * session without a direct dependency on `@maple-dev/browser`. Reads are
 * lazy/per-span on the consumer side, so init ordering between SDKs does not
 * matter.
 */
export function publishSessionSink(sink: MapleBrowserSessionSink): void {
	;(globalThis as Record<string, unknown>)[SESSION_SINK_KEY] = sink
}

/** Look up the published sink, if any page-level replay session is active. */
export function readSessionSink(): MapleBrowserSessionSink | undefined {
	return (globalThis as Record<string, unknown>)[SESSION_SINK_KEY] as
		| MapleBrowserSessionSink
		| undefined
}
