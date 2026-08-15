/**
 * The viewer-facing share surface, on v2.
 *
 * **The one v2 group with no `AuthorizationV2` middleware**, and the only one
 * whose operations are not bearer-authenticated. That is not an oversight and
 * it is not a gap in the scope model — a share link is a credential in itself,
 * carried in the request body, and the whole proposition is that it resolves
 * for someone with no Maple account at all. Requiring a bearer here would mean
 * the link only worked for people who did not need it.
 *
 * Consequences worth knowing before adding to this group:
 *
 *   - `requiredScopeForRequest` would derive the family `share` from the path,
 *     but it is only ever called by `ApiAuthorizationV2Layer`, which these
 *     routes do not run. There is no `share:read` scope and nothing issues one.
 *   - The operations publish `security: []`. That is derived from the absent
 *     middleware, not annotated, and it is accurate: no credential is required.
 *     An `org`-mode link *reads* a session token when one is present, but
 *     OpenAPI's `security` describes what is required, not what is consulted.
 *   - `openapi.test.ts` exempts these two operations from the "every operation
 *     is bearer-secured and declares a 401" invariant, by name. The exemption is
 *     an allowlist so a third public operation cannot appear silently.
 *
 * Every endpoint is a POST with the token in the **body**, never the path. The
 * web URL is `/share/<token>`, but the API need not mirror it, and keeping the
 * token out of `url.full` means it never reaches a span attribute, an access
 * log, or a `Referer` — no tracer suppression rule required.
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
	ShareForbiddenError,
	ShareNotConfiguredError,
	ShareNotFoundError,
	SharePersistenceError,
	ShareRangeInvalidError,
	ShareRateLimitedError,
	ShareResolveRequest,
	ShareWidgetDataPayload,
	ShareWidgetDataResponse,
	SharedDashboardResponse,
	ShareVariableInvalidError,
} from "../share"
import { publicErrors } from "./public-error"

const [
	shareNotFound,
	shareForbidden,
	shareRangeInvalid,
	shareVariableInvalid,
	shareRateLimited,
	shareNotConfigured,
	sharePersistence,
] = publicErrors(
	ShareNotFoundError,
	ShareForbiddenError,
	ShareRangeInvalidError,
	ShareVariableInvalidError,
	ShareRateLimitedError,
	ShareNotConfiguredError,
	SharePersistenceError,
)

export class V2SharePublicApiGroup extends HttpApiGroup.make("sharePublic")
	.add(
		HttpApiEndpoint.post("resolve", "/resolve", {
			payload: ShareResolveRequest,
			success: SharedDashboardResponse,
			error: [shareNotFound, shareForbidden, shareRateLimited, shareNotConfigured, sharePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "resolveShare",
				summary: "Open a shared dashboard",
				description:
					"Exchanges a share token for the dashboard it points at, as a redacted projection carrying no stored queries. Unknown, revoked, and deleted links are deliberately indistinguishable.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("widgetData", "/widget-data", {
			payload: ShareWidgetDataPayload,
			success: ShareWidgetDataResponse,
			error: [
				shareNotFound,
				shareForbidden,
				shareRangeInvalid,
				shareVariableInvalid,
				shareRateLimited,
				shareNotConfigured,
				sharePersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "resolveShareWidgetData",
				summary: "Read data for shared widgets",
				description:
					"Returns rows for up to four widgets on a shared dashboard. The caller names widgets only — every query is built server-side from the stored document, never from the request.",
			}),
		),
	)
	.prefix("/v2/share")
	.annotateMerge(
		OpenApi.annotations({
			title: "Shares",
			description:
				"Read a dashboard through a share link. The only unauthenticated group in this API: the token in the request body is the credential, so these operations resolve for a viewer with no Maple account.",
		}),
	) {}
