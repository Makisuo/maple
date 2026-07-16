import * as React from "react"

import type { TimeZoneId } from "@maple/ui/lib/time-format"
import { useTimeFormat } from "@/hooks/use-time-format"
import { relativeToAbsolute } from "@/lib/time-utils"

export interface RelativeRefreshRange {
	startTime: string
	endTime: string
	presetValue: string
}

interface PageRefreshContextValue {
	refreshVersion: number
	isReloading: boolean
	reload: () => void
}

interface PageRefreshProviderProps {
	children: React.ReactNode
	timePreset?: string
	onRelativeRangeRefresh?: (range: RelativeRefreshRange) => void
}

const PageRefreshContext = React.createContext<PageRefreshContextValue | null>(null)

export function resolveRelativeRefreshRange(
	timePreset?: string,
	timeZone?: TimeZoneId,
): RelativeRefreshRange | null {
	if (!timePreset) return null

	const range = relativeToAbsolute(timePreset, timeZone)
	if (!range) return null

	return {
		...range,
		presetValue: timePreset,
	}
}

export function PageRefreshProvider({
	children,
	timePreset,
	onRelativeRangeRefresh,
}: PageRefreshProviderProps) {
	const [refreshVersion, setRefreshVersion] = React.useState(0)
	const [isReloading, setIsReloading] = React.useState(false)
	const reloadTimeoutRef = React.useRef<ReturnType<typeof setTimeout>>(null)

	const { timeZone } = useTimeFormat()
	const reload = React.useCallback(() => {
		const relativeRange = resolveRelativeRefreshRange(timePreset, timeZone)
		if (relativeRange) {
			onRelativeRangeRefresh?.(relativeRange)
		}
		setRefreshVersion((current) => current + 1)

		if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current)
		setIsReloading(true)
		reloadTimeoutRef.current = setTimeout(() => setIsReloading(false), 600)
	}, [timePreset, timeZone, onRelativeRangeRefresh])

	React.useEffect(() => {
		return () => {
			if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current)
		}
	}, [])

	const value = React.useMemo<PageRefreshContextValue>(
		() => ({
			refreshVersion,
			isReloading,
			reload,
		}),
		[isReloading, refreshVersion, reload],
	)

	return <PageRefreshContext value={value}>{children}</PageRefreshContext>
}

export function usePageRefreshContext() {
	const context = React.use(PageRefreshContext)
	if (!context) {
		throw new Error("usePageRefreshContext must be used within a PageRefreshProvider")
	}
	return context
}

export function useOptionalPageRefreshContext() {
	return React.use(PageRefreshContext)
}
