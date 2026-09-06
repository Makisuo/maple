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
	// Keyed by the resource's declared field names (see `auditDiff`) so a wire-key
	// rename cannot silently disable a placeholder.
	placeholders: Record<string, string | undefined>,
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

/**
 * Build the `changes` diff for one resource's update handler.
 *
 * The spec is declared once next to the resource's wire shape and applied per
 * request: `fields` are diffed through the wire view, `summarize` replaces a
 * config blob's value with a static placeholder, `redact` rewrites a value
 * (scrape URLs carry tokens), `writeOnly` records credentials the response
 * never echoes as having rotated, and `opaque` records a knob the response does
 * not echo either but which is no secret — a channel id, a chat id — as simply
 * touched. `summarize` and `redact` are keyed by
 * `fields`, so a renamed wire key is a type error rather than a silently
 * disabled redaction.
 *
 * Returns undefined when nothing observable changed, so the caller passes the
 * result straight through as `changes`.
 */
const redactedField = (field: string): readonly [string, string] => [field, "<redacted>"]
const updatedField = (field: string): readonly [string, string] => [field, "<updated>"]

export const auditDiff = <Field extends string>(spec: {
	readonly fields: ReadonlyArray<Field>
	readonly summarize?: Partial<Record<Field, string>>
	readonly redact?: Partial<Record<Field, (value: string) => string>>
	readonly writeOnly?: ReadonlyArray<string>
	readonly opaque?: ReadonlyArray<string>
}) => {
	const redactors: Record<string, ((value: string) => string) | undefined> = spec.redact ?? {}

	const redactChanges = (changes: AuditChanges): AuditChanges => {
		const apply = (values: Record<string, unknown>): Record<string, unknown> => {
			const out = { ...values }
			for (const field of changes.fields) {
				const redact = redactors[field]
				const value = out[field]
				if (redact !== undefined && typeof value === "string") out[field] = redact(value)
			}
			return out
		}
		return { fields: changes.fields, before: apply(changes.before), after: apply(changes.after) }
	}

	return (
		payload: { readonly [P in Field]?: unknown },
		before: { readonly [P in Field]: unknown },
		after: { readonly [P in Field]: unknown },
	): AuditChanges | undefined => {
		const diffed = diffAuditChanges(
			pickPresentFields(spec.fields, payload, before),
			pickPresentFields(spec.fields, payload, after),
		)
		const compacted = diffed === undefined ? undefined : compactAuditChanges(diffed, spec.summarize ?? {})
		const observable = compacted === undefined ? undefined : redactChanges(compacted)
		// Neither kind appears in a response, so that the request carried them is
		// the only evidence they changed. They differ in what may be said about
		// them: a credential's value is withheld, a channel id's is simply not
		// known here.
		const present: Record<string, unknown> = payload
		const touched = [
			...(spec.writeOnly ?? []).filter((field) => present[field] !== undefined).map(redactedField),
			...(spec.opaque ?? []).filter((field) => present[field] !== undefined).map(updatedField),
		]
		if (touched.length === 0) return observable
		const placeholders = Object.fromEntries(touched)
		return {
			fields: [...(observable?.fields ?? []), ...touched.map(([field]) => field)],
			before: { ...observable?.before, ...placeholders },
			after: { ...observable?.after, ...placeholders },
		}
	}
}
