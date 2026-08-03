/**
 * Boundary converters between the app's epoch-ms number convention (domain
 * contracts, Clock.currentTimeMillis arithmetic) and the Postgres schema's
 * timestamptz columns (drizzle `mode: "date"` → JS Date). Keep time math in
 * ms-number space; wrap/unwrap only at the drizzle read/write boundary.
 */

export function msToDate(ms: number): Date
export function msToDate(ms: number | null): Date | null
export function msToDate(ms: number | null | undefined): Date | null
export function msToDate(ms: number | null | undefined): Date | null {
	return ms === null || ms === undefined ? null : new Date(ms)
}

export function dateToMs(date: Date): number
export function dateToMs(date: Date | null): number | null
export function dateToMs(date: Date | null | undefined): number | null
export function dateToMs(date: Date | null | undefined): number | null {
	return date === null || date === undefined ? null : date.getTime()
}
