import { recentlyUsedTimesAtom, type RecentTimeRange } from "@/atoms/recently-used-times-atoms"
import { useAtom } from "@/lib/effect-atom"
import { useCallback } from "react"

const MAX_ITEMS = 5

export type { RecentTimeRange }

export function useRecentlyUsedTimes() {
	const [recentTimes, setRecentTimes] = useAtom(recentlyUsedTimesAtom)

	const addRecentTime = useCallback(
		(item: RecentTimeRange) => {
			setRecentTimes((current) => {
				const filtered = current.filter((recent) => recent.value !== item.value)
				return [item, ...filtered].slice(0, MAX_ITEMS)
			})
		},
		[setRecentTimes],
	)

	const clearRecentTimes = useCallback(() => {
		setRecentTimes([])
	}, [setRecentTimes])

	return {
		recentTimes,
		addRecentTime,
		clearRecentTimes,
	}
}
