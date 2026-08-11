import { Effect } from "effect"
import { HttpClient, type HttpClientRequest } from "effect/unstable/http"
import { apiBaseUrl } from "./api-base-url"
import { hasCachedMapleAuthToken, invalidateMapleAuthToken } from "./auth-headers"
import { withMapleRetryPolicy } from "./retry-policy"

/** Requests already given their one stale-token retry, keyed by request identity. */
const retriedUnauthorized = new WeakSet<object>()

const refreshStaleAuthorization = (request: HttpClientRequest.HttpClientRequest): boolean => {
	if (!retriedUnauthorized.has(request) && hasCachedMapleAuthToken()) {
		retriedUnauthorized.add(request)
		invalidateMapleAuthToken()
		return true
	}
	// Billing reads can race Clerk's token-settle window and briefly leave without
	// a bearer token. Keep this exception URL-scoped; genuine 401s elsewhere fail fast.
	return request.url.includes("/api/billing/")
}

/** Shared v1/v2 client transform: service-map attribution plus one retry policy. */
export const transformMapleApiClient = <E, R>(
	client: HttpClient.HttpClient.With<E, R>,
): HttpClient.HttpClient.With<E, R> =>
	client.pipe(
		(self) =>
			HttpClient.transform(self, (effect, request) =>
				request.url.startsWith(apiBaseUrl)
					? Effect.annotateSpans(effect, "peer.service", "maple-api")
					: effect,
			),
		(self) => withMapleRetryPolicy(self, { retryUnauthorized: refreshStaleAuthorization }),
	)
