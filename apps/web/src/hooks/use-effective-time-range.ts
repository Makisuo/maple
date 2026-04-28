import { useMemo } from "react"
import { useOptionalPageRefreshContext } from "@/components/time-range-picker/page-refresh-context"
import { relativeToAbsolute } from "@/lib/time-utils"

interface TimeRange {
	startTime: string
	endTime: string
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

	return useMemo(() => {
		if (startTime && endTime) {
			return { startTime, endTime }
		}
		const resolved = relativeToAbsolute(defaultRange)
		if (resolved) return resolved
		return relativeToAbsolute("12h")!
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [startTime, endTime, defaultRange, refreshVersion])
}
