import { useLayoutEffect, useRef, useState } from "react"

import { cn } from "@maple/ui/lib/utils"

/** A message body clamps at ~12 lines with a "show full" control: prompts run
 *  to tens of thousands of tokens, and the list has to stay navigable. */
const CLAMP_CLASS = "line-clamp-[12]"

/**
 * A body that clamps with a "Show full" control. Overflow is measured, not
 * guessed from length: 12 short lines fit and never grow a control, while one
 * very long line wraps past the clamp and does.
 *
 * Shared by the span expansion and the transcript so a payload reads the same
 * wherever it was opened. Expansion is local by default and CONTROLLED where
 * the caller passes `expanded`: the transcript virtualizes its rows, so a row
 * scrolled out of view unmounts, and local state would take what the reader
 * opened with it.
 */
export function ClampedText({
	text,
	mono = false,
	/** Lines before clamping; the default is the expansion's twelve. */
	clampClass = CLAMP_CLASS,
	/** Overrides the body's text color — an errored payload reads as one. */
	toneClass,
	expanded: controlledExpanded,
	onToggleExpanded,
}: {
	text: string
	mono?: boolean
	clampClass?: string
	toneClass?: string
	/** Controlled expansion; omit to keep the state in this component. */
	expanded?: boolean
	onToggleExpanded?: () => void
}) {
	const [localExpanded, setLocalExpanded] = useState(false)
	const expanded = controlledExpanded ?? localExpanded
	const [clamped, setClamped] = useState(false)
	const bodyRef = useRef<HTMLDivElement>(null)

	useLayoutEffect(() => {
		const body = bodyRef.current
		if (body === null || expanded) return
		setClamped(body.scrollHeight > body.clientHeight + 1)
	}, [text, expanded])

	return (
		<div className="min-w-0">
			<div
				ref={bodyRef}
				className={cn(
					"whitespace-pre-wrap break-words",
					mono
						? "font-mono text-muted-foreground text-xs leading-relaxed"
						: "max-w-[70rem] text-foreground text-sm leading-relaxed",
					toneClass,
					!expanded && clampClass,
				)}
			>
				{text}
			</div>
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
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim()
		if (line !== "") return line
	}
	return ""
}
