import { createHmac } from "node:crypto"

export type IngestKeyType = "public" | "private"

export interface ResolvedIngestKey {
	readonly orgId: string
	readonly keyType: IngestKeyType
	readonly keyId: string
}

export const inferIngestKeyType = (rawKey: string): IngestKeyType | null => {
	if (rawKey.startsWith("maple_pk_")) return "public"
	if (rawKey.startsWith("maple_sk_")) return "private"
	return null
}

export const parseIngestKeyLookupHmacKey = (raw: string): string => {
	const trimmed = raw.trim()
	if (trimmed.length === 0) {
		throw new Error("MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required")
	}

	return trimmed
}

export const hashIngestKey = (rawKey: string, hmacKey: string): string =>
	createHmac("sha256", hmacKey).update(rawKey, "utf8").digest("base64url")

export const createIngestKeyId = (hash: string): string => hash.slice(0, 16)

// Fixed input for the startup HMAC fingerprint emitted by the API and ingest
// gateway. Operators diff the resulting 8-char prefix between the two services
// to detect env-var drift on `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY`. Must stay
// byte-identical with the Rust constant in `apps/ingest/src/main.rs`.
export const HMAC_FINGERPRINT_SENTINEL = "MAPLE_HMAC_FINGERPRINT_V1"

export const computeHmacFingerprint = (hmacKey: string): string =>
	hashIngestKey(HMAC_FINGERPRINT_SENTINEL, hmacKey).slice(0, 8)
