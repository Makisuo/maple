import { useMemo } from "react"
import { useOptionalPageRefreshContext } from "@/components/time-range-picker/page-refresh-context"
import { relativeToAbsolute, snapRangeForCache } from "@/lib/time-utils"

interface TimeRange {
	startTime: string
	endTime: string
}

export interface ResolveEffectiveTimeRangeOptions {
	/**
	 * Floor the endpoint to the cache-key grid. Default `true`.
	 *
	 * Pass `false` only when the user has explicitly asked for fresh data — see
	 * the note on refresh below.
	 */
	snap?: boolean
}

/**
 * The hook's resolution, without the hook — so a router `loader` can build the
 * exact same query inputs the component will and prefetch against them.
 *
 * A preset range has no absolute endpoint in the URL, so it is re-resolved
 * against `Date.now()` on every fresh mount. `snapRangeForCache` floors that
 * endpoint to a grid scaled to the window (15s for 1h, 5m for 12h, 15m for 7d),
 * which is what makes the atom key hold still between navigations — a loader
 * and a component resolving `now` milliseconds apart land on the same entry,
 * and so does the same page revisited a minute later.
 *
 * An explicit `startTime`/`endTime` pair is an absolute range the user chose;
 * it is already stable and is returned untouched.
 */
export function resolveEffectiveTimeRange(
	startTime?: string,
	endTime?: string,
	defaultRange: string = "12h",
	options?: ResolveEffectiveTimeRangeOptions,
): TimeRange {
	if (startTime && endTime) {
		return { startTime, endTime }
	}
	const resolved = relativeToAbsolute(defaultRange) ?? relativeToAbsolute("12h")!
	return options?.snap === false ? resolved : snapRangeForCache(resolved)
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
		// Snap while idle, but not once the user has asked for fresh data. Snapping
		// a reload would leave the window up to a grid interval in the past, so the
		// newest rows stay invisible however many times they click it. The bypass
		// lasts only for this mount — `refreshVersion` is back to 0 on the next
		// one, so navigation returns to stable, cache-friendly keys.
		() => resolveEffectiveTimeRange(startTime, endTime, defaultRange, { snap: refreshVersion === 0 }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[startTime, endTime, defaultRange, refreshVersion],
	)
}
