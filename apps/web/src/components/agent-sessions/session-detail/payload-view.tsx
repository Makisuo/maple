import { useMemo } from "react"

import { cn } from "@maple/ui/lib/utils"

import { tryParseJson } from "@/components/attributes"
import { highlightCode } from "@/lib/sugar-high"

/**
 * The rendered ↔ raw affordances every captured body shares, wherever it is
 * opened — a transcript block, the Traces expansion, the Flow drawer. Markdown
 * layout and pretty-printed JSON are readings of the capture, and a reading can
 * hide things — whitespace, key order, a literal `**` — so every rendered body
 * keeps a way back to the captured bytes.
 */

/**
 * A payload body, pretty-printed and highlighted where it parses as JSON
 * (object or array — same test as the log body), verbatim otherwise. An
 * emitter-truncated prefix fails the parse and stays verbatim, which is right:
 * pretty-printing a fragment would dress it up as a whole document.
 */
export function useJsonPayload(text: string): { formatted: string; highlighted: string | undefined } {
	return useMemo(() => {
		const parsed = tryParseJson(text)
		if (parsed === null) return { formatted: text, highlighted: undefined }
		const formatted = JSON.stringify(parsed, null, 2)
		return { formatted, highlighted: highlightCode(formatted) }
	}, [text])
}

/**
 * The rendered ↔ raw selector: two labelled segments where the selected one is
 * the view the reader is IN — a lone pressed icon named either the current view
 * or the one a click would bring, depending on who read it.
 */
export function ViewSwitch({
	rendered,
	raw,
	onRawChange,
	className,
}: {
	/** The rendered segment's label — what the rendering IS: "md" or "json". */
	rendered: string
	raw: boolean
	onRawChange: (raw: boolean) => void
	className?: string
}) {
	return (
		<span
			role="group"
			aria-label="Body view"
			className={cn(
				"flex shrink-0 items-center self-center overflow-hidden rounded-sm border border-border",
				className,
			)}
		>
			<ViewSegment active={!raw} onSelect={() => onRawChange(false)}>
				{rendered}
			</ViewSegment>
			<ViewSegment active={raw} onSelect={() => onRawChange(true)}>
				raw
			</ViewSegment>
		</span>
	)
}

/** One segment of a two-state switch; shared so a tool card's arguments ↔
 *  result selector reads exactly like the rendered ↔ raw one beside it. */
export function ViewSegment({
	active,
	onSelect,
	children,
}: {
	active: boolean
	onSelect: () => void
	children: string
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={(event) => {
				event.stopPropagation()
				onSelect()
			}}
			className={cn(
				"cursor-pointer px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em]",
				active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	)
}
