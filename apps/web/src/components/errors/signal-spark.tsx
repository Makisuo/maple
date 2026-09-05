import { useId } from "react"

import type { IssueSeverity } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import { SEVERITY_TEXT } from "./severity-badge"

/**
 * The trend shape drawn inside a list row.
 *
 * Deliberately not `IssueOccurrenceChart`: that one is an axed, interactive
 * plot with a tooltip, built for the detail page. Fifty of them in a scrolling
 * list would be fifty chart runtimes. This is a static bar chart in one <svg>,
 * no runtime, no interaction — the same bars, drawn the cheap way.
 *
 * Colour carries the row's severity rather than decorating it, so a column of
 * sparks reads as a heat map of the queue — the red shapes are the ones worth
 * looking at, and you can find them without reading a single label.
 */

export interface SignalSparkProps {
	/** Dense bucket counts, oldest first. Gaps must already be zero-filled. */
	values: ReadonlyArray<number>
	severity: IssueSeverity | null
	/** Overrides the severity hue — a surging fingerprint reads as urgent
	 *  regardless of the severity someone assigned it. */
	surging?: boolean
	/** Bars past this point are drawn at full strength — the window's recent tail. */
	tailFraction?: number
	className?: string
	label?: string
}

const BAR_GAP = 1
const BAR_WIDTH = 2
const VIEW_HEIGHT = 20

/**
 * A bucket that saw nothing still draws this much, so the comb has a floor and
 * the bars stand ON something. Without it a quiet window with two spikes drew
 * two marks hovering in an empty box, with no baseline to read them against —
 * the shape looked broken rather than sparse.
 */
const EMPTY_BAR_HEIGHT = 1

/** A bucket that saw errors clears the floor, because the difference between
 *  "one error" and "none" is the whole point of the shape. */
const MIN_BAR_HEIGHT = 2.5

export function SignalSpark({
	values,
	severity,
	surging = false,
	tailFraction = 0.2,
	className,
	label,
}: SignalSparkProps) {
	const gradientId = useId()

	if (values.length === 0) {
		return (
			<span
				className={cn("block h-5 w-full", className)}
				aria-hidden="true"
				title="No occurrences in this window"
			/>
		)
	}

	const peak = Math.max(...values)
	const step = BAR_WIDTH + BAR_GAP
	const viewWidth = values.length * step - BAR_GAP
	const tailStart = values.length - Math.max(1, Math.round(values.length * tailFraction))
	const tone = surging
		? "text-destructive"
		: severity === null
			? "text-muted-foreground"
			: SEVERITY_TEXT[severity]

	return (
		<svg
			viewBox={`0 0 ${viewWidth} ${VIEW_HEIGHT}`}
			preserveAspectRatio="none"
			className={cn("block h-5 w-full overflow-visible", tone, className)}
			role="img"
			aria-label={label ?? "Occurrences over the selected window"}
		>
			<title>{label ?? "Occurrences over the selected window"}</title>
			{/* Vertical ramp so a tall bar is not just taller but hotter — the
			    difference between a spike and a plateau survives being 20px high. */}
			<defs>
				<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor="currentColor" stopOpacity="1" />
					<stop offset="100%" stopColor="currentColor" stopOpacity="0.45" />
				</linearGradient>
			</defs>
			{values.map((value, index) => {
				// A window that saw nothing at all stays blank: a floor drawn under no
				// data is a chart claiming to have some. The floor is the baseline of a
				// shape that exists, not decoration on an empty cell.
				if (peak === 0) return null

				const empty = value === 0
				const height = empty
					? EMPTY_BAR_HEIGHT
					: Math.max(MIN_BAR_HEIGHT, (value / peak) * VIEW_HEIGHT)
				const recent = index >= tailStart
				return (
					<rect
						key={index}
						x={index * step}
						y={VIEW_HEIGHT - height}
						width={BAR_WIDTH}
						height={height}
						// Flat fill on the floor — a 1px tick has nothing to ramp, and
						// running it through the gradient only muddies the baseline.
						fill={empty ? "currentColor" : `url(#${gradientId})`}
						opacity={empty ? (recent ? 0.3 : 0.2) : recent ? 1 : 0.5}
					/>
				)
			})}
		</svg>
	)
}
