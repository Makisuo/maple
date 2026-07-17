"use client"

import { useRef, useState } from "react"

import { cn } from "../../lib/utils"
import { useClipboard } from "../../hooks/use-clipboard"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card"
import { tryParseJson, CopyableValue, CollapsibleJsonValue, useAttributesConfig } from "../attributes"
import type { ChipTone } from "../../lib/log-attributes"

const TONE_CLASSES: Record<ChipTone, string> = {
	error: "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15",
	warn: "bg-warning/10 text-warning-foreground border-warning/20 hover:bg-warning/15",
	info: "bg-muted text-foreground/80 border-border hover:bg-muted/80",
	muted: "bg-muted/40 text-muted-foreground border-border/60 hover:bg-muted/70",
}

const MAX_VALUE_CHARS = 24

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
 * Compact, copy-on-click attribute pill rendered inline on a log row. Hovering
 * reveals the full key/value (with JSON expansion). Copies the `key=value` pair
 * and reports it through `AttributesProvider`'s `notifyCopied`.
 */
export function LogAttributeChip({ attrKey, value, tone }: LogAttributeChipProps) {
	const [detailsEnabled, setDetailsEnabled] = useState(false)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const clipboard = useClipboard()
	const { notifyCopied } = useAttributesConfig()
	const parsed = tryParseJson(value)
	const displayValue = parsed !== null ? "{…}" : truncateValue(value)
	const displayKey = shortKey(attrKey)

	const handleCopy = (e: React.SyntheticEvent) => {
		e.stopPropagation()
		clipboard.copy(`${attrKey}=${value}`)
		notifyCopied?.(`Copied ${attrKey}`)
	}

	const trigger = (
		<button
			ref={triggerRef}
			type="button"
			onPointerEnter={() => setDetailsEnabled(true)}
			onFocus={() => {
				if (detailsEnabled) return
				setDetailsEnabled(true)
				// Wrapping the trigger in Base UI remounts it once. Restore keyboard
				// focus after that upgrade so deferred details stay accessible.
				queueMicrotask(() => triggerRef.current?.focus({ preventScroll: true }))
			}}
			onPointerDown={(e) => e.stopPropagation()}
			onClick={handleCopy}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					handleCopy(e)
				}
			}}
			className={cn(
				"inline-flex items-center gap-1 h-[18px] px-1.5 rounded border text-[10px] font-mono leading-none whitespace-nowrap shrink-0 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				TONE_CLASSES[tone],
			)}
			title={`${attrKey}=${value}`}
		>
			<span className="opacity-70">{displayKey}</span>
			<span className="opacity-40">:</span>
			<span>{displayValue}</span>
		</button>
	)

	// A wide virtualized row can contain dozens of chips. Base UI's complete
	// hover-card machinery is useful only for the chip a person actually
	// inspects, so keep the identical copyable trigger cheap until hover/focus.
	if (!detailsEnabled) return trigger

	return (
		<HoverCard defaultOpen>
			<HoverCardTrigger render={trigger} />
			<HoverCardContent align="start" className="w-80 p-0">
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
	)
}
