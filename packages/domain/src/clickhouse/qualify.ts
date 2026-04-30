/**
 * Source datasources that materialized views read from. Used by
 * `qualifyStatementForDatabase` to rewrite bare `FROM <name>` / `JOIN <name>`
 * references in MV bodies.
 */
export const CLICKHOUSE_MV_SOURCE_TABLES: ReadonlyArray<string> = [
	"traces",
	"logs",
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
]

/**
 * Rewrite a generated CREATE TABLE / CREATE MATERIALIZED VIEW statement to
 * fully qualify every Maple-managed identifier with the supplied database
 * name. Belt-and-suspenders: ClickHouse Cloud's new analyzer (24.x+) sometimes
 * fails to resolve unqualified table identifiers in materialized view bodies
 * even when the X-ClickHouse-Database header is set, surfacing as
 * `Code: 60. UNKNOWN_TABLE: <db>.<table>` at MV creation. Qualifying every
 * identifier sidesteps the analyzer's "current database" resolution entirely.
 *
 * Used by both the runtime API path (OrgClickHouseSettingsService.applySchema)
 * and the standalone CLI (`@maple/clickhouse-cli`).
 */
export const qualifyStatementForDatabase = (stmt: string, database: string): string => {
	if (database.length === 0) return stmt
	const ident = (name: string) => `\`${database}\`.\`${name}\``

	let result = stmt.replace(
		/^(CREATE TABLE\s+(?:IF NOT EXISTS\s+)?)([A-Za-z_][A-Za-z0-9_]*)/,
		(_match, prefix: string, name: string) => `${prefix}${ident(name)}`,
	)

	result = result.replace(
		/^(CREATE MATERIALIZED VIEW\s+(?:IF NOT EXISTS\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s+TO\s+)([A-Za-z_][A-Za-z0-9_]*)/,
		(_match, p1: string, view: string, mid: string, target: string) =>
			`${p1}${ident(view)}${mid}${ident(target)}`,
	)

	for (const table of CLICKHOUSE_MV_SOURCE_TABLES) {
		result = result.replace(
			new RegExp(`(\\bFROM|\\bJOIN)\\s+${table}\\b`, "g"),
			(_match, kw: string) => `${kw} ${ident(table)}`,
		)
	}

	return result
}
