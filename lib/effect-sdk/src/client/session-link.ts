import { getSessionId, readSessionSink, recordTraceId } from "@maple/browser-session"
import { Effect, Layer, Tracer } from "effect"
import { noteStandaloneSpan } from "./standalone-session.js"
import { getCurrentUserId } from "./user.js"

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
							if (sessionId !== undefined) {
								span.attribute("session.id", sessionId)
								// Feeds the standalone session's ended-row trace ids and
								// detects idle rotation — see standalone-session.ts.
								noteStandaloneSpan(sessionId, span.traceId)
								// Also feed this SDK's bundled shared registry, so spans
								// emitted before the lazily loaded replay engine publishes
								// the sink still land on the engine's ended rows.
								recordTraceId(span.traceId)
							}
						}
						// Stamp the signed-in end-user (once `identify()` has run) so
						// traces are user-attributable, not just session-grouped.
						// Read per span at creation time, so spans started before
						// `identify()` resolves stay anonymous — same semantics as the
						// session starting anonymous. `user.id` is standard OTel semconv,
						// used verbatim (no `maple.*` namespace).
						const userId = getCurrentUserId()
						if (userId !== undefined) span.attribute("user.id", userId)
						return span
					},
				}),
		),
	).pipe(Layer.provideMerge(base))
