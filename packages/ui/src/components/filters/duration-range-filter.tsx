import * as React from "react"

import { RangeFilterSection, formatValue, type RangePreset } from "./range-filter-section"

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

/** Trace duration, in milliseconds. A thin binding over `RangeFilterSection` —
 *  it only turns duration stats into presets; all the behaviour lives there. */
export function DurationRangeFilter({
	minValue,
	maxValue,
	onRangeChange,
	durationStats,
	defaultOpen,
	debounceMs,
}: DurationRangeFilterProps) {
	const presets = React.useMemo((): RangePreset[] => {
		const list: RangePreset[] = []
		if (durationStats && durationStats.p50DurationMs > 0) {
			const min = Math.round(durationStats.p50DurationMs)
			list.push({ key: "p50", label: "> p50", value: formatValue(min, "ms"), min })
		}
		if (durationStats && durationStats.p95DurationMs > 0) {
			const min = Math.round(durationStats.p95DurationMs)
			list.push({ key: "p95", label: "> p95", value: formatValue(min, "ms"), min })
		}
		list.push({ key: "1s", label: "> 1s", min: 1000 })
		return list
	}, [durationStats])

	return (
		<RangeFilterSection
			title="Duration"
			unit="ms"
			minValue={minValue}
			maxValue={maxValue}
			onRangeChange={onRangeChange}
			presets={presets}
			defaultOpen={defaultOpen}
			debounceMs={debounceMs}
		/>
	)
}
