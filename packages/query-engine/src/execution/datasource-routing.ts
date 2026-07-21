/**
 * Datasources that are written via `ingest` (hard-pinned to the managed
 * Tinybird pipeline) and have NO per-org materialization — they simply do not
 * exist in a BYO ClickHouse. Reads of these tables must route with purpose
 * "ingest" (declare `.routing("ingest")` at the query definition).
 *
 * The executor uses this list as a safety net: a read that resolves to an
 * org-BYO backend while referencing one of these tables would silently return
 * empty rows, so it logs a warning instead of failing quietly.
 */
export const INGEST_PINNED_TABLES: ReadonlyArray<string> = ["alert_checks"]

export const findIngestPinnedTable = (sql: string): string | undefined =>
	INGEST_PINNED_TABLES.find((table) => sql.includes(table))
