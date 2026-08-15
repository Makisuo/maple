import { createHmac, randomBytes } from "node:crypto"

export const SHARE_TOKEN_PREFIX = "mshare_"

/**
 * Number of trailing characters kept in plaintext so the share dialog can show
 * "…a1b2c3" next to a link whose full value it can no longer read back.
 */
export const SHARE_TOKEN_SUFFIX_LENGTH = 6

export const generateShareToken = (): string =>
	`${SHARE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`

/**
 * Keyed HMAC rather than a bare digest, matching `hashApiKey`: the token is the
 * only credential a public share link carries, so a database dump on its own
 * must not be a set of working links.
 *
 * Deterministic, which is what makes the lookup a single indexed equality on
 * `token_hash` — there is no candidate row to compare against in variable time,
 * so this path needs no constant-time compare.
 */
export const hashShareToken = (rawToken: string, hmacKey: string): string =>
	createHmac("sha256", hmacKey).update(rawToken, "utf8").digest("base64url")

export const shareTokenSuffix = (rawToken: string): string => rawToken.slice(-SHARE_TOKEN_SUFFIX_LENGTH)

export const isShareTokenShaped = (value: string): boolean => value.startsWith(SHARE_TOKEN_PREFIX)
