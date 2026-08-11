import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { apiBaseUrl } from "./api-base-url"
import { transformMapleApiClient } from "./api-client-transform"
import { MapleFetchHttpClientLive } from "./http-client"

/** Typed dashboard client for the public, stability-committed v2 API. */
export class MapleApiV2AtomClient extends AtomHttpApi.Service<MapleApiV2AtomClient>()(
	"@maple/web/services/common/MapleApiV2AtomClient",
	{
		api: MapleApiV2,
		httpClient: MapleFetchHttpClientLive,
		baseUrl: apiBaseUrl,
		transformClient: transformMapleApiClient,
	},
) {}
