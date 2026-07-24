import type { TimePreset } from "@/lib/time-utils"

export interface TimeRange {
	startTime?: string
	endTime?: string
	presetValue?: string
}

export interface TimeRangePickerProps {
	startTime?: string
	endTime?: string
	presetValue?: string
	onChange: (range: TimeRange) => void
	/** Register the page-level "D" shortcut to open the picker. */
	hotkey?: boolean
	/** Page-specific preset list; defaults to the standard one-month set. */
	presets?: ReadonlyArray<TimePreset>
	/** Reject shorthand/custom/recent ranges wider than this page supports. */
	maxRangeSeconds?: number
}

export type TimeRangeTab = "relative" | "custom"
