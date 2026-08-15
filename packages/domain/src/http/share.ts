/**
 * Dashboard share links.
 *
 * A share turns one dashboard into a link that resolves outside the normal
 * org-scoped auth gate, in one of two modes:
 *
 *   - `public` — anyone holding the link, no sign-in.
 *   - `org`    — any signed-in member of the dashboard's own org.
 *
 * The security property that shapes every schema here: **a share link is a
 * credential anyone may hold, so the holder never supplies a query.** The
 * viewer-facing payloads carry a `widgetId` and the controls the viewer is
 * allowed to change (time range, variable values) and nothing else — no
 * `QuerySpec`, no endpoint name, no params, no SQL. Query construction happens
 * on the server from the stored dashboard document. That invariant is enforced
 * here, in the schema, rather than by a check somewhere downstream.
 */
import { Schema } from "effect"
import { DashboardId, DashboardShareId, IsoDateTimeString } from "@maple/primitives"
import { HttpTaggedError } from "./error-policy"

/** How a share link resolves. */
export const DashboardShareMode = Schema.Literals(["public", "org"])
export type DashboardShareMode = Schema.Schema.Type<typeof DashboardShareMode>

/**
 * The raw token, as it appears in a share URL.
 *
 * Length-bounded so a pathological input is rejected before it reaches an HMAC
 * or the database, and pattern-bounded to the base64url alphabet the generator
 * emits. The prefix is deliberately NOT required here — an unknown-shaped token
 * must take the same "not found" path as a well-formed one that doesn't exist,
 * so nothing about the format is learnable by probing.
 */
export const ShareToken = Schema.String.check(
	Schema.isMinLength(8),
	Schema.isMaxLength(128),
	Schema.isPattern(/^[A-Za-z0-9_-]+$/),
).pipe(Schema.annotate({ identifier: "@maple/ShareToken", title: "Dashboard share token" }))
export type ShareToken = Schema.Schema.Type<typeof ShareToken>

// ---------------------------------------------------------------------------
// Management-side records (authed /v2 surface)
// ---------------------------------------------------------------------------

/**
 * A share as its owner sees it. Never carries the raw token: it is not
 * recoverable from storage, only the suffix is kept so a link can be
 * identified in a list.
 */
export class DashboardShare extends Schema.Class<DashboardShare>("DashboardShare")({
	id: DashboardShareId,
	dashboardId: DashboardId,
	mode: DashboardShareMode,
	tokenSuffix: Schema.String,
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
}) {}

/**
 * The result of a share write.
 *
 * `token` is present only when a token was actually minted — creating a share,
 * or rotating one — following the shown-once convention API keys already use.
 * Changing an existing share's mode deliberately keeps the same link, so it
 * mints nothing and the field is absent rather than empty: the caller cannot
 * mistake "unchanged, you already have it" for "here is your new link".
 */
export class DashboardShareCreated extends Schema.Class<DashboardShareCreated>("DashboardShareCreated")({
	share: DashboardShare,
	/** Shown once. Not recoverable afterwards. */
	token: Schema.optionalKey(Schema.String),
}) {}

export class DashboardShareTombstone extends Schema.Class<DashboardShareTombstone>("DashboardShareTombstone")(
	{
		dashboardId: DashboardId,
		revoked: Schema.Boolean,
	},
) {}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Unknown token, revoked token, or a share whose dashboard has been deleted —
 * all three, deliberately indistinguishable.
 *
 * Carries no context fields at all. A "this link was revoked" hint would
 * confirm that the token once existed, which is exactly the oracle a public
 * link must not offer.
 */
