import * as React from "react"

import { cn } from "@maple/ui/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { Input } from "@maple/ui/components/ui/input"
import { FILTER_SECTION_LABEL } from "@maple/ui/components/filters/filter-styles"
import { ChevronDownIcon, XmarkIcon } from "@/components/icons"

/**
 * A min/max range facet for dimensions that aren't durations — cost, turns,
 * tokens. `RangeFilterSection` from `@maple/ui` owns the duration case and
 * formats everything as a duration, which would render a cost of `0.61` as
 * "610ms". Same control grammar (typed bounds + p50/p95 shortcuts), a plain
 * number formatter instead of a clock.
 *
 * There is no histogram here: the facets endpoint only returns a distribution
 * for duration. Percentile shortcuts still come from the data, so the presets
 * mean the same thing they do in the duration section.
 */
interface NumericRangeFilterSectionProps {
	title: string
	minValue: number | undefined
	maxValue: number | undefined
	onRangeChange: (min: number | undefined, max: number | undefined) => void
	/** Renders a bound for badges and preset labels (e.g. `$0.61`, `1.2k`). */
	format: (value: number) => string
	/** Percentiles of the current population. Zero/absent percentiles are skipped
	 *  rather than offered as a degenerate "> 0" shortcut. */
	p50?: number
	p95?: number
	placeholderMin?: string
	placeholderMax?: string
	defaultOpen?: boolean
}

export function NumericRangeFilterSection({
	title,
	minValue,
	maxValue,
	onRangeChange,
	format,
	p50,
	p95,
	placeholderMin = "0",
	placeholderMax = "max",
	defaultOpen = false,
}: NumericRangeFilterSectionProps) {
	const hasActiveRange = minValue !== undefined || maxValue !== undefined
	const [isOpen, setIsOpen] = React.useState(defaultOpen || hasActiveRange)

	const [draft, setDraft] = React.useState({
		min: toDraft(minValue),
		max: toDraft(maxValue),
	})
	const [prevRange, setPrevRange] = React.useState({ minValue, maxValue })
	if (prevRange.minValue !== minValue || prevRange.maxValue !== maxValue) {
		setPrevRange({ minValue, maxValue })
		setDraft({ min: toDraft(minValue), max: toDraft(maxValue) })
	}

	// A reversed pair is a typo, not an intent — swap rather than commit a range
	// that can never match.
	const emit = (min: number | undefined, max: number | undefined) => {
		if (min !== undefined && max !== undefined && min > max) onRangeChange(max, min)
		else onRangeChange(min, max)
	}

	const commit = (next: { min: string; max: string }) => emit(parse(next.min), parse(next.max))

	const apply = (min: number | undefined, max: number | undefined) => {
		setDraft({ min: toDraft(min), max: toDraft(max) })
		emit(min, max)
	}

	const clearRange = () => apply(undefined, undefined)

	const presets = [["p50", p50] as const, ["p95", p95] as const].flatMap(([key, value]) =>
		value != null && value > 0 ? [{ key, label: `> ${key}`, value, min: value }] : [],
	)

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<CollapsibleTrigger
				className={cn(
					"group flex w-full items-center justify-between gap-2 py-2 text-muted-foreground transition-colors hover:text-foreground",
					FILTER_SECTION_LABEL,
				)}
			>
				<span className="truncate">{title}</span>
				<span className="flex items-center gap-1.5">
					{!isOpen && hasActiveRange && (
						<span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] tracking-normal text-foreground tabular-nums">
							{formatBadge(minValue, maxValue, format)}
							<span
								role="button"
								tabIndex={0}
								aria-label={`Clear ${title.toLowerCase()} filter`}
								className="rounded-xs hover:text-muted-foreground"
								onClick={(event) => {
									event.stopPropagation()
									clearRange()
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault()
										event.stopPropagation()
										clearRange()
									}
								}}
							>
								<XmarkIcon className="size-3" />
							</span>
						</span>
					)}
					<ChevronDownIcon
						className={cn(
							"size-3.5 shrink-0 text-muted-foreground/40 transition-[transform,color] duration-200 ease-out group-hover:text-muted-foreground",
							isOpen && "rotate-180",
						)}
					/>
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pb-3">
				<div className="space-y-2">
					<div className="flex items-center gap-1.5">
						<Input
							aria-label={`Minimum ${title.toLowerCase()}`}
							inputMode="decimal"
							size="sm"
							className="text-xs"
							placeholder={placeholderMin}
							value={draft.min}
							onChange={(event) => setDraft({ ...draft, min: event.target.value })}
							onBlur={() => commit(draft)}
							onKeyDown={(event) => {
								if (event.key === "Enter") commit(draft)
							}}
						/>
						<span className="text-xs text-muted-foreground">–</span>
						<Input
							aria-label={`Maximum ${title.toLowerCase()}`}
							inputMode="decimal"
							size="sm"
							className="text-xs"
							placeholder={placeholderMax}
							value={draft.max}
							onChange={(event) => setDraft({ ...draft, max: event.target.value })}
							onBlur={() => commit(draft)}
							onKeyDown={(event) => {
								if (event.key === "Enter") commit(draft)
							}}
						/>
					</div>

					{(presets.length > 0 || hasActiveRange) && (
						<div className="flex flex-wrap items-center gap-1">
							{presets.map((preset) => {
								const isActive = minValue === preset.min && maxValue === undefined
								return (
									<button
										key={preset.key}
										type="button"
										aria-pressed={isActive}
										onClick={() =>
											isActive ? clearRange() : apply(preset.min, undefined)
										}
										className={cn(
											"rounded-full border px-2 py-0.5 text-[11px] transition-colors",
											isActive
												? "border-primary/30 bg-primary/10 text-foreground"
												: "border-border/60 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
										)}
									>
										{preset.label}
										<span
											className={cn(
												"ml-1 tabular-nums",
												isActive ? "text-foreground/60" : "text-muted-foreground/70",
											)}
										>
											{format(preset.value)}
										</span>
									</button>
								)
							})}
							{hasActiveRange && (
								<button
									type="button"
									onClick={clearRange}
									className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
								>
									Clear
								</button>
							)}
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

function toDraft(value: number | undefined): string {
	return value === undefined ? "" : String(value)
}

function parse(text: string): number | undefined {
	const trimmed = text.trim().replace(/^\$/, "")
	if (trimmed === "") return undefined
	const parsed = Number(trimmed)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function formatBadge(
	minValue: number | undefined,
	maxValue: number | undefined,
	format: (value: number) => string,
): string {
	if (minValue !== undefined && maxValue !== undefined) {
		return `${format(minValue)} – ${format(maxValue)}`
	}
	if (minValue !== undefined) return `≥ ${format(minValue)}`
	return `≤ ${format(maxValue ?? 0)}`
}
