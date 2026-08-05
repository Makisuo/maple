import { createContext, use, type ReactNode } from "react"

import type { TimeRange } from "@/components/dashboard-builder/types"
import { formatTimeRangeDisplay, presetLabel } from "@/lib/time-utils"

/** How an override reads in the widget header and in the settings rail. */
export function widgetTimeRangeLabel(timeRange: TimeRange): string {
	return timeRange.type === "relative"
		? presetLabel(timeRange.value)
		: formatTimeRangeDisplay(timeRange.startTime, timeRange.endTime)
}

const WidgetTimeRangeContext = createContext<TimeRange | null>(null)

/**
 * The time range a single widget is pinned to, or `null` when it follows the
 * dashboard's. Read by `useWidgetDataSource` (so a tile's secondary fetches —
 * a stat's sparkline — query the same window as its headline value) and by
 * `WidgetShell` (which labels the override in the card header, so a reader can
 * tell the tile isn't on the board's range).
 */
export function useWidgetTimeRangeOverride(): TimeRange | null {
	return use(WidgetTimeRangeContext)
}

export function WidgetTimeRangeProvider({
	timeRange,
	children,
}: {
	timeRange: TimeRange | undefined
	children: ReactNode
}) {
	return <WidgetTimeRangeContext value={timeRange ?? null}>{children}</WidgetTimeRangeContext>
}
