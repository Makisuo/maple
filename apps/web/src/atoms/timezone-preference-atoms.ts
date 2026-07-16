import { Atom } from "@/lib/effect-atom"
import { Schema } from "effect"
import { browserTimeZoneId, makeTimeZoneId, type TimeZoneId } from "@maple/ui/lib/time-format"
import { localStorageRuntime } from "@/lib/services/common/storage-runtime"

export const TIMEZONE_STORAGE_KEY = "maple.preferences.timezone"
export const SYSTEM_VALUE = "__system__"

export function isValidIanaTimeZone(value: string): boolean {
	if (value.trim().length === 0) return false

	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date())
		return true
	} catch {
		return false
	}
}

export function getBrowserTimeZone(): TimeZoneId {
	return browserTimeZoneId()
}

export function resolveEffectiveTimezone(stored: string): TimeZoneId {
	if (stored === SYSTEM_VALUE) {
		return getBrowserTimeZone()
	}

	if (isValidIanaTimeZone(stored)) {
		return makeTimeZoneId(stored)
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
