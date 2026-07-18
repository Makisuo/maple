import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { V2AlertDestinationsApiGroup } from "./alert-destinations"
import { V2AnomaliesApiGroup } from "./anomalies"
import { V2AlertIncidentsApiGroup } from "./alert-incidents"
import { V2AlertRulesApiGroup } from "./alert-rules"
import { V2ApiKeysApiGroup } from "./api-keys"
import { V2AttributeMappingsApiGroup } from "./attribute-mappings"
import { V2DashboardsApiGroup } from "./dashboards"
import { V2IngestKeysApiGroup } from "./ingest-keys"
import { V2InvestigationsApiGroup } from "./investigations"
import { V2OrganizationApiGroup } from "./organization"
import { V2InstrumentationRecommendationsApiGroup } from "./recommendations"
import { V2ScrapeTargetsApiGroup } from "./scrape-targets"
import { V2SessionReplaysApiGroup } from "./session-replays"
import {
	V2LogsApiGroup,
	V2MetricsApiGroup,
	V2QueryApiGroup,
	V2ServiceMapApiGroup,
	V2ServicesApiGroup,
	V2TracesApiGroup,
} from "./telemetry"
import { V2UnexpectedErrors } from "./auth"

const HTTP_OPERATION_METHODS = ["get", "post", "put", "patch", "delete", "head"] as const

/** Add the rate-limit retry contract to every generated 429 response. */
const addRateLimitResponseHeaders = (spec: Record<string, any>): Record<string, any> => {
	for (const pathItem of Object.values(spec.paths ?? {})) {
		if (typeof pathItem !== "object" || pathItem === null) continue
		for (const method of HTTP_OPERATION_METHODS) {
			const operation = (pathItem as Record<string, any>)[method]
			if (typeof operation !== "object" || operation === null) continue
			const response = operation.responses?.["429"]
			if (typeof response !== "object" || response === null) continue
			response.headers = {
				...response.headers,
				"Retry-After": {
					description: "Seconds to wait before retrying the request.",
					schema: { type: "integer", minimum: 1 },
					example: 60,
				},
			}
		}
	}
	return spec
}

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
export class MapleApiV2 extends HttpApi.make("MapleApiV2")
	.add(V2ApiKeysApiGroup)
	.add(V2DashboardsApiGroup)
	.add(V2AlertRulesApiGroup)
	.add(V2AlertDestinationsApiGroup)
	.add(V2AlertIncidentsApiGroup)
	.add(V2IngestKeysApiGroup)
	.add(V2AttributeMappingsApiGroup)
	.add(V2ScrapeTargetsApiGroup)
	.add(V2InstrumentationRecommendationsApiGroup)
	.add(V2InvestigationsApiGroup)
	.add(V2AnomaliesApiGroup)
	.add(V2OrganizationApiGroup)
	.add(V2SessionReplaysApiGroup)
	.add(V2TracesApiGroup)
	.add(V2LogsApiGroup)
	.add(V2MetricsApiGroup)
	.add(V2ServicesApiGroup)
	.add(V2ServiceMapApiGroup)
	.add(V2QueryApiGroup)
	.middleware(V2UnexpectedErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Maple API",
			version: "2.0.0",
			summary: "The public, stability-committed HTTP API for the Maple observability platform.",
			description: [
				"The Maple public API is a resource-oriented REST interface for everything the dashboard can do.",
				"It follows Stripe's design philosophy, modernized where useful:",
				"",
				"- **Resources** are plural nouns under `/v2` (`/v2/api_keys`). Related resources share a product namespace (`/v2/alerts/rules`, `/v2/alerts/destinations`). Non-CRUD verbs are sub-resource POSTs (`/v2/api_keys/{id}/roll`).",
				"- **Object IDs** are opaque, prefixed strings (`key_…`, `dash_…`) — reversible encodings of internal IDs.",
				"- **Wire format** is snake_case JSON with an `object` type field on every resource and ISO-8601 UTC timestamps.",
				'- **Lists** use cursor pagination and a uniform `{ object: "list", data, has_more, next_cursor }` envelope.',
				"- **Errors** use a uniform `{ error: { type, code, message } }` envelope with a closed set of `type`s and stable `code`s.",
				"- **Auth** is a Bearer API key (`maple_ak_…`) or dashboard session token; keys can be restricted with scopes.",
				"",
				"See `docs/api-v2.md` for the full conventions.",
			].join("\n"),
			servers: [{ url: "https://api.maple.dev", description: "Production" }],
			// `info.contact` and top-level `externalDocs` have no dedicated annotation
			// key (they are not in `OpenAPISpecInfo`), so inject them via the api-level
			// spec transform, which receives the whole generated document.
			transform: (spec) => {
				const withRateLimitHeaders = addRateLimitResponseHeaders(spec)
				return {
					...withRateLimitHeaders,
					info: {
						...withRateLimitHeaders.info,
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
				}
			},
		}),
	) {}
