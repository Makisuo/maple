/**
 * Deduplicate and trim an array of `{ name: string }` items into a clean
 * string list. Used across every autocomplete-values consumer to normalise
 * facet results from Tinybird.
 */
export function toNames(items: Array<{ name: string }>): string[] {
	const seen = new Set<string>()
	const values: string[] = []
	for (const item of items) {
		const next = item.name.trim()
		if (!next || seen.has(next)) continue
		seen.add(next)
		values.push(next)
	}
	return values
}
