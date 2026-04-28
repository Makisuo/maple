import { useState, useCallback } from "react"

const STORAGE_KEY = "maple-recently-used-times"
const MAX_ITEMS = 5

export interface RecentTimeRange {
	label: string
	value: string
	startTime: string
	endTime: string
}

export function useRecentlyUsedTimes() {
	const [recentTimes, setRecentTimes] = useState<RecentTimeRange[]>(() => {
		try {
			const stored = localStorage.getItem(STORAGE_KEY)
			if (stored) return JSON.parse(stored)
		} catch {
			// Ignore localStorage errors
		}
		return []
	})

	const addRecentTime = useCallback((item: RecentTimeRange) => {
		setRecentTimes((prev) => {
			// Remove duplicate by value
			const filtered = prev.filter((t) => t.value !== item.value)
			const updated = [item, ...filtered].slice(0, MAX_ITEMS)

			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
			} catch {
				// Ignore localStorage errors
			}

			return updated
		})
	}, [])

	const clearRecentTimes = useCallback(() => {
		setRecentTimes([])
		try {
			localStorage.removeItem(STORAGE_KEY)
		} catch {
			// Ignore localStorage errors
		}
	}, [])

	return {
		recentTimes,
		addRecentTime,
		clearRecentTimes,
	}
}
