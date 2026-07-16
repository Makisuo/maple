import * as React from "react"
import { ChevronDownIcon, XmarkIcon } from "@/components/icons"

import { cn } from "@maple/ui/utils"
import { Input } from "@maple/ui/components/ui/input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"

interface DurationRangeFilterProps {
	minValue: number | undefined
	maxValue: number | undefined
	onMinChange: (value: number | undefined) => void
	onMaxChange: (value: number | undefined) => void
	durationStats?: {
		minDurationMs: number
		maxDurationMs: number
		p50DurationMs: number
		p95DurationMs: number
	}
	defaultOpen?: boolean
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

	const handleMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value
		onMinChange(val === "" ? undefined : Number(val))
	}

	const handleMaxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value
		onMaxChange(val === "" ? undefined : Number(val))
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
							value={minValue ?? ""}
							onChange={handleMinChange}
						/>
						<span className="text-xs text-muted-foreground">–</span>
						<Input
							aria-label="Max duration (ms)"
							type="number"
							min={0}
							className="h-7 text-xs"
							placeholder={durationStats ? String(Math.ceil(durationStats.maxDurationMs)) : "max"}
							value={maxValue ?? ""}
							onChange={handleMaxChange}
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
