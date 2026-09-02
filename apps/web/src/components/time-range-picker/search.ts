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

/** The decoded shape of `TimeRangeSearchFields` — what a link carries to keep the window. */
export interface TimeRangeSearch {
	startTime?: string
	endTime?: string
	timePreset?: string
}

/**
 * Just the window, nothing else. For a link between sibling pages whose other
 * search params don't transfer — a pod filter means nothing on the nodes list —
 * and for "clear filters", which must keep the window and drop the rest.
 */
export function pickTimeRangeSearch(search: TimeRangeSearch): TimeRangeSearch {
	return { startTime: search.startTime, endTime: search.endTime, timePreset: search.timePreset }
}
