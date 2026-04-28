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
	const lastRefreshVersion = React.useRef(refreshVersion)
	const relativePreset = resolveRefreshPreset({
		startTime,
		endTime,
		timePreset,
		defaultRange,
	})
	const [refreshedRange, setRefreshedRange] = React.useState<TimeRange>(baseRange)

	const prevBaseStartRef = React.useRef(baseRange.startTime)
	const prevBaseEndRef = React.useRef(baseRange.endTime)
	const prevPresetRef = React.useRef(relativePreset)

	if (
		baseRange.startTime !== prevBaseStartRef.current ||
		baseRange.endTime !== prevBaseEndRef.current ||
		relativePreset !== prevPresetRef.current
	) {
		prevBaseStartRef.current = baseRange.startTime
		prevBaseEndRef.current = baseRange.endTime
		prevPresetRef.current = relativePreset
		setRefreshedRange(baseRange)
	}

	if (pageRefresh && refreshVersion !== lastRefreshVersion.current) {
		lastRefreshVersion.current = refreshVersion
		if (relativePreset) {
			const nextRange = relativeToAbsolute(relativePreset)
			if (nextRange) {
				setRefreshedRange(nextRange)
			}
		}
	}

	return refreshedRange
}
