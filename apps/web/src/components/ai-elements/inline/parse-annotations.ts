import type { Segment } from "./types"

const ANNOTATION_RE = /^<<maple:(trace|service|error|log):(.+)>>$/gm

export function parseAnnotations(text: string): Segment[] {
	const segments: Segment[] = []
	let lastIndex = 0

	for (const match of text.matchAll(ANNOTATION_RE)) {
		const matchStart = match.index!
		// Add preceding text if any
		if (matchStart > lastIndex) {
			segments.push({ type: "text", content: text.slice(lastIndex, matchStart) })
		}

		const entityType = match[1] as "trace" | "service" | "error" | "log"
		const jsonStr = match[2]

		try {
			const data = JSON.parse(jsonStr)
			segments.push({ type: entityType, data })
		} catch {
			// Invalid JSON — treat the whole line as plain text
			segments.push({ type: "text", content: match[0] })
		}

		lastIndex = matchStart + match[0].length
	}

	// Add trailing text if any
	if (lastIndex < text.length) {
		segments.push({ type: "text", content: text.slice(lastIndex) })
	}

	// If no annotations found, return the original text as a single segment
	if (segments.length === 0) {
		segments.push({ type: "text", content: text })
	}

	return segments
}
