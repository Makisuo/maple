import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { apiBaseUrl } from "./api-base-url"
import { hasCachedMapleAuthToken, invalidateMapleAuthToken } from "./auth-headers"
import { MapleFetchHttpClientLive } from "./http-client"
import { isRetryableTransportError, mapleRetrySchedule } from "./retry-policy"

/**
 * Requests already given their one stale-token retry, keyed by request identity
 * so concurrent 401s don't consume each other's allowance.
 */
const retriedUnauthorized = new WeakSet<object>()

export class MapleApiAtomClient extends AtomHttpApi.Service<MapleApiAtomClient>()(
	"@maple/web/services/common/MapleApiAtomClient",
	{
		api: MapleApi,
		httpClient: MapleFetchHttpClientLive,
		baseUrl: apiBaseUrl,
		// `peer.service` on the outbound `http.client` span draws the
		// maple-web → maple-api edge on the service map. Annotate HERE rather than
		// by rewrapping MapleFetchHttpClientLive: that layer must stay literally
		// `FetchHttpClient.layer` + mapleFetch so the memoMap priming in
		// registry.ts keeps the JWT-injecting fetch (see the registry comment —
		// rewrapping it ships every API request without auth, mass 401s).
		transformClient: (client) =>
			client.pipe(
				(self) =>
					HttpClient.transform(self, (effect, request) =>
						request.url.startsWith(apiBaseUrl)
							? Effect.annotateSpans(effect, "peer.service", "maple-api")
							: effect,
					),
				HttpClient.retry({
					times: 3,
					schedule: mapleRetrySchedule,
					while: (error) => {
						// Transient network failures (idempotent requests only) self-heal
						// with backoff instead of failing fast to the error UI.
						if (isRetryableTransportError(error)) return true
						if (!HttpClientError.isHttpClientError(error)) return false
						const status = error.response?.status
						if (status === undefined) return false
						// Retry on 500/502/503 — not 504 (query timeout, won't get faster)
						if (status >= 500 && status < 600 && status !== 504) return true
						if (status !== 401) return false
						// A bearer token served from the auth-headers cache can go stale
						// ahead of its own `exp` — revoked session, org switch, clock skew —
						// and then 401s every request until it's dropped. Drop it and let
						// exactly one retry go out with a freshly minted token; a second 401
						// means the failure is real, so it falls through and fails fast.
						const request = (error as { request?: { url?: string } }).request
						const firstAttempt = request !== undefined && !retriedUnauthorized.has(request)
						if (firstAttempt) retriedUnauthorized.add(request)
						if (firstAttempt && hasCachedMapleAuthToken()) {
							invalidateMapleAuthToken()
							return true
						}
						// Billing reads (customer/usage/plans) can fire during the Clerk
						// token-settle window where getToken() is transiently null → the
						// request goes out unauthenticated → 401. Unlike the rest of the API
						// (which only mounts after auth settles), retry 401 *only* for the
						// billing endpoints so the data self-heals without a refresh. Scoped
						// by URL so a genuine auth failure elsewhere still fails fast.
						if (request?.url?.includes("/api/billing/")) return true
						return false
					},
				}),
			),
	},
) {}
