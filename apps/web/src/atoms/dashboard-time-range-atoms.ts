import { type ReactNode, createElement, useMemo } from "react"
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

// Use `unknown` as the ScopedAtom input to avoid TS union → never intersection
export const DashboardTimeRange = ScopedAtom.make((initialTimeRange: unknown) =>
	Atom.make(initialTimeRange as TimeRange),
)

export function useDashboardTimeRange() {
	const timeRangeAtom = DashboardTimeRange.use()
	const [timeRange, setTimeRange] = useAtom(timeRangeAtom)

	const resolvedTimeRange = useMemo(() => resolveTimeRange(timeRange), [timeRange])

	return {
		state: { timeRange, resolvedTimeRange },
		actions: {
			setTimeRange,
			refreshTimeRange: () => setTimeRange((current: TimeRange) => ({ ...current })),
		},
		meta: {},
	}
}

// Typed provider wrapper (avoids ScopedAtom union intersection issue)
export function DashboardTimeRangeProvider({ value, children }: { value: TimeRange; children?: ReactNode }) {
	return createElement(DashboardTimeRange.Provider, { value: value as never, children })
}
