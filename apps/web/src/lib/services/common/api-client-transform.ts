import { Effect } from "effect"
import { HttpClient, type HttpClientRequest } from "effect/unstable/http"
import { isMapleApiRequestUrl } from "./api-base-url"
import { hasCachedMapleAuthToken, invalidateMapleAuthToken } from "./auth-headers"
import { withMapleRetryPolicy } from "./retry-policy"

const retriedUnauthorized = new WeakSet<object>()

const refreshStaleAuthorization = (request: HttpClientRequest.HttpClientRequest): boolean => {
	if (!retriedUnauthorized.has(request) && hasCachedMapleAuthToken()) {
		retriedUnauthorized.add(request)
		invalidateMapleAuthToken()
		return true
	}
	// Billing reads can race Clerk's token-settle window and briefly leave without
	// a bearer token. Keep this exception URL-scoped; genuine 401s elsewhere fail fast.
	// Both prefixes are load-bearing: the authenticated operations moved to
	// `/internal/billing`, while the unauthenticated plan catalog stayed on
	// `/api/billing`. Dropping either one silently reinstates the hard 401.
	return request.url.includes("/internal/billing/") || request.url.includes("/api/billing/")
}

export const transformMapleApiClient = <E, R>(
	client: HttpClient.HttpClient.With<E, R>,
): HttpClient.HttpClient.With<E, R> =>
	client.pipe(
		(self) =>
			HttpClient.transform(self, (effect, request) =>
				isMapleApiRequestUrl(request.url)
					? Effect.annotateSpans(effect, "peer.service", "maple-api")
					: effect,
			),
		(self) => withMapleRetryPolicy(self, { retryUnauthorized: refreshStaleAuthorization }),
	)
