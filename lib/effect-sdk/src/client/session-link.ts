import { getSessionId, readSessionSink } from "@maple/browser-session"
import { Effect, Layer, Tracer } from "effect"

/**
 * Decorate the OTLP tracer so every span it creates carries `session.id` for
 * the active Maple browser session.
 *
 * Two sources, checked per span so init ordering never matters:
 *
 * 1. The sink `@maple-dev/browser` publishes on `globalThis` when a replay
 *    session is active — used when present so the span's trace id also feeds
 *    the replay's trace↔session correlation.
 * 2. Otherwise the shared `sessionStorage`-backed session from
 *    `@maple/browser-session` (bundled into this SDK), so the Effect SDK works
 *    standalone — no `@maple-dev/browser` import required. Both SDKs read and
 *    write the same storage record, so the ids agree when both are present.
 *
 * During SSR neither source resolves and the decorator no-ops. `provideMerge`
 * keeps the base layer's logger/metrics while overriding only the Tracer
 * reference.
 *
 * Shared by the `Otlp.layerJson`-based client `layer` and the buffer-backed
 * client `MapleFlush.make` preset so both link sessions identically.
 */
export const withSessionLink = <ROut, E, RIn>(base: Layer.Layer<ROut, E, RIn>) =>
	Layer.effect(
		Tracer.Tracer,
		Effect.map(
			Effect.tracer,
			(inner): Tracer.Tracer =>
				Tracer.make({
					context: inner.context,
					span(options) {
						const span = inner.span(options)
						const sink = readSessionSink()
						if (sink) {
							sink.recordTraceId(span.traceId)
							span.attribute("session.id", sink.sessionId)
						} else {
							const sessionId = getSessionId()
							if (sessionId !== undefined) span.attribute("session.id", sessionId)
						}
						return span
					},
				}),
		),
	).pipe(Layer.provideMerge(base))
