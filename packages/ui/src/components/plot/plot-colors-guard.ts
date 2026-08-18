/**
 * Throws on any colour a canvas cannot resolve.
 *
 * `"currentColor"` and `var(--token)` both paint correctly under the SVG
 * renderer and resolve to NOTHING under canvas — the 2D context takes literal
 * colour strings. Because the two renderers share one definition object, a chart
 * written against SVG looks perfect locally and paints an invisible series in
 * production. This rule was written down twice before and still shipped broken,
 * so it is enforced rather than documented.
 *
 * Dev only, and bounded: the walk stops at `MAX_DEPTH` and skips functions, so a
 * definition holding accessors or a large `data` array costs nothing meaningful.
 */
const UNRESOLVABLE_COLOR = /var\(|currentcolor/i
const MAX_WALK_DEPTH = 6

export function assertResolvedColors(definition: unknown, ariaLabel: string): void {
	const seen = new Set<object>()

	const walk = (value: unknown, depth: number, path: string): void => {
		if (depth > MAX_WALK_DEPTH) return
		if (typeof value === "string") {
			if (UNRESOLVABLE_COLOR.test(value)) {
				throw new Error(
					`PlotFrame(${ariaLabel}): unresolvable colour ${JSON.stringify(value)} at ${path}. ` +
						`Canvas cannot resolve var() or currentColor — resolve every colour to a literal ` +
						`with usePlotColors/resolvePlotColor before it reaches the definition.`,
				)
			}
			return
		}
		if (typeof value !== "object" || value === null) return
		if (seen.has(value)) return
		seen.add(value)

		if (Array.isArray(value)) {
			// Only the head of a data array can say anything the tail doesn't — a
			// colour literal lives on mark OPTIONS, not on rows.
			for (let index = 0; index < Math.min(value.length, 24); index += 1) {
				walk(value[index], depth + 1, `${path}[${index}]`)
			}
			return
		}
		for (const [key, nested] of Object.entries(value)) {
			if (typeof nested === "function") continue
			walk(nested, depth + 1, `${path}.${key}`)
		}
	}

	walk(definition, 0, "definition")
}
