import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export const TIMEZONE_STORAGE_KEY = "maple.preferences.timezone"
export const SYSTEM_VALUE = "__system__"

const DEFAULT_TIMEZONE = "UTC"

// Whether a zone name is one the runtime knows never changes, and asking is
// not cheap — building a formatter and running it. Every timestamp the app
// prints resolves its zone through here, which on a virtualized list is once
// per row per render: unmemoized it was the single hottest frame in a
// transcript scroll profile.
const knownZones = new Map<string, boolean>()

export function isValidIanaTimeZone(value: string): boolean {
	if (value.trim().length === 0) return false

	const known = knownZones.get(value)
	if (known !== undefined) return known
	let valid: boolean
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date())
		valid = true
	} catch {
		valid = false
	}
	knownZones.set(value, valid)
	return valid
}

export function getBrowserTimeZone(): string {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
		if (zone && isValidIanaTimeZone(zone)) {
			return zone
		}
	} catch {
		// fall through to UTC
	}

	return DEFAULT_TIMEZONE
}

export function resolveEffectiveTimezone(stored: string): string {
	if (stored === SYSTEM_VALUE) {
		return getBrowserTimeZone()
	}

	if (isValidIanaTimeZone(stored)) {
		return stored
	}

	return getBrowserTimeZone()
}

export function normalizeStoredTimezoneValue(value: string | null | undefined): string {
	if (!value || value === SYSTEM_VALUE) {
		return SYSTEM_VALUE
	}

	let decoded = value
	try {
		const parsed = JSON.parse(value) as unknown
		if (typeof parsed === "string") {
			decoded = parsed
		}
	} catch {
		// keep raw storage value
	}

	if (decoded === SYSTEM_VALUE) {
		return SYSTEM_VALUE
	}

	return isValidIanaTimeZone(decoded) ? decoded : SYSTEM_VALUE
}

export const timezonePreferenceAtom = Atom.kvs({
	runtime: localStorageRuntime,
	key: TIMEZONE_STORAGE_KEY,
	schema: Schema.String,
	defaultValue: () => SYSTEM_VALUE,
})
