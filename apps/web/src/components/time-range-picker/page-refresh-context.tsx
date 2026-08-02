import * as React from "react"

import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
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
	/**
	 * Auto-refresh cadence in ms; `0`/absent leaves the page manual-only, which is
	 * what every caller except the dashboard route wants.
	 */
	autoRefreshMs?: number
	/** Suspends the timer without forgetting the cadence (dashboard edit mode, history preview). */
	autoRefreshPaused?: boolean
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
	autoRefreshMs = 0,
	autoRefreshPaused = false,
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

	// One timer per page, not per widget: `reload` re-resolves the relative range
	// and fans out to every `subscribeReload` listener, so a single tick refreshes
	// the whole canvas. `enabled: false` registers no interval at all, which also
	// keeps `setInterval(…, 0)` unreachable.
	useIntervalRefresh(reload, {
		intervalMs: autoRefreshMs,
		enabled: autoRefreshMs > 0 && !autoRefreshPaused,
	})

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
