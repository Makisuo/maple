import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApi } from "@maple/domain/http"
import { apiBaseUrl } from "./api-base-url"
import { transformMapleApiClient } from "./api-client-transform"
import { MapleFetchHttpClientLive } from "./http-client"

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
		transformClient: transformMapleApiClient,
	},
) {}
