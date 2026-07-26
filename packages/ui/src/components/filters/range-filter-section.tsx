import * as React from "react"

import { ChevronDownIcon, XmarkIcon } from "../icons"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { Input } from "../ui/input"
import { cn } from "../../lib/utils"
import { FILTER_SECTION_LABEL } from "./filter-styles"

/** The unit the caller's numbers are already in. Only affects parsing and display —
 *  values cross this component's boundary unconverted. */
export type RangeUnit = "ms" | "s"

/** One shortcut below the inputs. `label` says why you'd click it ("Bounced",
 *  "> p50"); `value` shows the threshold it resolves to. */
export interface RangePreset {
	key: string
	label: string
	value?: string
	min?: number
	max?: number
}

/** One column of the distribution, in the control's unit. Callers supply a
 *  contiguous run (zero-count buckets included) so the axis reads continuously —
 *  the bucketing rule stays wherever the data came from. */
export interface RangeBucket {
	/** Inclusive lower bound. */
	from: number
	/** Exclusive upper bound. */
	to: number
	count: number
	/** Set on a trailing catch-all bucket, so the axis reads "5m+" and selecting
	 *  it leaves the upper bound open instead of clamping to a made-up ceiling. */
	unbounded?: boolean
}

interface RangeFilterSectionProps {
	title: string
	/** One short line under the header, for meaning the label can't carry. */
	hint?: string
	unit: RangeUnit
	minValue: number | undefined
	maxValue: number | undefined
	onRangeChange: (min: number | undefined, max: number | undefined) => void
	presets?: ReadonlyArray<RangePreset>
	histogram?: ReadonlyArray<RangeBucket>
	/** Noun for the histogram readout, e.g. "sessions". */
	histogramUnitLabel?: string
	defaultOpen?: boolean
	/** Pause before typed values commit. Local mode uses a shorter one since every commit re-queries chDB. */
	debounceMs?: number
}

