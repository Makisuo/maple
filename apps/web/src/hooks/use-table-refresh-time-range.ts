import * as React from "react"

import { useOptionalPageRefreshContext } from "@/components/time-range-picker/page-refresh-context"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { relativeToAbsolute } from "@/lib/time-utils"

interface UseTableRefreshTimeRangeOptions {
	startTime?: string
	endTime?: string
	timePreset?: string
	defaultRange?: string
}

interface TimeRange {
	startTime: string
	endTime: string
}

function resolveRefreshPreset({
	startTime,
	endTime,
	timePreset,
	defaultRange,
}: UseTableRefreshTimeRangeOptions): string | undefined {
	if (timePreset) return timePreset
	if (startTime || endTime) return undefined
	return defaultRange
}

export function useTableRefreshTimeRange({
	startTime,
	endTime,
	timePreset,
	defaultRange = "12h",
}: UseTableRefreshTimeRangeOptions): TimeRange {
	const baseRange = useEffectiveTimeRange(startTime, endTime, timePreset ?? defaultRange)
	const pageRefresh = useOptionalPageRefreshContext()
	const refreshVersion = pageRefresh?.refreshVersion ?? 0
	const relativePreset = resolveRefreshPreset({
		startTime,
		endTime,
		timePreset,
		defaultRange,
	})
	const source = `${baseRange.startTime}\u0000${baseRange.endTime}\u0000${relativePreset ?? ""}\u0000${refreshVersion}`
	const [refreshState, setRefreshState] = React.useState(() => ({ source, range: baseRange }))
	let refreshedRange = refreshState.range

	if (refreshState.source !== source) {
		const nextRange =
			pageRefresh && relativePreset ? (relativeToAbsolute(relativePreset) ?? baseRange) : baseRange
		refreshedRange = nextRange
		setRefreshState({ source, range: nextRange })
	}

	return refreshedRange
}
