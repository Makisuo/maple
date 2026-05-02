import { FetchHttpClient } from "effect/unstable/http"
import { Layer } from "effect"
import { apiBaseUrl } from "./api-base-url"
import { getMapleAuthHeaders } from "./auth-headers"

const CLIENT_TIMEOUT_MS = 45_000

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

	return globalThis.fetch(input, {
		...init,
		headers,
		signal: init?.signal ?? AbortSignal.timeout(CLIENT_TIMEOUT_MS),
	})
}

export const MapleFetchHttpClientLive = FetchHttpClient.layer.pipe(
	Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, mapleFetch)),
)
