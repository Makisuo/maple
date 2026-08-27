import { cn } from "../../lib/utils"

/** Values past this collapse into a "+N" suffix rather than running the line long. */
const MAX_NAMED_VALUES = 4

export interface ExcludedEmptyHintProps {
	/** The active exclusions, flattened across facets — usually the chip bar's negated values. */
	excluded: ReadonlyArray<string>
	onClear: () => void
	className?: string
}

/**
 * The line an empty result needs when exclusions are active.
 *
 * An empty list with an inclusion filter explains itself — you asked for X and there is no X. An
 * empty list with an *exclusion* does not: the filter is defined by what is absent, so a stale one
 * is indistinguishable from missing data, and the honest reading ("my telemetry stopped arriving")
 * is the alarming one. Naming the excluded values, with one click to drop them, closes that gap.
 *
 * Renders nothing when nothing is excluded, so an empty state can mount it unconditionally.
 */
export function ExcludedEmptyHint({ excluded, onClear, className }: ExcludedEmptyHintProps) {
	if (excluded.length === 0) return null

	const named = excluded.slice(0, MAX_NAMED_VALUES).join(", ")
	const rest = excluded.length - MAX_NAMED_VALUES
	const summary = rest > 0 ? `${named} +${rest} more` : named

	return (
		<div
			className={cn(
				"mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-xs",
				className,
			)}
		>
			<span className="text-muted-foreground">
				{excluded.length === 1 ? "1 value is" : `${excluded.length} values are`} being excluded:{" "}
				<span className="text-destructive">{summary}</span>
			</span>
			<button
				type="button"
				onClick={onClear}
				className="font-medium text-foreground underline-offset-2 hover:underline"
			>
				Remove exclusions
			</button>
		</div>
	)
}
