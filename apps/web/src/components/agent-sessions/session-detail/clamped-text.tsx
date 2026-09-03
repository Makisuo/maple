import { useLayoutEffect, useMemo, useRef, useState } from "react"

import { cn } from "@maple/ui/lib/utils"

import { MessageResponse } from "@/components/ai-elements/message-response"
import { highlightCode } from "@/lib/sugar-high"

/**
 * The clamps in use, by line count. A table rather than a class string so the
 * body knows the NUMBER — that is what lets it tell a body overruns its clamp
 * without asking the layout engine — while Tailwind still sees every class.
 */
const CLAMP_CLASSES = {
	6: "line-clamp-[6]",
	8: "line-clamp-[8]",
	12: "line-clamp-[12]",
	14: "line-clamp-[14]",
	24: "line-clamp-[24]",
} as const

export type ClampLines = keyof typeof CLAMP_CLASSES

/** A message body clamps at ~12 lines with a "show full" control: prompts run
 *  to tens of thousands of tokens, and the list has to stay navigable. */
const DEFAULT_CLAMP: ClampLines = 12

/**
 * What a clamped body mounts.
 *
 * A CSS clamp hides lines, it does not skip them: a megabyte tool result set
 * under `line-clamp-[14]` is still laid out whole and, highlighted, is a
 * hundred thousand elements for fourteen visible lines — and a virtualized
 * list mounts that again every time the row scrolls back in. So a clamped
 * body renders a prefix: three times the deepest clamp in use, so that even
 * markdown with a blank line between every line overruns it, and few enough
 * that the largest payload costs what a short one does. Once opened, the
 * whole body mounts.
 */
const PREVIEW_LINES = 72
/** A single line this long wraps past any clamp at any width. */
const PREVIEW_CHARS = 8_000
/**
 * Past this an opened body is set as plain text. Highlighting or laying out
 * markdown for a payload this size is seconds of work for a wall of elements
 * nobody reads as prose; the bytes are all still there, and still copy.
 */
const RENDER_LIMIT_CHARS = 200_000

/** How a body is set: verbatim, highlighted as JSON, or laid out as markdown. */
export type ClampedRendering = "text" | "json" | "md"

/** The prefix of `text` a clamped body mounts — `text` itself when it is short. */
export function previewOf(text: string): string {
	let end = Math.min(text.length, PREVIEW_CHARS)
	let lines = 0
	let at = text.indexOf("\n")
	while (at !== -1 && at < end) {
		if (++lines === PREVIEW_LINES) {
			end = at
			break
		}
		at = text.indexOf("\n", at + 1)
	}
	return end === text.length ? text : text.slice(0, end)
}

/** Whether `text` has more than `lines` lines — stops counting as soon as it knows. */
function exceedsLines(text: string, lines: number): boolean {
	let count = 1
	let at = text.indexOf("\n")
	while (at !== -1) {
		if (++count > lines) return true
		at = text.indexOf("\n", at + 1)
	}
	return false
}

/**
 * A body that clamps with a "Show full" control. Overflow is measured where
 * it has to be, not guessed from length: 12 short lines fit and never grow a
 * control, while one very long line wraps past the clamp and does.
 *
 * The body owns its rendering — the JSON highlight, the markdown layout — so
 * that only what is mounted is ever dressed up: the preview while clamped,
 * the whole text once opened. Shared by the span expansion and the transcript
 * so a payload reads the same wherever it was opened. Expansion is local by
 * default and CONTROLLED where the caller passes `expanded`: the transcript
 * virtualizes its rows, so a row scrolled out of view unmounts, and local
 * state would take what the reader opened with it.
 */
export function ClampedText({
	text,
	rendering = "text",
	mono = false,
	clampLines = DEFAULT_CLAMP,
	toneClass,
	proseClassName = "text-foreground text-sm leading-relaxed",
	expanded: controlledExpanded,
	onToggleExpanded,
}: {
	text: string
	rendering?: ClampedRendering
	mono?: boolean
	/** Lines before clamping; the default is the expansion's twelve. */
	clampLines?: ClampLines
	/** Overrides the body's text color — an errored payload reads as one. */
	toneClass?: string
	/** The markdown body's prose classes. */
	proseClassName?: string
	/** Controlled expansion; omit to keep the state in this component. */
	expanded?: boolean
	onToggleExpanded?: () => void
}) {
	const [localExpanded, setLocalExpanded] = useState(false)
	const expanded = controlledExpanded ?? localExpanded
	const bodyRef = useRef<HTMLDivElement>(null)

	const shown = useMemo(() => (expanded ? text : previewOf(text)), [text, expanded])
	const cut = shown.length < text.length
	const effective: ClampedRendering =
		rendering !== "text" && shown.length > RENDER_LIMIT_CHARS ? "text" : rendering
	const html = useMemo(() => (effective === "json" ? highlightCode(shown) : undefined), [effective, shown])

	// Whether the body overruns its clamp, known without a layout wherever it
	// can be: a cut preview always does, and a verbatim body with more lines
	// than the clamp does. Only a short body, or markdown, is measured — and
	// off the layout the browser was about to do anyway, not by reading
	// `scrollHeight` in the effect, which forces one. On a list that mounts
	// rows every scroll frame those forced layouts were most of what a frame
	// cost. The observer also re-measures on a width change, which a
	// one-shot read never did.
	const knownClamped = cut || (effective !== "md" && exceedsLines(shown, clampLines))
	const [measuredClamped, setMeasuredClamped] = useState(false)
	useLayoutEffect(() => {
		const measured = bodyRef.current
		if (measured === null || expanded || knownClamped) return
		const observer = new ResizeObserver(() => {
			setMeasuredClamped(measured.scrollHeight > measured.clientHeight + 1)
		})
		observer.observe(measured)
		return () => observer.disconnect()
	}, [expanded, knownClamped])
	const clamped = knownClamped || measuredClamped

	return (
		<div className="min-w-0">
			<div
				ref={bodyRef}
				className={cn(
					// A rendered body lays out its own blocks; pre-wrap is for raw text.
					effective !== "md" && "whitespace-pre-wrap",
					"break-words",
					mono
						? "font-mono text-muted-foreground text-xs leading-relaxed"
						: "max-w-[70rem] text-foreground text-sm leading-relaxed",
					toneClass,
					!expanded && CLAMP_CLASSES[clampLines],
				)}
				{...(effective === "md"
					? {
							children: (
								<MessageResponse className={proseClassName} mode="static" lightweight>
									{shown}
								</MessageResponse>
							),
						}
					: html === undefined
						? { children: shown }
						: { dangerouslySetInnerHTML: { __html: html } })}
			/>
			{(clamped || expanded) && (
				<button
					type="button"
					onClick={() =>
						onToggleExpanded === undefined
							? setLocalExpanded((previous) => !previous)
							: onToggleExpanded()
					}
					aria-expanded={expanded}
					className="mt-1 cursor-pointer text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
				>
					{expanded ? "Show less" : "Show full"}
				</button>
			)}
		</div>
	)
}

/** The first line worth showing of a body — a collapsed disclosure's preview.
 *  Shared so the transcript and the span expansion elide identically. */
export function firstLine(text: string): string {
	let start = 0
	while (start < text.length) {
		const end = text.indexOf("\n", start)
		const line = text.slice(start, end === -1 ? text.length : end).trim()
		if (line !== "") return line
		if (end === -1) break
		start = end + 1
	}
	return ""
}
