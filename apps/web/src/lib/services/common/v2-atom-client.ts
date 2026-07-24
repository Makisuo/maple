import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { apiBaseUrl } from "./api-base-url"
import { MapleFetchHttpClientLive } from "./http-client"
import { isRetryableTransportError, mapleRetrySchedule } from "./retry-policy"

/** Typed dashboard client for the public, stability-committed v2 API. */
export class MapleApiV2AtomClient extends AtomHttpApi.Service<MapleApiV2AtomClient>()(
	"@maple/web/services/common/MapleApiV2AtomClient",
	{
		api: MapleApiV2,
		httpClient: MapleFetchHttpClientLive,
		baseUrl: apiBaseUrl,
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
						return status !== undefined && status >= 500 && status < 600 && status !== 504
					},
				}),
			),
	},
) {}
