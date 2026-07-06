/**
 * Migration 0005 — alert_checks error columns.
 *
 * Failed alert evaluations now write an audit row (Status='error') instead of
 * disappearing into logs. ErrorMessage carries the failure message; ErrorCategory
 * the failure classification (e.g. "validation", "tinybird_quota"). ErrorCategory
 * uses a plain LowCardinality(String) with '' default rather than Nullable —
 * LowCardinality(Nullable) is awkward in ClickHouse and '' reads as "not an error
 * row".
 */
export const migration_0005_alert_checks_error_columns = {
	version: 5,
	description: "Add ErrorMessage/ErrorCategory columns to alert_checks for failed-evaluation audit rows",
	statements: [
		"ALTER TABLE alert_checks ADD COLUMN IF NOT EXISTS ErrorMessage Nullable(String)",
		"ALTER TABLE alert_checks ADD COLUMN IF NOT EXISTS ErrorCategory LowCardinality(String) DEFAULT ''",
	],
} as const
