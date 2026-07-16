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
		summary: "The public, stability-committed HTTP API for the Maple observability platform.",
		description: [
			"The Maple public API is a resource-oriented REST interface for everything the dashboard can do.",
			"It follows Stripe's design philosophy, modernized where useful:",
			"",
			"- **Resources** are plural nouns under `/v2` (`/v2/api_keys`). Non-CRUD verbs are sub-resource POSTs (`/v2/api_keys/{id}/roll`).",
			"- **Object IDs** are opaque, prefixed strings (`key_…`, `dash_…`) — reversible encodings of internal IDs.",
			"- **Wire format** is snake_case JSON with an `object` type field on every resource and ISO-8601 UTC timestamps.",
			"- **Lists** use cursor pagination and a uniform `{ object: \"list\", data, has_more, next_cursor }` envelope.",
			"- **Errors** use a uniform `{ error: { type, code, message } }` envelope with a closed set of `type`s and stable `code`s.",
			"- **Auth** is a Bearer API key (`maple_ak_…`) or dashboard session token; keys can be restricted with scopes.",
			"",
			"See `docs/api-v2.md` for the full conventions.",
		].join("\n"),
		servers: [{ url: "https://api.maple.dev", description: "Production" }],
		// `info.contact` and top-level `externalDocs` have no dedicated annotation
		// key (they are not in `OpenAPISpecInfo`), so inject them via the api-level
		// spec transform, which receives the whole generated document.
		transform: (spec) => ({
			...spec,
			info: {
				...spec.info,
				contact: {
					name: "Maple Support",
					url: "https://maple.dev",
					email: "support@maple.dev",
				},
			},
			externalDocs: {
				url: "https://api.maple.dev/v2/docs",
				description: "Interactive Maple API reference",
			},
		}),
	}),
) {}
