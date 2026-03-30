import { type ReactNode, createElement } from "react"
import { Atom, ScopedAtom, useAtom } from "@/lib/effect-atom"
import type { TimeRange } from "@/components/dashboard-builder/types"
import { relativeToAbsolute } from "@/lib/time-utils"

export type ResolvedTimeRange = { startTime: string; endTime: string }

export function resolveTimeRange(timeRange: TimeRange): ResolvedTimeRange | null {
  if (timeRange.type === "absolute") {
    return { startTime: timeRange.startTime, endTime: timeRange.endTime }
  }
  return relativeToAbsolute(timeRange.value)
}

// Use `unknown` as the ScopedAtom input to avoid TS union → never intersection
export const DashboardTimeRange = ScopedAtom.make((initialTimeRange: unknown) =>
  Atom.make(initialTimeRange as TimeRange),
)

export function useDashboardTimeRange() {
  const timeRangeAtom = DashboardTimeRange.use()
  const [timeRange, setTimeRange] = useAtom(timeRangeAtom)

  const resolvedTimeRange = resolveTimeRange(timeRange)

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
