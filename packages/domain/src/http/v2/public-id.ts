import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"

/**
 * Stripe-style prefixed public object IDs for the v2 API.
 *
 * Wire format: `<prefix>_<base58 body>` (e.g. `key_4CzLmR1pTx…`). The body is
 * a base58 encoding of the *internal* ID with a 1-byte mode header:
 *
 * - mode 0x01 — the internal ID is a UUID; the body is its 16 raw bytes
 * - mode 0x02 — the internal ID is a free-form string; the body is its UTF-8 bytes
 *
 * The codec lives entirely at the API boundary: handlers and services keep
 * using internal IDs (raw UUIDs / branded strings), and no DB migration is
 * needed. Encoding is deterministic and reversible.
 *
 * Clerk-issued IDs (`org_…`, `user_…`) are already prefixed public IDs and are
 * passed through as-is — they must NOT be wrapped with this codec.
 */

/** Registry of v2 public-ID prefixes — single source of truth. */
export const PublicIdPrefixes = {
	apiKey: "key",
	dashboard: "dash",
	dashboardVersion: "dbv",
	dashboardTemplate: "dtpl",
	alertRule: "alrt",
	alertDestination: "dest",
	alertIncident: "inc",
	errorIssue: "iss",
	errorIncident: "einc",
	investigation: "inv",
	anomalyIncident: "anom",
	scrapeTarget: "scrp",
	recommendation: "rec",
	ingestKey: "ingk",
	attributeMapping: "amap",
	sessionReplay: "srep",
	/** Synthetic identity for logs, which have no native OTel record id. */
	log: "log",
	/** Reserved for the future events/webhooks system. */
	event: "evt",
	webhookEndpoint: "we",
} as const

export type PublicIdPrefix = (typeof PublicIdPrefixes)[keyof typeof PublicIdPrefixes]

// Bitcoin base58 alphabet (no 0/O/I/l).
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const ALPHABET_MAP = new Map([...ALPHABET].map((char, index) => [char, index]))

const base58Encode = (bytes: Uint8Array): string => {
	let zeros = 0
	while (zeros < bytes.length && bytes[zeros] === 0) zeros++

	const digits: number[] = []
	for (let i = zeros; i < bytes.length; i++) {
		let carry = bytes[i]!
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j]! << 8
			digits[j] = carry % 58
			carry = (carry / 58) | 0
		}
		while (carry > 0) {
			digits.push(carry % 58)
			carry = (carry / 58) | 0
		}
	}

	let out = "1".repeat(zeros)
	for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!]
	return out
}

const base58Decode = (input: string): Uint8Array | null => {
	if (input.length === 0) return new Uint8Array(0)

	let zeros = 0
	while (zeros < input.length && input[zeros] === "1") zeros++

	const bytes: number[] = []
	for (let i = zeros; i < input.length; i++) {
		const value = ALPHABET_MAP.get(input[i]!)
		if (value === undefined) return null
		let carry = value
		for (let j = 0; j < bytes.length; j++) {
			carry += bytes[j]! * 58
			bytes[j] = carry & 0xff
			carry >>= 8
		}
		while (carry > 0) {
			bytes.push(carry & 0xff)
			carry >>= 8
		}
	}

	const out = new Uint8Array(zeros + bytes.length)
	for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!
	return out
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MODE_UUID = 0x01
const MODE_UTF8 = 0x02

const uuidToBytes = (uuid: string): Uint8Array => {
	const hex = uuid.replaceAll("-", "")
	const bytes = new Uint8Array(16)
	for (let i = 0; i < 16; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	return bytes
}

const bytesToUuid = (bytes: Uint8Array): string => {
	let hex = ""
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Encode an internal ID (raw UUID or free-form string) as a `<prefix>_…` public ID. */
export const encodePublicId = (prefix: PublicIdPrefix, internalId: string): string => {
	const isUuid = UUID_RE.test(internalId)
	const idBytes = isUuid ? uuidToBytes(internalId.toLowerCase()) : new TextEncoder().encode(internalId)
	const bytes = new Uint8Array(1 + idBytes.length)
	bytes[0] = isUuid ? MODE_UUID : MODE_UTF8
	bytes.set(idBytes, 1)
	return `${prefix}_${base58Encode(bytes)}`
}

/** Decode a `<prefix>_…` public ID back to its internal ID. Returns null on any mismatch. */
export const decodePublicId = (prefix: PublicIdPrefix, publicId: string): string | null => {
	if (!publicId.startsWith(`${prefix}_`)) return null
	const body = publicId.slice(prefix.length + 1)
	if (body.length === 0) return null

	const bytes = base58Decode(body)
	if (bytes === null || bytes.length < 2) return null

	const mode = bytes[0]!
	const idBytes = bytes.subarray(1)
	if (mode === MODE_UUID) {
		if (idBytes.length !== 16) return null
		return bytesToUuid(idBytes)
	}
	if (mode === MODE_UTF8) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(idBytes)
		} catch {
			return null
		}
	}
	return null
}

/**
 * Schema codec: wire `<prefix>_…` public ID ⇄ internal branded ID schema.
 *
 * Decoding a malformed or wrong-prefix ID fails schema decode, which the v2
 * error middleware surfaces as an `invalid_request_error`.
 */
export const PublicId = <S extends Schema.Codec<any, string>>(prefix: PublicIdPrefix, internal: S) => {
	const example = encodePublicId(prefix, "018f2b3c-4d5e-6f70-8192-a3b4c5d6e7f8")
	return (
		// Annotate the *encoded* base string: the OpenAPI schema renders the wire
		// form, and annotations on the transformation node above are dropped in the
		// encoded projection — so `description`/`examples`/`format` must live here to
		// surface in `/v2/docs`. Metadata only; decoding/encoding is unchanged.
		Schema.String.annotate({
			title: "Public ID",
			description: `Opaque, prefixed public object ID (e.g. \`${example}\`). A reversible base58 encoding of the internal ID — treat it as an opaque string.`,
			examples: [example],
			format: "maple.public_id",
		})
			.pipe(
				Schema.decodeTo(Schema.String, {
					decode: SchemaGetter.transformOrFail((publicId: string) => {
						const internalId = decodePublicId(prefix, publicId)
						return internalId === null
							? Effect.fail(
									new SchemaIssue.InvalidValue(Option.some(publicId), {
										message: `Invalid ID: expected an ID with prefix "${prefix}_"`,
									}),
								)
							: Effect.succeed(internalId)
					}),
					encode: SchemaGetter.transform((internalId: string) =>
						encodePublicId(prefix, internalId),
					),
				}),
				Schema.decodeTo(internal),
			)
			.annotate({ title: `Public ID (${prefix}_…)` })
	)
}
