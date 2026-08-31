import { useMemo } from "react"

import { cn } from "@maple/ui/lib/utils"

import { MessageResponse } from "@/components/ai-elements/message-response"
import { tryParseJson } from "@/components/attributes"
import { highlightCode } from "@/lib/sugar-high"
import { ClampedText } from "./clamped-text"

/**
 * The rendered ↔ raw affordances every captured body shares, wherever it is
 * opened — a transcript block, the span popover. Markdown
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
 * A message body's rendering, chosen from the capture: markdown for prose, the
 * payload cards' pretty-printed JSON where the text parses as a JSON document —
 * a JSON message laid out as markdown collapses its structure into one
 * paragraph. `rendered` names the choice and is what the ViewSwitch shows.
 */
export function useMessageBody(text: string): {
	rendered: "md" | "json"
	formatted: string
	highlighted: string | undefined
} {
	const payload = useJsonPayload(text)
	return { rendered: payload.highlighted === undefined ? "md" : "json", ...payload }
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

/** One segment of the two-state switch. */
function ViewSegment({
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

/**
 * Whether a keyed disclosure is open, given the default its section opens with.
 * Presence in the set means "flipped away from the default", so a toolbar chip
 * that changes the default still moves every row the reader has not touched.
 *
 * The set lives with the caller, never in the row: the transcript virtualizes,
 * and local state would leave with the row when it scrolls out of view.
 */
export function disclosed(openRows: ReadonlySet<string>, key: string, byDefault: boolean): boolean {
	return openRows.has(key) ? !byDefault : byDefault
}

/** The set with `id` flipped — the only write the disclosure set ever takes. */
export function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
	const next = new Set(set)
	if (!next.delete(id)) next.add(id)
	return next
}

/**
 * A captured message body, in whichever reading is selected, clamped with a
 * "Show full" control. Every message the transcript shows goes through here:
 * an uncapped body — one 900-line reply, one pasted file — pushes every row
 * after it off the page, and the list stops being a list.
 */
export function MessageBody({
	text,
	body,
	raw,
	clampClass,
	proseClassName = "text-foreground text-sm leading-relaxed",
	expanded,
	onToggleExpanded,
}: {
	text: string
	/** The reading chosen by `useMessageBody`, hoisted so the caller's ViewSwitch
	 *  can label the segment it selects. */
	body: { rendered: "md" | "json"; formatted: string; highlighted: string | undefined }
	raw: boolean
	clampClass?: string
	proseClassName?: string
	expanded: boolean
	onToggleExpanded: () => void
}) {
	return (
		<ClampedText
			text={raw ? text : body.formatted}
			html={raw ? undefined : body.highlighted}
			mono={!raw && body.rendered === "json"}
			clampClass={clampClass}
			body={
				raw || body.rendered === "json" ? undefined : (
					<MessageResponse className={proseClassName}>{text}</MessageResponse>
				)
			}
			expanded={expanded}
			onToggleExpanded={onToggleExpanded}
		/>
	)
}
