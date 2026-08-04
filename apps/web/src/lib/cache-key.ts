import { snapTimestamp } from "@/lib/time-utils"

function normalizeForKey(value: unknown): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "string") return snapTimestamp(value)
		return value
	}

	if (Array.isArray(value)) {
		return value.map(normalizeForKey)
	}

	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entryValue]) => entryValue !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))

	const normalized: Record<string, unknown> = {}
	for (const [key, entryValue] of entries) {
		normalized[key] = normalizeForKey(entryValue)
	}

	return normalized
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
