import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

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
