// Min/max duration filter for the filter sidebar — mirrors the web app's
// `@/components/traces/duration-range-filter`, with one local adaptation:
// changes are debounced (the web pushes per keystroke into router state, but
// locally every change re-queries chDB) and flushed on blur/Enter.

import * as React from "react"
import { ChevronDownIcon, XmarkIcon } from "@maple/ui/components/icons"
import { cn } from "@maple/ui/utils"
import { Input } from "@maple/ui/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import type { DurationStats } from "../hooks/use-local-trace-facets"

const DEBOUNCE_MS = 300

interface DurationRangeFilterProps {
	minValue: number | undefined
	maxValue: number | undefined
	onMinChange: (value: number | undefined) => void
	onMaxChange: (value: number | undefined) => void
	durationStats?: DurationStats
	defaultOpen?: boolean
}

function useDebouncedNumberInput(value: number | undefined, onChange: (value: number | undefined) => void) {
	const [text, setText] = React.useState(value != null ? String(value) : "")
	const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const onChangeRef = React.useRef(onChange)
	onChangeRef.current = onChange

	// Re-sync from the URL when it changes externally (e.g. "Clear all" or a preset chip).
	const [lastValue, setLastValue] = React.useState(value)
	if (value !== lastValue) {
		setLastValue(value)
		setText(value != null ? String(value) : "")
	}

	const commit = React.useCallback((raw: string) => {
		const parsed = Number(raw)
		onChangeRef.current(
			raw === "" || !Number.isFinite(parsed) || parsed < 0 ? undefined : Math.round(parsed),
		)
	}, [])

	const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const raw = e.target.value
		setText(raw)
		clearTimeout(timeoutRef.current)
		timeoutRef.current = setTimeout(() => commit(raw), DEBOUNCE_MS)
	}

	const flush = () => {
		clearTimeout(timeoutRef.current)
		commit(text)
	}

	React.useEffect(() => () => clearTimeout(timeoutRef.current), [])

	return { text, handleChange, flush }
}

export function DurationRangeFilter({
	minValue,
	maxValue,
	onMinChange,
	onMaxChange,
	durationStats,
	defaultOpen = false,
}: DurationRangeFilterProps) {
	const hasActiveRange = minValue !== undefined || maxValue !== undefined
	const [isOpen, setIsOpen] = React.useState(defaultOpen || hasActiveRange)
	const min = useDebouncedNumberInput(minValue, onMinChange)
	const max = useDebouncedNumberInput(maxValue, onMaxChange)

	const handleKeyDown = (flush: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") flush()
	}

	const applyPreset = (minMs: number) => {
		if (minValue === Math.round(minMs) && maxValue === undefined) {
			onMinChange(undefined)
			return
		}
		onMinChange(Math.round(minMs))
		onMaxChange(undefined)
	}

	const clearRange = () => {
		onMinChange(undefined)
		onMaxChange(undefined)
	}

	const presets: Array<{ key: string; label: string; minMs: number }> = []
	if (durationStats && durationStats.p50DurationMs > 0) {
		presets.push({
			key: "p50",
			label: `> p50 · ${formatDuration(durationStats.p50DurationMs)}`,
			minMs: durationStats.p50DurationMs,
		})
	}
	if (durationStats && durationStats.p95DurationMs > 0) {
		presets.push({
			key: "p95",
			label: `> p95 · ${formatDuration(durationStats.p95DurationMs)}`,
			minMs: durationStats.p95DurationMs,
		})
	}
	presets.push({ key: "1s", label: "> 1s", minMs: 1000 })

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
					<ChevronDownIcon className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pb-3">
				<div className="space-y-2">
					<div className="flex flex-wrap gap-1">
						{presets.map((preset) => {
							const isActive = minValue === Math.round(preset.minMs) && maxValue === undefined
							return (
								<button
									key={preset.key}
									type="button"
									onClick={() => applyPreset(preset.minMs)}
									className={cn(
										"h-6 rounded-sm border px-1.5 text-xs tabular-nums transition-colors",
										isActive
											? "border-primary/40 bg-primary/10 text-foreground"
											: "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
									)}
								>
									{preset.label}
								</button>
							)
						})}
					</div>
					<div className="flex items-center gap-1.5">
						<Input
							aria-label="Min duration (ms)"
							type="number"
							min={0}
							className="h-7 text-xs"
							placeholder={durationStats ? String(Math.floor(durationStats.minDurationMs)) : "0"}
							value={min.text}
							onChange={min.handleChange}
							onBlur={min.flush}
							onKeyDown={handleKeyDown(min.flush)}
						/>
						<span className="text-xs text-muted-foreground">–</span>
						<Input
							aria-label="Max duration (ms)"
							type="number"
							min={0}
							className="h-7 text-xs"
							placeholder={durationStats ? String(Math.ceil(durationStats.maxDurationMs)) : "max"}
							value={max.text}
							onChange={max.handleChange}
							onBlur={max.flush}
							onKeyDown={handleKeyDown(max.flush)}
						/>
						<span className="text-xs text-muted-foreground">ms</span>
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
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
