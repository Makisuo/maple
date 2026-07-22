import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { apiBaseUrl } from "./api-base-url"
import { MapleFetchHttpClientLive } from "./http-client"
import { isRetryableTransportError, mapleRetrySchedule } from "./retry-policy"

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
						// Billing reads (customer/usage/plans) can fire during the Clerk
						// token-settle window where getToken() is transiently null → the
						// request goes out unauthenticated → 401. Unlike the rest of the API
						// (which only mounts after auth settles), retry 401 *only* for the
						// billing endpoints so the data self-heals without a refresh. Scoped
						// by URL so a genuine auth failure elsewhere still fails fast.
						const url = (error as { request?: { url?: string } }).request?.url
						if (status === 401 && url?.includes("/api/billing/")) return true
						return false
					},
				}),
			),
	},
) {}