export function RangeFilterSection({
	title,
	hint,
	unit,
	minValue,
	maxValue,
	onRangeChange,
	presets,
	histogram,
	histogramUnitLabel = "sessions",
	defaultOpen = false,
	debounceMs = 400,
}: RangeFilterSectionProps) {
	const hasActiveRange = minValue !== undefined || maxValue !== undefined
	const [isOpen, setIsOpen] = React.useState(defaultOpen || hasActiveRange)

	// Inputs edit a local draft; the caller's state (and the queries behind it) only
	// updates after a pause in typing, on blur/Enter, or immediately for preset and
	// histogram clicks.
	const [draft, setDraft] = React.useState({
		min: formatCompact(minValue, unit),
		max: formatCompact(maxValue, unit),
	})
	const [prevRange, setPrevRange] = React.useState({ minValue, maxValue })
	if (prevRange.minValue !== minValue || prevRange.maxValue !== maxValue) {
		setPrevRange({ minValue, maxValue })
		setDraft({ min: formatCompact(minValue, unit), max: formatCompact(maxValue, unit) })
	}

	const commitTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const cancelPendingCommit = () => {
		if (commitTimer.current !== undefined) {
			clearTimeout(commitTimer.current)
			commitTimer.current = undefined
		}
	}

	// A reversed pair is a typo, not an intent — swap it rather than committing a
	// range that can never match and leaving the reader to work out why.
	const emit = (min: number | undefined, max: number | undefined) => {
		if (min !== undefined && max !== undefined && min > max) {
			onRangeChange(max, min)
			return
		}
		onRangeChange(min, max)
	}

	const commitDraft = (next: { min: string; max: string }) => {
		cancelPendingCommit()
		emit(parseRange(next.min, unit), parseRange(next.max, unit))
	}

	const handleDraftChange = (next: { min: string; max: string }) => {
		setDraft(next)
		cancelPendingCommit()
		commitTimer.current = setTimeout(() => {
			commitTimer.current = undefined
			emit(parseRange(next.min, unit), parseRange(next.max, unit))
		}, debounceMs)
	}

	// Commit whatever is pending, then rewrite the field in canonical form so
	// "90" reads back as "1m 30s". Typing is left alone until focus leaves.
	const flushDraft = () => {
		commitDraft(draft)
		setDraft({
			min: formatCompact(parseRange(draft.min, unit), unit),
			max: formatCompact(parseRange(draft.max, unit), unit),
		})
	}

	const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			commitDraft(draft)
		}
	}

	const applyRange = (min: number | undefined, max: number | undefined) => {
		cancelPendingCommit()
		setDraft({ min: formatCompact(min, unit), max: formatCompact(max, unit) })
		emit(min, max)
	}

	const clearRange = () => applyRange(undefined, undefined)

	const applyPreset = (preset: RangePreset) => {
		if (minValue === preset.min && maxValue === preset.max) {
			clearRange()
			return
		}
		applyRange(preset.min, preset.max)
	}

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<CollapsibleTrigger
				className={cn(
					"group flex w-full items-center justify-between gap-2 py-2 hover:text-foreground text-muted-foreground transition-colors",
					FILTER_SECTION_LABEL,
				)}
			>
				<span className="truncate">{title}</span>
				<span className="flex items-center gap-1.5">
					{!isOpen && hasActiveRange && (
						<span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] tabular-nums tracking-normal text-foreground">
							{formatRange(minValue, maxValue, unit)}
							<span
								role="button"
								tabIndex={0}
								aria-label={`Clear ${title.toLowerCase()} filter`}
								className="rounded-xs hover:text-muted-foreground"
								onClick={(e) => {
									e.stopPropagation()
									clearRange()
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault()
										e.stopPropagation()
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
							// Duration matches the panel's 200ms, as in `FilterSection`.
							"size-3.5 shrink-0 text-muted-foreground/40 transition-[transform,color] duration-200 ease-out group-hover:text-muted-foreground",
							isOpen && "rotate-180",
						)}
					/>
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pb-3">
				<div className="space-y-2">
					{hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}

					{histogram && histogram.length > 1 && (
						<RangeHistogram
							buckets={histogram}
							unit={unit}
							unitLabel={histogramUnitLabel}
							minValue={minValue}
							maxValue={maxValue}
							onSelect={applyRange}
							title={title}
						/>
					)}

					<div className="flex items-center gap-1.5">
						<Input
							aria-label={`Minimum ${title.toLowerCase()} (${unit === "ms" ? "milliseconds" : "seconds"})`}
							inputMode="decimal"
							size="sm"
							className="text-xs"
							placeholder="0"
							value={draft.min}
							onChange={(e) => handleDraftChange({ ...draft, min: e.target.value })}
							onBlur={flushDraft}
							onKeyDown={handleKeyDown}
						/>
						<span className="text-xs text-muted-foreground">–</span>
						<Input
							aria-label={`Maximum ${title.toLowerCase()} (${unit === "ms" ? "milliseconds" : "seconds"})`}
							inputMode="decimal"
							size="sm"
							className="text-xs"
							placeholder="max"
							value={draft.max}
							onChange={(e) => handleDraftChange({ ...draft, max: e.target.value })}
							onBlur={flushDraft}
							onKeyDown={handleKeyDown}
						/>
						{/* The trailing unit says what a bare number means, so it's noise
						    once a field spells its own out ("2.00s … ms"). Reserve the
						    space either way — the row must not jitter mid-typing. */}
						<span className="w-5 shrink-0 text-xs text-muted-foreground">
							{/[a-z]/i.test(draft.min) || /[a-z]/i.test(draft.max) ? "" : unit}
						</span>
					</div>

					{(presets?.length || hasActiveRange) && (
						<div className="flex flex-wrap items-center gap-1">
							{presets?.map((preset) => {
								const isActive = minValue === preset.min && maxValue === preset.max
								return (
									<button
										key={preset.key}
										type="button"
										onClick={() => applyPreset(preset)}
										aria-pressed={isActive}
										className={cn(
											"rounded-full border px-2 py-0.5 text-[11px] transition-colors",
											isActive
												? "border-primary/30 bg-primary/10 text-foreground"
												: "border-border/60 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
										)}
									>
										{preset.label}
										{preset.value && (
											<span
												className={cn(
													"ml-1 tabular-nums",
													isActive ? "text-foreground/60" : "text-muted-foreground/70",
												)}
											>
												{preset.value}
											</span>
										)}
									</button>
								)
							})}
							{hasActiveRange && (
								<button
									type="button"
									onClick={clearRange}
									className="ml-auto text-[11px] text-muted-foreground hover:text-foreground transition-colors"
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

// ---------------------------------------------------------------------------
// Distribution
//
// Anchors the typed numbers: without it the reader is guessing what a normal
// value looks like. Drag across bars to set both bounds, click one for "at least
// this long". Everything it does is also reachable from the inputs and presets,
// so it stays a redundant affordance rather than the only path — hence role=img
// and no focus handling of its own.
// ---------------------------------------------------------------------------

interface RangeHistogramProps {
	buckets: ReadonlyArray<RangeBucket>
	unit: RangeUnit
	unitLabel: string
	minValue: number | undefined
	maxValue: number | undefined
	onSelect: (min: number | undefined, max: number | undefined) => void
	title: string
}

function RangeHistogram({
	buckets,
	unit,
	unitLabel,
	minValue,
	maxValue,
	onSelect,
	title,
}: RangeHistogramProps) {
	const barsRef = React.useRef<HTMLDivElement>(null)
	const [hoverIndex, setHoverIndex] = React.useState<number | undefined>(undefined)
	const [dragStart, setDragStart] = React.useState<number | undefined>(undefined)

	const peak = Math.max(...buckets.map((b) => b.count), 1)
	const total = buckets.reduce((sum, b) => sum + b.count, 0)

	const indexAt = (clientX: number): number => {
		const rect = barsRef.current?.getBoundingClientRect()
		if (!rect || rect.width === 0) return 0
		const ratio = (clientX - rect.left) / rect.width
		return Math.min(buckets.length - 1, Math.max(0, Math.floor(ratio * buckets.length)))
	}

	const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		const index = indexAt(e.clientX)
		setDragStart(index)
		setHoverIndex(index)
		e.currentTarget.setPointerCapture(e.pointerId)
	}

	const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		setHoverIndex(indexAt(e.clientX))
	}

	const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		if (dragStart === undefined) return
		const end = indexAt(e.clientX)
		const lo = Math.min(dragStart, end)
		const hi = Math.max(dragStart, end)
		setDragStart(undefined)
		// A click picks a floor and leaves the top open — "at least this long" is
		// the dominant intent, and a single bucket is too narrow to be useful.
		if (lo === hi) {
			onSelect(buckets[lo]!.from, undefined)
			return
		}
		const top = buckets[hi]!
		onSelect(buckets[lo]!.from, top.unbounded ? undefined : top.to)
	}

	// While dragging, preview the pending selection instead of the applied one.
	const previewLo = dragStart !== undefined && hoverIndex !== undefined ? Math.min(dragStart, hoverIndex) : undefined
	const previewHi = dragStart !== undefined && hoverIndex !== undefined ? Math.max(dragStart, hoverIndex) : undefined

	const isSelected = (bucket: RangeBucket, index: number): boolean => {
		if (previewLo !== undefined && previewHi !== undefined) {
			return index >= previewLo && index <= previewHi
		}
		if (minValue === undefined && maxValue === undefined) return false
		return (maxValue === undefined || bucket.from < maxValue) && (minValue === undefined || bucket.to > minValue)
	}

	const hasSelection = minValue !== undefined || maxValue !== undefined || previewLo !== undefined
	const hovered = hoverIndex !== undefined ? buckets[hoverIndex] : undefined
	const last = buckets[buckets.length - 1]!

	return (
		<div>
			{/* Fixed-height readout instead of a floating tooltip — a popover would
			    clip inside a sidebar this narrow, and the total is worth showing anyway. */}
			<div className="mb-1 flex h-4 items-center justify-between text-[10px] tabular-nums text-muted-foreground">
				{hovered ? (
					<>
						<span>
							{hovered.unbounded
								? `≥ ${formatValue(hovered.from, unit)}`
								: `${formatValue(hovered.from, unit)} – ${formatValue(hovered.to, unit)}`}
						</span>
						<span className="text-foreground">{hovered.count.toLocaleString()}</span>
					</>
				) : (
					<span>
						{total.toLocaleString()} {unitLabel}
					</span>
				)}
			</div>
			<div
				ref={barsRef}
				role="img"
				aria-label={`${title} distribution across ${buckets.length} buckets, from ${formatValue(buckets[0]!.from, unit)} to ${last.unbounded ? `over ${formatValue(last.from, unit)}` : formatValue(last.to, unit)}`}
				className="flex h-8 cursor-crosshair touch-none items-end gap-px"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerLeave={() => setHoverIndex(undefined)}
			>
				{buckets.map((bucket, index) => {
					const selected = isSelected(bucket, index)
					return (
						<div
							key={bucket.from}
							className={cn(
								"min-w-px flex-1 rounded-t-[1px] motion-safe:transition-[height,background-color] duration-150",
								index === hoverIndex
									? "bg-foreground/60"
									: selected
										? "bg-primary/70"
										: hasSelection
											? "bg-muted-foreground/15"
											: "bg-muted-foreground/30",
							)}
							// Square-root heights, not linear. Session length is heavy-tailed —
							// the bounce spike is often 50× the next bucket, and on a linear
							// scale it flattens the hump this control exists to show. Ordering
							// is preserved and the hover readout carries the exact count.
							style={{
								height: `${bucket.count === 0 ? 2 : Math.max(8, Math.sqrt(bucket.count / peak) * 100)}%`,
							}}
						/>
					)
				})}
			</div>
			<div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground/60">
				<span>{formatValue(buckets[0]!.from, unit)}</span>
				<span>{formatValue(buckets[Math.floor(buckets.length / 2)]!.from, unit)}</span>
				<span>
					{last.unbounded ? `${formatValue(last.from, unit)}+` : formatValue(last.to, unit)}
				</span>
			</div>
		</div>
	)
}

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** Accepts a bare number in the control's own unit, or a suffixed duration
 *  ("90s", "2m", "1h 30m"). Blank or unparseable means unbounded on that side. */
export function parseRange(text: string, unit: RangeUnit): number | undefined {
	const trimmed = text.trim().toLowerCase()
	if (trimmed === "") return undefined

	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const bare = Number(trimmed)
		return Number.isFinite(bare) && bare >= 0 ? bare : undefined
	}

	if (!/^(\d+(\.\d+)?\s*(ms|s|m|h)\s*)+$/.test(trimmed)) return undefined
	let totalMs = 0
	for (const [, amount, suffix] of trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)) {
		totalMs += Number(amount) * UNIT_MS[suffix!]!
	}
	return unit === "ms" ? totalMs : totalMs / 1000
}

