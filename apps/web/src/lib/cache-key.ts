import { snapTimestamp } from "@/lib/time-utils"

/** How a leaf string is treated: snapped to the 15s grid, or dropped entirely. */
type TimestampMode = "snap" | "drop"

/** Matches the warehouse `YYYY-MM-DD HH:MM:SS[.fff]` shape, with or without a `T`. */
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/

const DROPPED = Symbol("dropped")

function normalize(value: unknown, mode: TimestampMode): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "string") {
			if (mode === "snap") return snapTimestamp(value)
			return TIMESTAMP_SHAPE.test(value) ? DROPPED : value
		}
		return value
	}

	if (Array.isArray(value)) {
		return value.map((entry) => normalize(entry, mode)).filter((entry) => entry !== DROPPED)
	}

	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entryValue]) => entryValue !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))

	const normalized: Record<string, unknown> = {}
	for (const [key, entryValue] of entries) {
		const entry = normalize(entryValue, mode)
		if (entry !== DROPPED) normalized[key] = entry
	}

	return normalized
}

function normalizeForKey(value: unknown): unknown {
	return normalize(value, "snap")
}

export function encodeKey(value: unknown): string {
	const normalized = normalizeForKey(value)
	return JSON.stringify(normalized === undefined ? null : normalized)
}

/**
 * Separator between the active org and the encoded input in an atom family key.
 *
 * Atom keys used to carry only filters and time range. The org rode along
 * invisibly in the auth header, so switching orgs left every cached entry
 * addressable by the new org: the UI re-rendered the previous org's rows until
 * the idle TTL expired — up to 30 minutes on some atoms. Electric collections
 * never had this bug because their ids already embed the org.
 *
 * The org is prefixed rather than folded into the encoded object because atoms
 * decode the key back into the query input; an extra field there would travel
 * to the server as part of the request payload.
 *
 * NUL cannot occur in `encodeKey` output (it is JSON) or in a Clerk org id, so
 * the first occurrence always marks the boundary.
 */
const ORG_KEY_SEPARATOR = "\u0000"

/** Build an org-scoped atom family key. */
export function encodeOrgScopedKey(orgId: string | null | undefined, value: unknown): string {
	return `${orgId ?? ""}${ORG_KEY_SEPARATOR}${encodeKey(value)}`
}

/** Recover just the encoded input from a key built by `encodeOrgScopedKey`. */
export function orgScopedKeyPayload(key: string): string {
	return key.slice(key.indexOf(ORG_KEY_SEPARATOR) + 1)
}

/**
 * The *logical* identity of an atom key: the same query, with the time window
 * removed. Two keys that differ only in their range collapse to one identity.
 *
 * This is what lets a remount serve the previous result while the new window
 * loads. Snapping the range (see `snapRangeForCache`) keeps a key stable for
 * minutes at a time, but the boundary still has to be crossed eventually, and
 * on a 1h preset the grid is only 15s — at that point the key is genuinely new
 * and only an identity that ignores time can find what was there before.
 *
 * Derived from the key rather than the input because `Atom.family` factories
 * only ever see the key.
 *
 * The org prefix is preserved deliberately. An identity that spanned orgs would
 * revive exactly the bug `ORG_KEY_SEPARATOR` above exists to prevent: switching
 * orgs and being shown the previous org's rows.
 */
export function identityFromKey(key: string): string {
	const separatorIndex = key.indexOf(ORG_KEY_SEPARATOR)
	const orgPrefix = separatorIndex === -1 ? "" : key.slice(0, separatorIndex)
	const payload = orgScopedKeyPayload(key)

	let parsed: unknown
	try {
		parsed = JSON.parse(payload)
	} catch {
		// Not decodable — fall back to the key itself. Identity stays correct
		// (never over-shares), it just can't match across windows.
		return key
	}

	const stripped = normalize(parsed, "drop")
	return `${orgPrefix}${ORG_KEY_SEPARATOR}${JSON.stringify(stripped === DROPPED ? null : stripped)}`
}
