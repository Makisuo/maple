import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApi } from "@maple/domain/http"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { apiBaseUrl } from "./api-base-url"
import { MapleFetchHttpClientLive } from "./http-client"

export class MapleApiAtomClient extends AtomHttpApi.Service<MapleApiAtomClient>()("MapleApiAtomClient", {
	api: MapleApi,
	httpClient: MapleFetchHttpClientLive,
	baseUrl: apiBaseUrl,
	transformClient: (client) =>
		client.pipe(
			HttpClient.retry({
				times: 3,
				while: (error) => {
					if (HttpClientError.isHttpClientError(error)) {
						const status = error.response?.status
						// Only retry on 500/502/503 — not 504 (timeout) or undefined (network failure)
						return status !== undefined && status >= 500 && status < 600 && status !== 504
					}

					return false
				},
			}),
		),
}) {}
