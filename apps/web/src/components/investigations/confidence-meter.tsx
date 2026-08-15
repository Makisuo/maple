import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"

type Confidence = NonNullable<V2Investigation["confidence"]>

/** Sort rank: most confident first, unset last. */
export const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 } satisfies Record<
	Confidence,
	number
>

/**
 * The word's tint, alongside this file's other confidence vocabulary. It lived on
 * the chat report card, which meant three surfaces in `investigations/` reached
 * into `chat/` for a colour — and the card itself now reaches the other way for
 * the action detail panel, which would have closed the loop.
 */
export const CONFIDENCE_TONE: Record<string, string> = {
	high: "text-success",
	medium: "text-severity-warn",
	low: "text-muted-foreground",
} satisfies Record<string, string>

const FILLED: Record<Confidence, number> = { high: 3, medium: 2, low: 1 } satisfies Record<Confidence, number>

const BAR_TONE: Record<Confidence, string> = {
	high: "bg-success",
	medium: "bg-severity-warn",
	low: "bg-muted-foreground",
} satisfies Record<Confidence, string>

/** Ascending bars, so the shape reads before the word does. */
const BAR_HEIGHT = ["h-1.5", "h-2", "h-2.5"] as const

/**
 * Confidence qualifies a diagnosis, and a bare capitalized word in a column of
 * its own read as a second severity. The meter says "less than" and "more than"
 * at a glance without competing with the severity badge beside it.
 */
export function ConfidenceMeter({
	confidence,
	className,
}: {
	confidence: Confidence | null
	className?: string
}) {
	if (confidence === null) {
		return (
			<span className={cn("text-xs text-muted-foreground/60", className)} title="No diagnosis yet">
				—
			</span>
		)
	}
	const filled = FILLED[confidence]
	return (
		<span
			className={cn("inline-flex items-center gap-1.5", className)}
			title={`Diagnosis confidence: ${confidence}`}
		>
			<span className="flex items-end gap-px" aria-hidden>
				{BAR_HEIGHT.map((height, index) => (
					<span
						key={height}
						className={cn(
							"w-[3px] rounded-[1px]",
							height,
							index < filled ? BAR_TONE[confidence] : "bg-border",
						)}
					/>
				))}
			</span>
			<span className={cn("text-xs capitalize", CONFIDENCE_TONE[confidence])}>{confidence}</span>
		</span>
	)
}
