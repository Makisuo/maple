// ---------------------------------------------------------------------------
// bench/table-map.ts — rewrite table identifiers in compiled SQL for A/B runs
//
// The sort-key spike compares the same suite against shadow tables (e.g.
// `traces` vs `traces_t2`). Rather than recompile the DSL against alternate
// table names, we rewrite `FROM <name>` / `JOIN <name>` in the already-compiled
// SQL. Rules apply longest-source-name-first and are anchored on whole
// identifiers so a `traces` rule never touches `trace_detail_spans` or
// `traces_aggregates_hourly`.
// ---------------------------------------------------------------------------

export type TableMap = ReadonlyMap<string, string>

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Parse `["traces=traces_t2", "logs=logs_l2"]` (or a single comma-joined string
 * split by the caller) into a source→target map. Throws on a malformed entry.
 */
export function parseTableMap(entries: ReadonlyArray<string>): TableMap {
	const map = new Map<string, string>()
	for (const raw of entries) {
		const entry = raw.trim()
		if (entry === "") continue
		const eq = entry.indexOf("=")
		if (eq <= 0 || eq === entry.length - 1) {
			throw new Error(`Invalid --table-map entry "${raw}" (expected from=to, e.g. traces=traces_t2)`)
		}
		map.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim())
	}
	return map
}

/**
 * Rewrite table identifiers in `sql`. Only rewrites the table position (directly
 * after `FROM` / `JOIN`), matching the whole identifier, so string literals or
 * column names that happen to share a table's name are untouched. Rules are
 * applied longest-source-first to avoid a short name shadowing a longer one.
 */
export function remapTables(sql: string, map: TableMap): string {
	if (map.size === 0) return sql
	const names = [...map.keys()].sort((a, b) => b.length - a.length)
	let out = sql
	for (const name of names) {
		const target = map.get(name)!
		const re = new RegExp(`(\\b(?:FROM|JOIN)\\s+)${escapeRegExp(name)}\\b`, "g")
		out = out.replace(re, `$1${target}`)
	}
	return out
}
