import * as React from "react"

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
	subscribeReload: (listener: () => void) => () => void
}

interface PageRefreshProviderProps {
	children: React.ReactNode
	timePreset?: string
	onRelativeRangeRefresh?: (range: RelativeRefreshRange) => void
}

const PageRefreshContext = React.createContext<PageRefreshContextValue | null>(null)

export function resolveRelativeRefreshRange(timePreset?: string): RelativeRefreshRange | null {
	if (!timePreset) return null

	const range = relativeToAbsolute(timePreset)
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
	const [reloadListeners] = React.useState(() => new Set<() => void>())
	const reloadTimeoutRef = React.useRef<ReturnType<typeof setTimeout>>(null)
	const subscribeReload = React.useCallback(
		(listener: () => void) => {
			reloadListeners.add(listener)
			return () => reloadListeners.delete(listener)
		},
		[reloadListeners],
	)

	const reload = React.useCallback(() => {
		const relativeRange = resolveRelativeRefreshRange(timePreset)
		if (relativeRange) {
			onRelativeRangeRefresh?.(relativeRange)
		}
		setRefreshVersion((current) => current + 1)
		for (const listener of reloadListeners) listener()

		if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current)
		setIsReloading(true)
		reloadTimeoutRef.current = setTimeout(() => setIsReloading(false), 600)
	}, [timePreset, onRelativeRangeRefresh, reloadListeners])

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
			subscribeReload,
		}),
		[isReloading, refreshVersion, reload, subscribeReload],
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
