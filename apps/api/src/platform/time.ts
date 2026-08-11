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

/**
 * Epoch-ms → ISO 8601 string, for interpolation into a raw `sql` template.
 *
 * Raw templates only. A drizzle *column* context (`.values()`, `.set()`,
 * `eq(col, …)`) carries the column's `mapToDriverValue` and converts a `Date`
 * itself — use `msToDate` there. A raw fragment has no column type behind it, so
 * whatever is interpolated reaches the driver verbatim, and the deployed
 * postgres.js path rejects a `Date` outright. Bind a string and pair it with the
 * explicit `::timestamptz` the statement already carries.
 */
export function msToSqlTimestamp(ms: number): string {
	return new Date(ms).toISOString()
}

export function dateToMs(date: Date): number
export function dateToMs(date: Date | null): number | null
export function dateToMs(date: Date | null | undefined): number | null
export function dateToMs(date: Date | null | undefined): number | null {
	return date === null || date === undefined ? null : date.getTime()
}
