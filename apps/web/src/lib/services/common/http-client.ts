import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http"
import { Clock, Duration, Effect, Layer } from "effect"
import { apiBaseUrl } from "./api-base-url"
import { getMapleAuthHeaders } from "./auth-headers"
import { noteReachable, noteUnreachable, originOf } from "./peer-reachability"

const CLIENT_TIMEOUT = Duration.seconds(45)

const resolveRequestUrl = (input: RequestInfo | URL): string => {
	if (typeof input === "string") return input
	if (input instanceof URL) return input.href
	return input.url
}

const mapleFetch: typeof globalThis.fetch = async (input, init) => {
	const headers = new Headers(init?.headers)

	if (resolveRequestUrl(input).startsWith(apiBaseUrl)) {
		const authHeaders = await getMapleAuthHeaders()
		for (const [name, value] of Object.entries(authHeaders)) {
			if (!headers.has(name)) {
				headers.set(name, value)
			}
		}
	}

	const origin = originOf(resolveRequestUrl(input))
	// Every API call the app makes passes through here, so this is where the app
	// learns whether an origin is reachable at all — the same clock `tracedFetch`
	// feeds from the ShapeStream side, since a blip takes both down at once. It
	// only observes; `normalizeWarehouseError` is what reads it to decide whether
	// a failure is the network's fault. An abort is evidence of nothing either
	// way: we stopped listening.
	return globalThis.fetch(input, { ...init, headers }).then(
		(response) => {
			noteReachable(origin)
			return response
		},
		(cause: unknown) => {
			if (!isAbort(cause)) noteUnreachable(origin, Date.now())
			throw cause
		},
	)
}

const isAbort = (cause: unknown): boolean =>
	typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError"

/**
 * The client-wide request deadline.
 *
 * It belongs here rather than in `mapleFetch` because a deadline the fetch
 * layer holds is not a deadline at all: `FetchHttpClient` always passes its own
 * signal, so a `signal: init?.signal ?? AbortSignal.timeout(…)` never chose the
 * timeout, and a stalled request stayed pending forever. Timing out the fiber
 * interrupts it, and that interruption is what aborts the in-flight fetch —
 * one deadline, enforced by the runtime rather than a second abort signal
 * raced against the first.
 *
 * `mapleFetch` sees the abort and reads it as evidence of nothing, which is
 * right for an interrupt and wrong for this, so the origin is marked here.
 */
export const withRequestTimeout = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
	HttpClient.transform(client, (effect, request) =>
		effect.pipe(
			Effect.timeoutOrElse({
				duration: CLIENT_TIMEOUT,
				orElse: () =>
					Effect.gen(function* () {
						noteUnreachable(originOf(request.url), yield* Clock.currentTimeMillis)
						return yield* new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								description: `No response within ${Duration.toMillis(CLIENT_TIMEOUT)}ms`,
							}),
						})
					}),
			}),
		),
	)

export const MapleFetchHttpClientLive = Layer.effect(
	HttpClient.HttpClient,
	Effect.map(HttpClient.HttpClient, withRequestTimeout),
).pipe(
	Layer.provide(FetchHttpClient.layer),
	Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, mapleFetch)),
)
