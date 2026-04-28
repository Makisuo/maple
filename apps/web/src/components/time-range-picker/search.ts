import type { TimeRange } from "./types"

export function applyTimeRangeSearch<T extends Record<string, unknown>>(prev: T, range: TimeRange) {
	if (range.presetValue) {
		return {
			...prev,
			startTime: undefined,
			endTime: undefined,
			timePreset: range.presetValue,
		}
	}
	return {
		...prev,
		startTime: range.startTime,
		endTime: range.endTime,
		timePreset: undefined,
	}
}
