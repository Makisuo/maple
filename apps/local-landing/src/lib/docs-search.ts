/**
 * Shared types + content helpers for the docs ⌘K search.
 *
 * Pure string utilities only (no browser/node globals at module scope), so this
 * file is safe to import from both the build-time index endpoint
 * (`pages/docs/search-index.json.ts`) and the client island (`DocsSearch.tsx`).
 */

export interface SearchDoc {
	/** Collection entry id, e.g. `guides/instrumentation-node`. */
	id: string
	/** Destination route, e.g. `/docs/guides/instrumentation-node`. */
	url: string
	title: string
	description: string
	group: string
	/** Heading text joined with " · " — weighted highly for relevance. */
	headings: string
	/** Plain-text body (markdown stripped, code identifiers kept). */
	content: string
}

/** Per-doc body cap. Bodies are small; this just bounds the worst case. */
export const CONTENT_CHAR_CAP = 6000

/**
 * Strip markdown/MDX syntax down to searchable plain text while KEEPING code
 * identifiers (env vars, function names, error strings) that users search for —
 * we drop the code-fence markers but keep the code inside.
 */
export function stripMarkdown(md: string): string {
	return md
		.replace(/^\s*(?:import|export)\s.*$/gm, " ") // MDX import/export lines
		.replace(/```[^\n]*\n?/g, " ") // fenced code markers (keep inner code text)
		.replace(/`+/g, " ") // inline code backticks
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> link text
		.replace(/<[^>]+>/g, " ") // html / jsx tags
		.replace(/[#>*_~|]/g, " ") // remaining markdown punctuation
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, CONTENT_CHAR_CAP)
}

/** Extract ATX heading text (`## Foo`), skipping fenced code blocks. */
export function extractHeadings(md: string): string[] {
	const headings: string[] = []
	let inFence = false
	for (const line of md.split("\n")) {
		if (line.trim().startsWith("```")) {
			inFence = !inFence
			continue
		}
		if (inFence) continue
		const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
		if (match) headings.push(match[1].replace(/[`*_]/g, "").trim())
	}
	return headings
}
