// The active-trace-id lookup lives in its own module rather than in
// `events-sink`, because the capture modules need it and the sink imports the
// capture modules — routing it through the sink would make that a cycle.

const ZERO_TRACE_ID = "00000000000000000000000000000000"

// Injected by the host SDK (e.g. `@maple-dev/browser` wires OTel's
// `trace.getActiveSpan()`), keeping this engine free of tracing dependencies.
// Without a provider, events simply carry no trace id.
let traceIdProvider: () => string | undefined = () => undefined

/** Wire the host SDK's active-trace-id lookup into event capture. */
export function setActiveTraceIdProvider(provider: () => string | undefined): void {
	traceIdProvider = provider
}

/** The trace id of the active span, or undefined when none is active. */
export function activeTraceId(): string | undefined {
	const id = traceIdProvider()
	return id && id !== ZERO_TRACE_ID ? id : undefined
}
