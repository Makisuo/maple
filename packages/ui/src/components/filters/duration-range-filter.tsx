import * as React from "react"

import { ChevronDownIcon, XmarkIcon } from "../icons"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible"
import { Input } from "../ui/input"
import { cn } from "../../lib/utils"

export interface DurationStats {
	minDurationMs: number
	maxDurationMs: number
	p50DurationMs: number
	p95DurationMs: number
}

interface DurationRangeFilterProps {
	minValue: number | undefined
	maxValue: number | undefined
	onRangeChange: (min: number | undefined, max: number | undefined) => void
	durationStats?: DurationStats
	defaultOpen?: boolean
	/** Pause before typed values commit. Local mode uses a shorter one since every commit re-queries chDB. */
	debounceMs?: number
}

export function DurationRangeFilter({
	minValue,
	maxValue,
	onRangeChange,
	durationStats,
	defaultOpen = false,
	debounceMs = 400,
}: DurationRangeFilterProps) {
	const hasActiveRange = minValue !== undefined || maxValue !== undefined
	const [isOpen, setIsOpen] = React.useState(defaultOpen || hasActiveRange)

	// Inputs edit a local draft; the caller's state (and the queries behind it) only
	// updates after a pause in typing, on blur/Enter, or immediately for preset clicks.
	const [draft, setDraft] = React.useState({ min: toText(minValue), max: toText(maxValue) })
	const [prevRange, setPrevRange] = React.useState({ minValue, maxValue })
	if (prevRange.minValue !== minValue || prevRange.maxValue !== maxValue) {
		setPrevRange({ minValue, maxValue })
		setDraft({ min: toText(minValue), max: toText(maxValue) })
	}

	const commitTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const cancelPendingCommit = () => {
		if (commitTimer.current !== undefined) {
			clearTimeout(commitTimer.current)
			commitTimer.current = undefined
		}
	}

	const commitDraft = (next: { min: string; max: string }) => {
		cancelPendingCommit()
		onRangeChange(fromText(next.min), fromText(next.max))
	}

	const handleDraftChange = (next: { min: string; max: string }) => {
		setDraft(next)
		cancelPendingCommit()
		commitTimer.current = setTimeout(() => {
			commitTimer.current = undefined
			onRangeChange(fromText(next.min), fromText(next.max))
		}, debounceMs)
	}

	const flushDraft = () => {
		if (commitTimer.current !== undefined) {
			commitDraft(draft)
		}
	}

	const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			commitDraft(draft)
		}
	}

	const applyRange = (min: number | undefined, max: number | undefined) => {
		cancelPendingCommit()
		setDraft({ min: toText(min), max: toText(max) })
		onRangeChange(min, max)
	}

	const applyPreset = (minMs: number) => {
		const rounded = Math.round(minMs)
		if (minValue === rounded && maxValue === undefined) {
			applyRange(undefined, undefined)
			return
		}
		applyRange(rounded, undefined)
	}

	const presets: Array<{ key: string; label: string; minMs: number; value: string }> = []
	if (durationStats && durationStats.p50DurationMs > 0) {
		presets.push({
			key: "p50",
			label: "> p50",
			minMs: durationStats.p50DurationMs,
			value: formatDuration(durationStats.p50DurationMs),
		})
	}
	if (durationStats && durationStats.p95DurationMs > 0) {
		presets.push({
			key: "p95",
			label: "> p95",
			minMs: durationStats.p95DurationMs,
			value: formatDuration(durationStats.p95DurationMs),
		})
	}
	presets.push({ key: "1s", label: "> 1s", minMs: 1000, value: "" })

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-sm font-medium hover:text-foreground text-muted-foreground transition-colors">
				<span>Duration</span>
				<span className="flex items-center gap-1.5">
					{!isOpen && hasActiveRange && (
						<span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs tabular-nums text-foreground">
							{formatRange(minValue, maxValue)}
							<span
								role="button"
								tabIndex={0}
								aria-label="Clear duration filter"
								className="rounded-xs hover:text-muted-foreground"
								onClick={(e) => {
									e.stopPropagation()
									applyRange(undefined, undefined)
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault()
										e.stopPropagation()
										applyRange(undefined, undefined)
									}
								}}
							>
								<XmarkIcon className="size-3" />
							</span>
						</span>
					)}
					<ChevronDownIcon className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pb-3">
				<div className="space-y-2">
					<div>
						{presets.map((preset) => {
							const isActive = minValue === Math.round(preset.minMs) && maxValue === undefined
							return (
								<button
									key={preset.key}
									type="button"
									onClick={() => applyPreset(preset.minMs)}
									className={cn(
										"flex w-full items-center justify-between rounded-sm px-1.5 py-1 text-xs transition-colors",
										isActive
											? "bg-primary/10 text-foreground"
											: "text-muted-foreground hover:bg-muted hover:text-foreground",
									)}
								>
									<span>{preset.label}</span>
									<span className="tabular-nums">{preset.value}</span>
								</button>
							)
						})}
					</div>
					<div className="flex items-center gap-1.5">
						<Input
							aria-label="Min duration (ms)"
							type="number"
							min={0}
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
							aria-label="Max duration (ms)"
							type="number"
							min={0}
							size="sm"
							className="text-xs"
							placeholder="max"
							value={draft.max}
							onChange={(e) => handleDraftChange({ ...draft, max: e.target.value })}
							onBlur={flushDraft}
							onKeyDown={handleKeyDown}
						/>
						<span className="text-xs text-muted-foreground">ms</span>
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

function toText(value: number | undefined): string {
	return value === undefined ? "" : String(value)
}

function fromText(text: string): number | undefined {
	if (text.trim() === "") return undefined
	const value = Number(text)
	return Number.isFinite(value) && value >= 0 ? value : undefined
}

function formatRange(minValue: number | undefined, maxValue: number | undefined): string {
	if (minValue !== undefined && maxValue !== undefined) {
		return `${formatDuration(minValue)} – ${formatDuration(maxValue)}`
	}
	if (minValue !== undefined) {
		return `≥ ${formatDuration(minValue)}`
	}
	return `≤ ${formatDuration(maxValue ?? 0)}`
}

function formatDuration(ms: number): string {
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)}us`
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)}ms`
	}
	return `${(ms / 1000).toFixed(2)}s`
}
