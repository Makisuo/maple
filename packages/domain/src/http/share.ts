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

/**
 * The single body every "no such share" answer carries.
 *
 * A constant, not a per-case string: unknown token, revoked token and deleted
 * dashboard must be indistinguishable, and a varying message would be exactly
 * the oracle that distinguishes them.
 */
export const SHARE_NOT_FOUND_MESSAGE = "This link is no longer available."

/** What a share link exposes: a whole dashboard, or one widget on it. */
export const DashboardShareScope = Schema.Literals(["dashboard", "widget"])
export type DashboardShareScope = Schema.Schema.Type<typeof DashboardShareScope>

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
 * A share as its owner sees it, raw token included.
 *
 * The token is readable on every response, not just the one that minted it:
 * anyone who can read this can already mint a replacement, so withholding it
 * bought no safety and cost the obvious thing — you had to destroy a live link
 * in order to see it.
 */
export class DashboardShare extends Schema.Class<DashboardShare>("DashboardShare")({
	id: DashboardShareId,
	dashboardId: DashboardId,
	/**
	 * Absent = the whole dashboard. Present = this one widget, and only this one.
	 *
	 * The scope is enforced at resolution, not just recorded: a token minted for
	 * one chart refuses every other widget id on the same board, so a chart share
	 * cannot be walked sideways into the rest of the dashboard.
	 */
	widgetId: Schema.optionalKey(Schema.String),
	mode: DashboardShareMode,
	/** The link's credential. Put it in a URL as `/share/<token>`. */
	token: Schema.String,
	/** Trailing characters of {@link token}, for naming a link compactly. */
	tokenSuffix: Schema.String,
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
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
	{
		// Always SHARE_NOT_FOUND_MESSAGE. The field exists because the error
		// contract requires one; the constant exists so the body cannot vary
		// between "unknown", "revoked" and "dashboard deleted".
		message: Schema.String,
	},
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
 * The token resolved, it is an `org`-mode link, and the caller is anonymous.
 *
 * Two separate error classes rather than one carrying a `reason`, because the
 * public envelope serializes a **fixed** field set — `_tag`, `type`, `code`,
 * `title`, `message`, `retryable`, `recovery` — and drops everything else on
 * the payload. A `reason` field therefore never reached the wire at all, and
 * the share page, which has to tell "sign in" from "wrong organization" to draw
 * the right card, could not see it. The distinction has to live in the tag.
 *
 * They also genuinely differ in remedy: this one is fixed by signing in, the
 * other by switching organization. Deliberately says nothing about which org
 * owns the link — the caller is anonymous, and naming it would tell them
 * something the link itself does not.
 */
export class ShareSignInRequiredError extends HttpTaggedError<ShareSignInRequiredError>()(
	"@maple/http/errors/ShareSignInRequiredError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "share_signin_required",
		title: "Sign-in required",
		message: "This dashboard is shared with its organization only.",
		retry: "never",
		recovery: "reauthenticate",
		exposure: "redacted",
	},
) {}

/**
 * The token resolved and the caller is signed in, but to a different org.
 *
 * Naming the owning org is safe here in a way it is not for an anonymous
 * caller — this one already proved they hold a real link and have an account —
 * but it is still withheld: nothing in the product needs it, and it would turn
 * a share link into a probe for org names.
 */
export class ShareWrongOrgError extends HttpTaggedError<ShareWrongOrgError>()(
	"@maple/http/errors/ShareWrongOrgError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "share_wrong_org",
		title: "Wrong organization",
		message: "This dashboard belongs to a different organization.",
		retry: "never",
		recovery: "request_access",
		exposure: "redacted",
	},
) {}

