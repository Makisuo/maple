import {
  createContext,
  use,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react"
import type { TimeRange } from "@/components/dashboard-builder/types"
import { relativeToAbsolute } from "@/lib/time-utils"

// ---------------------------------------------------------------------------
// Time Range Context
// ---------------------------------------------------------------------------

type ResolvedTimeRange = { startTime: string; endTime: string }

function resolveTimeRange(timeRange: TimeRange): ResolvedTimeRange | null {
  if (timeRange.type === "absolute") {
    return { startTime: timeRange.startTime, endTime: timeRange.endTime }
  }
  return relativeToAbsolute(timeRange.value)
}

interface DashboardTimeRangeContextValue {
  state: {
    timeRange: TimeRange
    resolvedTimeRange: ResolvedTimeRange | null
  }
  actions: {
    setTimeRange: (timeRange: TimeRange) => void
    refreshTimeRange: () => void
  }
  meta: {}
}

const DashboardTimeRangeContext = createContext<DashboardTimeRangeContextValue | null>(null)

export function useDashboardTimeRange() {
  const context = use(DashboardTimeRangeContext)
  if (!context) {
    throw new Error(
      "useDashboardTimeRange must be used within DashboardTimeRangeProvider."
    )
  }
  return context
}

interface DashboardTimeRangeProviderProps {
  initialTimeRange: TimeRange
  onTimeRangeChange?: (timeRange: TimeRange) => void
  children: ReactNode
}

export function DashboardTimeRangeProvider({
  initialTimeRange,
  onTimeRangeChange,
  children,
}: DashboardTimeRangeProviderProps) {
  const [timeRange, setTimeRangeState] = useState<TimeRange>(initialTimeRange)
  const [resolvedTimeRange, setResolvedTimeRange] = useState<ResolvedTimeRange | null>(
    () => resolveTimeRange(initialTimeRange)
  )
  const timeRangeRef = useRef(timeRange)
  timeRangeRef.current = timeRange

  const setTimeRange = useCallback(
    (tr: TimeRange) => {
      setTimeRangeState(tr)
      setResolvedTimeRange(resolveTimeRange(tr))
      onTimeRangeChange?.(tr)
    },
    [onTimeRangeChange]
  )

  const refreshTimeRange = useCallback(() => {
    setResolvedTimeRange(resolveTimeRange(timeRangeRef.current))
  }, [])

  const value = useMemo<DashboardTimeRangeContextValue>(
    () => ({
      state: { timeRange, resolvedTimeRange },
      actions: { setTimeRange, refreshTimeRange },
      meta: {},
    }),
    [timeRange, resolvedTimeRange, setTimeRange, refreshTimeRange]
  )

  return (
    <DashboardTimeRangeContext.Provider value={value}>
      {children}
    </DashboardTimeRangeContext.Provider>
  )
}
