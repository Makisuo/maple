import { XmarkIcon } from "../icons"
import { cn } from "../../lib/utils"

/** Values past this collapse into a "+N" suffix rather than wrapping the bar. */
const MAX_CHIP_VALUES = 3

export interface ActiveFilterChip {
	/** Stable across renders — the search-param key it came from is the natural id. */
	id: string
	/** The facet's name, as the sidebar spells it ("Service", "Root Span"). */
	label: string
	values: ReadonlyArray<string>
	/** Renders the chip as an exclusion: `is not` rather than `is`. */
	negated?: boolean
	onRemove: () => void
	/** Opens the section this chip came from. Omit and the chip is not clickable. */
	onSelect?: () => void
	/** Stored value → display text, matching the section's own `getOptionLabel`. */
	getValueLabel?: (value: string) => string
}

function summarize(chip: ActiveFilterChip): string {
	const labelFor = (v: string) => chip.getValueLabel?.(v) ?? v
	const shown = chip.values.slice(0, MAX_CHIP_VALUES).map(labelFor).join(", ")
	const rest = chip.values.length - MAX_CHIP_VALUES
	return rest > 0 ? `${shown} +${rest}` : shown
}

interface ActiveFilterChipsProps {
	chips: ReadonlyArray<ActiveFilterChip>
	onClearAll?: () => void
	className?: string
}

/**
 * The row of applied filters above a result list.
 *
 * It exists for the negative ones. An inclusion explains itself — you can see what came back. An
 * exclusion is only visible as absence, so a page that hides it behind a collapsed sidebar section
 * turns every stale exclusion into "why is my data missing?". Positives ride along so the bar reads
 * as one account of the query rather than a list of warnings.
 */
export function ActiveFilterChips({ chips, onClearAll, className }: ActiveFilterChipsProps) {
	if (chips.length === 0) return null

	return (
		<div className={cn("mb-4 flex flex-wrap items-center gap-1.5", className)}>
			{chips.map((chip) => {
				const summary = summarize(chip)
				const description = `${chip.label} ${chip.negated ? "is not" : "is"} ${chip.values.join(", ")}`
				return (
					<span
						key={chip.id}
						title={description}
						className={cn(
							"inline-flex max-w-full items-center gap-1.5 rounded-md border py-1 pr-1 pl-2 text-xs",
							// Dashed border and a "not" in the sentence, so the state survives both a
							// colorblind reading and a glance that skips the words.
							chip.negated
								? "border-dashed border-destructive/40 bg-destructive/5 text-destructive"
								: "border-border/60 bg-muted/40 text-foreground",
						)}
					>
						<span className="truncate">
							<span className="text-muted-foreground">{chip.label}</span>{" "}
							<span className={cn(chip.negated ? "font-medium" : "text-muted-foreground")}>
								{chip.negated ? "is not" : "is"}
							</span>{" "}
							{chip.onSelect ? (
								<button
									type="button"
									onClick={chip.onSelect}
									className="font-medium underline-offset-2 hover:underline"
								>
									{summary}
								</button>
							) : (
								<span className="font-medium">{summary}</span>
							)}
						</span>
						<button
							type="button"
							onClick={chip.onRemove}
							aria-label={`Remove filter: ${description}`}
							title={`Remove filter: ${description}`}
							className="shrink-0 rounded-sm p-0.5 text-current/60 transition-colors hover:bg-current/10 hover:text-current"
						>
							<XmarkIcon className="size-3" />
						</button>
					</span>
				)
			})}
			{onClearAll && chips.length > 1 && (
				<button
					type="button"
					onClick={onClearAll}
					className="ml-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Clear all
				</button>
			)}
		</div>
	)
}
