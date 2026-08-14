import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleInternalApi } from "@maple/domain/http"
import { apiBaseUrl } from "./api-base-url"
import { transformMapleApiClient } from "./api-client-transform"
import { MapleFetchHttpClientLive } from "./http-client"

/**
 * Client for the dashboard's private transport (`/internal/*`).
 *
 * Same origin and same `apiBaseUrl` as the public clients, so `mapleFetch`'s
 * URL scoping still attaches the Clerk JWT. `MapleFetchHttpClientLive` is passed
 * through untouched for the reason spelled out in `atom-client.ts` and
 * `registry.ts`: rewrapping it defeats the memoMap priming and memoizes a
 * second, non-JWT-injecting fetch.
 *
 * There is deliberately no `retainedQuery` equivalent here. Every caller reaches
 * this client through `runWarehouseQuery` in `api/warehouse/effect-utils.ts`,
 * which owns retention and span naming for warehouse reads; a second retention
 * path would just be a way to get the cache identity wrong.
 */
export class MapleInternalAtomClient extends AtomHttpApi.Service<MapleInternalAtomClient>()(
	"@maple/web/services/common/MapleInternalAtomClient",
	{
		api: MapleInternalApi,
		httpClient: MapleFetchHttpClientLive,
		baseUrl: apiBaseUrl,
		transformClient: transformMapleApiClient,
	},
) {}
