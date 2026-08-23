import { Cause, Context, Effect, Schema } from "effect"
import { HttpMiddleware } from "effect/unstable/http"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"

// `HttpMiddleware.tracer` ends the root server span from the HttpApp's Exit. A
// declared HttpApi error that a handler group renders into a response (e.g.
// WarehouseUpstreamError → 503) reaches it as `Exit.succeed(response)`, so the
// span records StatusCode=Ok while `http.response.status_code=503`. During the
// 2026-08 Hyperdrive CONNECT_TIMEOUT incident that made user-facing 503s
// invisible *as failing requests*: request-level error rates computed over
// server spans read ~0% and trace roots stayed green — only the failing inner
// operation spans (Database.execute, executeSql) reached error tracking, which
// counts operations, not affected requests.
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
// error. Past the tracer, the failure is inert: `toHandled`'s outer
// `matchCauseEffect` sees the request already handled and returns `Effect.void`,
// so the request scope still closes with a Success exit and finalizers never
// observe the synthetic failure.

/**
 * Marker failure recorded on the server span when a request completed with a
 * 5xx response. Must never be listed in `ANTICIPATED_ERROR_IDENTIFIERS` — its
 * whole purpose is StatusCode=Error (pinned by a test in
 * `server-error-span.test.ts`).
 *
 * The failure also reaches Effect's error-reporter boundary
 * (`reportCauseUnsafe` in `HttpEffect.toHandled`). No `ErrorReporter` is
 * registered in this app today, so that is a no-op — but a future reporter
 * would receive the raw two-reason cause; the `Die(response)` reason is
 * skipped by reporters via `HttpServerResponse`'s `ErrorReporter.ignore` flag.
 */
export class Http5xxResponseError extends Schema.TaggedError<Http5xxResponseError>()(
	"@maple/api/http/Http5xxResponseError",
	{
		status: Schema.Number,
		method: Schema.String,
		path: Schema.String,
	},
) {
	override get message(): string {
		return `HTTP ${this.status} (${this.method} ${this.path})`
	}
}

export const serverErrorSpanMiddleware = HttpMiddleware.make((httpApp) =>
	Effect.flatMap(httpApp, (response) => {
		if (response.status < 500) return Effect.succeed(response)
		return Effect.withFiber((fiber) => {
			const request = Context.getUnsafe(fiber.context, HttpServerRequest)
			// Query strings can carry credentials (OAuth callback `code`). The
			// message keeps only the path so it stays safe in span exception events
			// and in any future error-reporter output — the failure reaches the
			// reporter boundary even for requests whose server span is suppressed
			// via `TracerDisabledWhen`.
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
