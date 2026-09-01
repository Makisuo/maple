import * as React from "react"

const MAX_MATCHES = 40

/**
 * Occurrences of `query` inside `text`, as alternating plain/match segments.
 * Mirrors the backend predicate exactly: the whole query is one case-insensitive
 * substring (`Body ILIKE '%query%'` — tokens only accelerate the scan, they are
 * never matched on their own), so a reader never sees a highlight the query did
 * not cause, or a match the query did.
 */
export function splitOnMatches(text: string, query: string): ReadonlyArray<{ text: string; match: boolean }> {
	const needle = query.trim().toLowerCase()
	if (needle === "") return [{ text, match: false }]

	const haystack = text.toLowerCase()
	const segments: { text: string; match: boolean }[] = []
	let cursor = 0
	// A one-character query against a long JSON body would otherwise split the
	// line into thousands of nodes — on every row of a virtualized stream.
	for (let found = 0; found < MAX_MATCHES; found++) {
		const at = haystack.indexOf(needle, cursor)
		if (at === -1) break
		if (at > cursor) segments.push({ text: text.slice(cursor, at), match: false })
		segments.push({ text: text.slice(at, at + needle.length), match: true })
		cursor = at + needle.length
	}
	if (segments.length === 0) return [{ text, match: false }]
	if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
	return segments
}

interface HighlightedTextProps {
	text: string
	/** The active log search, or undefined when nothing is being searched for. */
	query?: string
}

/** Renders `text` with every occurrence of `query` marked. */
export const HighlightedText = React.memo(function HighlightedText({ text, query }: HighlightedTextProps) {
	const segments = React.useMemo(() => (query ? splitOnMatches(text, query) : undefined), [text, query])
	if (!segments) return text
	return segments.map((segment, index) =>
		segment.match ? (
			<mark
				key={index}
				className="rounded-[2px] bg-primary/30 px-px text-foreground [text-decoration:inherit]"
			>
				{segment.text}
			</mark>
		) : (
			<React.Fragment key={index}>{segment.text}</React.Fragment>
		),
	)
})
