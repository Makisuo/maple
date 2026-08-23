import { Effect, Schema } from "effect"
import { noteReachable, noteUnreachable, PEER_OUTAGE_GRACE_MS } from "./peer-reachability"
import { runtime } from "./runtime"

const requestUrl = (input: RequestInfo | URL): string =>
	typeof input === "string" ? input : input instanceof URL ? input.href : input.url

/**
 * Electric's own abort reason. `PauseLock` aborts the in-flight live long-poll
 * with this literal whenever a ShapeStream pauses.
 * @see https://github.com/electric-sql/electric — `PAUSE_STREAM` in @electric-sql/client
 */
const PAUSE_STREAM = "pause-stream"

/**
 * True when a fetch rejection is a cancellation *we* caused rather than a
 * request that failed.
 *
 * Every ShapeStream fetch flows through `tracedFetch`, and Electric aborts them
 * routinely by design: `pause-stream` on pause/resume, a bare `AbortError` on
 * teardown. The server side of those traces completes `Ok` — nothing failed, the
 * browser just stopped listening, so reporting them as span errors inflated
 * maple-web's error rate with cancellations.
 *
 * This covers only the aborts *we* issue. A connection that dies on its own
 * rejects with a `TypeError`, which no abort signal explains and which this
 * therefore declines; `PEER_OUTAGE_GRACE_MS` is what tells those apart.
 *
 * HTTP error responses are unaffected: a 5xx resolves the promise, so it never
 * reaches here and still lands on the `Error` path via `http.response.status_code`.
 *
 * This can't ride on the SDK's `anticipatedErrorIdentifiers`: that matcher keys
 * off `_tag`/`name`, and `pause-stream` is a bare string with neither. The set is
 * also derived from domain 4xx HTTP errors — a fetch cancellation isn't one.
 *
 * Exported for tests.
 */
