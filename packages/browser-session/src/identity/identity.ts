/**
 * Who the current visitor is.
 *
 * Held in module memory only — never written to localStorage/sessionStorage.
 * An email at rest in browser storage is a PII surface with no upside here: the
 * identity is re-attached to every metadata row the SDK posts, so there is
 * nothing to persist across a reload that the host app won't re-`identify()`.
 */

/** Trait values a host app may pass. Coerced to strings before they leave. */
export type TraitValue = string | number | boolean | null | undefined

export interface MapleIdentity {
	readonly id?: string
	readonly email?: string
	readonly username?: string
	/** Company / team / tenant — the grouping dimension in the sessions UI. */
	readonly groupId?: string
	readonly groupName?: string
	/** Open-ended attributes (plan, role, …). Capped; see `MAX_TRAITS`. */
	readonly traits?: Readonly<Record<string, TraitValue>>
}

/**
 * `identify` accepts a bare user id as well as the full object — the string
 * form is what every existing caller passes, and keeping it means this can ship
 * without touching them.
 */
export type IdentifyInput = string | null | undefined | MapleIdentity

export interface ResolvedIdentity {
	readonly id?: string
	readonly email?: string
	readonly username?: string
	readonly groupId?: string
	readonly groupName?: string
	/** Coerced + capped for row size; the warehouse column is `Map(String, String)`. */
	readonly traits: Readonly<Record<string, string>>
}

/**
 * Trait caps. The warehouse column is `Map(String, String)` — plain keys
 * precisely because they are arbitrary — so the cost of a unique key per user
 * is row size and query-time map width rather than a churned dictionary. The
 * cap bounds one row's damage; `warnOnIdLikeTraitKey` surfaces the pattern to
 * whoever wrote it, since an id in a trait key is nearly always a mistake.
 */
const MAX_TRAITS = 24
const MAX_TRAIT_KEY_LENGTH = 64
const MAX_TRAIT_VALUE_LENGTH = 256

let warnedAboutTraitKeys = false

/** Heuristic: a trait *key* that looks like an id is almost always a mistake. */
function looksLikeId(key: string): boolean {
	return /^[0-9a-f]{8,}$/i.test(key) || /^(usr|user|org|cus|acct)_/i.test(key)
}

function coerceTraitValue(value: TraitValue): string | undefined {
	if (value === null || value === undefined) return undefined
	const text = typeof value === "string" ? value : String(value)
	return text.slice(0, MAX_TRAIT_VALUE_LENGTH)
}

function normalizeTraits(traits: Readonly<Record<string, TraitValue>> | undefined): Record<string, string> {
	if (!traits) return {}
	const out: Record<string, string> = {}
	for (const [rawKey, rawValue] of Object.entries(traits)) {
		if (Object.keys(out).length >= MAX_TRAITS) break
		const value = coerceTraitValue(rawValue)
		if (value === undefined) continue
		const key = rawKey.slice(0, MAX_TRAIT_KEY_LENGTH)
		if (!key) continue
		if (!warnedAboutTraitKeys && looksLikeId(key)) {
			warnedAboutTraitKeys = true
			console.warn(
				`[maple] identity trait key "${key}" looks like an id. Trait keys share a ClickHouse ` +
					"dictionary — put ids in the value, or in id/groupId, not the key.",
			)
		}
		out[key] = value
	}
	return out
}

function trimmed(value: string | undefined): string | undefined {
	const text = value?.trim()
	return text ? text : undefined
}

/**
 * Normalize whatever a host app passed into the shape the metadata row wants.
 *
 * Each call *replaces* the identity rather than merging into the previous one.
 * Merging would leak a signed-out user's email into the next person to use a
 * shared device, and replacement is what the existing string-only `identify`
 * already did.
 */
export function normalizeIdentity(input: IdentifyInput): ResolvedIdentity | undefined {
	if (input === null || input === undefined) return undefined
	if (typeof input === "string") {
		const id = trimmed(input)
		return id ? { id, traits: {} } : undefined
	}
	const resolved: ResolvedIdentity = {
		id: trimmed(input.id),
		email: trimmed(input.email),
		username: trimmed(input.username),
		groupId: trimmed(input.groupId),
		groupName: trimmed(input.groupName),
		traits: normalizeTraits(input.traits),
	}
	// An object with nothing usable in it reads as "clear the identity" — the
	// same as identify(undefined).
	const hasAnything =
		resolved.id ||
		resolved.email ||
		resolved.username ||
		resolved.groupId ||
		resolved.groupName ||
		Object.keys(resolved.traits).length > 0
	return hasAnything ? resolved : undefined
}