export class ShareWidgetNotFoundError extends HttpTaggedError<ShareWidgetNotFoundError>()(
	"@maple/http/errors/ShareWidgetNotFoundError",
	{
		message: Schema.String,
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
		message: Schema.String,
		widgetId: Schema.String,
		kind: Schema.String,
	},
	{
		// 422, not the 503 this started as. The request is well-formed and the
		// server has no implementation for this data source — which reads like a
		// 5xx, but is a permanent, expected property of the widget, not a fault.
		//
		// The status is load-bearing for telemetry, not just for the wire. The
		// anticipated-error set is derived from `status >= 400 && status < 500`
		// (see `anticipated-errors.ts`), so as a 503 this recorded an `Error` span
		// — per unsupported widget, per view, at anonymous-viewer volume — for a
		// state this file's own docstring calls "an expected state, not a failure
		// of the share". That is the flooding the 4xx-is-Ok rule exists to stop,
		// arriving through a 5xx side door.
		status: 422,
		code: "share_widget_unsupported",
		title: "Widget unavailable in shared views",
		message: "This widget isn't available in shared views.",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

/**
 * The widget is real and supported, but running it failed.
 *
 * The counterpart to `ShareUnsupportedWidgetError`, and the distinction is
 * structural vs transient: "no server-side implementation exists for this data
 * source" is permanent and the page draws a muted tile, whereas a warehouse
 * timeout is worth retrying. Collapsing the two — which is what a single catch
 * arm did — turned every transient failure into a permanent-looking tile with
 * no retry, and discarded the cause on the way.
 */
export class ShareWidgetExecutionError extends HttpTaggedError<ShareWidgetExecutionError>()(
	"@maple/http/errors/ShareWidgetExecutionError",
	{
		message: Schema.String,
		widgetId: Schema.String,
	},
	{
		status: 503,
		code: "share_widget_failed",
		title: "Widget could not be loaded",
		message: "This widget couldn't be loaded. Try again shortly.",
		retry: "after",
		recovery: "retry",
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
		message: Schema.String,
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
		message: Schema.String,
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
		retryAfterSeconds: (error) => error.retryAfterSeconds,
	},
) {}

/**
 * `MAPLE_SHARE_TOKEN_HMAC_KEY` is absent, so no token can be minted or
 * verified. Deployments require it; this exists so a misconfigured environment
 * fails loudly at the share endpoint instead of hashing under a fallback key.
 */
export class ShareNotConfiguredError extends HttpTaggedError<ShareNotConfiguredError>()(
	"@maple/http/errors/ShareNotConfiguredError",
	{
		message: Schema.String,
	},
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
		// 503, per the repo-wide convention that a *PersistenceError is a
		// retryable dependency failure rather than a generic 500.
		status: 503,
		code: "share_persistence_failed",
		title: "Could not save the share link",
		message: "Something went wrong updating this dashboard's share link.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

// ---------------------------------------------------------------------------
// Viewer-facing surface (unauthenticated /v2/share)
// ---------------------------------------------------------------------------

/**
 * The window a viewer asks for. Absolute only — see `resolveShareWindow`.
 */
export const ShareTimeRange = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
}).annotate({ identifier: "ShareTimeRange", title: "Shared dashboard time range" })
export type ShareTimeRange = Schema.Schema.Type<typeof ShareTimeRange>

/**
 * One widget's data request.
 *
 * **This is the entire input surface a share link's holder has.** There is no
 * field here for a query, an endpoint name, params, or SQL.
 *
 * A caller that sends one anyway is not rejected — the decoder strips unknown
 * keys — but the field never reaches anything, because no code downstream reads
 * it. That is the stronger guarantee of the two: rejection depends on a
 * validation rule someone could relax, whereas "there is no code path that
 * consumes a client-supplied query" is structural. The server reads the
 * widget's stored data source and builds the query itself; `widgetId` only says
 * which tile is being asked about.
 */
export const ShareWidgetDataRequest = Schema.Struct({
	widgetId: Schema.String,
	source: Schema.optionalKey(Schema.Literals(["primary", "sparkline"])),
}).annotate({ identifier: "ShareWidgetDataRequest", title: "Shared widget data request" })
export type ShareWidgetDataRequest = Schema.Schema.Type<typeof ShareWidgetDataRequest>

/** Matches the query-engine batch cap, for the same per-request cost reason. */
export const SHARE_WIDGET_BATCH_MAX = 4

export const ShareResolveRequest = Schema.Struct({
	token: ShareToken,
}).annotate({ identifier: "ShareResolveRequest" })

export const ShareWidgetDataPayload = Schema.Struct({
	token: ShareToken,
	requests: Schema.Array(ShareWidgetDataRequest).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(SHARE_WIDGET_BATCH_MAX),
	),
	timeRange: ShareTimeRange,
	/** Selected values, keyed by variable name. Validated against the board's own definitions. */
	variableValues: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "ShareWidgetDataPayload" })
export type ShareWidgetDataPayload = Schema.Schema.Type<typeof ShareWidgetDataPayload>

/**
 * Per-widget outcome.
 *
 * Failures ride inside a 200 rather than failing the batch: one widget the
 * share cannot serve must not blank its neighbours, and "this tile is
 * unavailable" is a state the page draws, not an error it reports.
 */
export const ShareWidgetDataOutcome = Schema.Union([
	Schema.Struct({
		widgetId: Schema.String,
		ok: Schema.Literal(true),
		data: Schema.Unknown,
		/** Set when the server narrowed the window for this widget's shape. */
		narrowedToSeconds: Schema.optionalKey(Schema.Number),
	}),
	Schema.Struct({
		widgetId: Schema.String,
		ok: Schema.Literal(false),
		/** `unsupported` draws a muted tile; `failed` draws a retryable error. */
		reason: Schema.Literals(["unsupported", "not_found", "failed"]),
		message: Schema.String,
	}),
]).annotate({ identifier: "ShareWidgetDataOutcome" })
export type ShareWidgetDataOutcome = Schema.Schema.Type<typeof ShareWidgetDataOutcome>

export class ShareWidgetDataResponse extends Schema.Class<ShareWidgetDataResponse>("ShareWidgetDataResponse")(
	{
		results: Schema.Array(ShareWidgetDataOutcome),
	},
) {}

/**
 * What the share page needs to render before it asks for any data.
 *
 * `dashboard` is a redacted projection (see `redactForShare`), never the stored
 * document.
 */
export class SharedDashboardResponse extends Schema.Class<SharedDashboardResponse>("SharedDashboardResponse")(
	{
		mode: DashboardShareMode,
		scope: DashboardShareScope,
		dashboard: Schema.Unknown,
		limits: Schema.Struct({
			maxRangeSeconds: Schema.Number,
			maxListRangeSeconds: Schema.Number,
		}),
		/** True when this link may be rendered inside a third-party iframe. */
		embeddable: Schema.Boolean,
	},
) {}
