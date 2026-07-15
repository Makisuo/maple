import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { V2ApiKeysApiGroup } from "./api-keys"

/**
 * The Maple v2 public API (see docs/api-v2.md).
 *
 * Stripe-style conventions: `/v2/<resource>` nouns, prefixed public IDs,
 * `{object:"list",data,has_more,next_cursor}` list envelopes, the
 * `{error:{type,code,message}}` error envelope, snake_case wire fields,
 * ISO-8601 timestamps, and scoped API keys.
 *
 * Mounted alongside the internal v1 `MapleApi`; groups are added here as they
 * are promoted to the public surface. Dashboard-only operations move to the
 * internal Effect RPC tier instead — they never appear in this API.
 */
export class MapleApiV2 extends HttpApi.make("MapleApiV2").add(V2ApiKeysApiGroup).annotateMerge(
	OpenApi.annotations({
		title: "Maple API",
		version: "2.0.0",
		description:
			"The Maple public API. Resource-oriented REST endpoints with prefixed object IDs, cursor pagination, and scoped API keys. See docs/api-v2.md for conventions.",
	}),
) {}
