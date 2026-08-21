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
 *   - `openapi.test.ts` exempts these operations from the "every operation
 *     is bearer-secured and declares a 401" invariant, by name. The exemption is
 *     an allowlist so a third public operation cannot appear silently.
 *
 * Every endpoint is a POST, and the ones that take a token take it in the
 * **body**, never the path. The web URL is `/share/<token>`, but the API need
 * not mirror it, and keeping the token out of `url.full` means it never reaches
 * a span attribute, an access log, or a `Referer` — no tracer suppression rule
 * required.
 *
 * `alertChart` is not about a shared dashboard at all — it lives here because
 * this is the API's one unauthenticated surface, and it is unauthenticated for
 * the same reason: the image is fetched by Slack's and Discord's servers, which
 * hold no Maple credential. Like `ogCard` it takes a signed id, never a token,
 * and that id pins the rule and the window it may read.
 *
 * `ogCard` is the one operation that names a share without a token at all. It
 * cannot have one: it exists so a social-preview image can be drawn, and an
 * `og:image` is a URL that travels to every crawler and chat client that
 * unfurls the link. It takes a signed share id instead (`shareOgId`), which is
 * not a credential and cannot be turned back into a token.
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { AlertChartRequest, AlertChartResponse } from "../alerts"
import {
	ShareNotConfiguredError,
	ShareNotFoundError,
	ShareOgCardRequest,
	ShareOgCardResponse,
	ShareOgMetaRequest,
	ShareOgMetaResponse,
	SharePersistenceError,
	ShareRangeInvalidError,
	ShareRateLimitedError,
	ShareResolveRequest,
	ShareSignInRequiredError,
	ShareWidgetDataPayload,
	ShareWidgetDataResponse,
	SharedDashboardResponse,
	ShareVariableInvalidError,
	ShareWrongOrgError,
} from "../share"
import { publicErrors } from "./public-error"

const [
	shareNotFound,
	shareSignInRequired,
	shareWrongOrg,
	shareRangeInvalid,
	shareVariableInvalid,
	shareRateLimited,
	shareNotConfigured,
	sharePersistence,
] = publicErrors(
	ShareNotFoundError,
	ShareSignInRequiredError,
	ShareWrongOrgError,
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
			error: [
				shareNotFound,
				shareSignInRequired,
				shareWrongOrg,
				shareRateLimited,
				shareNotConfigured,
				sharePersistence,
			],
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
				shareSignInRequired,
				shareWrongOrg,
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
	.add(
		HttpApiEndpoint.post("ogMeta", "/og-meta", {
			payload: ShareOgMetaRequest,
			success: ShareOgMetaResponse,
			error: [shareNotFound, shareRateLimited, shareNotConfigured, sharePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "resolveShareOgMeta",
				summary: "Read a share link's social preview tags",
				description:
					"Returns the title, description and preview-image path for a public share link, for the worker that serves the page to inline into its HTML. Org-only links resolve as not found: their board's name must not travel to whatever renders the link preview.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("ogCard", "/og-card", {
			payload: ShareOgCardRequest,
			success: ShareOgCardResponse,
			error: [shareNotFound, shareRateLimited, shareNotConfigured, sharePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "resolveShareOgCard",
				summary: "Read what a share link's preview image draws",
				description:
					"Takes the signed image id from `og-meta`, never a share token, and returns the layout facts the preview image is drawn from. Revoked and org-only links resolve as not found, so an image URL stops working the moment its link does.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("alertChart", "/alert-chart", {
			payload: AlertChartRequest,
			success: AlertChartResponse,
			error: [shareNotFound, shareRateLimited, shareNotConfigured, sharePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "resolveAlertChart",
				summary: "Read the series an alert notification's chart draws",
				description:
					"Takes the signed chart id embedded in a Slack, Discord or email alert and returns the observed values over the window that id pins. Unauthenticated for the same reason as the rest of this group: the image is fetched by Slack and Discord themselves, which carry no Maple credential.",
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
