import { type ReactNode, useCallback } from "react"
import {
	DashboardTimeRange,
	DashboardTimeRangeProvider,
	useDashboardTimeRange,
} from "@/atoms/dashboard-time-range-atoms"
import { useAtomSubscribe } from "@/lib/effect-atom"
import type { TimeRange } from "@/components/dashboard-builder/types"

export { useDashboardTimeRange }

// Sync atom changes back to the dashboard store
function DashboardTimeRangeSync({
	onTimeRangeChange,
}: {
	onTimeRangeChange?: (timeRange: TimeRange) => void
}) {
	const stableCallback = useCallback(
		(tr: TimeRange) => {
			onTimeRangeChange?.(tr)
		},
		[onTimeRangeChange],
	)

	const timeRangeAtom = DashboardTimeRange.use()
	useAtomSubscribe(timeRangeAtom, stableCallback)
	return null
}

interface DashboardTimeRangeWrapperProps {
	initialTimeRange: TimeRange
	onTimeRangeChange?: (timeRange: TimeRange) => void
	children: ReactNode
}

export function DashboardTimeRangeWrapper({
	initialTimeRange,
	onTimeRangeChange,
	children,
}: DashboardTimeRangeWrapperProps) {
	return (
		<DashboardTimeRangeProvider value={initialTimeRange}>
			<DashboardTimeRangeSync onTimeRangeChange={onTimeRangeChange} />
			{children}
		</DashboardTimeRangeProvider>
	)
}