export const isCancellation = (cause: unknown, signal: AbortSignal | null | undefined): boolean =>
	signal?.aborted === true ||
	cause === PAUSE_STREAM ||
	(typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError")

type FetchOutcome =
	| { readonly ok: true; readonly response: Response }
	| { readonly ok: false; readonly cause: unknown }

const causeName = (cause: unknown): string | null =>
	typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string"
		? cause.name
		: null

const causeMessage = (cause: unknown): string | null => {
	if (cause instanceof Error) return cause.message.length > 0 ? cause.message : null
	if (typeof cause === "string") return cause.length > 0 ? cause : null
	return null
}

/**
 * The human half of a `TracedFetchError`.
 *
 * These arrived with an empty exception message and were therefore
 * undiagnosable: a transport rejection carries no response, so nothing in the
 * span said which call failed or how. Method + path + (when there is one) status
 * + the cause's name/message is enough to tell "the API is down" apart from
 * "this one endpoint 500s".
 *
 * The path is `URL.pathname` on purpose — a query string can carry ids, filter
 * values and search text, none of which belong in an error message.
 *
 * Exported for tests.
 */
export const describeFetchFailure = (input: {
	readonly method: string
	readonly path: string
	readonly status?: number | undefined
	readonly cause: unknown
}): string => {
	const where = `${input.method} ${input.path}`
	const status = input.status === undefined ? "" : ` (HTTP ${input.status})`
	const name = causeName(input.cause)
	const message = causeMessage(input.cause)
	const detail = [name, message].filter((part) => part !== null).join(": ")
	return `Fetch failed: ${where}${status}${detail.length > 0 ? ` — ${detail}` : ""}`
}

class TracedFetchError extends Schema.TaggedError<TracedFetchError>()("@maple/web/TracedFetchError", {
	message: Schema.String,
	cause: Schema.Defect(),
}) {}

export const tracedFetch = (
	peerService: string,
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> => {
	const url = requestUrl(input)
	const parsed = new URL(url, window.location.href)
	const method =
		init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")

	return (
		runtime
			.runPromise(
				Effect.gen(function* () {
					const span = yield* Effect.currentSpan
					const headers = new Headers(
						init?.headers ??
							(typeof Request !== "undefined" && input instanceof Request
								? input.headers
								: undefined),
					)
					if (!headers.has("traceparent")) {
						headers.set("traceparent", `00-${span.traceId}-${span.spanId}-01`)
					}
					// Settle the fetch into a value rather than the failure channel:
					// `withSpan` derives span status from that channel, and there is no way
					// to walk an `Error` back once the effect has failed. Cancellations
					// therefore return normally and only real failures are re-failed below.
					const outcome: FetchOutcome = yield* Effect.promise(() =>
						// This function is Electric's injectable fetch port; preserving the platform
						// rejection value is required for pause-stream cancellation semantics.
						// oxlint-disable-next-line effecttsgo/global-fetch-in-effect
						globalThis.fetch(input, { ...init, headers }).then(
							(response) => ({ ok: true, response }) as const,
							(cause) => ({ ok: false, cause }) as const,
						),
					)
					if (outcome.ok) {
						noteReachable(parsed.origin)
						yield* Effect.annotateCurrentSpan(
							"http.response.status_code",
							outcome.response.status,
						)
						return outcome
					}
					if (isCancellation(outcome.cause, init?.signal)) {
						// An abort is an expected outcome (navigation away, Electric
						// pause/resume), so the span stays `Ok` and only says what happened.
						// The peer's reachability is untouched: we stopped listening, so
						// the attempt is evidence of nothing either way.
						yield* Effect.annotateCurrentSpan({
							"maple.http.cancelled": true,
							"error.type": "aborted",
						})
						return outcome
					}
					const unreachableMs = noteUnreachable(parsed.origin, Date.now())
					yield* Effect.annotateCurrentSpan({
						"error.type": causeName(outcome.cause) ?? "TracedFetchError",
						"maple.http.unreachable_ms": unreachableMs,
					})
					if (unreachableMs < PEER_OUTAGE_GRACE_MS) {
						// Inside the grace window this is a connectivity blip, not a
						// failure of the application: the span stays `Ok` and carries the
						// annotations above, so the loss is still charted and alertable
						// without fingerprinting an exception. The caller is rejected
						// exactly as before and retries on its own.
						yield* Effect.annotateCurrentSpan("maple.http.unreachable", true)
						return outcome
					}
					return yield* new TracedFetchError({
						cause: outcome.cause,
						message: describeFetchFailure({
							method,
							path: parsed.pathname,
							cause: outcome.cause,
						}),
					})
				}).pipe(
					Effect.withSpan("http.client", {
						kind: "client",
						attributes: {
							"http.request.method": method,
							"url.full": parsed.href,
							"server.address": parsed.hostname,
							"peer.service": peerService,
						},
					}),
				),
			)
			// Cancellations resolved the effect to keep the span `Ok`, so rethrow the
			// original rejection verbatim here — Electric's pause/resume and every other
			// caller must see exactly the value `fetch` rejected with.
			.then(
				(outcome) => (outcome.ok ? outcome.response : Promise.reject(outcome.cause)),
				(error) => Promise.reject(error instanceof TracedFetchError ? error.cause : error),
			)
	)
}

export const logClientError = (
	event: string,
	error: unknown,
	attributes: Record<string, string | number | boolean> = {},
): void => {
	runtime.runFork(
		Effect.logError("Client operation failed").pipe(
			Effect.annotateLogs({
				...attributes,
				"maple.client.event": event,
				"error.type": error instanceof Error ? error.name : "UnknownError",
				"error.message": error instanceof Error ? error.message : String(error),
			}),
		),
	)
}

export const logClientWarning = (
	event: string,
	error: unknown,
	attributes: Record<string, string | number | boolean> = {},
): void => {
	runtime.runFork(
		Effect.logWarning("Client operation degraded").pipe(
			Effect.annotateLogs({
				...attributes,
				"maple.client.event": event,
				"error.type": error instanceof Error ? error.name : "UnknownError",
				"error.message": error instanceof Error ? error.message : String(error),
			}),
		),
	)
}
