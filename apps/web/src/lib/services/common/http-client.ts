import { FetchHttpClient } from "effect/unstable/http"
import { Layer } from "effect"
import { isMapleApiRequestUrl } from "./api-base-url"
import { getMapleAuthHeaders } from "./auth-headers"
import { noteReachable, noteUnreachable, originOf } from "./peer-reachability"

const CLIENT_TIMEOUT_MS = 45_000

const resolveRequestUrl = (input: RequestInfo | URL): string => {
	if (typeof input === "string") return input
	if (input instanceof URL) return input.href
	return input.url
}

const mapleFetch: typeof globalThis.fetch = async (input, init) => {
	const headers = new Headers(init?.headers)

	if (isMapleApiRequestUrl(resolveRequestUrl(input))) {
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
	return globalThis
		.fetch(input, {
			...init,
			headers,
			signal: init?.signal ?? AbortSignal.timeout(CLIENT_TIMEOUT_MS),
		})
		.then(
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

export const MapleFetchHttpClientLive = FetchHttpClient.layer.pipe(
	Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, mapleFetch)),
)
