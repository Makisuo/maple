import { Tracer } from "effect"

/**
 * A tracer that keeps every span it opens, so a test can assert on span names,
 * kinds and attributes.
 *
 * Use with `Effect.withTracer(tracer)` on the effect under test, then read
 * `spans`. Spans are recorded at open time, so they are present even when the
 * effect fails — which is the point for failure-path assertions (an upstream
 * 4xx must still land on the span).
 *
 * `Tracer.NativeSpan` exposes `name`, `kind` and `attributes`; it does NOT
 * expose the exit status. A test that needs the recorded status has to capture
 * it separately (see `apps/api/src/http/server-error-span.test.ts`).
 */
export const makeRecordingTracer = () => {
	const spans: Array<Tracer.NativeSpan> = []
	const tracer = Tracer.make({
		span(options) {
			const span = new Tracer.NativeSpan(options)
			spans.push(span)
			return span
		},
	})
	return { spans, tracer }
}

/** All recorded spans with the given name, in open order. */
export const spansNamed = (spans: ReadonlyArray<Tracer.NativeSpan>, name: string) =>
	spans.filter((span) => span.name === name)
