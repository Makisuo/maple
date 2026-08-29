import type { AuditChanges } from "@maple/domain/http"

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
		if (JSON.stringify(prev) === JSON.stringify(next)) continue
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
 * Replace selected fields' before/after values with a compact summary so large
 * config blobs (dashboard widgets, query drafts) don't bloat the audit row.
 */
export const compactAuditChanges = (
	changes: AuditChanges | undefined,
	summarize: Record<string, (value: unknown) => unknown>,
): AuditChanges | undefined => {
	if (changes === undefined) return undefined
	const before: Record<string, unknown> = { ...changes.before }
	const after: Record<string, unknown> = { ...changes.after }
	for (const field of changes.fields) {
		const summary = summarize[field]
		if (summary === undefined) continue
		if (field in before) before[field] = summary(before[field])
		if (field in after) after[field] = summary(after[field])
	}
	return { fields: changes.fields, before, after }
}