/** Always carries its unit — for badges, ticks and readouts, where there's no
 *  input context to imply one. */
export function formatValue(value: number, unit: RangeUnit): string {
	return unit === "ms" ? formatMs(value) : formatSeconds(value)
}

/** For input fields: bare inside the unit's natural range so typed numbers read
 *  back unchanged, units only once the raw number stops being legible. Always
 *  round-trips through `parseRange`. */
export function formatCompact(value: number | undefined, unit: RangeUnit): string {
	if (value === undefined) return ""
	const threshold = unit === "ms" ? 1000 : 60
	if (value < threshold) return String(value)
	// The display formats round to something readable — "2h 2m" for 7325s. That's
	// right for a badge and wrong for a field the reader's own number goes back
	// into, so only rewrite when the human form means exactly the same thing.
	const human = formatValue(value, unit)
	return parseRange(human, unit) === value ? human : String(value)
}

function formatMs(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
	if (ms < 1000) return `${ms.toFixed(1)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

export function formatSeconds(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
	if (seconds < 3600) {
		const minutes = Math.floor(seconds / 60)
		const rest = Math.round(seconds % 60)
		return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
	}
	const hours = Math.floor(seconds / 3600)
	const restMinutes = Math.round((seconds % 3600) / 60)
	return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
}

export function formatRange(
	minValue: number | undefined,
	maxValue: number | undefined,
	unit: RangeUnit,
): string {
	if (minValue !== undefined && maxValue !== undefined) {
		return `${formatValue(minValue, unit)} – ${formatValue(maxValue, unit)}`
	}
	if (minValue !== undefined) return `≥ ${formatValue(minValue, unit)}`
	return `≤ ${formatValue(maxValue ?? 0, unit)}`
}
