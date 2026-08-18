import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { AlertRuleId, OrgId } from "@maple/domain/primitives"
import { AlertChartBreachSide, AlertChartUnit } from "@maple/domain/http"
import { Result, Schema } from "effect"

const SHARE_TOKEN_PREFIX = "mshare_"

/**
 * Number of trailing characters kept in plaintext, so a link can be named in a
 * list or an audit trail ("…a1b2c3") without decrypting the stored token.
 */
const SHARE_TOKEN_SUFFIX_LENGTH = 6

export const generateShareToken = (): string =>
	`${SHARE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`

/**
 * Keyed HMAC rather than a bare digest, matching `hashApiKey`: the token is the
 * only credential a public share link carries, so a database dump on its own
 * must not be a set of working links. The recoverable copy alongside it is
 * encrypted under a key held outside Postgres, which keeps that true.
 *
 * Deterministic, which is what makes the lookup a single indexed equality on
 * `token_hash` — there is no candidate row to compare against in variable time,
 * so this path needs no constant-time compare.
 */
export const hashShareToken = (rawToken: string, hmacKey: string): string =>
	createHmac("sha256", hmacKey).update(rawToken, "utf8").digest("base64url")

export const shareTokenSuffix = (rawToken: string): string => rawToken.slice(-SHARE_TOKEN_SUFFIX_LENGTH)

/**
 * Domain separation for the OG-card id below, so a signature minted for one
 * purpose can never be replayed as another. Same reasoning as the AAD label in
 * `SharedDashboardService` (`dashboard_shares:v1:{orgId}:{shareId}:token`).
 */
const SHARE_OG_ID_LABEL = "og:v1:"

const signShareOgId = (shareId: string, hmacKey: string): string =>
	createHmac("sha256", hmacKey).update(`${SHARE_OG_ID_LABEL}${shareId}`, "utf8").digest("base64url")

/**
 * The public, opaque id of a share's social-preview image.
 *
 * A share token must never appear in a URL — every share endpoint takes it in
 * the request body, and `/share/` is served `Referrer-Policy: no-referrer`, so
 * the token reaches no access log, span attribute or `Referer` header. An
 * `og:image` is a URL by definition and travels further than any of those, so
 * it carries this instead: the share's **id**, which is not a credential and
 * cannot be turned back into the token.
 *
 * Signed rather than bare so the id is only usable in the shape this repo
 * minted it in. Ids are random UUIDs, so this is not the thing standing between
 * an attacker and enumeration — it is what makes a tampered id fail closed
 * rather than reaching a database lookup.
 */
export const shareOgId = (shareId: string, hmacKey: string): string =>
	`${Buffer.from(shareId, "utf8").toString("base64url")}.${signShareOgId(shareId, hmacKey)}`

/**
 * The share id inside an OG id, or `undefined` if the signature does not match.
 *
 * Constant-time, unlike `hashShareToken`: there the value is looked up by
 * equality in an index and no comparison happens in JS, whereas here a
 * candidate signature is compared against a computed one, which is exactly the
 * shape a timing oracle needs.
 */
export const verifyShareOgId = (ogId: string, hmacKey: string): string | undefined => {
	const separator = ogId.indexOf(".")
	if (separator <= 0) return undefined

	const shareId = Buffer.from(ogId.slice(0, separator), "base64url").toString("utf8")
	if (shareId.length === 0) return undefined

	const presented = Buffer.from(ogId.slice(separator + 1), "utf8")
	const expected = Buffer.from(signShareOgId(shareId, hmacKey), "utf8")
	// `timingSafeEqual` throws on a length mismatch, which would itself be the
	// oracle it exists to remove.
	if (presented.length !== expected.length) return undefined

	return timingSafeEqual(presented, expected) ? shareId : undefined
}

/**
 * Domain separation for the alert-chart id, distinct from `og:v1:` so a
 * signature minted for a dashboard preview can never be replayed to render an
 * alert chart, or the reverse.
 */
const ALERT_CHART_ID_LABEL = "alertchart:v1:"

/**
 * What an alert chart image is allowed to draw.
 *
 * The title, unit and threshold ride along with the window for the same reason
 * the window does: pinning them is what makes an image drawn today still true
 * next month. A rule that is renamed, re-thresholded or deleted afterwards does
 * not retroactively change what a delivered alert said — and it also means the
 * endpoint needs no rule lookup at all, only the series read.
 *
 * The window is part of the signed payload rather than a query parameter,
 * which is the whole reason this feature needs no snapshot table: `alert_checks`
 * is append-only with a year of retention, so a pinned window returns the same
 * rows forever and the image is deterministic without storing its points. It is
 * also what stops the URL becoming an arbitrary-range scan against the
 * warehouse — a caller cannot widen `fromMs` without invalidating the signature.
 */
