"use client"

import { useCallback, useRef, useState } from "react"

import { cn } from "../../lib/utils"
import { useCopy } from "../../hooks/use-copy"
import { useMountEffect } from "../../hooks/use-mount-effect"
import { HoverCard, HoverCardContent } from "../ui/hover-card"
import { tryParseJson, CopyableValue, CollapsibleJsonValue } from "../attributes"
import type { ChipTone } from "../../lib/log-attributes"

const TONE_CLASSES: Record<ChipTone, string> = {
	error: "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15",
	warn: "bg-warning/10 text-warning-foreground border-warning/20 hover:bg-warning/15",
	info: "bg-muted text-foreground/80 border-border hover:bg-muted/80",
	muted: "bg-muted/40 text-muted-foreground border-border/60 hover:bg-muted/70",
} satisfies Record<ChipTone, string>

const MAX_VALUE_CHARS = 24

/** Rest-to-reveal. Sweeping the cursor along a row of chips must open nothing. */
const OPEN_DELAY_MS = 300
/** Grace period for crossing the gap between the chip and its card. */
const CLOSE_DELAY_MS = 150

function truncateValue(value: string): string {
	if (value.length <= MAX_VALUE_CHARS) return value
	return value.slice(0, MAX_VALUE_CHARS - 1) + "…"
}

function shortKey(key: string): string {
	if (key === "http.status_code" || key === "http.response.status_code") return "status"
	if (key === "http.method" || key === "http.request.method") return "method"
	if (key === "http.url" || key === "url.full") return "url"
	if (key === "http.route" || key === "url.path") return "path"
	return key
}

export interface LogAttributeChipProps {
	attrKey: string
	value: string
	tone: ChipTone
}

/**
 * Compact, copy-on-click attribute pill rendered inline on a log row. Resting on
 * it reveals the full key/value (with JSON expansion). Copies the `key=value`
 * pair. The chip is too small to carry a status glyph, so this is one of the few
 * surfaces that toasts.
 *
 * Two constraints shape the hover plumbing, and they pull against each other.
 *
 * The card must never outlive the pointer. It used to: the chip swapped its bare
 * <button> for a Base UI trigger on first hover, and a node inserted under a
 * cursor that has already moved on never receives `pointerenter`, so the browser
 * never sends it the matching `pointerleave` either. One sweep across a row
 * stranded a card per chip it brushed, and they piled up over the detail drawer.
 * So the <button> below is mounted once and never wrapped or swapped — it is the
 * same DOM node for the life of the chip, and it always gets its leave event.
 *
 * The card must also stay cheap. A wide virtualized row carries a dozen chips
 * and ~28 rows are live at once, so mounting Base UI's `PreviewCard.Root` per
 * chip — even closed, even with the popup deferred — more than doubled React
 * render time during a scroll on the /lab/bench/logs gate. So the card mounts as an
 * anchored *sibling*, only while it is actually shown. Open/close is driven from
 * the stable button rather than by Base UI's hover machinery, which is the price
 * of not having a Base UI trigger for that machinery to attach to.
 */
export function LogAttributeChip({ attrKey, value, tone }: LogAttributeChipProps) {
	const [open, setOpen] = useState(false)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const { copy } = useCopy({ successMessage: `Copied ${attrKey}` })
	const parsed = tryParseJson(value)
	const displayValue = parsed !== null ? "{…}" : truncateValue(value)
	const displayKey = shortKey(attrKey)

	const clearTimers = useCallback(() => {
		if (openTimer.current) clearTimeout(openTimer.current)
		if (closeTimer.current) clearTimeout(closeTimer.current)
		openTimer.current = null
		closeTimer.current = null
	}, [])

	const scheduleOpen = useCallback(() => {
		clearTimers()
		openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS)
	}, [clearTimers])

	const scheduleClose = useCallback(() => {
		clearTimers()
		closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
	}, [clearTimers])

	/** Reaching into the card to copy a value must not dismiss it. */
	const keepOpen = useCallback(() => {
		clearTimers()
		setOpen(true)
	}, [clearTimers])

	const closeNow = useCallback(() => {
		clearTimers()
		setOpen(false)
	}, [clearTimers])

	// A row can scroll out with a timer pending. Never let one fire into an
	// unmounted chip.
	useMountEffect(() => clearTimers)

	// The virtualizer recycles this chip across logs rather than remounting it,
	// so a new key/value pair means the same DOM node now describes a different
	// attribute — and anything already on screen described the old one. Adjusted
	// during render rather than in an effect, the same way `LogDetailSheet`
	// re-syncs its viewed log.
	const identity = `${attrKey}\0${value}`
	const [syncedIdentity, setSyncedIdentity] = useState(identity)
	if (identity !== syncedIdentity) {
		setSyncedIdentity(identity)
		clearTimers()
		setOpen(false)
	}

	const handleCopy = (e: React.SyntheticEvent) => {
		e.stopPropagation()
		void copy(`${attrKey}=${value}`)
	}

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				// Names the chip by its action and carries the *untruncated* pair: the
				// visible label clips the value at MAX_VALUE_CHARS. Deliberately no
				// `title` — a native tooltip on its own browser-controlled schedule
				// would fire alongside the card.
				aria-label={`Copy ${attrKey}=${value}`}
				onPointerEnter={scheduleOpen}
				onPointerLeave={scheduleClose}
				onFocus={scheduleOpen}
				onBlur={closeNow}
				onPointerDown={(e) => e.stopPropagation()}
				onClick={handleCopy}
				onKeyDown={(e) => {
					if (e.key === "Escape") closeNow()
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault()
						handleCopy(e)
					}
				}}
				className={cn(
					"inline-flex items-center gap-1 h-[18px] px-1.5 rounded border text-[10px] font-mono leading-none whitespace-nowrap shrink-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					TONE_CLASSES[tone],
				)}
			>
				<span className="opacity-70">{displayKey}</span>
				<span className="opacity-40">:</span>
				<span>{displayValue}</span>
			</button>
			{open && (
				<HoverCard open onOpenChange={(next) => !next && closeNow()}>
					<HoverCardContent
						align="start"
						anchor={triggerRef}
						className="w-80 p-0"
						onPointerEnter={keepOpen}
						onPointerLeave={scheduleClose}
					>
						<div className="px-3 py-2 border-b">
							<div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
								Attribute
							</div>
							<div className="font-mono text-xs break-all">
								<CopyableValue value={attrKey}>{attrKey}</CopyableValue>
							</div>
						</div>
						<div className="px-3 py-2">
							<div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
								Value
							</div>
							<div className="font-mono text-xs break-all">
								{parsed !== null ? (
									<CollapsibleJsonValue value={value} parsed={parsed} />
								) : (
									<CopyableValue value={value}>{value}</CopyableValue>
								)}
							</div>
						</div>
					</HoverCardContent>
				</HoverCard>
			)}
		</>
	)
}
