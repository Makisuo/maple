import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleApi } from "@maple/domain/http"
import { encodeOrgScopedKey, identityFromKey } from "@/lib/cache-key"
import { withRetention } from "@/lib/services/atoms/retained-atom"
import { apiBaseUrl } from "./api-base-url"
import { getActiveOrgId } from "./auth-headers"
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

/**
 * Idle TTL applied to every `retainedQuery` atom.
 *
 * `AtomHttpApi.query` applies neither `setIdleTTL` nor `keepAlive` unless a
 * `timeToLive` is given, so a bare query atom is disposed the moment its last
 * subscriber unmounts — every revisit is a cold fetch, however quickly the user
 * comes back. A minute is enough to make back-and-forth navigation free and
 * short enough that anything not covered by `reactivityKeys` self-heals fast.
 *
 * Staleness past the TTL is not a risk: retention only fills the visual gap
 * while a refetch is in flight, it never suppresses the refetch.
 */
export const DEFAULT_QUERY_TTL = "1 minute"

/**
 * `MapleApiAtomClient.query` with caching that survives unmount.
 *
 * Prefer this over calling `.query` directly — the bare version has no TTL and
 * no retention, which is why settings, integrations and similar panels used to
 * flash a skeleton on every single visit.
 *
 * Pass `timeToLive` in the request to override the default; pass
 * `reactivityKeys` (as before) so mutations invalidate the atom.
 */
// The single cast in this module, and it is confined to the signature rather
// than the body. `query`'s return type is a conditional resolved from the
// group/endpoint literals; a forwarder cannot restate that relationship, so TS
// rejects both the generic arguments going in and the generic atom coming out.
// The runtime behaviour is a pass-through — `withRetention` wraps the atom
// without changing its value type — so the borrowed signature stays accurate.
const queryWithRetention = (
	group: string,
	endpoint: string,
	request: Record<string, unknown> | undefined,
) => {
	const atom = MapleApiAtomClient.query(
		group as never,
		endpoint as never,
		{
			timeToLive: DEFAULT_QUERY_TTL,
			...request,
		} as never,
	)

	// Org-scoped, and with any time window stripped, so the identity is stable
	// across windows but can never serve one org's rows to another. `group` and
	// `endpoint` namespace it, so two endpoints taking the same request shape
	// cannot collide.
	const identity = `${group}:${endpoint}:${identityFromKey(
		encodeOrgScopedKey(getActiveOrgId(), request ?? {}),
	)}`

	return withRetention(atom, identity)
}

export const retainedQuery = queryWithRetention as unknown as typeof MapleApiAtomClient.query
