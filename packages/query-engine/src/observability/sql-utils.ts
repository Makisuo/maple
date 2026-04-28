/**
 * Escape a string for safe use in ClickHouse SQL literals.
 */
export function escapeForSQL(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}
