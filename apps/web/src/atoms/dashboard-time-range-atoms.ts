import { type ReactNode, createElement, useCallback, useMemo } from "react"
import { Atom, ScopedAtom, useAtom } from "@/lib/effect-atom"
import { useOptionalPageRefreshContext } from "@/components/time-range-picker/page-refresh-context"
import type { TimeRange } from "@/components/dashboard-builder/types"
import { resolveTimeRangeWindow } from "@maple/query-engine"

type ResolvedTimeRange = { startTime: string; endTime: string }

const DEFAULT_RELATIVE_FALLBACK = "1h"

export interface ResolveTimeRangeOptions {
	/**
	 * Floor the endpoint to the cache-key grid. Default `true`; pass `false` on
	 * an explicit reload so the window actually advances to "now".
	 */
	snap?: boolean
}

/**
 * The signed-in dashboard's view of `resolveTimeRangeWindow` — the same
 * resolver the share page and the share API use, so a board and its share link
 * run over the same window. Only the DEV warning and the `"1h"` fallback for a
 * malformed stored preset are this app's own.
 *
 * Every widget on the dashboard keys its fetch off this range, so an unsnapped
 * `now` hands all of them a fresh cache key on each mount at once — hence the
 * default snap.
 */
export function resolveTimeRange(
	timeRange: TimeRange,
	options?: ResolveTimeRangeOptions,
): ResolvedTimeRange | null {
	const resolved = resolveTimeRangeWindow(timeRange, { snap: options?.snap })
	if (resolved) return resolved

	if (import.meta.env.DEV) {
		console.warn(
			`[resolveTimeRange] Invalid time range ${JSON.stringify(timeRange)}, falling back to "${DEFAULT_RELATIVE_FALLBACK}"`,
		)
	}
	return resolveTimeRangeWindow(
		{ type: "relative", value: DEFAULT_RELATIVE_FALLBACK },
		{ snap: options?.snap },
	)
}

function timeRangesEqual(a: TimeRange, b: TimeRange): boolean {
	if (a === b) return true
	if (a.type !== b.type) return false
	if (a.type === "relative" && b.type === "relative") return a.value === b.value
	if (a.type === "absolute" && b.type === "absolute") {
		return a.startTime === b.startTime && a.endTime === b.endTime
	}
	return false
}

// Use `unknown` as the ScopedAtom input to avoid TS union → never intersection
export const DashboardTimeRange = ScopedAtom.make((initialTimeRange: unknown) =>
	Atom.make(initialTimeRange as TimeRange),
)

export function useDashboardTimeRange() {
	const timeRangeAtom = DashboardTimeRange.use()
	const [timeRange, setTimeRangeRaw] = useAtom(timeRangeAtom)

	// Rebase relative presets to "now" on manual reload, matching
	// useEffectiveTimeRange. Without refreshVersion in the deps the resolved
	// absolute window stays frozen, so clicking Reload re-fetches the same stale
	// range and appears to do nothing. Absolute ranges resolve to the same value,
	// so they are unaffected (the explicit useRefreshableAtomValue refresh still
	// re-runs their queries).
	const refreshVersion = useOptionalPageRefreshContext()?.refreshVersion ?? 0
	const resolvedTimeRange = useMemo(
		// Snapped while idle so navigating back to a dashboard reuses every tile's
		// cached result; unsnapped once the user reloads, so the window advances to
		// the real "now" rather than staying inside the previous grid cell.
		() => resolveTimeRange(timeRange, { snap: refreshVersion === 0 }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[timeRange, refreshVersion],
	)

	// Skip atom writes when the new range is structurally equal to the current
	// one. Without this guard the picker can re-emit the same range on mount
	// or focus, which fires useAtomSubscribe → updateDashboardTimeRange →
	// upsert → list-query invalidation, cascading a refetch of every widget.
	const setTimeRange = useCallback(
		(next: TimeRange | ((current: TimeRange) => TimeRange)) => {
			setTimeRangeRaw((current: TimeRange) => {
				const resolved = typeof next === "function" ? next(current) : next
				return timeRangesEqual(current, resolved) ? current : resolved
			})
		},
		[setTimeRangeRaw],
	)

	return {
		state: { timeRange, resolvedTimeRange },
		actions: {
			setTimeRange,
			refreshTimeRange: () => setTimeRangeRaw((current: TimeRange) => ({ ...current })),
		},
		meta: {},
	}
}

// Typed provider wrapper (avoids ScopedAtom union intersection issue)
export function DashboardTimeRangeProvider({ value, children }: { value: TimeRange; children?: ReactNode }) {
	return createElement(DashboardTimeRange.Provider, { value: value as never, children })
}