export class ShareNotFoundError extends HttpTaggedError<ShareNotFoundError>()(
	"@maple/http/errors/ShareNotFoundError",
	{},
	{
		status: 404,
		code: "share_not_found",
		title: "Share link not found",
		message: "This link is no longer available.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

/**
 * The token resolved, but this caller may not use it.
 *
 * `orgName` is populated ONLY on the `wrong_org` arm, where the caller is
 * already authenticated. An anonymous caller hitting an org-only link must
 * learn nothing about which org owns it.
 */
export class ShareForbiddenError extends HttpTaggedError<ShareForbiddenError>()(
	"@maple/http/errors/ShareForbiddenError",
	{
		reason: Schema.Literals(["signin_required", "wrong_org"]),
		orgName: Schema.optionalKey(Schema.String),
	},
	{
		status: 403,
		code: "share_forbidden",
		title: "Sign-in required",
		message: "This dashboard is shared with its organization only.",
		retry: "never",
		recovery: "reauthenticate",
		exposure: "redacted",
	},
) {}

export class ShareWidgetNotFoundError extends HttpTaggedError<ShareWidgetNotFoundError>()(
	"@maple/http/errors/ShareWidgetNotFoundError",
	{
		widgetId: Schema.String,
	},
	{
		status: 404,
		code: "share_widget_not_found",
		title: "Widget not found",
		message: "That widget is not on this dashboard.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

/**
 * The widget is real, but its data source has no server-side implementation, so
 * it cannot be rendered for a viewer who is not allowed to build the query
 * themselves. The share page draws a muted "not available" tile for this — it
 * is an expected state, not a failure of the share.
 */
export class ShareUnsupportedWidgetError extends HttpTaggedError<ShareUnsupportedWidgetError>()(
	"@maple/http/errors/ShareUnsupportedWidgetError",
	{
		widgetId: Schema.String,
		kind: Schema.String,
	},
	{
		// 503 rather than a 4xx: the request is well-formed, the server simply has
		// no implementation for this data source. In practice this rides inside the
		// per-widget outcome envelope, so the status is rarely the wire status.
		status: 503,
		code: "share_widget_unsupported",
		title: "Widget unavailable in shared views",
		message: "This widget isn't available in shared views.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class ShareRangeInvalidError extends HttpTaggedError<ShareRangeInvalidError>()(
	"@maple/http/errors/ShareRangeInvalidError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "share_range_invalid",
		title: "Invalid time range",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/**
 * A submitted variable value is not one the stored variable definition allows.
 *
 * This is a security boundary, not input polish: dashboard variables are
 * interpolated into `whereClause` values without escaping (only the `sql` key
 * is escaped), so an unchecked value from a link holder could widen a filter
 * the dashboard's author meant to pin.
 */
export class ShareVariableInvalidError extends HttpTaggedError<ShareVariableInvalidError>()(
	"@maple/http/errors/ShareVariableInvalidError",
	{
		variableName: Schema.String,
	},
	{
		status: 400,
		code: "share_variable_invalid",
		title: "Invalid variable value",
		message: "That value isn't allowed for this dashboard variable.",
		retry: "never",
		recovery: "fix_request",
		exposure: "redacted",
	},
) {}

export class ShareRateLimitedError extends HttpTaggedError<ShareRateLimitedError>()(
	"@maple/http/errors/ShareRateLimitedError",
	{
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
	},
	{
		status: 429,
		code: "share_rate_limited",
		title: "Too many requests",
		message: "This shared dashboard is receiving too many requests. Try again shortly.",
		retry: "after",
		recovery: "retry",
		exposure: "redacted",
		retryAfterSeconds: (error: { readonly retryAfterSeconds?: number }) => error.retryAfterSeconds,
	},
) {}

/**
 * `MAPLE_SHARE_TOKEN_HMAC_KEY` is absent, so no token can be minted or
 * verified. Deployments require it; this exists so a misconfigured environment
 * fails loudly at the share endpoint instead of hashing under a fallback key.
 */
export class ShareNotConfiguredError extends HttpTaggedError<ShareNotConfiguredError>()(
	"@maple/http/errors/ShareNotConfiguredError",
	{},
	{
		status: 503,
		code: "share_not_configured",
		title: "Sharing is unavailable",
		message: "Dashboard sharing is not configured on this deployment.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

export class SharePersistenceError extends HttpTaggedError<SharePersistenceError>()(
	"@maple/http/errors/SharePersistenceError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 500,
		code: "share_persistence_failed",
		title: "Could not save the share link",
		message: "Something went wrong updating this dashboard's share link.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}