export interface AlertChartClaims {
	readonly orgId: OrgId
	readonly ruleId: AlertRuleId
	/** `null` for an ungrouped rule. */
	readonly groupKey: string | null
	readonly fromMs: number
	readonly toMs: number
	/** What the card is titled — the rule's measured quantity, as the message names it. */
	readonly title: string
	readonly unit: AlertChartUnit
	readonly threshold: number | null
	/** Which side of the threshold the renderer shades. */
	readonly breachSide: AlertChartBreachSide
}

/**
 * What comes back out of a chart id, which is **not** the same type that went in.
 *
 * The signature proves this repo minted the payload; it does not make the
 * strings inside it decoded entity ids. They arrived in a URL and came out of
 * `JSON.parse`, so they are named `raw*` and stay unbranded — the caller decodes
 * them at its boundary, and a value that fails to decode is a 404 rather than a
 * brand that was asserted into existence.
 */
export interface VerifiedAlertChartClaims extends Omit<AlertChartClaims, "orgId" | "ruleId"> {
	readonly rawOrgId: string
	readonly rawRuleId: string
}

/**
 * Canonical, order-independent encoding of the claims.
 *
 * Hand-built rather than `JSON.stringify` of the object: key order there is
 * insertion order, so a caller that built the claims differently would produce
 * a different signature for the same claims.
 */
/**
 * The signed payload, positionally.
 *
 * A tuple rather than an object because the bytes are what is signed: object
 * key order is insertion order, so two callers building the same claims in a
 * different order would produce different signatures for the same claims. The
 * positions are the format — appending is safe, reordering is a break.
 *
 * Declared as a schema so verification *decodes* rather than hand-checking
 * nine `typeof`s, and so `unit` and `breachSide` come back as their literal
 * unions instead of `string` the caller has to re-narrow.
 */
const AlertChartPayload = Schema.Tuple([
	Schema.String,
	Schema.String,
	Schema.NullOr(Schema.String),
	Schema.Number,
	Schema.Number,
	Schema.String,
	AlertChartUnit,
	Schema.NullOr(Schema.Number),
	AlertChartBreachSide,
])

const decodeAlertChartPayload = Schema.decodeUnknownResult(Schema.fromJsonString(AlertChartPayload))

const encodeAlertChartClaims = (claims: AlertChartClaims): string =>
	JSON.stringify([
		claims.orgId,
		claims.ruleId,
		claims.groupKey,
		claims.fromMs,
		claims.toMs,
		claims.title,
		claims.unit,
		claims.threshold,
		claims.breachSide,
	])

const signAlertChartId = (payload: string, hmacKey: string): string =>
	createHmac("sha256", hmacKey).update(`${ALERT_CHART_ID_LABEL}${payload}`, "utf8").digest("base64url")

/**
 * The public, opaque id of an alert notification's chart image.
 *
 * Unlike a share link this carries no credential at all — it is a rule id and a
 * time range, signed. Anyone holding the URL can see one metric series, which
 * is the same exposure a public dashboard share already accepts, and the
 * signature is what keeps it to *that* series over *that* window.
 */
export const alertChartId = (claims: AlertChartClaims, hmacKey: string): string => {
	const payload = encodeAlertChartClaims(claims)
	const encoded = Buffer.from(payload, "utf8").toString("base64url")
	return `${encoded}.${signAlertChartId(payload, hmacKey)}`
}

/**
 * The claims inside an alert-chart id, or `undefined` if it does not verify.
 *
 * Constant-time for the same reason as `verifyShareOgId`: a presented signature
 * is compared against a computed one, which is the shape a timing oracle needs.
 * A malformed id fails identically to a tampered one — the caller gets no
 * signal about which.
 */
export const verifyAlertChartId = (id: string, hmacKey: string): VerifiedAlertChartClaims | undefined => {
	const separator = id.indexOf(".")
	if (separator <= 0) return undefined

	const payload = Buffer.from(id.slice(0, separator), "base64url").toString("utf8")
	if (payload.length === 0) return undefined

	const presented = Buffer.from(id.slice(separator + 1), "utf8")
	const expected = Buffer.from(signAlertChartId(payload, hmacKey), "utf8")
	// `timingSafeEqual` throws on a length mismatch, which would itself be the
	// oracle it exists to remove.
	if (presented.length !== expected.length) return undefined
	if (!timingSafeEqual(presented, expected)) return undefined

	// Reached only for a payload this repo signed, so the shape is ours — but it
	// is decoded rather than trusted. A signature written by an older or newer
	// version of this format still verifies, and its payload still has to parse.
	const decoded = decodeAlertChartPayload(payload)
	if (Result.isFailure(decoded)) return undefined

	const [rawOrgId, rawRuleId, groupKey, fromMs, toMs, title, unit, threshold, breachSide] = decoded.success
	return { rawOrgId, rawRuleId, groupKey, fromMs, toMs, title, unit, threshold, breachSide }
}
