import { useMemo } from "react"
import { useOptionalPageRefreshContext } from "@/components/time-range-picker/page-refresh-context"
import { relativeToAbsolute } from "@/lib/time-utils"

interface TimeRange {
	startTime: string
	endTime: string
}

/**
 * The hook's resolution, without the hook — so a router `loader` can build the
 * exact same query inputs the component will and prefetch against them. Safe to
 * call from both: atom family keys run through `encodeKey`, which snaps
 * timestamps to a 15s grid, so a loader and a component resolving `now`
 * milliseconds apart land on the same cache entry.
 */
export function resolveEffectiveTimeRange(
	startTime?: string,
	endTime?: string,
	defaultRange: string = "12h",
): TimeRange {
	if (startTime && endTime) {
		return { startTime, endTime }
	}
	const resolved = relativeToAbsolute(defaultRange)
	if (resolved) return resolved
	return relativeToAbsolute("12h")!
}

/**
 * Returns effective time range, applying defaults when not specified.
 *
 * When no explicit startTime/endTime are provided, the range is computed
 * dynamically from the defaultRange preset. Recomputes on page refresh
 * (refreshVersion change) so live mode and reload work correctly.
 *
 * @param defaultRange - shorthand like "12h", "7d" etc. Defaults to "12h".
 */
export function useEffectiveTimeRange(
	startTime?: string,
	endTime?: string,
	defaultRange: string = "12h",
): TimeRange {
	const pageRefresh = useOptionalPageRefreshContext()
	const refreshVersion = pageRefresh?.refreshVersion ?? 0

	return useMemo(
		() => resolveEffectiveTimeRange(startTime, endTime, defaultRange),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[startTime, endTime, defaultRange, refreshVersion],
	)
}
