import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

/** The session page's badge tones. One vocabulary, so an error reads the same
 *  on a waterfall row, a turn header and a transcript block. */
export const PILL_TONE = {
	error: "bg-destructive/12 text-destructive",
	warn: "bg-severity-warn/12 text-severity-warn",
	outline: "border border-border text-muted-foreground",
} satisfies Record<string, string>

/**
 * A small status badge.
 *
 * The default shape is the waterfall's — uppercase, tracked, rounded-full —
 * which is right for a one-word state. `className` is the escape hatch for a
 * badge whose content is a raw attribute value (`error.type
 * context_length_exceeded`), where upper-casing a wire string reads as shouting.
 */
export function Pill({
	tone,
	className,
	children,
}: {
	tone: keyof typeof PILL_TONE
	className?: string
	children: ReactNode
}) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full px-1.5 py-px font-medium text-[10px] uppercase tracking-wide",
				PILL_TONE[tone],
				className,
			)}
		>
			{children}
		</span>
	)
}
