import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { encodeOrgScopedKey, identityFromKey } from "@/lib/cache-key"
import { withRetention } from "@/lib/services/atoms/retained-atom"
import { DEFAULT_QUERY_TTL } from "./atom-client"
import { apiBaseUrl } from "./api-base-url"
import { getActiveOrgId } from "./auth-headers"
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

/**
 * `MapleApiV2AtomClient.query` with caching that survives unmount.
 *
 * Same rationale as `retainedQuery` in `atom-client.ts` — see the note there.
 * Prefer this over calling `.query` directly.
 */
export const retainedQueryV2: typeof MapleApiV2AtomClient.query = ((
	group: string,
	endpoint: string,
	request: Record<string, unknown> | undefined,
) => {
	const atom = MapleApiV2AtomClient.query(group as never, endpoint as never, {
		timeToLive: DEFAULT_QUERY_TTL,
		...request,
	} as never)

	const identity = `v2:${group}:${endpoint}:${identityFromKey(
		encodeOrgScopedKey(getActiveOrgId(), request ?? {}),
	)}`

	return withRetention(atom, identity)
	// See `retainedQuery`: `query`'s conditional return type cannot be restated
	// by a forwarder, and the wrapping is a value-preserving pass-through.
}) as unknown as typeof MapleApiV2AtomClient.query
