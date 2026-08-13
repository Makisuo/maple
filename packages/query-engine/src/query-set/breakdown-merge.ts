/**
 * Folding N breakdown results into chart-ready rows.
 *
 * Pure. Deliberately a different shape from the timeseries merge in
 * `series-merge.ts`: a breakdown has no bucket axis, so a single query returns
 * bare `{name, value}` rows and only a multi-query set widens into one column
 * per query. Collapsing the two merges into one would force every single-query
 * breakdown through the wide shape and change what every pie and bar chart
 * receives.
 */

/** One query's breakdown outcome. Failures are values, not thrown — see `runBreakdownQuerySet`. */
export interface BreakdownQueryResult {
	readonly queryId: string
	readonly queryName: string
	readonly status: "success" | "error"
	readonly error: string | null
	readonly data: ReadonlyArray<{ name: string; value: number }>
}

/** The label a query draws under: its legend if set, else its name. */
export function toDisplayName(query: { name: string; legend?: string }): string {
	const trimmedLegend = (query.legend ?? "").trim()
	return trimmedLegend || query.name
}

export function mergeBreakdownResults(
	results: ReadonlyArray<BreakdownQueryResult>,
	enabledQueries: ReadonlyArray<{ id: string; name: string; legend?: string }>,
): Array<Record<string, string | number>> {
	const successful = results.filter((r) => r.status === "success" && r.data.length > 0)
	if (successful.length === 0) return []

	// Single query: return simple { name, value } rows
	if (successful.length === 1) {
		return successful[0].data
			.map((item) => ({ name: item.name, value: item.value }))
			.sort((a, b) => b.value - a.value)
	}

	const rowsByName = new Map<string, Record<string, string | number>>()
	const columnNames: string[] = []
	const queriesById = new Map(enabledQueries.map((q) => [q.id, q]))

	for (const result of successful) {
		const query = queriesById.get(result.queryId)
		const displayName = query ? toDisplayName(query) : result.queryName
		columnNames.push(displayName)

		for (const item of result.data) {
			const row = rowsByName.get(item.name) ?? { name: item.name }
			row[displayName] = item.value
			rowsByName.set(item.name, row)
		}
	}

	// Zero-fill, same reason as the timeseries merge: an absent column reads as
	// missing data rather than as no events.
	for (const row of rowsByName.values()) {
		for (const col of columnNames) {
			if (typeof row[col] !== "number") {
				row[col] = 0
			}
		}
	}

	// Ordered by the first query's values — the one the author added first, which
	// is the one a reader treats as the subject of the chart.
	const firstCol = columnNames[0]
	return Array.from(rowsByName.values()).sort((a, b) => {
		const aVal = typeof a[firstCol] === "number" ? a[firstCol] : 0
		const bVal = typeof b[firstCol] === "number" ? b[firstCol] : 0
		return bVal - aVal
	})
}
