import { AtomHttpApi } from "@/lib/effect-atom"
import { MapleInternalApi } from "@maple/domain/http"
import { encodeOrgScopedKey, identityFromKey } from "@/lib/cache-key"
import { withRetention } from "@/lib/services/atoms/retained-atom"
import { apiBaseUrl } from "./api-base-url"
import { getActiveOrgId } from "./auth-headers"
import { DEFAULT_QUERY_TTL } from "./atom-client"
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
 * Warehouse reads reach this client through `runWarehouseQuery` in
 * `api/warehouse/effect-utils.ts`, which owns retention and span naming for
 * them — do not wrap those in `retainedInternalQuery` as well, or the cache
 * identity is computed twice and the two disagree.
 *
 * `retainedInternalQuery` below is for the other half of this tier: the product
 * workflows (billing, digest, AI triage) that moved off `/api` and still need
 * the same unmount-surviving retention their settings panels always had.
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

/**
 * `MapleInternalAtomClient.query` with caching that survives unmount — the
 * `/internal` twin of `retainedQuery` in `atom-client.ts`, and cast for the same
 * reason spelled out there.
 *
 * The identity carries an `internal:` prefix so a group name that exists on both
 * clients can never share a retention slot with its public namesake.
 */
const internalQueryWithRetention = (
	group: string,
	endpoint: string,
	request: Record<string, unknown> | undefined,
) => {
	const atom = MapleInternalAtomClient.query(
		group as never,
		endpoint as never,
		{
			timeToLive: DEFAULT_QUERY_TTL,
			...request,
		} as never,
	)

	const identity = `internal:${group}:${endpoint}:${identityFromKey(
		encodeOrgScopedKey(getActiveOrgId(), request ?? {}),
	)}`

	return withRetention(atom, identity)
}

// SAFETY: internalQueryWithRetention preserves MapleInternalAtomClient.query's arguments and retained result.
export const retainedInternalQuery =
	internalQueryWithRetention as unknown as typeof MapleInternalAtomClient.query
