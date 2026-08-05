import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { ArrowsSwapIcon, CircleWarningIcon, SquareRedactedIcon, XmarkIcon } from "@/components/icons"
import type { JourneyEventData } from "./journey-model"
import { formatTokensCompact, humaniseFinishReason } from "./journey-format"

// ---------------------------------------------------------------------------
// Badge grammar.
//
// Three tones, and the rule that gives them meaning: **success gets no badge**.
// A badge exists only where a fact changes how the message should be read.
//
//   neutral — a fact worth knowing, nothing is wrong  (cached 8.2k, reasoning 1,240)
//   amber   — the message reads normally but isn't what you think (CUT OFF AT max_tokens)
//   red     — this turn produced nothing usable (PROVIDER ERROR)
//
// Deliberately not the shadcn `Badge`: these sit inline in a 14px metadata row
// at 11px with 5px of padding, and every attempt to reach that from `Badge`'s
// size scale ends in a `className` that overrides more than it keeps.
// ---------------------------------------------------------------------------

export type JourneyBadgeTone = "neutral" | "amber" | "red" | "live"

const toneClasses: Record<JourneyBadgeTone, string> = {
	neutral: "bg-muted text-foreground/75",
	amber: "bg-warning/12 text-warning-foreground font-medium dark:bg-warning/16",
	red: "bg-destructive/12 text-destructive-foreground font-medium dark:bg-destructive/16",
	live: "bg-warning/12 text-warning-foreground font-medium dark:bg-warning/16",
}

export function JourneyBadge({
	tone = "neutral",
	icon,
	children,
	title,
	className,
}: {
	tone?: JourneyBadgeTone
	icon?: ReactNode
	children: ReactNode
	title?: string
	className?: string
}) {
	return (
		<span
			title={title}
			className={cn(
				"inline-flex h-[17px] shrink-0 items-center gap-1 rounded-sm px-1.5 font-mono text-[11px] leading-none whitespace-nowrap tabular-nums",
				toneClasses[tone],
				className,
			)}
		>
			{icon}
			{children}
		</span>
	)
}

/**
 * Every badge an inference event earns, in reading order. Returning a list (not
 * JSX) keeps the ordering decision here rather than duplicated across the
 * message row, the collapsed group row and any future dense view.
 */
export function JourneyEventBadges({ event }: { event: JourneyEventData }) {
	const badges: Array<ReactNode> = []

	if (event.requestedModel != null && event.model != null && event.requestedModel !== event.model) {
		badges.push(
			<JourneyBadge
				key="served"
				title={`Requested ${event.requestedModel}, served ${event.model}`}
				icon={<ArrowsSwapIcon size={9} className="shrink-0 text-muted-foreground" />}
			>
				served {event.model}
			</JourneyBadge>,
		)
	}

	if (event.cachedInputTokens != null && event.cachedInputTokens > 0) {
		badges.push(
			<JourneyBadge
				key="cached"
				title={`${event.cachedInputTokens.toLocaleString()} cached input tokens`}
			>
				cached {formatTokensCompact(event.cachedInputTokens)}
			</JourneyBadge>,
		)
	}

	if (event.reasoningTokens != null && event.reasoningTokens > 0) {
		badges.push(
			<JourneyBadge key="reasoning" title="Reasoning tokens are billed but never shown">
				reasoning {event.reasoningTokens.toLocaleString()}
			</JourneyBadge>,
		)
	}

	const finish = event.finishReason
	if (finish === "length" || finish === "max_tokens") {
		badges.push(
			<JourneyBadge
				key="finish"
				tone="amber"
				icon={<CircleWarningIcon size={9} className="shrink-0" />}
				title="The model hit its token cap mid-answer — this response is incomplete"
			>
				CUT OFF AT max_tokens
			</JourneyBadge>,
		)
	} else if (finish === "content_filter") {
		badges.push(
			<JourneyBadge
				key="finish"
				tone="amber"
				icon={<CircleWarningIcon size={9} className="shrink-0" />}
			>
				CONTENT FILTERED
			</JourneyBadge>,
		)
	} else if (finish != null && finish !== "" && finish !== "stop" && finish !== "tool_calls") {
		badges.push(
			<JourneyBadge key="finish" tone="amber">
				{humaniseFinishReason(finish).toUpperCase()}
			</JourneyBadge>,
		)
	}

	if (event.status === "error") {
		badges.push(
			<JourneyBadge key="error" tone="red" icon={<XmarkIcon size={9} className="shrink-0" />}>
				PROVIDER ERROR
			</JourneyBadge>,
		)
	}

	return <>{badges}</>
}

/**
 * The redaction marker. Not an empty state and not an error: the provider chose
 * not to record the text, and everything else about the event is intact.
 */
export function ContentRedactedLine({
	source,
	detail,
	className,
}: {
	source: "attributes" | "events" | "absent"
	detail?: string
	className?: string
}) {
	const label =
		source === "events" ? "content recorded as span events · not yet read here" : "content not recorded"
	return (
		<div className={cn("flex items-center gap-2 text-muted-foreground", className)}>
			<SquareRedactedIcon size={11} className="shrink-0 text-input" />
			<span className="font-mono text-xs">
				{label}
				{detail != null && <span className="text-muted-foreground/80"> · {detail}</span>}
			</span>
		</div>
	)
}
