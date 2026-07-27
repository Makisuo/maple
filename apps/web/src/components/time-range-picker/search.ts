import { Schema } from "effect"

import type { TimeRange } from "./types"

/**
 * The three URL search params every time-filtered page carries. Spread into a
 * route's own `Schema.Struct` (last, so the diffs stay uniform) rather than
 * re-declaring them:
 *
 * ```ts
 * const searchSchema = Schema.Struct({ ...routeFilters, ...TimeRangeSearchFields })
 * ```
 *
 * `Schema.optional` (not `optionalKey`) because TanStack Router hands us keys
 * that are present-but-`undefined`, and `applyTimeRangeSearch` below writes
 * `undefined` explicitly to clear whichever mode isn't active.
 */
export const TimeRangeSearchFields = {
	startTime: Schema.optional(Schema.String),
	endTime: Schema.optional(Schema.String),
	timePreset: Schema.optional(Schema.String),
}

const TimeRangeSearchStruct = Schema.Struct(TimeRangeSearchFields)

/** Structural shape of the time-range slice of any route's search params. */
export type TimeRangeSearch = typeof TimeRangeSearchStruct.Type

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
