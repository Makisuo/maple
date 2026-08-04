import { cn } from "@maple/ui/lib/utils"
import type { ActionKind } from "./replay-player-context"
import { MARKER_LABELS, MARKER_STYLES } from "./replay-format"

const KINDS: ReadonlyArray<ActionKind> = ["click", "input", "scroll", "nav"]

/**
 * Compact key for the action-marker dots shown on the scrubber and the timeline
 * activity track. Without it the colored dots are undiscoverable. Driven by the
 * same `MARKER_STYLES` / `MARKER_LABELS` maps the markers themselves use, so the
 * legend can never drift from the dots.
 */
export function MarkerLegend({ className }: { className?: string }) {
	return (
		<ul
			className={cn(
				"flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground",
				className,
			)}
			aria-label="Activity marker legend"
		>
			{KINDS.map((kind) => (
				<li key={kind} className="flex items-center gap-1.5">
					<span
						className={cn("size-1.5 rounded-full ring-1 ring-card", MARKER_STYLES[kind])}
						aria-hidden
					/>
					{MARKER_LABELS[kind]}
				</li>
			))}
		</ul>
	)
}
