import type { AuditChanges } from "@maple/domain/http"

/**
 * Structural equality, insensitive to object key order (a server-rebuilt
 * `timeRange` must not diff against the decoded payload echo). Arrays stay
 * order-sensitive; anything non-JSON-shaped falls back to reference equality.
 */
export const structuralEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) return true
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
		return a.every((item, index) => structuralEqual(item, b[index]))
	}
	const aEntries = Object.entries(a)
	const bEntries = new Map(Object.entries(b))
	if (aEntries.length !== bEntries.size) return false
	return aEntries.every(([key, value]) => bEntries.has(key) && structuralEqual(value, bEntries.get(key)))
}

/**
 * Diff two snapshots restricted to the keys of `after` (the fields the request
 * actually touched — omitted fields are unchanged by contract). Returns
 * undefined when nothing changed so the audit entry can omit `changes`.
 */
export const diffAuditChanges = (
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): AuditChanges | undefined => {
	const fields: string[] = []
	const beforeOut: Record<string, unknown> = {}
	const afterOut: Record<string, unknown> = {}
	for (const key of Object.keys(after)) {
		const prev = before[key]
		const next = after[key]
		if (structuralEqual(prev, next)) continue
		fields.push(key)
		beforeOut[key] = prev
		afterOut[key] = next
	}
	return fields.length === 0 ? undefined : { fields, before: beforeOut, after: afterOut }
}

/**
 * Snapshot only the fields the update payload actually carries, reading their
 * values from a wire-shaped view of the resource (pre- or post-update).
 */
export const pickPresentFields = <K extends string>(
	keys: ReadonlyArray<K>,
	payload: { readonly [P in K]?: unknown },
	source: { readonly [P in K]: unknown },
): Record<string, unknown> => {
	const out: Record<string, unknown> = {}
	for (const key of keys) {
		if (payload[key] !== undefined) out[key] = source[key]
	}
	return out
}

/**
 * Replace selected fields' before/after values with a static placeholder so
 * large config blobs (dashboard widgets, query drafts) and secrets don't reach
 * the audit row. Null survives, so "cleared" still reads as cleared.
 */
export const compactAuditChanges = (
	changes: AuditChanges | undefined,
	// Call sites `satisfies Partial<Record<(typeof xAuditKeys)[number], string>>`
	// so a wire-key rename cannot silently disable a redaction placeholder.
	placeholders: Record<string, string>,
): AuditChanges | undefined => {
	if (changes === undefined) return undefined
	const before = { ...changes.before }
	const after = { ...changes.after }
	for (const field of changes.fields) {
		const placeholder = placeholders[field]
		if (placeholder === undefined) continue
		if (field in before && before[field] !== null) before[field] = placeholder
		if (field in after && after[field] !== null) after[field] = placeholder
	}
	return { fields: changes.fields, before, after }
}

/**
 * Strip userinfo, query string, and fragment from a URL destined for an audit
 * row — scrape URLs routinely embed tokens there. Keeps scheme/host/path.
 */
export const redactAuditUrl = (raw: string): string => {
	if (!URL.canParse(raw)) return "<invalid-url>"
	const url = new URL(raw)
	return `${url.protocol}//${url.host}${url.pathname}`
}
