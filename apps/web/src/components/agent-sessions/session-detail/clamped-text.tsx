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
 * wherever it was opened.
 */
export function ClampedText({
	text,
	mono = false,
	/** Lines before clamping; the default is the expansion's twelve. */
	clampClass = CLAMP_CLASS,
	/** Overrides the body's text color — an errored payload reads as one. */
	toneClass,
}: {
	text: string
	mono?: boolean
	clampClass?: string
	toneClass?: string
}) {
	const [expanded, setExpanded] = useState(false)
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
					onClick={() => setExpanded((previous) => !previous)}
					className="mt-1 cursor-pointer text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
				>
					{expanded ? "Show less" : "Show full"}
				</button>
			)}
		</div>
	)
}
