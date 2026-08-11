import { Cause, Context, Data, Effect } from "effect"
import { HttpMiddleware } from "effect/unstable/http"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"

// `HttpMiddleware.tracer` ends the root server span from the HttpApp's Exit. A
// declared HttpApi error that a handler group renders into a response (e.g.
// WarehouseUpstreamError → 503) reaches it as `Exit.succeed(response)`, so the
// span records StatusCode=Ok while `http.response.status_code=503` — which made
// every user-facing 503 invisible to error dashboards during the 2026-08
// Hyperdrive CONNECT_TIMEOUT incident (`error_events_mv` keys off
// `StatusCode='Error'`).
//
// OTel HTTP semconv for SERVER spans: only 5xx is an error; 4xx stays Ok (the
// same rule as the ingest gateway's `otel_status_for_rejection` and the
// anticipated-error identifiers). This middleware runs INSIDE the tracer —
// `HttpEffect.toHandled` composes `tracer(middleware(responded))`, and
// `responded` has already sent the response to the client by the time the
// middleware observes it — so converting a 5xx success into a failure changes
// only the exit the tracer records, never the response. The cause mirrors
// Effect's own failure shape (`Fail(error)` + `Die(response)`): the tracer's
// `causeResponseStripped` recovers the response for
// `http.response.status_code` and records the remaining `Fail` as the span
// error.

/**
 * Marker failure recorded on the server span (and error reporter) when a
 * request completed with a 5xx response. Must never be listed in
 * `ANTICIPATED_ERROR_IDENTIFIERS` — its whole purpose is StatusCode=Error.
 */
export class Http5xxResponseError extends Data.TaggedError("Http5xxResponseError")<{
	readonly status: number
	readonly method: string
	readonly path: string
}> {
	override get message(): string {
		return `HTTP ${this.status} (${this.method} ${this.path})`
	}
}

export const serverErrorSpanMiddleware = HttpMiddleware.make((httpApp) =>
	Effect.flatMap(httpApp, (response) => {
		if (response.status < 500) return Effect.succeed(response)
		return Effect.withFiber((fiber) => {
			const request = Context.getUnsafe(fiber.context, HttpServerRequest)
			// Query strings can carry credentials (OAuth callback `code`), and this
			// message lands in logs even where the server span is suppressed.
			const queryIndex = request.url.indexOf("?")
			return Effect.failCause(
				Cause.fromReasons([
					Cause.makeFailReason(
						new Http5xxResponseError({
							status: response.status,
							method: request.method,
							path: queryIndex === -1 ? request.url : request.url.slice(0, queryIndex),
						}),
					),
					Cause.makeDieReason(response),
				]),
			)
		})
	}),
)
