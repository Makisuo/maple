import { Data, Effect } from "effect"
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
 * browser just stopped listening. Reporting them as span errors is what put
 * maple-web at a ~15% error rate that was ~99% cancellations.
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

class TracedFetchError extends Data.TaggedError("@maple/web/TracedFetchError")<{
	readonly cause: unknown
}> {}

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
						globalThis.fetch(input, { ...init, headers }).then(
							(response) => ({ ok: true, response }) as const,
							(cause) => ({ ok: false, cause }) as const,
						),
					)
					if (outcome.ok) {
						yield* Effect.annotateCurrentSpan(
							"http.response.status_code",
							outcome.response.status,
						)
						return outcome
					}
					if (isCancellation(outcome.cause, init?.signal)) {
						yield* Effect.annotateCurrentSpan("maple.http.cancelled", true)
						return outcome
					}
					return yield* new TracedFetchError({ cause: outcome.cause })
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
