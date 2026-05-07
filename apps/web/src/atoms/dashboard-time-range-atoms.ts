import { type ReactNode, createElement, useCallback, useMemo } from "react"
import { Atom, ScopedAtom, useAtom } from "@/lib/effect-atom"
import type { TimeRange } from "@/components/dashboard-builder/types"
import { relativeToAbsolute } from "@/lib/time-utils"

export type ResolvedTimeRange = { startTime: string; endTime: string }

const DEFAULT_RELATIVE_FALLBACK = "1h"

export function resolveTimeRange(timeRange: TimeRange): ResolvedTimeRange | null {
	if (timeRange.type === "absolute") {
		return { startTime: timeRange.startTime, endTime: timeRange.endTime }
	}
	const resolved = relativeToAbsolute(timeRange.value)
	if (resolved) return resolved

	if (import.meta.env.DEV) {
		console.warn(
			`[resolveTimeRange] Invalid relative time range value "${timeRange.value}", falling back to "${DEFAULT_RELATIVE_FALLBACK}"`,
		)
	}
	return relativeToAbsolute(DEFAULT_RELATIVE_FALLBACK)
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

	const resolvedTimeRange = useMemo(() => resolveTimeRange(timeRange), [timeRange])

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
